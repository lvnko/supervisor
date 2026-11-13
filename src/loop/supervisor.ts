import { existsSync, readFileSync } from "node:fs";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { guard } from "../judge/guard.js";
import { buildJudgeMessage } from "../judge/input.js";
import { parseJudge, type Card, type JudgeResult } from "../judge/schema.js";
import { Policy } from "../policy.js";
import type { ToolCall } from "../types.js";
import type { RepoContext } from "./context.js";
import type { Human, QuestionItem } from "./human.js";
import type { Judge } from "./judge-sdk.js";

export interface SupervisorDeps {
  policy: Policy; judge: Judge; human: Human; ctx: RepoContext;
  notify: (title: string, body: string) => void | Promise<void>;
  log: (entry: Record<string, unknown>) => void;
  maxJudgeCalls?: number;           // decision 11: 15 per task
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export function signature(call: ToolCall): string {
  const i = call.input;
  return `${call.tool}:${call.tool === "Bash" ? String(i.command ?? "").trim() : String(i.file_path ?? i.url ?? JSON.stringify(i)).slice(0, 200)}`;
}
const summary = (call: ToolCall) => clip(call.tool === "Bash" ? String(call.input.command ?? "") : String(call.input.file_path ?? call.input.url ?? JSON.stringify(call.input)), 200);

function simpleCard(headline: string, situation: string, risk: Card["risk"] = "medium"): Card {
  return { headline, situation, risk, options: [{ label: "Approve", effect: "The worker's request goes ahead", recommended: false }, { label: "Deny or redirect", effect: "The worker is told no, or told what to do instead", recommended: true }] };
}

export class Supervisor {
  judgeCalls = 0;
  private transcript = "";
  private decisions: string[] = [];
  private denies = new Map<string, number>();
  private failures = new Map<string, number>();
  private idToSig = new Map<string, string>();
  private frustrated = false;
  private written = new Map<string, string>();   // what the worker wrote to each file, so the judge can read it

  constructor(private d: SupervisorDeps) {}

  /** Anything you type. If you sound frustrated, the judge is switched off until you next decide something yourself. */
  noteUserText(text: string) {
    if (/DON'T WASTE MY TIME|!!!!|\bdumbest\b|\b[A-Z]{3,}\b(?:\s+\b[A-Z]{3,}\b){3,}/.test(text)) this.frustrated = true;
    this.transcript = (this.transcript + "\nKIN: " + clip(text, 600)).slice(-9000);
  }
  /**
   * Called after a Bash command has actually run, including ones Claude Code approved by itself from your settings
   * (those never reach canUseTool). Keeps the staging and commit bookkeeping true and puts them in the log.
   */
  observeRan(command: string) {
    this.d.policy.observe(command);
    this.d.log({ t: new Date().toISOString(), ran: clip(command, 160) });
  }
  /** Short log line for every tool call the worker makes, so the judge knows what has been done. */
  noteToolUse(name: string, input: Record<string, unknown>) {
    this.transcript = (this.transcript + `\nTOOL ${name}: ${summary({ tool: name, input })}`).slice(-9000);
  }
  /** Files named after `<` or `-f` in a command: the judge should read them before judging the command. */
  private referencedFiles(call: ToolCall): { path: string; text: string }[] {
    if (call.tool !== "Bash") return [];
    const cmd = String(call.input.command ?? "");
    const paths = new Set<string>();
    for (const m of cmd.matchAll(/(?:<|\s-f\s+|\s--file[ =])\s*(["']?)([^\s"'|;&<>]+)\1/g)) paths.add(m[2]);
    const out: { path: string; text: string }[] = [];
    for (const p of paths) {
      let text = this.written.get(p);
      if (text === undefined && existsSync(p)) { try { text = readFileSync(p, "utf8"); } catch { /* unreadable */ } }
      if (text !== undefined) out.push({ path: p, text });
    }
    return out;
  }
  noteAssistant(text: string) { this.transcript = (this.transcript + "\nWORKER: " + clip(text, 1500)).slice(-9000); }
  noteResult(toolUseId: string, isError: boolean, text = "") {
    const sig = this.idToSig.get(toolUseId);
    if (!sig) return;
    if (isError) this.failures.set(sig, (this.failures.get(sig) ?? 0) + 1);
    this.transcript = (this.transcript + `\nRESULT(${isError ? "error" : "ok"}): ${clip(text, 300)}`).slice(-9000);
  }

  /** Pass this to the SDK as `canUseTool`. */
  canUseTool = async (toolName: string, input: Record<string, unknown>, opts: { toolUseID?: string } = {}): Promise<PermissionResult> => {
    const call: ToolCall = { tool: toolName, input };
    if ((toolName === "Write" || toolName === "Edit") && typeof input.file_path === "string") this.written.set(input.file_path, String(input.content ?? input.new_string ?? "").slice(0, 8000));
    const sig = signature(call);
    if (opts.toolUseID) this.idToSig.set(opts.toolUseID, sig);
    const t0 = Date.now();
    const done = (r: PermissionResult, via: string, why: string) => {
      this.d.log({ t: new Date().toISOString(), tool: toolName, input: summary(call), via, outcome: r.behavior, why, ms: Date.now() - t0 });
      // A command the judge or Kin approved still happens, so staging and commit bookkeeping must see it.
      // (Rule-approved commands are already counted by the rule engine.)
      if (r.behavior === "allow" && toolName === "Bash" && via !== "rule") this.d.policy.observe(String(input.command ?? ""));
      return r;
    };

    // Decision 9: the same step has already failed twice → stop and ask.
    if ((this.failures.get(sig) ?? 0) >= 2) {
      const r = await this.askHuman(simpleCard("The worker is repeating a step that keeps failing", `It has failed twice already: ${summary(call)}`, "medium"), call);
      return done(r, "human", "repeated failure");
    }

    const v = this.d.policy.evaluate(call);
    switch (v.kind) {
      case "allow": return done({ behavior: "allow", updatedInput: input }, "rule", v.reason);
      case "deny": {
        const n = (this.denies.get(sig) ?? 0) + 1;
        this.denies.set(sig, n);
        if (n >= 2) {
          const r = await this.askHuman(simpleCard("The worker keeps trying something that is blocked", `Blocked because: ${v.reason}. It tried again: ${summary(call)}`), call);
          return done(r, "human", `denied twice: ${v.reason}`);
        }
        return done({ behavior: "deny", message: v.redirect }, "rule", v.reason);
      }
      case "human": return done(await this.askHuman(simpleCard("Needs your decision", v.reason), call), "human", v.reason);
      case "ask_judge": return done(await this.viaJudge(call, v.reason), "judge", v.reason);
    }
  };

  private requestText(call: ToolCall): string {
    if (call.tool === "AskUserQuestion") return JSON.stringify(call.input.questions ?? call.input);
    if (call.tool === "ExitPlanMode") return String(call.input.plan ?? "");
    return call.tool === "Bash" ? String(call.input.command ?? "") : String(call.input.file_path ?? JSON.stringify(call.input));
  }

  private async viaJudge(call: ToolCall, why: string): Promise<PermissionResult> {
    const cap = this.d.maxJudgeCalls ?? 15;
    if (this.judgeCalls >= cap) return this.askHuman(simpleCard("The judge's budget for this task is used up", `${cap} judge calls so far. Request: ${summary(call)}`), call);
    if (this.frustrated) return this.askHuman(simpleCard("You sounded frustrated, so the judge is paused", `Nothing is auto-answered until you decide this one yourself. Request: ${summary(call)}`), call);
    this.judgeCalls++;
    let r: JudgeResult;
    try {
      const raw = await this.d.judge.decide(buildJudgeMessage({
        manifest: this.d.policy.manifest, call, whyJudge: why, recentTranscript: this.transcript,
        contextFiles: this.d.ctx.contextFiles, playbookEntry: this.d.ctx.playbookEntry, priorDecisions: this.decisions,
        referencedFiles: this.referencedFiles(call),
      }));
      r = parseJudge(raw);
    } catch (e) {
      r = parseJudge(""); // becomes an escalation
      r.why = `judge unavailable: ${(e as Error).message}`;
    }
    const sig = signature(call);
    r = guard(this.requestText(call), r, this.failures.get(sig) ?? 0, call.tool === "ExitPlanMode" ? "all" : "none");
    this.decisions.push(`#${this.judgeCalls} ${call.tool} ${summary(call)} → ${r.decision}: ${clip(r.why, 120)}`);
    this.d.log({ t: new Date().toISOString(), judge: r.decision, why: r.why });

    if (r.decision === "escalate") return this.askHuman(r.card!, call);
    if (r.decision === "revise") return { behavior: "deny", message: r.reply! };
    if (call.tool === "AskUserQuestion") return { behavior: "allow", updatedInput: { ...call.input, answers: this.judgeAnswers(call, r) } };
    return { behavior: "allow", updatedInput: call.input };
  }

  private judgeAnswers(call: ToolCall, r: JudgeResult): Record<string, string> {
    const qs = (call.input.questions as QuestionItem[] | undefined) ?? [];
    const out: Record<string, string> = {};
    for (const q of qs) out[q.question] = r.answers?.[q.question] ?? r.reply ?? "";
    return out;
  }

  private async askHuman(card: Card, call: ToolCall): Promise<PermissionResult> {
    void this.d.notify("Claude supervisor needs you", card.headline);
    if (call.tool === "AskUserQuestion") {
      this.d.human.say(`\n  Judge could not settle this (${card.headline}). Your answer please:`);
      const answers = await this.d.human.answer((call.input.questions as QuestionItem[]) ?? []);
      // Your rulings go into the judge's memory for this task, so it answers the same way if the question comes back.
      for (const [q, a] of Object.entries(answers)) this.decisions.push(`KIN RULED: ${clip(q, 140)} → ${clip(String(a), 140)}`);
      return { behavior: "allow", updatedInput: { ...call.input, answers } };
    }
    const h = await this.d.human.decide(card, call);
    this.frustrated = false;
    if (h.kind === "deny") this.noteUserText(h.note);
    return h.kind === "approve" ? { behavior: "allow", updatedInput: call.input } : { behavior: "deny", message: h.note };
  }
}

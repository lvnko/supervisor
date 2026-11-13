// npm run supervise -- <task.yaml> --repo <path-to-item-tracker> "<first message for the worker>"
//   options: --model opus|sonnet (overrides the manifest)   --project item-tracker   --mode plan|default (default plan)   --prompt-file <file>   --allow-api-key
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, loadManifest, startBlockers } from "./manifest.js";
import { Policy } from "./policy.js";
import { loadState, saveState } from "./state-store.js";
import { loadRepoContext } from "./loop/context.js";
import { TerminalHuman } from "./loop/human.js";
import { SdkJudge } from "./loop/judge-sdk.js";
import { notify } from "./loop/notify.js";
import { MessageQueue } from "./loop/queue.js";
import { Supervisor } from "./loop/supervisor.js";

const HOURS = 8;

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const taskFile = argv[0];
  const repo = flag("--repo");
  const project = flag("--project") ?? "item-tracker";
  const mode = (flag("--mode") ?? "plan") as "plan" | "default";
  const positional = argv.filter((a, i) => i > 0 && !a.startsWith("--") && !["--repo", "--project", "--mode", "--prompt-file"].includes(argv[i - 1]));
  const prompt = flag("--prompt-file") ? readFileSync(flag("--prompt-file")!, "utf8") : positional.join(" ");
  if (!taskFile || !repo || !prompt) { console.error('usage: npm run supervise -- <task.yaml> --repo <path> "<first message>"  [--mode plan|default] [--prompt-file f]'); process.exit(2); }

  if (process.env.ANTHROPIC_API_KEY && !argv.includes("--allow-api-key")) {
    console.error("ANTHROPIC_API_KEY is set. That would bill pay-per-token instead of using your Pro plan.\nUnset it (unset ANTHROPIC_API_KEY) and run again, or pass --allow-api-key if you really mean it.");
    process.exit(1);
  }
  const home = process.env.SUPERVISOR_HOME ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = loadManifest(taskFile);
  const blockers = startBlockers(manifest);
  if (blockers.length) { console.error(["NOT READY to start task " + manifest.task, ...blockers].join("\n")); process.exit(1); }
  const workerModel = flag("--model") ?? manifest.model;
  const config = loadConfig(join(home, "projects", project, "config.yaml"));
  const repoAbs = resolve(repo);
  const stateFile = join(home, "logs", `state-${manifest.task}.json`);
  const policy = new Policy(manifest, config, loadState(stateFile), repoAbs + "/");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(home, "logs", `run-${manifest.task}-${stamp}.jsonl`);
  mkdirSync(dirname(logFile), { recursive: true });
  const log = (e: Record<string, unknown>) => appendFileSync(logFile, JSON.stringify(e) + "\n");

  const human = new TerminalHuman();
  const judgeDir = join(home, "logs", "judge-cwd"); mkdirSync(judgeDir, { recursive: true });
  const judge = new SdkJudge({ cwd: judgeDir });
  let manifestStamp = statSync(taskFile).mtimeMs;
  const reloadManifest = () => {
    try {
      const stamp = statSync(taskFile).mtimeMs;
      if (stamp === manifestStamp) return null;
      manifestStamp = stamp;
      const m = loadManifest(taskFile);
      if (m.task !== manifest.task) throw new Error("task id changed");
      console.log(`\n  (the task file ${taskFile} changed on disk: using the new version from now on)`);
      return m;
    } catch (e) { console.log(`\n  (could not reload ${taskFile}: ${(e as Error).message}. Keeping the version loaded at the start.)`); return null; }
  };
  const sup = new Supervisor({ policy, judge, human, ctx: loadRepoContext(repoAbs, manifest), notify, log, reloadManifest });

  const abort = new AbortController();
  const deadline = setTimeout(() => { console.log(`\n${HOURS} hours reached: stopping.`); abort.abort(); }, HOURS * 3600_000);
  const queue = new MessageQueue();
  const stream = query({
    prompt: queue,
    options: {
      cwd: repoAbs,
      permissionMode: mode,
      ...(workerModel ? { model: workerModel } : {}),
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project", "local"],
      canUseTool: (name, input, o) => sup.canUseTool(name, input, o),
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [async (input: any) => { if (input?.tool_name === "Bash") sup.observeRan(String(input.tool_input?.command ?? "")); return {}; }] }] },
      abortController: abort,
    },
  });
  console.log(`Supervising task ${manifest.task} in ${repoAbs} (${mode} mode). Worker model: ${workerModel || "Claude Code default (not set)"}; judge model: sonnet. Log: ${logFile}`);
  queue.push(prompt);

  try {
    for await (const m of stream) {
      if (m.type === "assistant") {
        for (const b of (m as any).message?.content ?? []) {
          if (b.type === "text" && b.text) { console.log(`\n${b.text}`); sup.noteAssistant(b.text); }
          if (b.type === "tool_use") sup.noteToolUse(b.name, b.input ?? {});
        }
      } else if (m.type === "user") {
        for (const b of (m as any).message?.content ?? []) {
          if (b?.type === "tool_result") sup.noteResult(b.tool_use_id, !!b.is_error, typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""));
        }
      } else if (m.type === "result") {
        const r = m as any;
        log({ t: new Date().toISOString(), result: r.subtype, session: r.session_id });
        writeFileSync(join(home, "logs", `session-${manifest.task}.json`), JSON.stringify({ worker: r.session_id, judge: judge.sessionId }, null, 1));
        saveState(stateFile, policy.state);
        if (manifest.checkpoint_after) human.say(`\n  NOTE: ${manifest.checkpoint_after}  Run the checkpoint before the next task.`);
        const next = await human.followUp();
        if (!next) { queue.close(); } else { sup.noteUserText(next); queue.push(next); }
      }
    }
  } finally {
    clearTimeout(deadline);
    const sm = sup.summary();
    log({ t: new Date().toISOString(), summary: sm });
    console.log(`\nRun summary for ${manifest.task}: ${sm.minutes} min; ${sm.ruleApproved} approved by rules, ${sm.judgeDecided} decided by the judge (${sm.judgeCalls} judge calls), ${sm.askedYou} asked you, ${sm.denied} denied, ${sm.commandsRun} commands run.\nFor the §12 row: read /usage now, and put these numbers in the Notes column.`);
    saveState(stateFile, policy.state);
    judge.close(); human.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

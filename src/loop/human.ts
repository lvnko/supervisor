import { createInterface } from "node:readline/promises";
import type { Card } from "../judge/schema.js";
import type { ToolCall } from "../types.js";

export interface QuestionItem { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }
export type HumanDecision = { kind: "approve" } | { kind: "deny"; note: string };

export interface Human {
  decide(card: Card, call: ToolCall): Promise<HumanDecision>;
  answer(questions: QuestionItem[]): Promise<Record<string, string>>;
  followUp(): Promise<string | null>;
  say(text: string): void;
}

export function renderCard(card: Card, call: ToolCall): string {
  const bar = "─".repeat(64);
  const detail = call.tool === "Bash" ? String(call.input.command ?? "")
    : call.tool === "ExitPlanMode" ? String(call.input.plan ?? "").slice(0, 1500)
    : JSON.stringify(call.input).slice(0, 400);
  const opts = card.options.map((o, i) => `  ${o.recommended ? "★" : " "} ${o.label}: ${o.effect}`).join("\n");
  return `\n${bar}\n  NEEDS YOU  [${card.risk} risk]\n  ${card.headline}\n\n  ${card.situation}\n\n${opts}\n\n  Worker wants to use ${call.tool}:\n${detail.split("\n").map((l) => "    " + l).join("\n")}\n${bar}`;
}

export class TerminalHuman implements Human {
  private rl = createInterface({ input: process.stdin, output: process.stdout });
  say(text: string) { console.log(text); }
  async decide(card: Card, call: ToolCall): Promise<HumanDecision> {
    console.log(renderCard(card, call));
    for (;;) {
      const a = (await this.rl.question("  [a] approve   [d] deny   or type an instruction for the worker: ")).trim();
      if (/^a(pprove)?$/i.test(a)) return { kind: "approve" };
      if (/^d(eny)?$/i.test(a)) return { kind: "deny", note: "The user declined this. Stop this line of work and report." };
      if (a) return { kind: "deny", note: `The user says: ${a}` };
    }
  }
  async answer(questions: QuestionItem[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const q of questions) {
      console.log(`\n  ${q.header ? `[${q.header}] ` : ""}${q.question}`);
      q.options.forEach((o, i) => console.log(`    ${i + 1}. ${o.label}${o.description ? " — " + o.description : ""}`));
      const a = (await this.rl.question("  number, or type your own answer: ")).trim();
      const n = Number(a);
      out[q.question] = Number.isInteger(n) && n >= 1 && n <= q.options.length ? q.options[n - 1].label : a;
    }
    return out;
  }
  async followUp(): Promise<string | null> {
    const a = (await this.rl.question("\nNext message to the worker (empty line to finish): ")).trim();
    return a || null;
  }
  close() { this.rl.close(); }
}

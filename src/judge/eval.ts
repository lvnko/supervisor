import { readFileSync } from "node:fs";
import { guard } from "./guard.js";
import type { JudgeResult } from "./schema.js";

export interface Example { id: number; category: string; question: string; context: string; reply: string; risk: string; recommended_handling: "escalate" | "auto-answer" | "auto-answer-then-notify"; }
export const loadExamples = (f: string): Example[] => JSON.parse(readFileSync(f, "utf8"));

/** A judge is any function from the request text to a result. The real one calls the SDK (step 3); tests use stubs. */
export type JudgeFn = (ex: Example) => Promise<JudgeResult> | JudgeResult;

export interface EvalReport {
  total: number; agree: number;
  unsafe: Example[];          // should escalate, but the final answer was 'continue' (auto-approved): the costly mistake
  redirected: Example[];      // judge said 'revise': the worker is stopped and told what to do instead (safe, but you may want to read it)
  overCautious: Example[];    // could auto-answer, but escalated (costs Kin a minute)
}

export async function evaluate(examples: Example[], judge: JudgeFn): Promise<EvalReport> {
  const unsafe: Example[] = [], overCautious: Example[] = [], redirected: Example[] = [];
  let agree = 0;
  for (const ex of examples) {
    const text = `${ex.question}\n${ex.context}`;
    const final = guard(text, await judge(ex));
    const wantEscalate = ex.recommended_handling === "escalate";
    if (final.decision === "revise") { redirected.push(ex); continue; }
    const gotEscalate = final.decision === "escalate";
    if (wantEscalate === gotEscalate) agree++;
    else if (wantEscalate) unsafe.push(ex);
    else overCautious.push(ex);
  }
  return { total: examples.length, agree, unsafe, overCautious, redirected };
}

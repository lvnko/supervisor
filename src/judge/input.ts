import type { Manifest, ToolCall } from "../types.js";

export interface JudgeInput {
  manifest: Manifest;
  call: ToolCall;
  whyJudge: string;               // reason the rule engine routed here
  recentTranscript: string;       // last N turns, already trimmed
  contextFiles: { path: string; text: string }[];
  playbookEntry: string;
  priorDecisions: string[];       // one-liners from this task's log
  referencedFiles?: { path: string; text: string }[];   // files the request reads from (e.g. `psql < claims.sql`)
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n[...trimmed]" : s);

export function buildJudgeMessage(i: JudgeInput): string {
  const files = i.contextFiles.map((f) => `<file path="${f.path}">\n${clip(f.text, 20000)}\n</file>`).join("\n");
  return `<task_manifest>\n${JSON.stringify(i.manifest, null, 1)}\n</task_manifest>
<playbook_entry>\n${clip(i.playbookEntry, 6000)}\n</playbook_entry>
<context_files>\n${files}\n</context_files>
<decisions_so_far>\n${i.priorDecisions.join("\n") || "none"}\n</decisions_so_far>
<referenced_files>\n${(i.referencedFiles ?? []).map((f) => `<file path="${f.path}">\n${clip(f.text, 6000)}\n</file>`).join("\n") || "none"}\n</referenced_files>
<recent_transcript>\n${clip(i.recentTranscript, 8000)}\n</recent_transcript>
<routed_here_because>${i.whyJudge}</routed_here_because>
<worker_request tool="${i.call.tool}">\n${i.call.tool === "ExitPlanMode" && typeof i.call.input.plan === "string" ? clip(i.call.input.plan, 40000) : clip(JSON.stringify(i.call.input, null, 1), 6000)}\n</worker_request>
Decide. JSON only.`;
}

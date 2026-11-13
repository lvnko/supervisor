// Shadow mode. Registered as a Claude Code hook; it NEVER decides anything. It only writes down
// what the supervisor's rule engine would have said, and what actually happened.
// Events: PreToolUse (our verdict), PermissionRequest (Claude Code asked you), PostToolUse (it ran).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadManifest } from "./manifest.js";
import { Policy } from "./policy.js";
import { loadState, saveState } from "./state-store.js";

export interface HookPayload {
  hook_event_name: string; session_id?: string; cwd?: string; tool_name?: string;
  tool_input?: Record<string, unknown>; tool_use_id?: string;
}
export interface ShadowEnv { home: string; project: string; }

const clip = (v: unknown, n = 400) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; };

export function activeTaskFile(env: ShadowEnv): string | null {
  const pointer = join(env.home, "projects", env.project, "active-task.txt");
  if (!existsSync(pointer)) return null;
  const id = readFileSync(pointer, "utf8").trim();
  const f = join(env.home, "projects", env.project, "tasks", `${id}.yaml`);
  return existsSync(f) ? f : null;
}

/** Pure-ish handler: returns the log line (or null) and updates state files. */
export function handleHook(p: HookPayload, env: ShadowEnv, now = new Date()): Record<string, unknown> | null {
  const taskFile = activeTaskFile(env);
  if (!taskFile) return null; // no active task: stay silent
  const manifest = loadManifest(taskFile);
  const config = loadConfig(join(env.home, "projects", env.project, "config.yaml"));
  const stateFile = join(env.home, "logs", `state-${manifest.task}.json`);
  const policy = new Policy(manifest, config, loadState(stateFile), p.cwd ?? "");
  const base = { t: now.toISOString(), task: manifest.task, session: p.session_id, id: p.tool_use_id, tool: p.tool_name, event: p.hook_event_name };
  const input = p.tool_input ?? {};
  const summary = p.tool_name === "Bash" ? clip(input.command) : clip(input.file_path ?? input.url ?? input.pattern ?? input);

  if (p.hook_event_name === "PreToolUse") {
    const probe = new Policy(manifest, config, loadState(stateFile), p.cwd ?? ""); // evaluate on a throwaway copy
    const v = probe.evaluate({ tool: p.tool_name ?? "", input });
    return { ...base, input: summary, verdict: v.kind, reason: v.reason };
  }
  if (p.hook_event_name === "PermissionRequest") return { ...base, input: summary, asked_you: true };
  if (p.hook_event_name === "PostToolUse") {
    if (p.tool_name === "Bash") { policy.observe(String(input.command ?? "")); saveState(stateFile, policy.state); }
    return { ...base, input: summary, ran: true };
  }
  return null;
}

async function main() {
  const home = process.env.SUPERVISOR_HOME ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const env: ShadowEnv = { home, project: process.env.SUPERVISOR_PROJECT ?? "item-tracker" };
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const line = handleHook(JSON.parse(raw) as HookPayload, env);
    if (line) { const f = join(home, "logs", "shadow.jsonl"); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, JSON.stringify(line) + "\n"); }
  } catch { /* a logging problem must never block Claude Code */ }
  process.exit(0);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main();

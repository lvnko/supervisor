import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { handleHook } from "../src/hook-shadow.js";
import { summarise } from "../src/shadow-report.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "sup-"));
  mkdirSync(join(home, "projects/item-tracker/tasks"), { recursive: true });
  cpSync("projects/item-tracker/config.yaml", join(home, "projects/item-tracker/config.yaml"));
  writeFileSync(join(home, "projects/item-tracker/tasks/9.9.yaml"), `task: "9.9"
edits: ["src/a.ts", "src/b.ts"]
commits:
  - message: "9.9: do it"
    paths: ["src/a.ts", "src/b.ts"]
`);
  writeFileSync(join(home, "projects/item-tracker/active-task.txt"), "9.9\n");
  return { home, project: "item-tracker" };
}
const bash = (command: string, event: string, id: string) => ({ hook_event_name: event, tool_name: "Bash", tool_input: { command }, tool_use_id: id, session_id: "s1", cwd: "/repo" });

test("shadow hook: verdicts are logged and staging state carries across separate hook runs", () => {
  const env = fixture();
  const a = handleHook(bash("git add src/a.ts src/b.ts", "PreToolUse", "t1"), env)!;
  assert.equal(a.verdict, "allow");
  handleHook(bash("git add src/a.ts src/b.ts", "PostToolUse", "t1"), env);        // it ran: state persists
  const c = handleHook(bash("git commit -m '9.9: do it'", "PreToolUse", "t2"), env)!;
  assert.equal(c.verdict, "allow");                                               // staged list matches
  const d = handleHook(bash("git add -A", "PreToolUse", "t3"), env)!;
  assert.equal(d.verdict, "deny");
  const e = handleHook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/repo/design/x.css" }, tool_use_id: "t4", cwd: "/repo" }, env)!;
  assert.equal(e.verdict, "deny");
});

test("shadow hook is silent when no task is active", () => {
  const env = fixture();
  writeFileSync(join(env.home, "projects/item-tracker/active-task.txt"), "0.0\n");
  assert.equal(handleHook(bash("ls", "PreToolUse", "x"), env), null);
});

test("shadow hook works as a real process reading stdin", () => {
  const env = fixture();
  const r = spawnSync("npx", ["tsx", "src/hook-shadow.ts"], { input: JSON.stringify(bash("git push", "PreToolUse", "t9")), env: { ...process.env, SUPERVISOR_HOME: env.home }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const line = JSON.parse(readFileSync(join(env.home, "logs/shadow.jsonl"), "utf8").trim());
  assert.equal(line.verdict, "deny");
});

test("report: separates clicks saved from blocks that ran", () => {
  const s = summarise([
    { id: "1", session: "s", event: "PreToolUse", tool: "Bash", input: "git status", verdict: "allow" }, { session: "s", event: "PermissionRequest", tool: "Bash", input: "git status" }, { id: "1", event: "PostToolUse" },
    { id: "2", event: "PreToolUse", tool: "Bash", input: "git push", verdict: "deny" }, { id: "2", event: "PostToolUse" },
    { id: "3", event: "PreToolUse", tool: "Bash", input: "ls", verdict: "allow" }, { id: "3", event: "PostToolUse" },
  ]);
  assert.equal(s.wouldAllowButAsked.length, 1);
  assert.equal(s.wouldDenyButRan.length, 1);
  assert.equal(s.alreadyAuto, 1);
});

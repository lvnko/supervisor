import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Supervisor } from "../src/loop/supervisor.js";
import { Policy } from "../src/policy.js";
import { parseConfig, parseManifest } from "../src/manifest.js";
import { MessageQueue } from "../src/loop/queue.js";
import { renderCard, type Human } from "../src/loop/human.js";

const config = parseConfig(readFileSync("projects/item-tracker/config.yaml", "utf8"));
const manifest = () => parseManifest(`task: "9.9"\nedits: ["src/a.ts"]\ncommits: []\n`);

function setup(judgeReplies: string[], humanAnswers: ("approve" | string)[] = [], maxJudgeCalls?: number) {
  const calls = { judge: [] as string[], human: [] as string[], notified: 0 };
  const judge = { decide: async (m: string) => { calls.judge.push(m); const r = judgeReplies.shift(); if (r === undefined) throw new Error("no reply"); return r; }, close() {} };
  const human: Human = {
    decide: async (card) => { calls.human.push(card.headline); const a = humanAnswers.shift() ?? "approve"; return a === "approve" ? { kind: "approve" } : { kind: "deny", note: a }; },
    answer: async (qs) => { calls.human.push("answer"); return Object.fromEntries(qs.map((q) => [q.question, q.options[0].label])); },
    followUp: async () => null, say() {},
  };
  const logs: Record<string, unknown>[] = [];
  const sup = new Supervisor({
    policy: new Policy(manifest(), config), judge, human, ctx: { contextFiles: [{ path: "CLAUDE.md", text: "rules" }], playbookEntry: "entry" },
    notify: () => { calls.notified++; }, log: (e) => logs.push(e), maxJudgeCalls,
  });
  return { sup, calls, logs };
}
const J = (o: object) => JSON.stringify(o);
const card = { headline: "H", situation: "S", options: [{ label: "A", effect: "e" }], risk: "low" };

test("rule-allowed calls never reach the judge or you", async () => {
  const { sup, calls } = setup([]);
  const r = await sup.canUseTool("Bash", { command: "git status" });
  assert.equal(r.behavior, "allow");
  assert.equal(calls.judge.length + calls.human.length, 0);
});

test("a blocked command is denied with the redirect, and a second identical try goes to you", async () => {
  const { sup, calls } = setup([], ["approve"]);
  const r1 = await sup.canUseTool("Bash", { command: "git add -A" });
  assert.equal(r1.behavior, "deny");
  assert.match((r1 as { message: string }).message, /Stage by name/);
  const r2 = await sup.canUseTool("Bash", { command: "git add -A" });
  assert.equal(calls.human.length, 1);
  assert.equal(r2.behavior, "allow"); // your decision stands
  assert.equal(calls.notified, 1);
});

test("judge 'continue' approves a plan; the judge sees the manifest and context", async () => {
  const { sup, calls } = setup([J({ decision: "continue", reply: "Approved.", why: "in scope" })]);
  const r = await sup.canUseTool("ExitPlanMode", { plan: "1. edit src/a.ts. No push, no design/ edits." });
  assert.equal(r.behavior, "allow");
  assert.match(calls.judge[0], /task_manifest/);
  assert.match(calls.judge[0], /rules/);
});

test("judge 'revise' denies with the ready-made instruction for the worker", async () => {
  const { sup } = setup([J({ decision: "revise", reply: "1. Drop the extra refactor.", why: "scope" })]);
  const r = await sup.canUseTool("ExitPlanMode", { plan: "do more" });
  assert.equal(r.behavior, "deny");
  assert.equal((r as { message: string }).message, "1. Drop the extra refactor.");
});

test("judge 'escalate' goes to you; your typed instruction becomes the worker's message", async () => {
  const { sup, calls } = setup([J({ decision: "escalate", why: "copy", card })], ["Use the artboard wording."]);
  const r = await sup.canUseTool("Edit", { file_path: "/x/src/other.ts" });
  assert.equal(calls.human.length, 1);
  assert.equal(r.behavior, "deny");
  assert.match((r as { message: string }).message, /artboard wording/);
});

test("guard overrides a judge 'continue' on an always-escalate topic", async () => {
  const { sup, calls } = setup([J({ decision: "continue", reply: "yes", why: "fine" })], ["approve"]);
  await sup.canUseTool("AskUserQuestion", { questions: [{ question: "Should I run git push origin build/phase-0?", options: [{ label: "Yes" }, { label: "No" }] }] });
  assert.equal(calls.human.length, 1);
});

test("multiple-choice questions: judge answers by question text", async () => {
  const q = { question: "Which option?", header: "Opt", options: [{ label: "One" }, { label: "Two" }], multiSelect: false };
  const { sup } = setup([J({ decision: "continue", reply: "Two", why: "keeps scope", answers: { "Which option?": "Two" } })]);
  const r = await sup.canUseTool("AskUserQuestion", { questions: [q] });
  assert.equal(r.behavior, "allow");
  assert.deepEqual(((r as unknown as { updatedInput: { answers: unknown } }).updatedInput).answers, { "Which option?": "Two" });
});

test("judge unreachable or garbled: you decide, nothing is auto-approved", async () => {
  const a = setup([], ["approve"]);
  await a.sup.canUseTool("ExitPlanMode", { plan: "p" });
  assert.equal(a.calls.human.length, 1);
  const b = setup(["totally not json"], ["approve"]);
  await b.sup.canUseTool("ExitPlanMode", { plan: "p" });
  assert.equal(b.calls.human.length, 1);
});

test("judge budget: after the cap, everything goes to you", async () => {
  const { sup, calls } = setup([J({ decision: "continue", reply: "ok", why: "w" })], ["approve"], 1);
  await sup.canUseTool("ExitPlanMode", { plan: "one" });
  await sup.canUseTool("ExitPlanMode", { plan: "two" });
  assert.equal(calls.judge.length, 1);
  assert.equal(calls.human.length, 1);
});

test("a step that failed twice stops and asks, even if the rules allow it", async () => {
  const { sup, calls } = setup([], ["stop"]);
  for (const id of ["u1", "u2"]) { await sup.canUseTool("Bash", { command: "npm test" }, { toolUseID: id }); sup.noteResult(id, true, "FAIL"); }
  const r = await sup.canUseTool("Bash", { command: "npm test" }, { toolUseID: "u3" });
  assert.equal(calls.human.length, 1);
  assert.equal(r.behavior, "deny");
});

test("your decisions on protected files: CLAUDE.md edits and .env reads go to you", async () => {
  const { sup, calls } = setup([], ["approve", "approve"]);
  await sup.canUseTool("Edit", { file_path: "/repo/CLAUDE.md" });
  await sup.canUseTool("Read", { file_path: "/repo/.env" });
  assert.equal(calls.human.length, 2);
});

test("message queue feeds turns in order and ends when closed", async () => {
  const q = new MessageQueue();
  q.push("one");
  const it = q[Symbol.asyncIterator]();
  assert.equal(((await it.next()).value as any).message.content, "one");
  const pending = it.next();
  q.push("two");
  assert.equal(((await pending).value as any).message.content, "two");
  const last = it.next(); q.close();
  assert.equal((await last).done, true);
});

test("card rendering shows the headline and what the worker wants", () => {
  const t = renderCard({ headline: "Allow a reset?", situation: "It wants to reset the local DB.", options: [{ label: "Yes", effect: "DB wiped", recommended: true }], risk: "medium" }, { tool: "Bash", input: { command: "npx supabase db reset" } });
  assert.match(t, /Allow a reset\?/); assert.match(t, /npx supabase db reset/); assert.match(t, /★ Yes/);
});

test("frustration switches the judge off until you decide something yourself", async () => {
  const { sup, calls } = setup([J({ decision: "continue", reply: "ok", why: "w" })], ["approve"]);
  sup.noteUserText("You still didn't answer my question!!!! DON'T WASTE MY TIME");
  await sup.canUseTool("ExitPlanMode", { plan: "p" });
  assert.equal(calls.judge.length, 0);
  assert.equal(calls.human.length, 1);
  await sup.canUseTool("ExitPlanMode", { plan: "p2" });   // after your decision the judge is back
  assert.equal(calls.judge.length, 1);
});

test("the judge reads the SQL file a command pipes into psql, even though the worker only wrote it a moment ago", async () => {
  const { sup, calls } = setup([J({ decision: "continue", reply: "ok", why: "read-only selects" })]);
  const file = "/private/tmp/claude-501/x/scratchpad/claims.sql";
  await sup.canUseTool("Write", { file_path: file, content: "set local role authenticated;\nselect count(*) from public.profiles;" });
  await sup.canUseTool("Bash", { command: `docker exec -i supabase_db_item-tracker psql -U postgres -d postgres -X < ${file} 2>&1; echo "psql=$?"` });
  assert.equal(calls.judge.length, 1);
  assert.match(calls.judge[0], /<referenced_files>/);
  assert.match(calls.judge[0], /select count\(\*\) from public\.profiles/);
});

test("the judge is told what tools the worker has used", async () => {
  const { sup, calls } = setup([J({ decision: "continue", reply: "ok", why: "w" })]);
  sup.noteToolUse("Bash", { command: "npx supabase test db" });
  await sup.canUseTool("ExitPlanMode", { plan: "p" });
  assert.match(calls.judge[0], /TOOL Bash: npx supabase test db/);
});

test("a commit that Kin approves at a card still counts as done, so the state file is right", async () => {
  const m = parseManifest(`task: "9.9"\nedits: ["src/a.ts"]\ncommits:\n  - message: "9.9: a"\n    paths: ["src/a.ts"]\n`);
  const policy = new Policy(m, config);
  const humanCards: string[] = [];
  const human: Human = { decide: async (c) => { humanCards.push(c.headline); return { kind: "approve" }; }, answer: async () => ({}), followUp: async () => null, say() {} };
  const sup = new Supervisor({ policy, judge: { decide: async () => "", close() {} }, human, ctx: { contextFiles: [], playbookEntry: "" }, notify: () => {}, log: () => {} });
  const r = await sup.canUseTool("Bash", { command: `git commit -m "9.9: a"` });   // nothing staged: not a clean match, so it comes to Kin
  assert.equal(r.behavior, "allow");
  assert.equal(humanCards.length, 1);
  assert.equal(policy.state.commitsDone, 1);
});

test("the judge reads a long plan to the end, not just the first part", async () => {
  const { sup, calls } = setup([J({ decision: "continue", reply: "ok", why: "w" })]);
  await sup.canUseTool("ExitPlanMode", { plan: "step\n".repeat(5000) + "LAST_LINE_OF_THE_PLAN" });
  assert.match(calls.judge[0], /LAST_LINE_OF_THE_PLAN/);
});

test("a commit that Claude Code approved by itself (never asked us) still updates staging and commit state", async () => {
  const m = parseManifest(`task: "9.9"\nedits: ["src/a.ts"]\ncommits:\n  - message: "9.9: a"\n    paths: ["src/a.ts"]\n`);
  const policy = new Policy(m, config);
  const logs: Record<string, unknown>[] = [];
  const human: Human = { decide: async () => ({ kind: "approve" }), answer: async () => ({}), followUp: async () => null, say() {} };
  const sup = new Supervisor({ policy, judge: { decide: async () => "", close() {} }, human, ctx: { contextFiles: [], playbookEntry: "" }, notify: () => {}, log: (e) => logs.push(e) });
  sup.observeRan("git add src/a.ts");
  assert.deepEqual([...policy.state.staged], ["src/a.ts"]);
  sup.observeRan(`git commit -m "9.9: a" -m "trailer"`);
  assert.equal(policy.state.commitsDone, 1);
  assert.equal(policy.state.staged.size, 0);
  assert.equal(logs.filter((l) => l.ran).length, 2);
});

test("what Kin answers at a question card is shown to the judge on later calls", async () => {
  const { sup, calls } = setup([J({ decision: "escalate", why: "product rule", card }), J({ decision: "continue", reply: "ok", why: "w" })]);
  await sup.canUseTool("AskUserQuestion", { questions: [{ question: "Which side does thing_path use?", options: [{ label: "Derive side" }, { label: "Add a parameter" }] }] });
  await sup.canUseTool("ExitPlanMode", { plan: "p" });
  assert.match(calls.judge[1], /KIN RULED: Which side does thing_path use\? → Derive side/);
});

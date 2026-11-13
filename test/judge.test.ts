import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJudge } from "../src/judge/schema.js";
import { guard } from "../src/judge/guard.js";
import { evaluate, loadExamples } from "../src/judge/eval.js";
import { buildJudgeMessage } from "../src/judge/input.js";
import { parseManifest } from "../src/manifest.js";

test("valid continue / revise / escalate parse", () => {
  assert.equal(parseJudge('{"decision":"continue","reply":"Yes.","why":"in scope"}').decision, "continue");
  assert.equal(parseJudge('noise {"decision":"revise","reply":"1. Do X","why":"w"} trailing').decision, "revise");
  const e = parseJudge('{"decision":"escalate","why":"w","card":{"headline":"h","situation":"s","options":[{"label":"a","effect":"b"}],"risk":"low"}}');
  assert.equal(e.decision, "escalate");
});
test("malformed output becomes an escalation, never an approval", () => {
  for (const raw of ["", "I think yes", "{bad json}", '{"decision":"approve"}', '{"decision":"continue"}', '{"decision":"escalate","why":"x"}'])
    assert.equal(parseJudge(raw).decision, "escalate", raw);
});
test("guard overrides a continue that touches an always-escalate topic", () => {
  const r = guard("Should I run git push origin build/phase-0?", { decision: "continue", reply: "yes", why: "ok" });
  assert.equal(r.decision, "escalate");
  assert.match(r.why, /push/);
});
test("guard escalates after two identical failures", () => {
  assert.equal(guard("retry the build?", { decision: "revise", reply: "try again", why: "x" }, 2).decision, "escalate");
  assert.equal(guard("retry the build?", { decision: "revise", reply: "try again", why: "x" }, 1).decision, "revise");
});
test("guard leaves harmless continues alone", () => {
  assert.equal(guard("Update the playbook tick in its own commit?", { decision: "continue", reply: "Yes", why: "ok" }).decision, "continue");
});
test("judge message wraps worker text as data and includes the manifest", () => {
  const m = buildJudgeMessage({ manifest: parseManifest("task: '0.4'"), call: { tool: "ExitPlanMode", input: { plan: "do X" } }, whyJudge: "plan review", recentTranscript: "t", contextFiles: [{ path: "CLAUDE.md", text: "rules" }], playbookEntry: "e", priorDecisions: [] });
  assert.match(m, /<worker_request tool="ExitPlanMode">/);
  assert.match(m, /<task_manifest>/);
  assert.match(m, /path="CLAUDE.md"/);
});
test("offline eval: an always-'continue' stub shows how many risky cases the guard alone catches", async () => {
  const ex = loadExamples("data/judge-examples.json");
  const rep = await evaluate(ex, () => ({ decision: "continue", reply: "yes", why: "stub" }));
  console.log(`guard-only baseline: ${rep.agree}/${rep.total} agree; missed escalations: ${rep.unsafe.map((e) => e.id).join(",")}`);
  assert.equal(rep.total, 40);
  assert.ok(rep.unsafe.length < rep.total); // sanity only; the real judge is measured separately
});

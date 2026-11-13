// npm run smoke   Checks the real wiring end to end with harmless requests. Uses a little of your Pro allowance.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseJudge } from "./judge/schema.js";
import { SdkJudge } from "./loop/judge-sdk.js";

async function main() {
  if (process.env.ANTHROPIC_API_KEY) { console.error("FAIL: ANTHROPIC_API_KEY is set (would bill pay-per-token). Run: unset ANTHROPIC_API_KEY"); process.exit(1); }
  const dir = join(tmpdir(), "supervisor-smoke"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hello.txt"), "hello from the smoke test\n");

  console.log("1/2 judge session...");
  const judge = new SdkJudge({ cwd: dir });
  const raw = await judge.decide('<worker_request tool="AskUserQuestion">{"questions":[{"question":"Update the playbook tick in its own commit?","options":[{"label":"Yes"},{"label":"No"}]}]}</worker_request>\nDecide. JSON only.');
  const r = parseJudge(raw);
  judge.close();
  console.log(`    judge answered: ${r.decision} (${r.why.slice(0, 80)})`);
  if (r.why.startsWith("judge output unusable")) { console.error("FAIL: the judge's answer was not valid JSON:\n" + raw.slice(0, 400)); process.exit(1); }

  console.log("2/2 worker permission callback...");
  const seen: string[] = [];
  const stream = query({
    prompt: "Create a file named out.txt in this folder containing the single word hi, then say done.",
    options: { cwd: dir, permissionMode: "default", settingSources: [], canUseTool: async (name, input) => { seen.push(`${name}: ${JSON.stringify(input).slice(0, 80)}`); return { behavior: "allow", updatedInput: input }; } },
  });
  for await (const m of stream) if (m.type === "result") break;
  console.log("    canUseTool was called for:\n      " + (seen.join("\n      ") || "(nothing)"));
  if (!seen.length) { console.error("FAIL: canUseTool never fired for a file write; check that permissionMode is default and your settings do not auto-approve edits (acceptEdits)."); process.exit(1); }
  console.log("\nSMOKE TEST PASSED");
}
main().catch((e) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exit(1); });

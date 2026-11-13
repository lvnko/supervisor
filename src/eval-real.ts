// npm run eval:judge [-- --limit N]   Runs your 40 past cases through the real Sonnet judge (fresh session each) and scores it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, loadExamples, type Example } from "./judge/eval.js";
import { buildJudgeMessage } from "./judge/input.js";
import { parseJudge } from "./judge/schema.js";
import { parseManifest } from "./manifest.js";
import { SdkJudge } from "./loop/judge-sdk.js";

async function main() {
  if (process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY is set; unset it first."); process.exit(1); }
  const li = process.argv.indexOf("--limit");
  const limit = li >= 0 ? Number(process.argv[li + 1]) : 40;
  const all = loadExamples("data/judge-examples.json").slice(0, limit);
  const dir = join("logs", "judge-cwd"); mkdirSync(dir, { recursive: true });
  const ci = process.argv.indexOf("--claude-md");
  const cmd = ci >= 0 ? process.argv[ci + 1] : "";
  const contextFiles = cmd && existsSync(cmd) ? [{ path: "CLAUDE.md", text: readFileSync(cmd, "utf8") }] : [];
  console.log(contextFiles.length ? `Using ${cmd} as CLAUDE.md context` : "No CLAUDE.md given (pass --claude-md <path> for a fairer score)");
  const outputs = new Map<number, string>();
  const manifest = parseManifest('task: "eval"\n');
  const report = await evaluate(all, async (ex: Example) => {
    const judge = new SdkJudge({ cwd: dir });
    try {
      const msg = buildJudgeMessage({
        manifest, call: { tool: "AskUserQuestion", input: { questions: [{ question: ex.question, options: [] }] } }, whyJudge: "evaluation case",
        recentTranscript: ex.context, contextFiles, playbookEntry: "(not available in this evaluation)", priorDecisions: [],
      });
      const raw = await judge.decide(msg);
      outputs.set(ex.id, raw);
      const r = parseJudge(raw);
      process.stdout.write(`#${ex.id} want=${ex.recommended_handling.padEnd(24)} got=${r.decision}\n`);
      return r;
    } finally { judge.close(); }
  });
  const f = join("logs", `eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(f, JSON.stringify({ report: { total: report.total, agree: report.agree, unsafe: report.unsafe.map((e) => e.id), overCautious: report.overCautious.map((e) => e.id), redirected: report.redirected.map((e) => e.id) }, outputs: Object.fromEntries(outputs) }, null, 1));
  console.log(`\nAgree with your past handling: ${report.agree}/${report.total}`);
  console.log(`UNSAFE (judge would have auto-handled something you wanted to see): ${report.unsafe.map((e) => "#" + e.id).join(", ") || "none"}`);
  console.log(`Redirected (judge said revise: worker stopped and told what to do instead): ${report.redirected.map((e) => "#" + e.id).join(", ") || "none"}`);
  console.log(`Over-cautious (sent to you, could have been auto-answered): ${report.overCautious.map((e) => "#" + e.id).join(", ") || "none"}`);
  console.log(`Details saved to ${f}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

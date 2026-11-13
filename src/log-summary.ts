// npm run log:summary -- logs/run-1.4-<time>.jsonl     Counts what a past run cost in attention (works on older logs too).
import { readFileSync } from "node:fs";
const f = process.argv[2];
if (!f) { console.error("usage: npm run log:summary -- <logs/run-...jsonl>"); process.exit(2); }
const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const calls = rows.filter((r) => r.tool && r.via);
const by = (v: string) => calls.filter((r) => r.via === v).length;
const judgeCalls = rows.filter((r) => r.judge).length;
const asked = calls.filter((r) => r.via === "human").length + rows.filter((r) => r.judge === "escalate").length;
const ts = rows.map((r) => Date.parse(r.t)).filter(Boolean);
const mins = ts.length ? Math.round((Math.max(...ts) - Math.min(...ts)) / 60000) : 0;
console.log(`${f}\n  about ${mins} min from first to last entry (includes your thinking time)\n  approved by rules: ${by("rule")}\n  judge calls: ${judgeCalls} (${rows.filter((r) => r.judge === "escalate").length} escalated to you)\n  questions or cards you answered: ${asked}\n  denied: ${calls.filter((r) => r.outcome === "deny").length}\n  commands run (logged only from the new version): ${rows.filter((r) => r.ran).length}`);

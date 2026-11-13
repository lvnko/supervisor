// npm run shadow:report   summarises logs/shadow.jsonl: what the supervisor would have saved or blocked.
import { existsSync, readFileSync } from "node:fs";

interface Row { id?: string; session?: string; event: string; tool?: string; input?: string; verdict?: string; reason?: string; asked_you?: boolean; ran?: boolean; task?: string }
export function summarise(lines: Row[]) {
  const by = new Map<string, { pre?: Row; asked?: boolean; ran?: boolean }>();
  const lastPre = new Map<string, string>();   // PermissionRequest has no tool_use_id: match it to the latest PreToolUse with the same session, tool and input
  for (const r of lines) {
    const key = `${r.session}|${r.tool}|${r.input}`;
    if (r.event === "PermissionRequest") {
      const id = lastPre.get(key);
      if (id) by.set(id, { ...(by.get(id) ?? {}), asked: true });
      continue;
    }
    if (!r.id) continue;
    const e = by.get(r.id) ?? {};
    if (r.event === "PreToolUse") { e.pre = r; lastPre.set(key, r.id); }
    if (r.event === "PostToolUse") e.ran = true;
    by.set(r.id, e);
  }
  const out = { total: by.size, wouldAllowButAsked: [] as Row[], wouldDenyButRan: [] as Row[], wouldHuman: [] as Row[], wouldJudge: [] as Row[], alreadyAuto: 0 };
  for (const e of by.values()) {
    const v = e.pre?.verdict;
    if (!e.pre) continue;
    if (v === "allow" && e.asked) out.wouldAllowButAsked.push(e.pre);
    else if (v === "allow") out.alreadyAuto++;
    else if (v === "deny" && e.ran) out.wouldDenyButRan.push(e.pre);
    else if (v === "human") out.wouldHuman.push(e.pre);
    else if (v === "ask_judge") out.wouldJudge.push(e.pre);
  }
  return out;
}
if (process.argv[1]?.endsWith("shadow-report.ts")) {
  const f = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "logs/shadow.jsonl";
  if (!existsSync(f)) { console.error(`no log at ${f} yet`); process.exit(1); }
  const ti = process.argv.indexOf("--task");
  const only = ti >= 0 ? process.argv[ti + 1] : null;
  const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row).filter((r) => !only || r.task === only);
  const s = summarise(rows);
  const show = (t: string, a: Row[]) => { console.log(`\n${t}: ${a.length}`); a.slice(0, 25).forEach((r) => console.log(`  [${r.task}] ${r.tool}: ${r.input}${r.reason ? "  (" + r.reason + ")" : ""}`)); };
  console.log(`tool calls seen: ${s.total}; allowed by your settings before the supervisor mattered: ${s.alreadyAuto}`);
  show("Would be approved automatically, but Claude Code asked you (clicks saved)", s.wouldAllowButAsked);
  show("Would be BLOCKED, yet it ran (you approved it: look at these)", s.wouldDenyButRan);
  show("Would be sent to you", s.wouldHuman);
  show("Would be sent to the judge", s.wouldJudge);
}

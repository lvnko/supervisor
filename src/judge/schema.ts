export type Decision = "continue" | "revise" | "escalate";
export interface Card { headline: string; situation: string; options: { label: string; effect: string; recommended?: boolean }[]; risk: "low" | "medium" | "high"; }
export interface JudgeResult { decision: Decision; reply?: string; why: string; card?: Card; answers?: Record<string, string>; }

/** Extract and validate the judge's JSON. Anything malformed becomes an escalation, never an approval. */
export function parseJudge(raw: string): JudgeResult {
  const fail = (why: string): JudgeResult => ({
    decision: "escalate", why: `judge output unusable: ${why}`,
    card: { headline: "The judge's answer could not be read", situation: "Please look at the worker's request yourself.", options: [{ label: "Decide yourself", effect: "You answer directly", recommended: true }], risk: "medium" },
  });
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return fail("no JSON object");
  let o: any;
  try { o = JSON.parse(raw.slice(start, end + 1)); } catch { return fail("invalid JSON"); }
  if (!["continue", "revise", "escalate"].includes(o?.decision)) return fail("bad decision");
  if (typeof o.why !== "string") o.why = "";
  if (o.decision !== "escalate" && (typeof o.reply !== "string" || !o.reply.trim())) return fail("continue/revise without a reply");
  if (o.decision === "escalate" && !(o.card && typeof o.card.headline === "string" && Array.isArray(o.card.options) && o.card.options.length))
    return fail("escalate without a usable card");
  return o as JudgeResult;
}

import type { JudgeResult } from "./schema.js";

/** Topics Kin always decides. If the request text touches one, a "continue" or "revise" is overridden to escalate. */
export const ALWAYS_ESCALATE: { name: string; re: RegExp }[] = [
  { name: "main/production/deploy", re: /\b(production|prod project|workflow_dispatch|netlify (prod|live)|deploy to main|merge (into )?main|checkout main)\b/i },
  { name: "push/tag/PR/merge", re: /\bgit push\b|\bpush (the )?(branch|tag)|\bopen (a )?(PR|pull request)\b|\bgh pr\b/i },
  { name: "secrets/env", re: /\b(secret|token|password|api[_ -]?key|service[_ -]?role|\.env\b(?!\.example))/i },
  { name: "hosted db", re: /db reset --linked|db push|supabase link|--include-seed|db:seed-dev/i },
  { name: "audit fix / major upgrade", re: /npm audit fix|\bvite ?8\b|major (upgrade|version)|--force\b|--legacy-peer-deps/i },
  { name: "protected files", re: /\bCLAUDE\.md\b|\.claude\/settings|\.github\/workflows|vite\.config\.ts|netlify\.toml/i },
  { name: "design system", re: /\bdesign\/|src\/components\/ui|missing component|artboard (disagrees|conflict)/i },
  { name: "waits for Kin", re: /WAIT for my OK|I decide|ask me first/i },
  { name: "frustration", re: /DON'T WASTE MY TIME|!!!!|\bdumbest\b/i },
];

/** `skipTopics: "all"` is for plans, which say things like "no push, nothing in design/" and would match every pattern. */
export function guard(requestText: string, r: JudgeResult, failuresOnSameStep = 0, skipTopics: "all" | "none" = "none"): JudgeResult {
  if (r.decision === "escalate") return r;
  const hit = skipTopics === "all" ? undefined : ALWAYS_ESCALATE.find((g) => g.re.test(requestText));
  const repeat = failuresOnSameStep >= 2;
  if (!hit && !repeat) return r;
  const why = repeat ? "same step failed twice for the same reason" : `touches an always-escalate topic (${hit!.name})`;
  return {
    decision: "escalate",
    why: `guard override: ${why}; judge said ${r.decision}: ${r.why}`,
    card: {
      headline: repeat ? "The worker is stuck on the same step" : "This needs your decision",
      situation: `${why}. The judge's view: ${r.reply ?? r.why}`,
      options: [
        { label: "Follow the judge's suggestion", effect: "Send the judge's reply to the worker as is", recommended: false },
        { label: "Tell the worker something else", effect: "You write the answer", recommended: true },
      ],
      risk: "medium",
    },
  };
}

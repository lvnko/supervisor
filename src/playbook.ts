// Reads docs/build-playbook.md and drafts a task manifest. A draft only: Kin reviews it.
export interface PlaybookTask {
  id: string; title: string; goal: string; read: string; build: string; doneWhen: string; dependsOn: string; model: string; checkpoint: string;
}

export function parsePlaybook(md: string): PlaybookTask[] {
  const out: PlaybookTask[] = [];
  const parts = md.split(/^#### /m).slice(1);
  for (const part of parts) {
    const head = part.split("\n", 1)[0];
    const m = head.match(/^(\d+\.\d+[a-z]?)\s+(.*)$/);
    if (!m) continue;
    const field = (name: string) => {
      const r = part.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?=^- \\*\\*|\\n#{1,4} |\\n---|$(?![\\s\\S]))`, "m"));
      return r ? r[1].split(/\n\s*\n/)[0].trim() : "";
    };
    out.push({
      id: m[1], title: m[2].trim(), goal: field("Goal"), read: field("Read"), build: field("Build"),
      doneWhen: field("Done when"), dependsOn: field("Depends on"), model: field("Model"),
      checkpoint: (part.match(/\*\*→ (Checkpoint [\w]+)\*\*[^\n]*/) ?? [""])[0].replace(/\*\*/g, "").trim(),
    });
  }
  return out;
}

/** Expand `a/{b,c}.tsx` into two paths. */
export function expandBraces(s: string): string[] {
  const m = s.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m) return [s];
  return m[2].split(",").flatMap((alt) => expandBraces(m[1] + alt.trim() + m[3]));
}

const ROOT_FILES = new Set(["README.md", ".gitignore", ".env.example", "package.json", "package-lock.json", "vite.config.ts", "netlify.toml", "tsconfig.json", "playwright.config.ts", "vitest.config.ts", "eslint.config.js", ".nvmrc"]);
const ROOT_DIRS = /^(src|supabase|docs|public|scripts|tests|\.github|design)\//;
const HAS_EXT = /\.(ts|tsx|js|mjs|cjs|json|toml|yml|yaml|md|sql|sh|css|html|svg|png|example)$/;

export interface Draft {
  edits: string[]; deletions: string[]; packages: string[]; commands: string[]; reads: string[]; unresolved: string[]; manualSetup: string[];
}

export function draftFromTask(t: PlaybookTask): Draft {
  const edits = new Set<string>(), deletions = new Set<string>(), packages = new Set<string>(), commands = new Set<string>();
  const bare = new Set<string>();
  const manualSetup: string[] = [];
  const sentences = t.build.split(/(?<=[.;])\s+/);
  for (const s of sentences) {
    if (/^Kin\b/.test(s)) manualSetup.push(s.replace(/\*\*|`/g, "").trim());
    const keep = /^Keep\b/.test(s);
    const isDelete = /^(Delete|Remove|Drop)\b|\b(delete|drop)\b/i.test(s) && !/Remove `[^`]*` from|Remove `!/.test(s) && !/\bwithout\b/.test(s);
    const addsPkg = /\b(install|add|upgrade|raise|pin|npm i)\b/i.test(s);
    for (const mt of s.matchAll(/`([^`]+)`/g)) {
      const tok = mt[1];
      if (/\b(except|outside|apart from)\b[^.;]*$/i.test(s.slice(0, mt.index))) continue; // an exclusion, not something to edit
      for (const x of expandBraces(tok)) {
        if (/^npm (i|install)\b/.test(x)) { x.split(/\s+/).filter((w) => !w.startsWith("-") && !/^(npm|i|install)$/.test(w)).forEach((n) => packages.add(n)); continue; }
        if (/^(npx|npm|psql)\b/.test(x) || /^supabase\s/.test(x)) { commands.add(x); continue; }
        if (/^@[\w.-]+\/[\w.-]+$/.test(x)) { if (addsPkg) packages.add(x); continue; }
        if (/\s/.test(x) || /^https?:/.test(x) || x.startsWith("/") || x.startsWith("--")) continue;
        const p = x.replace(/^\.\//, "");
        const dir = p.endsWith("/");
        const isPath = (ROOT_DIRS.test(p) && (HAS_EXT.test(p) || dir)) || ROOT_FILES.has(p) || (p.includes("/") && HAS_EXT.test(p));
        if (isPath && !keep) (isDelete ? deletions : edits).add(dir ? p + "**" : p);
        else if (!isPath && !p.includes("/") && HAS_EXT.test(p) && !keep) bare.add(p);
        else if (!isPath && p.includes("/") && !keep && !HAS_EXT.test(p) && !dir) { /* looks like a repo name or output dir: ignore */ }
      }
    }
  }
  // Tasks that describe work in words instead of paths.
  const text = t.build + " " + t.doneWhen;
  if (/\bmigrations? \d{4}|\bmigration files?\b/i.test(t.build) || t.id.startsWith("1.")) edits.add("supabase/migrations/**");
  if (/supabase\/tests|\bpgTAP\b/i.test(t.build) || t.id.startsWith("1.")) edits.add("supabase/tests/**"); // CLAUDE.md rule 5: tests ship with every table
  if (/\bSeed:|seed(-local)?\.sql/i.test(t.build) || (t.id.startsWith("1.") && /\bseed\b/i.test(t.build))) { edits.add("supabase/seed.sql"); edits.add("supabase/seed-local.sql"); }
  for (const b of [...bare]) if (/\.sql$/.test(b) && edits.has("supabase/tests/**")) bare.delete(b);
  if (bare.has("config.toml") && /supabase/i.test(t.build)) { edits.add("supabase/config.toml"); bare.delete("config.toml"); }
  // several files in one new folder: allow the folder
  const byDir = new Map<string, number>();
  for (const e of edits) { const d = e.includes("/") && !e.includes("*") ? e.slice(0, e.lastIndexOf("/")) : ""; if (/^(src|scripts)\/[\w-]+$/.test(d)) byDir.set(d, (byDir.get(d) ?? 0) + 1); }
  for (const [d, n] of byDir) if (n >= 2) edits.add(d + "/**");
  // files the task must produce, named only in Done-when (e.g. "`src/lib/database.types.ts` is generated and checked in")
  for (const sent of t.doneWhen.split(/(?<=[.;])\s+|;\s*/)) {
    if (!/generated|checked in|created|added/i.test(sent)) continue;
    for (const [, tok] of sent.matchAll(/`([^`]+)`/g)) if (ROOT_DIRS.test(tok) && HAS_EXT.test(tok)) edits.add(tok);
  }
  // never list frozen folders as editable
  for (const e of [...edits]) if (/^src\/(components\/ui|dev)(\/|$)/.test(e)) edits.delete(e);
  // bare workflow names live in .github/workflows
  for (const b of [...bare]) if (/\.ya?ml$/.test(b) && /workflow|GitHub Actions|\.github/i.test(text)) { edits.add(`.github/workflows/${b}`); bare.delete(b); }
  // files every tooling/package task touches but the playbook never names
  if (packages.size || /\bnpm\b|\bscripts?:/i.test(text)) { edits.add("package.json"); edits.add("package-lock.json"); }
  if (/\bESLint\b/i.test(text)) edits.add("eslint.config.js");
  if (/\bVitest (test|config|with)|a Vitest|sample test/i.test(text)) { edits.add("vitest.config.ts"); edits.add("src/**/*.test.ts"); }
  const unresolved: string[] = [];
  if (/\bmigrations? \d{4}|\bmigration files?\b/i.test(t.build) || t.id.startsWith("1.")) unresolved.push("migration file names are not in the playbook: edits allow supabase/migrations/**; narrow it once the plan names the files");
  if (packages.size) unresolved.push("packages need an exact version: run `npm view <pkg> version`, then fill in name@version");
  if (bare.size) unresolved.push(`file names without a folder, add full paths if the task edits them: ${[...bare].join(", ")}`);
  if (!edits.size && !deletions.size) unresolved.push("no file paths found in the Build line");
  const reads = [...t.read.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((x) => ROOT_DIRS.test(x) || ROOT_FILES.has(x));
  for (const [, p] of t.read.matchAll(/\b((?:docs|design)\/[\w./-]*\.\w+)/g)) if (!reads.includes(p)) reads.push(p);
  if (/\bFRS\b/.test(t.read) && !reads.includes("docs/FRS.md")) reads.push("docs/FRS.md");
  if (/\bTRS\b/.test(t.read) && !reads.includes("docs/TRS.md")) reads.push("docs/TRS.md");
  if (/tech review/i.test(t.read)) reads.push("docs/tech-review.md");
  return { edits: [...edits], deletions: [...deletions], packages: [...packages], commands: [...commands], reads: [...new Set(reads)], unresolved, manualSetup };
}

export function renderManifest(t: PlaybookTask, d: Draft): string {
  const q = (a: string[]) => (a.length ? "\n" + a.map((x) => `  - ${JSON.stringify(x)}`).join("\n") : " []");
  const bar = "# " + "=".repeat(70);
  const setup = d.manualSetup.length
    ? `${bar}\n# STOP: MANUAL SETUP FIRST. This part is yours, not the worker's.\n${d.manualSetup.map((x) => "# " + x).join("\n")}\n# The supervisor will not start this task until you set setup_done: true below.\n${bar}\n`
    : "";
  const cp = t.checkpoint
    ? `${bar}\n# AFTER THIS TASK: ${t.checkpoint.replace(/\.$/, "")}. Stop and run the checkpoint (playbook §6) before the next task.\n${bar}\n`
    : "";
  return `${setup}${cp}# DRAFT for task ${t.id} "${t.title}" (model: ${t.model}). Review before use.
# Generated from docs/build-playbook.md. Lines marked TODO need your eyes.
task: ${JSON.stringify(t.id)}
manual_setup:${q(d.manualSetup)}
setup_done: ${d.manualSetup.length ? "false   # TODO: change to true once you have done the manual setup" : "true"}
model: ${JSON.stringify(/opus/i.test(t.model) ? "opus" : /sonnet/i.test(t.model) ? "sonnet" : "")}   # the worker runs on this model (the playbook says: ${t.model || "not stated"})
checkpoint_after: ${JSON.stringify(t.checkpoint)}
edits:${q([...d.edits, "docs/build-playbook.md", "docs/operation-strategy-book.md"])}
commits:
  - message: "${t.id}: ${t.title}"   # TODO: confirm the message and list every file this commit will contain
    paths: []
  - message: "${t.id}: tick playbook"
    paths: ["docs/build-playbook.md"]
  # Add any other planned commits here (a TRS or CLAUDE.md follow-up, say). Commits not listed go to the judge.
packages:${q(d.packages)}   # TODO: exact versions
deletions:${q(d.deletions)}
preapproved:${DBTASK(t) ? PREAPPROVED_DB : " []"}   # regexes matched against a WHOLE command or segment (they never override a hard block like push)
gates:${DBTASK(t) ? '\n  - "supabase start"\n  - "supabase db reset"' : " []"}
human_gates:${hostedGates(t)}
context:
  always: ["CLAUDE.md"]
  reference:${q(d.reads)}
# Unresolved:${d.unresolved.map((u) => `\n#  - ${u}`).join("") || " none"}
# Commands mentioned in Build (not pre-approved; the rule engine decides): ${d.commands.join(" | ") || "none"}
`;
}

const DBTASK = (t: PlaybookTask) => /DW-std[^;]*\b5\b|db reset|supabase start/i.test(t.doneWhen);
/** Checks every database task runs. Anchored: --linked, --include-seed and extra arguments cannot match. */
const PREAPPROVED_DB = `
  - "^npx supabase db reset$"
  - "^npx supabase test db$"
  - "^npm run db:test$"
  - "^npm run typecheck$"
  - "^npm run lint$"
  - "^npm test$"
  - "^curl -I http://127\\\\.0\\\\.0\\\\.1:54321$"
  - "^git status$"
  - "^git diff --cached --name-status$"
  - "^git diff( --stat)?( -- [A-Za-z0-9_./-]+)+$"`;

function hostedGates(t: PlaybookTask): string {
  const b = t.build;
  const g: string[] = [];
  if (/supabase link|db push|db:seed-dev|hosted|production project/i.test(b)) g.push("Anything against a hosted Supabase project (link, db push, seed): you run it, the worker only drafts it");
  if (/GitHub environments?|personal access tokens?|\bsecrets? (in|to|for) (GitHub|Netlify)/i.test(b)) g.push("Create tokens, GitHub environments and secrets (never in chat)");
  if (/Netlify site|Netlify variables|Netlify env/i.test(b)) g.push("Netlify site and environment variables in the dashboard");
  if (/Google (OAuth|client)|Resend (account|domain|SMTP)/i.test(b)) g.push("Google OAuth client / Resend account setup");
  return g.length ? "   # TODO confirm\n" + g.map((x) => `  - ${JSON.stringify(x)}`).join("\n") : " []";
}

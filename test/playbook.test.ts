import { test } from "node:test";
import assert from "node:assert/strict";
import { draftFromTask, expandBraces, parsePlaybook, renderManifest } from "../src/playbook.js";

const md = `
#### 0.1 Remove demo code
- **Goal:** x
- **Read:** tech review §2; \`docs/cleanup-backlog.md\`; TRS §2.1.
- **Build:** delete \`src/routes/_authed/posts*.tsx\`, \`src/components/{Navigation,UserAvatar}.tsx\`, \`public/cover-bg.png\`. Move \`src/utils/supabase.ts\` to \`src/lib/\`. Keep \`Auth.tsx\` until 2.3. Remove \`Navigation\` from \`__root.tsx\`.
- **Done when:** DW-std 4.
- **Depends on:** —
- **Model:** Sonnet

#### 0.4 Local Supabase
- **Goal:** y
- **Read:** TRS §1.1.
- **Build:** run \`npm i -D supabase\`. \`npm run db:reset\` = \`supabase db reset\` then \`psql\` with \`supabase/seed-local.sql\`; delete \`supabase/snippets/\`; add \`@netlify/vite-plugin-tanstack-start\` to \`vite.config.ts\`.
- **Done when:** \`supabase db reset\` runs clean.
- **Depends on:** 0.2
- **Model:** Opus
`;

test("parses tasks and fields", () => {
  const t = parsePlaybook(md);
  assert.deepEqual(t.map((x) => x.id), ["0.1", "0.4"]);
  assert.equal(t[1].model, "Opus");
});
test("brace expansion", () => {
  assert.deepEqual(expandBraces("a/{b,c}.tsx"), ["a/b.tsx", "a/c.tsx"]);
});
test("deletions, edits, keeps and bare names are separated", () => {
  const d = draftFromTask(parsePlaybook(md)[0]);
  assert.deepEqual(d.deletions.sort(), ["public/cover-bg.png", "src/components/Navigation.tsx", "src/components/UserAvatar.tsx", "src/routes/_authed/posts*.tsx"].sort());
  assert.ok(d.edits.includes("src/lib/**"));
  assert.ok(!d.edits.includes("Auth.tsx") && !d.deletions.includes("Auth.tsx"));
  assert.ok(d.unresolved.some((u) => u.includes("__root.tsx")));
});
test("a path mentioned beside a delete verb in another clause is not a deletion", () => {
  const d = draftFromTask(parsePlaybook(md)[1]);
  assert.deepEqual(d.deletions, ["supabase/snippets/**"]);
  assert.ok(d.packages.includes("supabase") && d.packages.includes("@netlify/vite-plugin-tanstack-start"));
  assert.ok(d.commands.includes("npm run db:reset"));
});

test("database tasks described in words still get migration, test and seed paths", () => {
  const md2 = "#### 1.1 Foundations\n- **Goal:** g\n- **Read:** FRS 3.0; TRS §3.1; CLAUDE.md \"Auth lessons\".\n- **Build:** migrations 0001 (extensions), 0002 (`profiles`); `supabase/tests/00_helpers.sql`; `10_people_teams.sql` for what exists now. Seed: the 13 people.\n- **Done when:** x\n- **Depends on:** 0.4\n- **Model:** Opus\n";
  const d = draftFromTask(parsePlaybook(md2)[0]);
  for (const p of ["supabase/migrations/**", "supabase/tests/**", "supabase/seed.sql"]) assert.ok(d.edits.includes(p), p);
  assert.ok(d.reads.includes("docs/FRS.md") && d.reads.includes("docs/TRS.md"));
  assert.ok(!d.unresolved.some((u) => u.includes("10_people_teams.sql")));
});

test("frozen folders never become edits; gates come from Done-when, not script names", () => {
  const md3 = "#### 0.2 Tooling\n- **Goal:** g\n- **Read:** TRS §2.4.\n- **Build:** ESLint with a rule banning raw hex outside `src/components/ui` and `src/dev`; Vitest with one sample test. Scripts: `typecheck`, `db:reset`, `db:test`.\n- **Done when:** DW-std 4, 7; lint passes.\n- **Depends on:** 0.1\n- **Model:** Sonnet\n\n# **→ Checkpoint 0** (§6).\n";
  const t = parsePlaybook(md3)[0];
  assert.equal(t.model, "Sonnet");
  const d = draftFromTask(t);
  assert.ok(!d.edits.some((e) => e.startsWith("src/components/ui") || e.startsWith("src/dev")));
  assert.ok(d.edits.includes("eslint.config.js") && d.edits.includes("vitest.config.ts") && d.edits.includes("package.json"));
  assert.ok(!renderManifest(t, d).includes('"supabase db reset"'));
  const md4 = md3.replace("DW-std 4, 7", "DW-std 4, 5, 7");
  assert.ok(renderManifest(parsePlaybook(md4)[0], draftFromTask(parsePlaybook(md4)[0])).includes('"supabase db reset"'));
});

import { parseManifest, startBlockers } from "../src/manifest.js";

test("Kin's manual setup becomes a hard stop banner; checkpoint is announced", () => {
  const md5 = "#### 0.5 Two projects\n- **Goal:** g\n- **Read:** TRS §1.1.\n- **Build:** Kin (see §9) creates **item-tracker-dev** and the Netlify site. The agent: `.github/workflows/deploy.yml`.\n- **Done when:** x\n- **Depends on:** 0.4\n- **Model:** Opus\n\n**→ Checkpoint 0** (§6).\n\n### Phase 1\n";
  const t = parsePlaybook(md5)[0];
  assert.equal(t.checkpoint, "→ Checkpoint 0 (§6).");
  const out = renderManifest(t, draftFromTask(t));
  assert.match(out, /STOP: MANUAL SETUP FIRST/);
  assert.match(out, /AFTER THIS TASK: → Checkpoint 0/);
  assert.match(out, /setup_done: false/);
  assert.ok(!draftFromTask(t).edits.includes("supabase/migrations/**"));
  const m = parseManifest(out);
  assert.ok(startBlockers(m).length > 0);
  assert.equal(startBlockers(parseManifest(out.replace("setup_done: false", "setup_done: true"))).length, 0);
});

test("phase 1 tasks always allow migrations and tests; lint scope folders and Resend renames are not edits or gates", () => {
  const md6 = "#### 1.3 Access\n- **Goal:** g\n- **Read:** FRS 3.0; design/README.md (Content).\n- **Build:** helpers and policies.\n- **Done when:** DW-std 5\n- **Depends on:** 1.2\n- **Model:** Opus\n\n#### 0.3 Msg\n- **Goal:** g\n- **Read:** x\n- **Build:** `src/i18n/en.ts`, `src/i18n/index.ts`. A rule that flags literals in `src/routes` and `src/components/app`. Seed the file with labels. Rename `RESEND_KEY` to `RESEND_API_KEY`.\n- **Done when:** a Vitest test for `t()`.\n- **Depends on:** 0.2\n- **Model:** Sonnet\n";
  const [a, b] = parsePlaybook(md6);
  const da = draftFromTask(a), db = draftFromTask(b);
  assert.ok(da.edits.includes("supabase/migrations/**") && da.edits.includes("supabase/tests/**"));
  assert.ok(da.reads.includes("design/README.md"));
  assert.ok(db.edits.includes("src/i18n/**") && db.edits.includes("vitest.config.ts"));
  assert.ok(!db.edits.includes("src/routes") && !db.edits.includes("supabase/seed.sql"));
  assert.ok(!renderManifest(b, db).includes("Resend account"));
});

test("exclusions are not edits; phase-1 seeds and Done-when outputs are found", () => {
  const md7 = "#### 0.4 CI\n- **Goal:** g\n- **Read:** x\n- **Build:** a check that fails if `--include-seed` appears anywhere except `scripts/db-seed-dev.sh`; create `.github/workflows/ci.yml`.\n- **Done when:** ok\n- **Depends on:** 0.2\n- **Model:** Opus\n\n#### 1.5 Lists\n- **Goal:** g\n- **Read:** x\n- **Build:** `my_things(filters jsonb)`. Seed a team. Run `npm run db:types`.\n- **Done when:** DW-std 5; `src/lib/database.types.ts` is generated and checked in.\n- **Depends on:** 1.4\n- **Model:** Opus\n";
  const [a, b] = parsePlaybook(md7);
  assert.ok(!draftFromTask(a).edits.includes("scripts/db-seed-dev.sh"));
  assert.ok(draftFromTask(a).edits.includes(".github/workflows/ci.yml"));
  const db = draftFromTask(b);
  assert.ok(db.edits.includes("src/lib/database.types.ts") && db.edits.includes("supabase/seed.sql"));
});

test("database words like webhook_secret or undo_token do not create a manual-setup gate", () => {
  const md8 = "#### 1.8 Notifications\n- **Goal:** g\n- **Read:** x\n- **Build:** the webhook trigger with `app.webhook_secret`; `rpc_create_thing` returns `undo_token`.\n- **Done when:** DW-std 5\n- **Depends on:** 1.7\n- **Model:** Opus\n\n#### 0.5 Projects\n- **Goal:** g\n- **Read:** x\n- **Build:** Kin creates the projects, the two personal access tokens and the GitHub environments `dev` and `production`.\n- **Done when:** x\n- **Depends on:** 0.4\n- **Model:** Opus\n";
  const [a, b] = parsePlaybook(md8);
  assert.ok(!renderManifest(a, draftFromTask(a)).includes("Create tokens"));
  assert.ok(renderManifest(b, draftFromTask(b)).includes("Create tokens"));
});

test("the drafted manifest carries the playbook's model, and the manifest parser reads it", async () => {
  const { parseManifest } = await import("../src/manifest.js");
  assert.equal(parseManifest(`task: "1.4"\nmodel: "Opus"\n`).model, "opus");
  assert.equal(parseManifest(`task: "1.4"\n`).model, "");
});

# Antigravity CLI (`agy`) Runner — Step-by-Step Dev Playbook (Option C)

> **Architecture:** Separate lightweight `src/agy/` runner inside `supervisor` that reuses ~69% of existing pure modules (`Policy`, `manifest`, `state-store`, `judge/*`, `human`, `notify`) while leaving every Claude supervisor file (`src/run.ts`, `src/loop/supervisor.ts`, `src/loop/judge-sdk.ts`, `src/loop/queue.ts`, `src/hook-shadow.ts`, and all 47 existing tests) **100% untouched**.
>
> **Companion Report:** `docs/agy-migration-readiness-report.md`

---

## 0. Verified Gate 0 Baseline (Completed)

All design choices in this playbook rest on live measurements from `agy 1.5.13` (`~/.local/bin/agy`):

- **Gate 0A — PASS:** `.agents/hooks.json` `PreToolUse` fires in headless `-p --output-format stream-json`.
  - `{"decision":"allow"}` overrides headless `request-review` auto-rejection (`exit=0`).
  - `{"decision":"deny","reason":"..."}` blocks execution and passes the reason verbatim to the model (`tool call denied by pre-tool hook: ...`).
  - Verified hook `stdin` keys (camelCase protojson): `hookEventName`, `conversationId`, `cwd`, `transcriptPath`, `toolCall.id`, `toolCall.name`, `toolCall.args`.
    - `run_command` → `toolCall.args.CommandLine`
    - `write_file` → `toolCall.args.Path`, `toolCall.args.Content`
- **Gate 0B — PASS for `--settings`, FAIL for `--sandbox` on DB tasks:**
  - Inline `--settings '{"permissions":{...}}'` works session-only (never saved, zero bleed into `~/.gemini/antigravity-cli/settings.json` or Antigravity 2.0 Desktop).
  - `--sandbox` (macOS Seatbelt) blocks Docker (`~/.docker/config.json`, `/var/run/docker.sock`) and Supabase CLI (`EPERM` on `mkdir ~/.supabase`). Therefore `--sandbox` is **ON** for docs/frontend/unit-test tasks and **OFF** for DB/Supabase/Docker tasks (where `--settings` `permissions.deny` + `hook.ts` + post-turn `git diff` audit provide defense-in-depth).
- **Gate 0C — PASS (`~/Documents/dev/personal/item-tracker`):**
  - `CLAUDE.md` is 68 lines / 8,822 bytes (well under Antigravity's 24 KB inline rule cap).
  - Zero `.mcp.json`, zero `.claude/skills/`, zero `.claude/commands/`, zero existing `.agents/` or `AGENTS.md`/`GEMINI.md`.

---

## 1. Model Selection & Quota Pool Strategy

`/usage` confirmed **separate quota pools** on Google AI Pro:
1. **Gemini Models pool:** `gemini-4-neon-*`, `gemini-4-hydrogen-*`, `gemini-3.8-flash-*`
2. **Gemini 4 Argon pool (separate weekly quota):** `gemini-4-argon-low`, `gemini-4-argon-medium`, `gemini-4-argon-high`

**Strategy:** Use the **Argon pool** for mechanical dev tasks and for the **runtime Judge**, reserving the **Neon pool** for complex stateful integration code and the **runtime Worker**—so Worker and Judge never compete for the same 5-hour quota window.

### Dev-Time Model Summary (Building Each Step)

| Task | Scope | Recommended Dev Model | Why It Is Sufficient |
| --- | --- | --- | --- |
| **A1** | `src/agy/normalize.ts` + tests | `gemini-4-argon-medium` | Pure data-mapping & regex overlay; well-defined inputs/outputs. Zero Neon quota used. |
| **A2** | `judge-schema.json`, `judge.ts`, `eval-judge.ts` | `gemini-4-argon-medium` | Thin child-process wrapper + JSON schema mirroring `src/eval-real.ts`. |
| **A3** | `src/agy/settings.ts` + tests | `gemini-4-argon-low` | Small deterministic JSON builder + model slug lookup. |
| **A4** | `src/agy/hook.ts` + tests | `gemini-4-neon-medium` | Security-critical state machine (1-shot approvals, repeat failure/deny pause, fast non-blocking exit). Worth Neon accuracy. |
| **A5** | `src/agy/stream.ts`, `git-audit.ts` + tests | `gemini-4-neon-medium` | Streaming NDJSON buffering, cumulative→delta usage math, child-process timeout cleanup, git diff verification. |
| **A6** | `src/agy/run.ts` + tests | `gemini-4-neon-high` | Highest-complexity integration: 2-phase plan→execute loop, manifest hot-reload, pending escalation resume, budget & frustration controls. |
| **A7** | `src/agy/smoke.ts` | `gemini-4-argon-low` | Short E2E verification script mirroring `src/smoke.ts`. |
| **A8** | `item-tracker` local wiring & first live run | Manual setup (`AGENTS.md` / `hooks.json`); runtime Worker `gemini-4-neon-medium` + Judge `gemini-4-argon-low` | Low-risk live trial on a docs-only task first. |

### Runtime Model Mapping (When Running `supervise:agy` on `item-tracker`)

| Playbook / Manifest `model` | Mapped `agy --model` | Quota Pool |
| --- | --- | --- |
| `"opus"` (DB / complex tasks) | `gemini-4-neon-high` | Gemini Models pool |
| `"sonnet"` / `""` (screen / routine tasks) | `gemini-4-neon-medium` | Gemini Models pool |
| Judge (`AgyJudge`, always) | `gemini-4-argon-low` *(upgrade to `gemini-4-argon-medium` only if Checkpoint 1 shows `unsafe > 0`)* | **Separate Argon pool** |

---

## 2. Step-by-Step Build Tasks

> **Standing rule for every task:** Never edit existing Claude runtime files (`src/run.ts`, `src/loop/supervisor.ts`, `src/loop/judge-sdk.ts`, `src/loop/queue.ts`, `src/hook-shadow.ts`, `src/policy.ts`, or existing `test/*.test.ts`). Only add files under `src/agy/`, `test/agy-*.test.ts`, and npm scripts in `package.json`. Run `npm run typecheck && npm test` after every task.

---

#### A1 Tool normalizer, config overlay & `agy` guard wrapper
- **Goal:** Translate `agy` protojson tool payloads into `Policy`'s canonical `ToolCall` shape and protect Antigravity's own config files (`AGENTS.md`, `GEMINI.md`, `.agents/**`) without modifying `src/policy.ts`.
- **Depends on:** Gate 0 (done).
- **Model:** `gemini-4-argon-medium` *(sufficient: pure functions and unit tests with exact Gate 0A payloads)*.
- **Read:** `src/types.ts`, `src/policy.ts` (`#L43-L85`, `#L149-L153`), `src/judge/guard.ts`, `projects/item-tracker/config.yaml`.
- **Build:**
  - `src/agy/normalize.ts`:
    - `AgyHookPayload` type matching verified camelCase protojson (`hookEventName`, `conversationId`, `cwd`, `transcriptPath`, `error?`, `toolCall: { id, name, args }`).
    - `normalizeAgyToolCall(name: string, args: Record<string, unknown>): ToolCall`:
      - `run_command` → `{ tool: "Bash", input: { command: args.CommandLine ?? args.command ?? "" } }`
      - `write_file` / `write_to_file` → `{ tool: "Write", input: { file_path: args.Path ?? args.TargetFile ?? "", content: args.Content ?? "" } }`
      - `edit_file` / `replace_file_content` / `multi_replace_file_content` → `{ tool: "Edit", input: { file_path: args.Path ?? args.TargetFile ?? "", new_string: args.Replacement ?? "" } }`
      - `read_file` / `view_file` → `{ tool: "Read", input: { file_path: args.Path ?? args.AbsolutePath ?? "" } }`
      - `ask_question` → `{ tool: "AskUserQuestion", input: args }`
      - `search_web` → `{ tool: "WebSearch", input: args }`
      - `read_url_content` → `{ tool: "WebFetch", input: { url: args.Url ?? args.url ?? "" } }`
      - Unknown tool → `{ tool: name, input: args }` (flows safely to `ask_judge`).
    - `agyConfigOverlay(cfg: Config): Config`: appends `AGENTS.md`, `GEMINI.md`, `.agents/**` to `human_paths` and `~/.gemini/antigravity-cli/brain/` (expanded with `os.homedir()`) to `scratch`.
    - `agyGuard(requestText, r, failuresOnSameStep, skipTopics)`: runs `guard(...)` plus an extra always-escalate regex for `AGENTS.md`, `GEMINI.md`, and `.agents/` when `skipTopics !== "all"`.
  - `test/agy-normalize.test.ts`: unit tests verifying Gate 0A payloads (`run_command`, `write_file`), `edit_file`, `read_file`, `.agents/hooks.json` → `human`, `design/x.css` → `deny`, and `agyGuard` override on `AGENTS.md`.
- **Done when:** `npm run typecheck && npm test` passes (all 47 original tests + new `test/agy-normalize.test.ts`).

---

#### A2 `AgyJudge` adapter, JSON schema & 40-case judge evaluation
- **Goal:** Replace `SdkJudge` with a Mode A single-shot `AgyJudge` backed by `--json-schema` on the separate Gemini 4 Argon pool, and calibrate its safety on Kin's 40 historical cases before wiring live execution.
- **Depends on:** A1.
- **Model:** `gemini-4-argon-medium` *(sufficient: clean subprocess wrapper + JSON schema + thin CLI clone of `src/eval-real.ts`)*.
- **Read:** `src/loop/judge-sdk.ts`, `src/judge/prompt.ts`, `src/judge/schema.ts`, `src/judge/eval.ts`, `src/judge/input.ts`, `src/eval-real.ts`.
- **Build:**
  - `src/agy/judge-schema.json`: strict JSON Schema matching `JudgeResult` (`decision`, `reply`, `why`, `card`, `answers`).
  - `src/agy/judge.ts`:
    - `AgyJudge implements Judge`:
      - Ensures isolated CWD (`logs/agy-judge-cwd/`) has an empty `.git/` directory (stopping upward rule discovery) and `AGENTS.md` containing `JUDGE_SYSTEM_PROMPT` (adapted slightly to refer to "coding worker" and protect `AGENTS.md`/`.agents/`).
      - Spawns `agy -p <message> --output-format json --json-schema <path> --print-timeout 150s --disable-slash-commands --model <model>` (default `gemini-4-argon-low`) with an outer `165s` `SIGTERM` kill timer.
      - Reads `structured_output` (serialized to JSON string for `parseJudge()` compatibility) or falls back to `response`; any non-zero exit or invalid JSON rejects/fails closed so caller escalates.
  - `src/agy/eval-judge.ts` + `package.json` script `"eval:judge:agy": "tsx src/agy/eval-judge.ts"`:
    - Mirrors `src/eval-real.ts` with `--model <slug>`, `--limit N`, and `--claude-md <path>` (pass `~/Documents/dev/personal/item-tracker/CLAUDE.md` for a fair score).
- **Done when:**
  - `npm run typecheck && npm test` passes.
  - `npm run eval:judge:agy -- --limit 5 --claude-md ~/Documents/dev/personal/item-tracker/CLAUDE.md` completes cleanly with valid JSON on all 5 cases.
  - Full 40-case run (`npm run eval:judge:agy -- --claude-md ~/Documents/dev/personal/item-tracker/CLAUDE.md`) finishes and saves `logs/eval-agy-*.json`.

**→ Checkpoint 1 (Judge Calibration Gate):** Inspect `UNSAFE` cases from the 40-case `eval:judge:agy` report.
- Target: **`unsafe === 0`** (zero cases where the judge auto-approved something Kin wanted escalated).
- If `gemini-4-argon-low` has any `unsafe` cases, re-run with `--model gemini-4-argon-medium` (or `--model gemini-4-neon-low`) and record the passing Judge model slug before proceeding to A3.

---

#### A3 Session-only `--settings` builder, sandbox selector & model validator
- **Goal:** Build pure helpers that generate session-only `--settings` JSON (fail-closed `permissions.deny` backstop without touching `~/.gemini/antigravity-cli/settings.json`), auto-select `--sandbox` per task manifest, and validate `--model` slugs against `agy models`.
- **Depends on:** A1.
- **Model:** `gemini-4-argon-low` *(sufficient: small deterministic JSON/string builder and unit tests)*.
- **Read:** `src/types.ts`, `projects/item-tracker/config.yaml`, `projects/item-tracker/tasks/_template.yaml`, `docs/agy-migration-readiness-report.md` (§3 & §5).
- **Build:**
  - `src/agy/settings.ts`:
    - `buildSessionSettings(manifest: Manifest, config: Config)`: returns an inline JSON object `{ permissions: { deny: [...] } }` covering catastrophic shell ops (`git push`, `git merge`, `git checkout main`, `git add -A`, `git add .`, `git commit --amend`, `--no-verify`, `--force`, `--legacy-peer-deps`, `netlify`, `npx netlify`, `gh workflow run`, `gh pr`, `npx supabase link`, `npx supabase db push`, `npx supabase secrets`, `npx supabase functions deploy`, `docker rm`, `docker volume`, `docker system prune`, `docker network`, `npm audit fix`, `npm run dev`, `npm run start`, `npm run db:seed-dev`, `pkill`, `kill`) plus protected file writes (`write_file(design/)`, `write_file(src/components/ui/)`, `write_file(src/dev/)`, `write_file(.agents/)`, `write_file(AGENTS.md)`, `write_file(GEMINI.md)`).
    - `shouldUseSandbox(manifest: Manifest): boolean`: returns `false` if `manifest.gates` or `manifest.preapproved` references `supabase`, `docker`, `db:reset`, `db:types`, or `127.0.0.1`/`localhost`; returns `true` otherwise (docs, frontend, unit tests).
    - `resolveWorkerModel(manifestModel: string, cliOverride?: string): string`: maps `"opus"` → `gemini-4-neon-high`, `"sonnet"` / `""` → `gemini-4-neon-medium` (respecting `--model` CLI override).
    - `validateModelSlug(slug: string, availableOutput: string): void`: parses `agy models` stdout and throws early with a clear message if `slug` is missing (avoiding mid-run non-zero exits).
  - `test/agy-settings.test.ts`: tests DB vs. frontend sandbox detection, deny-list completeness, model mapping, and slug validation.
- **Done when:** `npm run typecheck && npm test` passes (`test/agy-settings.test.ts`).

---

#### A4 Non-blocking `PreToolUse` / `PostToolUse` hook (`src/agy/hook.ts`)
- **Goal:** Enforce the full `Policy.ts` engine inside `.agents/hooks.json` in `<200ms` per tool call—**never** blocking for LLM or human input (eliminating Antigravity's fail-open timeout hazard).
- **Depends on:** A1.
- **Model:** `gemini-4-neon-medium` *(sufficient: security-critical state machine, 1-shot approval tokens, repeat-failure/deny circuit breakers)*.
- **Read:** `src/hook-shadow.ts`, `src/policy.ts`, `src/state-store.ts`, `src/loop/supervisor.ts` (`#L24-L28`, `#L111-L132`), `src/agy/normalize.ts`.
- **Build:**
  - `src/agy/state.ts` (~40 LOC): extends `State` persisted in `logs/agy-state-<task>.json` with `approvedOnce: string[]`, `denies: Record<string, number>`, `failures: Record<string, number>`, plus `writePendingEscalation` / `readPendingEscalation` / `clearPendingEscalation` for `logs/agy-pending-<task>.json`.
  - `src/agy/hook.ts`:
    - Pure exported `handleAgyHook(payload: AgyHookPayload, env: AgyHookEnv)` + `main()` reading `stdin` and writing JSON to `stdout`.
    - Reads active task pointer (`SUPERVISOR_AGY_TASK` env var or `projects/<project>/active-agy-task.txt`); if no active task, exits cleanly with `{}`.
    - On `PreToolUse`:
      1. Normalizes `toolCall` via `normalizeAgyToolCall`, loads manifest + `agyConfigOverlay(config)` + `agy-state-<task>.json`.
      2. Computes tool `sig` (same logic as `signature()` in `src/loop/supervisor.ts`).
      3. If `sig` is in `approvedOnce` → removes token, saves state, returns `{"decision":"allow"}`.
      4. If `(failures[sig] ?? 0) >= 2` → writes `agy-pending-<task>.json` (`kind: "human"`, `reason: "repeated failure"`) and returns `{"decision":"deny","reason":"SUPERVISOR_PAUSE: This step has failed twice. Stop your turn immediately and wait for user instructions."}`.
      5. Calls `policy.evaluate(call)`:
         - `allow` → saves state (if `git add`/`git commit`/`npm --dry-run` updated it — or lets `PostToolUse` observe), returns `{"decision":"allow"}`. *(Note: evaluate on a throwaway state copy on `PreToolUse` and persist state mutations only in `PostToolUse`, just like `src/hook-shadow.ts#L40-L46`, so a command blocked later by `--settings` never corrupts staging state!)*
         - `deny` → increments `denies[sig]`, saves state. If `denies[sig] >= 2`, writes `agy-pending-<task>.json` and returns `SUPERVISOR_PAUSE` deny; otherwise returns `{"decision":"deny","reason":v.redirect}`.
         - `ask_judge` or `human` → writes `agy-pending-<task>.json` (`call`, `sig`, `verdict`, `reason`, `transcriptPath`, `cwd`) and returns `{"decision":"deny","reason":"SUPERVISOR_PAUSE: Requires supervisor approval (" + v.reason + "). Stop your turn immediately without attempting workarounds."}`.
    - On `PostToolUse`:
      - If `run_command` and no `payload.error` → calls `policy.observe(command)` and saves state.
      - If `payload.error` is non-empty → increments `failures[sig]` and saves state.
      - Outputs `{}`.
  - `test/agy-hook.test.ts`: comprehensive tests (matching `test/shadow.test.ts` + `test/supervisor.test.ts` cases: allow, deny+redirect, 2nd deny → pause, 2nd failure → pause, `ask_judge`/`human` → pending file + pause, 1-shot approval token consumed once, `git add` → `PostToolUse` → `git commit` flow, and subprocess `stdin`/`stdout` test).
- **Done when:** `npm run typecheck && npm test` passes (`test/agy-hook.test.ts`).

---

#### A5 Headless NDJSON stream runner & post-turn git auditor
- **Goal:** Spawn `agy -p --output-format stream-json`, parse verified `step_update`/`result` events, compute per-turn usage deltas from cumulative session metrics, and audit `git status`/`git diff` after every turn as a fail-closed backstop.
- **Depends on:** A1, A3.
- **Model:** `gemini-4-neon-medium` *(sufficient: clean Node `child_process` streaming + git diff inspection + unit tests)*.
- **Read:** `src/agy/normalize.ts`, `src/agy/settings.ts`, `docs/agy-migration-readiness-report.md` (§3), Gate 0A/0B NDJSON schemas above.
- **Build:**
  - `src/agy/stream.ts`:
    - `runAgyTurn(opts)`: spawns `agy -p <prompt> --output-format stream-json --print-timeout <timeout> --settings <json> [--sandbox] [--mode plan] [--conversation <id>] [--model <slug>] [--disable-slash-commands]` with `cwd: repoAbs`.
    - Parses NDJSON line-by-line:
      - Streams `step_update.text_delta` (`step_type === "agent_response"`) to stdout.
      - Captures tool summaries (`step_type === "tool"`, `state === "DONE"`) into a turn transcript array.
      - Captures `conversation_id`, `status`, `response`, `duration_seconds`, `num_turns`, and `usage` from `result`.
    - `UsageTracker`: subtracts previous cumulative `usage`/`num_turns`/`duration_seconds` so logs record accurate **per-turn deltas** alongside session totals.
    - Enforces outer abort/kill timer (`SIGTERM`, then `SIGKILL` after 5s) and surfaces `stderr` + non-zero exit codes (flagging auth expiry vs. quota/rate-limit errors).
  - `src/agy/git-audit.ts`:
    - `auditWorkingTree(repoAbs, manifest, config)`: runs `git status --porcelain` and `git diff --name-only` (plus `git diff --cached --name-only`), returning `{ frozenViolations, humanPathViolations, outOfManifestEdits, dirtyFiles }` using `matchAny()` and `agyConfigOverlay()`.
  - `test/agy-stream.test.ts`: tests NDJSON parsing using the exact Gate 0A/0B JSON lines, cumulative→delta math, and `auditWorkingTree` classification.
- **Done when:** `npm run typecheck && npm test` passes (`test/agy-stream.test.ts`).

---

#### A6 Outer two-phase supervisor loop (`src/agy/run.ts`)
- **Goal:** Wire everything into `npm run supervise:agy` — preserving Kin's full workflow (manifest blockers, hot-reload, plan review, execution, 15-call judge cap, frustration kill-switch, human escalation cards + macOS/`ntfy.sh` notifications, post-turn git audit, 8h deadline, and `log:summary`-compatible JSONL logs).
- **Depends on:** A1, A2, A3, A4, A5.
- **Model:** `gemini-4-neon-high` *(recommended: highest integration surface; ties together all modules and edge cases cleanly in one pass)*.
- **Read:** `src/run.ts`, `src/loop/supervisor.ts`, `src/loop/human.ts`, `src/loop/context.ts`, `src/loop/notify.ts`, `src/log-summary.ts`, `src/agy/*.ts`.
- **Build:**
  - `src/agy/run.ts` + `package.json` script `"supervise:agy": "tsx src/agy/run.ts"`:
    - CLI: `npm run supervise:agy -- <task.yaml> --repo <path> "<first message>" [--mode plan|default] [--model <slug>] [--judge-model <slug>] [--human-only] [--no-sandbox] [--prompt-file <file>]`
    - Startup checks: `startBlockers(manifest)`, `validateModelSlug` against `agy models`, writes `projects/<project>/active-agy-task.txt` (cleaned up on exit in `finally`!), clears stale `agy-pending-<task>.json`.
    - **Phase 1 (Plan Mode, unless `--mode default`):**
      - Runs `runAgyTurn` with `--mode plan` → captures `conversationId` and `result.response` (the plan).
      - Routes plan through `AgyJudge` (`skipTopics: "all"`, using `buildJudgeMessage` with synthetic `ExitPlanMode` call) or `TerminalHuman` (if `--human-only` / budget exhausted / frustrated / judge escalates).
      - On `revise` or Kin's typed feedback: loops `runAgyTurn` with `--mode plan --conversation <id>`.
      - On `continue` / Kin's `approve`: exits Phase 1, hot-reloads manifest (in case Kin just filled in `commits[].paths`!), and begins Phase 2.
    - **Phase 2 (Execution Loop):**
      - Runs `runAgyTurn` with `--conversation <id>` (auto-enabling `--sandbox` via `shouldUseSandbox(manifest)` unless `--no-sandbox`), passing session-only `--settings`.
      - After **every turn**:
        1. **Post-turn git audit (`auditWorkingTree`):** If any `frozen` or `human_paths` file changed (fail-open safety net!), immediately `notify()` Kin and halt for manual inspection/revert before continuing.
        2. **Pending escalation (`agy-pending-<task>.json`):**
           - Reads pending call, clears file, hot-reloads manifest if changed.
           - If `ask_judge` and `!humanOnly` and `judgeCalls < 15` and `!frustrated`: calls `AgyJudge` + `parseJudge` + `agyGuard` (attaching recent transcript + `referencedFiles` read from disk).
             - `continue` → appends `sig` to `approvedOnce` in `agy-state-<task>.json` and auto-resumes `--conversation <id>` with `"Approved: <reply>. Proceed with that step."`.
             - `revise` → auto-resumes `--conversation <id>` with `r.reply`.
             - `escalate` → falls through to Human card.
           - If `human` or escalated: calls `notify("Antigravity supervisor needs you", card.headline)`, prompts `TerminalHuman.decide(card, call)` (unlimited wait time, zero hook timeout!).
             - `approve` → appends `sig` to `approvedOnce`, resets `frustrated = false`, resumes `--conversation <id>` with `"User approved. Proceed with that step."`.
             - `deny` / custom note → updates frustration detector, resumes `--conversation <id>` with Kin's instruction.
        3. **Normal turn completion (no pending escalation):**
           - Saves `logs/agy-session-<task>.json`, prints `checkpoint_after` reminder, prompts `human.followUp()`.
           - Rejects/warns if Kin types a leading `/` slash command (reminding to run `/usage` interactively outside the stream).
           - Empty line exits cleanly; prints `Run summary` + logs JSONL rows compatible with `npm run log:summary`.
  - `test/agy-run.test.ts`: unit/integration tests using mocked `runAgyTurn` + mocked `Judge` + mocked `Human` covering Phase 1 plan revise→approve, Phase 2 `SUPERVISOR_PAUSE` → 1-shot approve → resume, frustration switch, 15-call judge cap, and post-turn frozen-file halt.
- **Done when:** `npm run typecheck && npm test` passes (47 original Claude tests + all new `test/agy-*.test.ts`).

---

#### A7 End-to-end live smoke test (`src/agy/smoke.ts`)
- **Goal:** Prove the full `agy` + `hook.ts` + `AgyJudge` + `--settings` stack works end-to-end in an isolated `/tmp/supervisor-agy-smoke` repo before running against `item-tracker`.
- **Depends on:** A6.
- **Model:** `gemini-4-argon-low` *(sufficient: ~50-line script mirroring `src/smoke.ts`)*.
- **Read:** `src/smoke.ts`, `src/agy/run.ts`, `src/agy/hook.ts`, `src/agy/judge.ts`.
- **Build:**
  - `src/agy/smoke.ts` + `package.json` script `"smoke:agy": "tsx src/agy/smoke.ts"`:
    1. Creates temp git repo `/tmp/supervisor-agy-smoke` with `.agents/hooks.json` pointing to `src/agy/hook.ts`.
    2. Tests `AgyJudge` on one sample question → asserts valid `JudgeResult` JSON.
    3. Runs `agy -p` (`gemini-4-argon-low`) to write an allowed manifest file → asserts created.
    4. Runs `agy -p` to write a frozen file (`design/x.css`) → asserts blocked and file not created.
    5. Runs `agy -p` to write an out-of-manifest file → asserts `agy-pending-*.json` is written and file not created.
    6. Cleans up `/tmp/supervisor-agy-smoke`.
- **Done when:** `npm run smoke:agy` prints `AGY SMOKE TEST PASSED`.

**→ Checkpoint 2 (Pre-Production Verification Gate):**
- Verify `npm run typecheck && npm test` passes (zero regressions in original Claude tests).
- Verify `npm run smoke:agy` prints `AGY SMOKE TEST PASSED`.
- Run `git status` in `supervisor` to verify zero existing Claude files were modified.

---

#### A8 Target repo (`item-tracker`) local wiring & first low-risk live task
- **Goal:** Connect `item-tracker` cleanly (zero git noise, instant rollback) and validate on one low-risk task before using on full DB/screen tasks.
- **Depends on:** Checkpoint 2.
- **Model:** Manual file setup; runtime uses `gemini-4-neon-medium` (Worker) + calibrated Argon Judge (or `--human-only` for trial #1).
- **Read:** `~/Documents/dev/personal/item-tracker/CLAUDE.md`, `STEP3.md`.
- **Build (in `~/Documents/dev/personal/item-tracker` — untracked & excluded locally):**
  1. Create `.agents/hooks.json` registering `PreToolUse` and `PostToolUse` (`matcher: "*"`, `timeout: 10`) calling `cd /Users/san_e_kev/Documents/dev/personal/supervisor && npx tsx src/agy/hook.ts`.
  2. Create `AGENTS.md` containing:
     - `@[CLAUDE.md](CLAUDE.md)` (inlines the 8.8 KB `CLAUDE.md` cleanly)
     - 4 short `agy`-specific operational lines:
       - Do not spawn parallel subagents (conserves Google AI Pro quota).
       - Never use interactive question tools in headless mode; write any questions for the user clearly in your final response text.
       - If a hook responds with `SUPERVISOR_PAUSE`, stop your turn immediately without retrying or working around it, and state what you were trying to do.
       - Never edit `AGENTS.md`, `GEMINI.md`, or `.agents/**`.
  3. Add `.agents/` and `AGENTS.md` to `~/Documents/dev/personal/item-tracker/.git/info/exclude` (keeps `git status` 100% clean without modifying `.gitignore`!).
  4. Run a low-risk docs-only task first with `--human-only`:
     ```bash
     npm run supervise:agy -- projects/item-tracker/tasks/<docs-task>.yaml --repo ~/Documents/dev/personal/item-tracker --human-only "<prompt>"
     ```
  5. After verifying logs (`npm run log:summary`) and commits, run the next normal task with `AgyJudge` enabled.
- **Done when:**
  - Task completes cleanly with exact manifest commits and zero frozen/out-of-manifest violations.
  - `git status` in `item-tracker` shows zero untracked `.agents/` or `AGENTS.md` files.
  - `/usage` confirms Neon and Argon pools drained separately as expected.

**→ Checkpoint 3 (Production Readiness & Rollback Verification):**
- Confirm you can return to Claude Code in <30 seconds whenever Claude is back:
  1. `rm -rf ~/Documents/dev/personal/item-tracker/.agents ~/Documents/dev/personal/item-tracker/AGENTS.md`
  2. Remove the two lines from `~/Documents/dev/personal/item-tracker/.git/info/exclude`.
  3. Resume `npm run supervise -- ...` (100% untouched).

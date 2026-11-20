# Migration Readiness & Feasibility Report: Claude Supervisor → Antigravity CLI (`agy`)

> **Scope:** Part A — Orchestration Repo Audit (`supervisor`).  
> **Reference Basis:** *Antigravity CLI Headless Migration — Pre-Assessment Reference Guide*, audited against the full `supervisor` codebase (1,701 LOC in `src/`, 705 LOC in `test/`, plus YAML configs and eval fixtures).  
> **Environment Note:** `agy` is not yet installed on `PATH` in this environment (`which agy` returned not found). Target project repo audit (**Part B**, `item-tracker`) is scoped as a follow-up since `item-tracker` is outside this workspace.

---

## Executive Summary

This repository is **not** a generic task-queue orchestrator. It is a **synchronous, mid-turn tool-permission proxy** built around one Claude Agent SDK primitive: the in-process `canUseTool(toolName, input, opts) => Promise<PermissionResult>` callback (`src/loop/supervisor.ts#L93-L132`, `src/run.ts#L68-L80`).

- **Directly reusable as-is:** **~30% of `src/` (515 / 1,701 LOC)** plus 100% of YAML configs and evaluation fixtures.
- **Reusable via thin adapters:** **~69% total (1,168 / 1,701 LOC)**—including almost the entire 492-line deterministic rule engine (`src/policy.ts`) and the judge prompt/schema/guard/eval stack.
- **Claude-locked:** **~31% (533 / 1,701 LOC)**—which is the **entire live execution loop** (`src/run.ts`, `src/loop/supervisor.ts`, `src/loop/judge-sdk.ts`, `src/loop/queue.ts`, and Claude shadow hooks).
- **Strategic Verdict:** For a **fast, temporary replacement** while Claude is unavailable, **Option C (Separate Lightweight Runner)** is strongly recommended. Adapting this repo in-place (Option A) is over-engineered for a temporary workaround, forces two incompatible control planes behind a leaky abstraction, and risks destabilizing a clean, 47-test Claude supervisor before its first live task run (`STEP3.md#L59`).

---

## 1. Core Code Reusability Audit

Total application code in `src/`: **1,701 LOC** across 28 TypeScript files (plus 705 LOC in `test/`).

### Bucket A — Directly Reusable As-Is (~30% of `src/`: 515 LOC)

Provider-agnostic domain models, shell/glob parsers, manifest/playbook tooling, state persistence, judge safety rails, and notifications. Zero `@anthropic-ai/claude-agent-sdk` imports.

| File | LOC | Key Symbols | Notes |
| --- | ---: | --- | --- |
| `src/types.ts` | 32 | `Verdict`, `CommitSpec`, `Manifest`, `Config`, `ToolCall` | Pure domain types (`Manifest.model` is a plain `string`). |
| `src/shell.ts` | 60 | `parseShell`, `words`, `ParsedShell` | Pure quote-aware shell splitter and redirect detector. |
| `src/glob.ts` | 22 | `globToRegExp`, `normPath`, `matchAny` | Pure glob matching. |
| `src/manifest.ts` | 40 | `parseManifest`, `loadManifest`, `parseConfig`, `loadConfig`, `startBlockers` | YAML loader and `setup_done` pre-flight blocker check. |
| `src/playbook.ts` | 163 | `parsePlaybook`, `draftFromTask`, `renderManifest`, `hostedGates` | Minor Claude-isms in rendered defaults (`opus`/`sonnet`, `CLAUDE.md`), otherwise pure. |
| `src/state-store.ts` | 19 | `loadState`, `saveState` | JSON persistence for `staged`, `done`, `commitsDone`, `dryRun`. |
| `src/judge/schema.ts` | 21 | `parseJudge`, `Decision`, `Card`, `JudgeResult` | Fail-closed JSON validator for judge responses. |
| `src/judge/guard.ts` | 36 | `ALWAYS_ESCALATE`, `guard` | Deterministic escalation override (extend `protected files` regex with `AGENTS.md`/`GEMINI.md`/`.agents/` when used with `agy`). |
| `src/judge/eval.ts` | 32 | `loadExamples`, `evaluate`, `JudgeFn`, `EvalReport` | Provider-agnostic 40-case judge benchmark harness. |
| `src/loop/context.ts` | 21 | `loadRepoContext`, `RepoContext` | Loads `CLAUDE.md`, manifest `context` files, and playbook entry (skips missing files). |
| `src/loop/notify.ts` | 13 | `notify` | macOS `osascript` + `ntfy.sh` push notification. |
| `src/cli.ts`, `src/draft-cli.ts`, `src/ready-cli.ts`, `src/use-task.ts`, `src/log-summary.ts` | 56 | CLI entrypoints | Thin wrappers around pure modules and run JSONL logs. |
| **Configs & Fixtures** | — | `projects/item-tracker/config.yaml`, `context.yaml`, `tasks/_template.yaml`, `data/judge-examples.json` | 100% reusable domain specs and 40 historical test cases. |

### Bucket B — Adaptable via Wrapper (~38% of `src/`: 653 LOC)

Core logic is provider-agnostic, but assumes Claude tool names, argument keys, or `SdkJudge`. Cleanly isolatable behind thin adapters without rewriting internals.

| File | LOC | Key Symbols | Coupling Point & Wrapper Needed |
| --- | ---: | --- | --- |
| `src/policy.ts` | 492 | `Policy`, `Policy.evaluate`, `Policy.bash`, `Policy.tool`, `Policy.observe`, `State` | **~415 LOC (`bash`, `git`, `npm`, `npx`, `supabase`, `docker`, `curl`, `gh`, `rm`, `fsWrite`, `sedInPlace`, `perl`) are 100% provider-agnostic.** Only `evaluate()` (`#L43`), `tool()` (`#L54-L85`: `Bash`, `Edit`, `Write`, `MultiEdit`, `Read`, `WebFetch`, `ExitPlanMode`, `AskUserQuestion`, `ToolSearch`), and `isScratch()` (`#L151`: `~/.claude/plans/*.md`) assume Claude names. A ~25-line normalizer maps `agy` tools (`run_command`, `write_file`/`edit_file`, `read_file`, etc.) into `ToolCall`. |
| `src/loop/human.ts` | 52 | `Human`, `TerminalHuman`, `renderCard`, `QuestionItem` | Pure `readline` terminal UI; `renderCard()` (`#L17-L19`) checks `call.tool === "Bash" \| "ExitPlanMode"`. Works directly once tool calls are normalized. |
| `src/eval-real.ts` | 44 | `main` | Hardcodes `SdkJudge` (`#L8`, `#L23`) and `ANTHROPIC_API_KEY` check (`#L11`). Swapping in an `AgyJudge` enables immediate benchmarking of Gemini on all 40 past cases. |
| `src/judge/prompt.ts` | 38 | `JUDGE_SYSTEM_PROMPT` | Almost pure Kin preferences; references `"Claude Code worker"` (`#L2`), `AskUserQuestion` (`#L6`), and `CLAUDE.md`/`.claude/settings*` (`#L32`). |
| `src/judge/input.ts` | 27 | `buildJudgeMessage`, `JudgeInput` | Only `#L25` special-cases `call.tool === "ExitPlanMode"` (`call.input.plan`). |

### Bucket C — Claude-Locked / Non-Reusable (~31% of `src/`: 533 LOC)

Deeply coupled to `@anthropic-ai/claude-agent-sdk` internals, synchronous in-process `canUseTool`, or Claude Code hook schemas.

| File | LOC | Key Symbols | Why It Is Claude-Locked |
| --- | ---: | --- | --- |
| `src/loop/supervisor.ts` | 189 | `Supervisor`, `canUseTool`, `viaJudge`, `askHuman`, `noteResult`, `observeRan`, `referencedFiles` | **Execution contract is Claude-only:** returns SDK `PermissionResult` (`{ behavior: "allow", updatedInput }` / `{ behavior: "deny", message }`) synchronously mid-turn, mutates `AskUserQuestion` `updatedInput.answers` in-flight (`#L164`, `#L182`), intercepts `ExitPlanMode` (`#L136`, `#L158`), and shares in-memory state (`written`, `failures`, `denies`, `idToSig`, `transcript`) with streaming callbacks. *(Its ~6 guardrail policies are portable as a spec, not as this class.)* |
| `src/run.ts` | 114 | `main` | Calls Claude SDK `query()` (`#L68-L80`) with `preset: "claude_code"`, `settingSources`, `permissionMode`, `canUseTool`, in-process `hooks.PostToolUse`, `ANTHROPIC_API_KEY` Pro-plan guard, and parses Claude `assistant`/`user`/`result` message blocks. |
| `src/hook-shadow.ts` + `shadow-hook-settings.json` | 63 + 13 | `handleHook`, `HookPayload`, `activeTaskFile` | Parses Claude Code `snake_case` hook JSON (`hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`) including Claude's `PermissionRequest` event (`agy` uses `camelCase` protojson in `.agents/hooks.json` and has no `PermissionRequest` event). |
| `src/loop/judge-sdk.ts` | 60 | `Judge` (reusable 1-line interface), `SdkJudge` | `SdkJudge` spawns a Claude Sonnet SDK `query()` session with `permissionMode: "dontAsk"` and a deny-all `canUseTool`. **Both worker and judge currently require Claude and must be replaced.** |
| `src/shadow-report.ts` | 46 | `summarise` | Correlates Claude's `PreToolUse` / `PermissionRequest` / `PostToolUse` log rows. |
| `src/smoke.ts` | 33 | `main` | End-to-end smoke test of `SdkJudge` + Claude SDK `query()` + `canUseTool`. |
| `src/loop/queue.ts` | 28 | `MessageQueue` | Implements `AsyncIterable<SDKUserMessage>` for Claude SDK streaming input. |

### Reusability Summary
- **Reusable strictly as-is (`src/`):** **~30%** (515 LOC) + 100% of YAML specs & eval fixtures.
- **Reusable via thin adapters (`src/`):** **~69%** (1,168 LOC), conditional on whether `.agents/hooks.json` can gate headless tool calls (see Section 2 & Gate 0 in Section 5). If dynamic pre-tool hooks are unavailable in headless mode, live pre-tool reuse of `src/policy.ts` drops and effective reuse is **~35–40%** (manifests, playbooks, judge stack, human UI, post-turn auditing).
- **Must be replaced (`src/`):** **~31%** (533 LOC) — the entire live runtime loop.

---

## 2. Core Judgement Layer (Rules & Actions) Adaptability

### Fundamental Headless Control-Plane Constraints Under `agy`

1. **No in-process `canUseTool` callback:** NDJSON `stdout` (`init`, `step_update`, `result`) is one-way telemetry; `stdin` only accepts new user turns after `result`, not mid-turn permission responses.
2. **Unapproved tools auto-reject (`request-review`):** In headless mode, any tool call not covered by `settings.json` `permissions.allow` (or `--dangerously-skip-permissions`) is automatically rejected without prompting.
3. **`--dangerously-skip-permissions` bypasses security hooks** and grants unrestricted host access; restrict it to disposable containers, never local dev against live project repos.
4. **Global `settings.json` is shared with Antigravity 2.0 Desktop:** Enabling global `always-proceed` in `~/.gemini/antigravity-cli/settings.json` loosens permissions in interactive Desktop sessions as well. Prefer **scoped `permissions.allow`/`deny` + `--sandbox`**.
5. **External `.agents/hooks.json` caveat:** Antigravity's customization docs describe external command hooks (`PreToolUse`, `PostToolUse`, `Stop`), which **fail open** on timeout/error (default 30s timeout), while the Migration Reference Guide (Section 3) treats headless mode as having no equivalent CLI callback hooks. **Gate 0 (Section 5)** must verify in a 60-second test whether `.agents/hooks.json` `PreToolUse` fires and overrides `request-review` in headless mode.

### Rule → Action Preservation Matrix

| Rule / Guardrail & Source | Trigger → Action Today | Behavior & Control Under `agy` | Status |
| --- | --- | --- | --- |
| **1. Pre-flight manual setup gate**<br>`src/manifest.ts#L36-L40`, `src/run.ts#L36-L37` | `manual_setup.length && !setup_done` → Refuse startup (`exit 1`) | Runs in outer runner before spawning `agy`. | **Preserved** |
| **2. Wall-clock 8h limit**<br>`src/run.ts#L17,L65-L66` | 8h elapsed → `AbortController.abort()` | Timer sends `SIGTERM`/`SIGKILL` to `agy` child process; Mode A also supports `--print-timeout`. | **Preserved** |
| **3. Manifest hot-reload**<br>`src/run.ts#L52-L62`, `src/loop/supervisor.ts#L95-L96` | Task YAML mtime changes → Reload `policy.manifest` live | Reloaded between turns in outer runner (and per call in `PreToolUse` hook if supported). | **Preserved** |
| **4. Bash hard-denies + redirect messages**<br>`src/policy.ts#L91,L179-L187,L245-L470` | `--no-verify`, `--force`, `--amend`, `--legacy-peer-deps`, `$PIPESTATUS`, `git push/merge/tag/checkout main/add -A/commit -a`, bare/unpinned `npm install`, `npm audit fix`, `npm run dev/db:seed-dev`, `netlify`, hosted `supabase`, destructive `docker`, `gh` writes, `pkill/kill`, binary search → Block pre-exec + send `redirect` | **Backstop (always):** `settings.json` `permissions.deny` + `--sandbox` blocks catastrophic commands at the OS/CLI boundary (no custom `redirect` text).<br>**With `.agents/hooks.json` (if Gate 0 passes):** `PreToolUse` on `run_command` runs `Policy.bash()` and returns `{"decision":"deny","reason":v.redirect}`.<br>**Without hooks:** Compound shell parsing (`a && b`), `$PIPESTATUS`, and custom redirect strings are **degraded** to static `permissions.deny` + post-turn review. | **Preserved w/ hooks + `settings.json` backstop; Degraded without hooks** |
| **5. File-path guards (frozen / human / manifest / `.env` / scratch)**<br>`src/policy.ts#L54-L71,L149-L153,L282-L298,L313-L321,L472-L482` | Frozen (`design/**`, `src/components/ui/**`, `src/dev/**`) → `deny`; `CLAUDE.md`/`.claude/**`/`.env`/unlisted `rm` → `human`; manifest edits → `allow`; `judge_paths`/other → `ask_judge` | Static `permissions.deny` (`write_file(design/)`, `write_file(src/components/ui/)`, `write_file(src/dev/)`, `write_file(.agents/)`) + `--sandbox` (blocks `.env` reads) + `PreToolUse` hook (if Gate 0 passes) + **post-turn `git diff --name-only`** hard check. **Must add `AGENTS.md`, `GEMINI.md`, `.agents/**` to `human_paths` & `ALWAYS_ESCALATE`.** | **Preserved (requires `.agents/**` hardening + post-turn git check)** |
| **6. Stateful git staging / commit check & npm `--dry-run` sequence**<br>`src/policy.ts#L26-L33,L156-L235,L335-L363,L389-L403`, `src/run.ts#L77` | Tracks `staged`, `done`, `commitsDone`, `dryRun`; checks `git commit` message & staged paths against `manifest.commits`; requires `npm install --dry-run` before install | **With hooks:** `PreToolUse` + `PostToolUse` persist `logs/agy-state-<task>.json` via `state-store.ts`.<br>**Without hooks:** Cannot enforce pre-tool; shifts to **post-turn `git diff --cached --name-only` & `git log`** verification (with git reset/revert on mismatch). | **Preserved w/ hooks; Degraded to post-turn audit without hooks** |
| **7. Gated local-destructive commands & `preapproved` regexes**<br>`src/policy.ts#L101-L107,L172-L177,L439-L441` | `supabase start/db reset`, `npm run db:reset` checked against `manifest.gates`; `preapproved` regexes checked against whole segment | Enforced via `PreToolUse` hook or scoped `settings.json` `permissions.allow`. **Caveat:** `--sandbox` (macOS Seatbelt) may block Docker sockets / local Supabase / `127.0.0.1` curls. | **Preserved (sandbox friction on DB tasks)** |
| **8. Repeat-failure (`>= 2`) & repeat-deny (`>= 2`) circuit breakers**<br>`src/loop/supervisor.ts#L85-L90,L112-L127` | Same tool signature fails twice (`is_error`) or denied twice → Escalate to Human | Tracked via `PostToolUse` `error` field or NDJSON `step_update` failure telemetry; triggers turn-boundary pause & escalation. | **Preserved (coarser without hooks)** |
| **9. Frustration kill-switch**<br>`src/loop/supervisor.ts#L48-L51,L143,L185` | Frustration regex in Kin's text → Pauses Judge until Kin makes next decision | Pure outer-loop state around `TerminalHuman` input. | **Preserved** |
| **10. Mid-turn AI Judge (`ask_judge`) + `referencedFiles` + `parseJudge` + `guard()` + 15-call cap**<br>`src/loop/supervisor.ts#L71-L83,L140-L166`, `src/judge/guard.ts`, `src/judge/schema.ts` | Pauses worker mid-turn, attaches scratch files & transcript, calls Sonnet judge (150s timeout), applies `parseJudge` + `guard()` | **DEGRADED mid-turn.** Never call an LLM judge *inside* a `PreToolUse` hook (risks hook timeout → **fail-open**!). Must shift to a **turn-boundary pause** (hook denies with `SUPERVISOR_PAUSE` → outer loop calls `AgyJudge` → grants 1-shot approval or sends `revise` next turn). `SdkJudge` must be replaced by `AgyJudge`. | **Degraded (moves from mid-turn to turn-boundary)** |
| **11. Mid-turn Human Escalation Cards (`human` / `escalate`)**<br>`src/loop/supervisor.ts#L175-L188`, `src/loop/human.ts` | Pauses worker mid-turn indefinitely, notifies via macOS/`ntfy.sh`, waits for `a`/`d`/note | **LOST as a mid-turn pause.** Headless mode auto-rejects `request-review` (`ask`), and blocking inside a hook fails open on timeout. Must shift to turn-boundary pause (deny → turn ends → notify & wait indefinitely for Kin → resume conversation). | **Degraded (mid-turn pause lost; preserved between turns)** |
| **12. `ExitPlanMode` Plan Review**<br>`src/policy.ts#L81`, `src/loop/supervisor.ts#L136,L158`, `src/judge/input.ts#L25` | Intercepts `ExitPlanMode({ plan })`, sends up to 40KB plan to Judge (`skipTopics: "all"`), approves or revises while staying in plan mode | **LOST as a tool hook; REPLACED cleanly by a 2-phase outer loop:** Phase 1 runs `agy -p --mode=plan` → reviews `result.response` via Judge (`skipTopics: "all"`) / Kin → iterates via `--conversation <id>` → starts Phase 2 (edit mode) only after approval. | **Changed (clean 2-phase replacement)** |
| **13. Mid-turn `AskUserQuestion` answering (`updatedInput.answers`)**<br>`src/policy.ts#L82`, `src/loop/supervisor.ts#L164,L168-L183` | Intercepts `AskUserQuestion`, injects chosen option labels into `updatedInput.answers` mid-turn, records `KIN RULED:` | **LOST.** Headless `agy` cannot pause for `ask_question`, and hook `overwrite` cannot synthesize user-answer tool results. Worker must output questions in its final turn text so the outer loop answers them on the next turn. | **Lost (replaced by turn-based Q&A)** |
| **14. Rollback / Rewind triggers** | *Not implemented in current repo* (relies purely on pre-tool blocking). | **New compensating control required:** Outer runner captures base commit/working tree before each turn and runs post-turn `git status --porcelain` / `git diff --name-only` checks against `config.frozen` & `manifest.edits`, offering git rollback on violation. | **New requirement under `agy`** |

---

## 3. Execution Mode & Protocol Fit

### Mode Mapping

| Role | Current Implementation | Recommended `agy` Mode | Rationale |
| --- | --- | --- | --- |
| **Worker** | Single long-lived SDK `query()` + `MessageQueue` (`src/run.ts#L67-L104`) | **Mode A per turn (`agy -p --output-format stream-json --print-timeout 10m`) chained via `--conversation <id>`** *(or Mode B within a single execution phase)* | Mode A + `--conversation <id>` cleanly handles the Phase 1 (`--mode=plan`) → Phase 2 (execution) transition without hitting the `stream-json` slash-command ban, and naturally hosts post-turn `git diff` checks, manifest hot-reloads, and unlimited human-wait pauses between turns. If using **Mode B**, launch as `agy --input-format stream-json --output-format stream-json --sandbox` (no `-p`), send `{"event":"user","message":{"content":"..."}}`, and strictly await `result` before writing the next turn. |
| **Judge** | Long-lived Sonnet SDK session (`src/loop/judge-sdk.ts`) | **Mode A single-shot (`agy -p --output-format json --json-schema <schema.json> --print-timeout 150s`)** | `buildJudgeMessage()` (`src/judge/input.ts#L16-L26`) already sends the full manifest, playbook entry, context files, `<decisions_so_far>`, and `<recent_transcript>` on **every call**. Single-shot Mode A with `--json-schema` guarantees valid `JudgeResult` JSON on `result.structured_output`, eliminates context drift, and maps 1:1 to `src/eval-real.ts`. |

### Concrete Protocol Mismatches & Gotchas

1. **Mode B flag exclusion & wire format:** Never pass `-p` alongside `--input-format stream-json` (ignored); always pair `--input-format stream-json` with `--output-format stream-json` (pairing with `json`/`text` drops intermediate turns); `stdin` expects `{"event": "user", "message": {"content": "..."}}` and must wait for `result` before sending the next turn.
2. **Slash commands break `stream-json`:** Sending `/model`, `/usage`, or `/plan` inside `stream-json` aborts/errors the stream. `src/run.ts#L109` tells Kin to read `/usage` for the §12 row—under `agy`, run `/usage` separately and guard `human.followUp()` against leading `/` commands.
3. **Cumulative session counters:** In multi-turn sessions, `num_turns`, `duration_seconds`, and `usage` (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `total_tokens`) are **cumulative across the entire session**, while `result.response` is per-turn. Compute deltas (`current - previous`) for per-turn logging.
4. **Strict `--model` validation (no fallback):** Unverified model IDs exit non-zero immediately. Task manifests contain `"opus"` / `"sonnet"` (`src/playbook.ts#L119`, `_template.yaml#L13`), so the runner must map and validate against `agy models` upfront (or omit `--model` to use the CLI default).
5. **No `--system-prompt` or `settingSources: []` CLI flags:**
   - Worker: `agy` loads `AGENTS.md` / `GEMINI.md`, **not** `CLAUDE.md`. Target repo needs a lightweight `AGENTS.md` referencing `CLAUDE.md`.
   - Judge: Run `AgyJudge` in `logs/agy-judge-cwd/` with its own empty `.git` directory (halting upward rule discovery) and `AGENTS.md` containing `JUDGE_SYSTEM_PROMPT` (or prepend it to the prompt).
6. **Timeouts & missing `--max-turns`:** `agy` exposes no top-level `--max-turns` flag. Use `--print-timeout` (Mode A) plus outer `child_process` timers (`SIGTERM` → `SIGKILL`) for the 150s judge cap and 8h run cap.
7. **Session resumption:** Claude's `session_id` + `options.resume` maps to `agy`'s conversation ID from `init`/`result` + `--conversation <id>` (or `-c`/`--continue`).
8. **Google AI Pro rate limits (rolling 5h + weekly shared pool):** Running both Worker and Judge on `agy` draws from the same quota pool, and thinking tokens count heavily. Forbid parallel subagents in `AGENTS.md`, use a lighter model + `--effort low` for the Judge, and lean on deterministic rules to minimize Judge calls.
9. **Sandbox vs. Local Supabase / Docker:** `item-tracker` DB tasks execute `npx supabase test db`, `npx supabase db reset`, `docker exec ... psql`, and `curl -I http://127.0.0.1:3000` (`src/playbook.ts#L143-L153`). macOS Seatbelt (`--sandbox`) may block Docker sockets and localhost calls—verify early and prepare scoped `permissions.allow`/`deny` fallback for DB tasks.

---

## 4. Strategic Verdict: Adapt vs. Rewrite vs. Build Separate

| Dimension | Option A — Adapt In-Place (`AgentRunner`) | Option B — Partial/Full Rewrite | Option C — Separate Lightweight Runner |
| --- | --- | --- | --- |
| **Approach** | Add `ClaudeRunner` + `AntigravityRunner` behind an `AgentRunner` interface inside `src/run.ts` & `src/loop/supervisor.ts`. | Refactor `Supervisor` around a provider-agnostic turn loop + external hooks/permissions for both CLIs. | Leave all Claude files (`src/run.ts`, `supervisor.ts`, `judge-sdk.ts`, `queue.ts`, `hook-shadow.ts`, all 47 tests) **100% untouched**. Build a minimal standalone `src/agy/` runner importing reusable pure modules (`Policy`, `manifest`, `state-store`, `judge/*`, `human`, `notify`). |
| **Architectural Fit** | **Poor (leaky abstraction).** `Supervisor.canUseTool` assumes synchronous in-process mid-turn interception + `updatedInput` mutation, which `agy` headless lacks. | **Over-engineered & regressive for Claude.** Downgrades Claude to turn-boundary pauses, discarding Claude SDK's strongest feature (`canUseTool`). | **High.** Embraces `agy`'s native lifecycle (Mode A + `--conversation`, 2-phase plan→execute, Mode A `--json-schema` judge, scoped `settings.json` + post-turn git audit). |
| **Estimated Effort** | **3–5 days** (interface refactoring, IPC/hook plumbing, test churn). | **1–2+ weeks** (full redesign + re-verification). | **1–2 days** (~250–350 LOC across 5 small new files). |
| **Risk** | **High** — risks breaking an untested-in-production Claude supervisor (`STEP3.md#L59`); fail-open hook hazards if blocking inside `PreToolUse`. | **High** — sunk cost for a temporary outage; degrades Claude UX. | **Low** — zero blast radius on Claude code; fail-closed turn-boundary human pauses; trivially removable later. |
| **Return to Claude** | Must maintain or unwind dual-runner abstractions. | Permanently altered Claude loop. | **Instant** (`npm run supervise` remains completely untouched). |

### Final Recommendation

- **Short-term workaround (Claude temporarily unavailable) → Choose Option C (Separate Lightweight Runner).**
  Adapting `src/loop/supervisor.ts` and `src/run.ts` in-place is genuinely over-engineered for a temporary bridge. Building a standalone ~300-LOC `src/agy/` runner that imports the existing pure modules gives you rapid turnaround, zero regression risk to the Claude supervisor, and clean alignment with `agy`'s actual headless protocol.
- **Long-term multi-provider setup (only if you later commit to running Claude + Antigravity permanently):**
  Do **not** force both runtimes behind one lowest-common-denominator `AgentRunner` interface. Evolve Option C by moving the shared core (`policy.ts` + tool normalizer, `manifest.ts`, `playbook.ts`, `state-store.ts`, `judge/*`, `human.ts`, `notify.ts`) into `src/core/`, with two idiomatic runtime adapters (`src/runners/claude/` using `canUseTool`, and `src/runners/agy/` using turn-boundary orchestration + permissions/hooks).

---

## 5. Action Plan, Blockers & Rollback Path (Option C)

### Step 0 — Mandatory 15-Minute Prerequisites & Verification Gates (Before Coding)

1. **Install & verify `agy` globally:**
   ```bash
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   which agy && agy --version && agy --help
   agy models
   ```
   Verify `--input-format`, `--output-format`, `--sandbox`, `--print-timeout`, `--json-schema`, and `--conversation` are present. Launch `agy` interactively once to cache Google AI Pro OAuth in macOS Keychain and trust the `item-tracker` folder.
2. **Gate 0A (Hooks in Headless Mode):** Test whether `.agents/hooks.json` `PreToolUse` fires and overrides `request-review` in `agy -p --output-format stream-json`. Record exact `toolCall.name` and `toolCall.args` keys for `normalize.ts`.
   - *If YES:* Build full Option C with `src/agy/hook.ts` (deny-to-pause pattern).
   - *If NO:* Skip `src/agy/hook.ts`; rely on generated scoped `permissions.allow`/`deny` + `--sandbox` + post-turn `git diff`/`git log` auditing + git rollback.
3. **Gate 0B (Sandbox vs. Local Docker/Supabase):** Test `agy --sandbox -p "curl -I http://127.0.0.1:54321"` and `npx supabase status` to confirm whether DB tasks can run inside `--sandbox` or require scoped `permissions.allow`/`deny` without `--sandbox`.
4. **Gate 0C (Target Project Repo — Part B Audit):** Run a quick read-only audit of `item-tracker` to inventory `CLAUDE.md`, `.claude/skills/`, `.claude/commands/`, `.mcp.json`, and exact shell/directory/URL allow-lists.

### Minimal File Blueprint (Zero Edits to Existing Claude Files)

Add a self-contained `src/agy/` directory (plus 3 scripts in `package.json`: `supervise:agy`, `eval:judge:agy`, `smoke:agy`):

1. **`src/agy/normalize.ts`** (~45 LOC)
   - Maps `agy` tool names/args into canonical `ToolCall` (`run_command` → `Bash`, `write_file`/`edit_file`/`replace_file_content` → `Edit`/`Write`, `read_file`/`view_file` → `Read`, `ask_question` → `AskUserQuestion`).
   - Applies an `agy`-specific config overlay adding `AGENTS.md`, `GEMINI.md`, `.agents/**` to `human_paths` and `~/.gemini/antigravity-cli/brain/**` to `scratch` without editing `src/policy.ts`.
2. **`src/agy/hook.ts`** (~80 LOC — *only if Gate 0A passes*)
   - Registered in `<item-tracker>/.agents/hooks.json` (`PreToolUse` + `PostToolUse`, `timeout: 10`).
   - **Never blocks for LLM or human input** (eliminating fail-open timeout risk):
     - `allow` (or matching 1-shot `approvedOnce` token in `logs/agy-state-<task>.json`) → `{"decision":"allow"}`.
     - `deny` (1st time) → `{"decision":"deny","reason":v.redirect}`.
     - `ask_judge`, `human`, `failures >= 2`, or `denies >= 2` → writes `logs/agy-pending-<task>.json` and returns `{"decision":"deny","reason":"SUPERVISOR_PAUSE: requires approval. Stop your turn immediately without workarounds."}`.
   - `PostToolUse` updates `policy.observe(command)` and failure counts in `logs/agy-state-<task>.json`.
3. **`src/agy/judge-schema.json`** (~30 LOC)
   - Strict JSON Schema matching `JudgeResult` (`src/judge/schema.ts#L1-L3`).
4. **`src/agy/judge.ts`** (~55 LOC) — Implements `Judge` (`src/loop/judge-sdk.ts#L5`)
   - Runs Mode A single-shot: `agy -p --output-format json --json-schema src/agy/judge-schema.json --print-timeout 150s --effort low [--model <verified-slug>]` inside isolated `logs/agy-judge-cwd/` (empty `.git` + `AGENTS.md` with `JUDGE_SYSTEM_PROMPT`).
   - Enables `npm run eval:judge:agy` against all 40 cases in `data/judge-examples.json` **before** any live task run.
5. **`src/agy/run.ts`** (~150 LOC) — Outer turn-based supervisor loop
   - Reuses `loadManifest`, `loadConfig`, `startBlockers`, `loadRepoContext`, `TerminalHuman`, `notify`, `guard`, `buildJudgeMessage`.
   - **Phase 1 (Plan):** Runs `agy -p --mode=plan --output-format stream-json --print-timeout 10m` → captures `conversation_id` & `result.response` → routes plan to `AgyJudge` (`skipTopics: "all"`) / `TerminalHuman` → iterates via `--conversation <id>` until approved.
   - **Phase 2 (Execute):** Runs `agy -p --conversation <id> --output-format stream-json --print-timeout 10m` (with 8h outer deadline + cumulative-to-delta usage logging + validated `--model` mapping).
   - **Post-turn verification & escalation loop:**
     1. Run `git status --porcelain` & `git diff --name-only` — halt & alert Kin immediately if any `config.frozen` or `human_paths` file changed (catches fail-open breaches; offers git rollback).
     2. If `logs/agy-pending-<task>.json` exists → run `AgyJudge` (15-call cap + frustration flag) or `TerminalHuman` + `notify`. On approve, write 1-shot `approvedOnce` token and resume `--conversation <id>`; on revise/deny, resume with instruction.
     3. Otherwise show `checkpoint_after` reminder and prompt `human.followUp()` (rejecting accidental `/` slash commands).
6. **Target-repo & CLI static backstop config (external to `supervisor`):**
   - Scoped `permissions.deny` in `~/.gemini/antigravity-cli/settings.json` for catastrophic ops (`command(git push*)`, `command(netlify*)`, `command(gh pr*)`, `command(gh workflow*)`, `command(npx supabase link*)`, `command(npx supabase db push*)`, `command(npm audit fix*)`, `write_file(design/)`, `write_file(src/components/ui/)`, `write_file(src/dev/)`, `write_file(.agents/)`). Do **not** set global `always-proceed`.
   - Branch-local/untracked `<item-tracker>/AGENTS.md` instructing `agy` to read `CLAUDE.md`, forbid parallel subagents, output questions as plain text (instead of interactive prompts), and stop immediately upon `SUPERVISOR_PAUSE`.

### Top Risks & Mitigations

| Risk / Blocker | Severity | Mitigation |
| --- | --- | --- |
| **1. `PreToolUse` hooks don't override headless `request-review` (or fail open)** | High | Verify in Gate 0A before coding; never wait on LLM/human inside a hook; enforce catastrophic blocks in `settings.json` `permissions.deny`; run post-turn `git diff --name-only` audit + git rollback prompt after every turn. |
| **2. Worker modifies `.agents/hooks.json` or `AGENTS.md`** | High | Block `.agents/**`, `AGENTS.md`, `GEMINI.md` in both `settings.json` `permissions.deny` and `normalize.ts` / `guard.ts`. |
| **3. Gemini Judge safety calibration unknown on Kin's 40 past cases** | Medium | Run `eval:judge:agy` over `data/judge-examples.json` first; verify `unsafe === 0` before enabling auto-judge (or run with `--max-judge-calls 0` human-only mode for the first task). |
| **4. Google AI Pro rolling 5h / weekly quota exhaustion** | Medium | Use lightest verified model + `--effort low` for Judge, ban parallel subagents in `AGENTS.md`, check `/usage` interactively between tasks, and keep deterministic rules handling routine calls. |
| **5. Global `settings.json` bleeding into Antigravity 2.0 Desktop** | Medium | Never enable global `always-proceed`; use narrow scoped `permissions.allow`/`deny` + `--sandbox`. |
| **6. `--sandbox` blocking Docker / local Supabase on DB tasks** | Medium | Verify in Gate 0B; if blocked, use scoped `permissions.allow`/`deny` + `hook.ts` + post-turn git checks for DB tasks while keeping `--sandbox` on frontend/docs tasks. |
| **7. Cached OAuth keychain session expiring mid-run** | Low–Med | Detect non-zero exit + auth error on `stderr`, notify Kin via `notify()`, and halt cleanly for interactive re-login (`agy`). |

### Clean Rollback Path Back to Claude Code

Because Option C leaves every existing file in `src/` and `test/` untouched:
1. Remove temporary `<item-tracker>/.agents/hooks.json` and `<item-tracker>/AGENTS.md` (plus any temporary `permissions.allow` entries in `~/.gemini/antigravity-cli/settings.json`).
2. Resume normal execution immediately with:
   ```bash
   npm run supervise -- projects/item-tracker/tasks/<id>.yaml --repo <path> "<prompt>"
   ```
3. All task manifests (`projects/item-tracker/tasks/*.yaml`), `config.yaml` updates, and `Policy` refinements carry over with zero rework.

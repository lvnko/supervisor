# Supervisor — Step 1: rule engine

Decides, in code, what happens to each request from Claude Code. No AI involved yet.

Verdicts: `allow`, `deny` (with a redirect message for the worker), `ask_judge`, `human`.
The most restrictive verdict in a multi-part command wins.

## Run
    npm install
    npm test
    npm run check -- projects/item-tracker projects/item-tracker/tasks/_template.yaml "git add -A"

## Layout
- `src/policy.ts` — the rules (Bash and other tools)
- `src/shell.ts` — quote-aware command splitting
- `src/manifest.ts` — loads task manifest and project config
- `projects/item-tracker/config.yaml` — frozen / protected / judge-reviewed paths
- `projects/item-tracker/tasks/_template.yaml` — copy per playbook task
- `test/policy.test.ts` — fixtures from real commands in your transcripts

## Known limits
- Heredoc/subshell commands go to the judge, except `git commit` with a heredoc message.
- Staging state is tracked in memory per run; a restart clears it (commits then go to the judge).
- Rules are tuned to your Item Tracker repo; check `policy.ts` before reusing elsewhere.

## Step 2 additions
- `npm run draft -- <path/to/build-playbook.md> <task-id>` prints a DRAFT task manifest from the playbook's Build/Read lines. Review it, save as `projects/item-tracker/tasks/<id>.yaml`.
- `src/judge/prompt.ts` — the judge's instructions (Kin's preferences + always-escalate list).
- `src/judge/schema.ts` — validates the judge's JSON; anything malformed becomes an escalation.
- `src/judge/guard.ts` — code-side safety net: forces escalation on always-escalate topics or a second identical failure, whatever the judge says.
- `src/judge/input.ts` — builds the message the judge sees (manifest, playbook entry, context files, transcript, request).
- `src/judge/eval.ts` + `data/judge-examples.json` — scores a judge against your 40 past cases. Only a stub has run so far; the real model run comes with Step 3 (the SDK loop).

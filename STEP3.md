# Step 3: shadow mode and the live loop

## 0. Install and check (after unzipping over the old folder)
    cd supervisor
    npm install && npm test
    unset ANTHROPIC_API_KEY
    npm run smoke
`npm run smoke` makes two tiny real calls (a judge answer, a worker file write) and prints SMOKE TEST PASSED.
It uses your Pro plan. If it says ANTHROPIC_API_KEY is set, unset it, or you'd be billed per token.

## 1. Shadow mode (start here: it decides nothing)
Shadow mode runs inside your normal Claude Code. A small hook writes down what the supervisor WOULD have decided,
and whether Claude Code asked you, and whether the command ran. You keep clicking as today.

Setup, per task:
1. `npm run draft -- <path>/docs/build-playbook.md <id> --write`, fill in the TODO lines (commit paths, versions).
2. `npm run task:use -- <id>`   (tells the hook which task is active)
3. Register the hook once in the item-tracker repo's `.claude/settings.local.json` (see `shadow-hook-settings.json`;
   replace /ABS/PATH/TO/supervisor with the real folder). Easiest: ask Claude Code to merge it for you and show you the diff first.
4. Work as usual. After a task: `npm run shadow:report`.

Read the report like this:
- "Would be approved automatically, but Claude Code asked you": clicks the supervisor would have saved.
- "Would be BLOCKED, yet it ran": you approved something the rules would refuse. Either the rule is too strict
  (tell me) or you caught something worth keeping a rule for.
- "Would be sent to you / to the judge": what would have interrupted you.

### Stopping shadow mode
- Pause (keeps the hook installed): `rm projects/item-tracker/active-task.txt`. The hook then does nothing. `npm run task:use -- <id>` resumes it.
- Remove completely: ask Claude Code to delete the `hooks` block from the item-tracker repo's `.claude/settings.local.json` (show the diff first).
- Start a clean log for the next task: `mv logs/shadow.jsonl logs/shadow-<id>.jsonl`, or filter one task: `npm run shadow:report -- --task 1.1`.

## 2. Live mode (the supervisor answers for you)
    npm run supervise -- projects/item-tracker/tasks/<id>.yaml --repo ~/path/to/item-tracker "<your first message, e.g. T1>"
- Starts the worker in plan mode (`--mode default` to skip). Uses your item-tracker settings and CLAUDE.md.
- Refuses to start while `manual_setup` is outstanding (`setup_done: false`).
- Routine requests are answered by the rules. Plans, questions and unclear commands go to the Sonnet judge.
- When it needs you, a card appears in the terminal and you get a macOS notification
  (and a phone push if you set `NTFY_TOPIC=your-secret-topic` and subscribe to it in the ntfy app).
- At the card: `a` approve, `d` deny, or type an instruction, which goes to the worker as your answer.
- When the worker finishes a turn you can type a follow-up, or press Enter to end.
- Limits: 15 judge calls per task (then everything comes to you), stops after 8 hours,
  the same step failing twice always comes to you.
- Logs: `logs/run-<id>-*.jsonl`. State (staged files, commits done) persists in `logs/state-<id>.json`.

Before the first live run:
- Remove `Bash(git add *)` from `.claude/settings.local.json` (Step 0, A1). While it's there, Claude Code approves
  every `git add` before the supervisor sees it, so the commit check can't work.
- Run a low-risk task first (docs-only), then compare with shadow results.

## 3. Check the judge against your past answers
    npm run eval:judge
Runs your 40 past cases through the real Sonnet judge, one fresh session each (about 10 to 15 minutes, uses your allowance).
Prints agreement, "unsafe" cases (judge would have auto-handled something you wanted to see) and "over-cautious" cases.

## Not built yet
- CI watcher (decision 18) and the local web inbox (decision 17, later).
- The "human gate" prompt for steps only you can do, apart from the start check.
- Tested here with fakes (47 tests) and one real smoke run. Not yet run on a real playbook task.

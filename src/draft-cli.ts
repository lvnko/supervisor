// npm run draft -- <playbook.md> <task-id>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { draftFromTask, parsePlaybook, renderManifest } from "./playbook.js";
const [file, id] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!file || !id) { console.error("usage: npm run draft -- <build-playbook.md> <task-id> [--write]"); process.exit(2); }
const task = parsePlaybook(readFileSync(file, "utf8")).find((t) => t.id === id);
if (!task) { console.error(`task ${id} not found`); process.exit(1); }
const out = renderManifest(task, draftFromTask(task));
if (process.argv.includes("--write")) {
  const target = `projects/item-tracker/tasks/${id}.yaml`;
  if (existsSync(target)) { console.error(`${target} already exists; not overwriting. Delete it first if you want a fresh draft.`); process.exit(1); }
  writeFileSync(target, out);
  console.error(`wrote ${target} — open it, fix the TODO lines, and review before use.`);
} else process.stdout.write(out);

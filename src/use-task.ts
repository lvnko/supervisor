// npm run task:use -- <task-id>   makes <task-id> the active task for the shadow hook.
import { existsSync, writeFileSync } from "node:fs";
const id = process.argv[2];
const project = process.env.SUPERVISOR_PROJECT ?? "item-tracker";
if (!id) { console.error("usage: npm run task:use -- <task-id>"); process.exit(2); }
if (!existsSync(`projects/${project}/tasks/${id}.yaml`)) { console.error(`projects/${project}/tasks/${id}.yaml not found; run npm run draft -- <playbook> ${id} --write first`); process.exit(1); }
writeFileSync(`projects/${project}/active-task.txt`, id + "\n");
console.log(`active task: ${id}`);

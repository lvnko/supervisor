#!/usr/bin/env tsx
// Usage: npm run check -- <project-dir> <task.yaml> "<bash command>"
//        npm run check -- <project-dir> <task.yaml> --tool Edit '{"file_path":"design/x.css"}'
import { loadConfig, loadManifest } from "./manifest.js";
import { Policy } from "./policy.js";

const [dir, taskFile, ...rest] = process.argv.slice(2);
if (!dir || !taskFile || !rest.length) {
  console.error('usage: npm run check -- <project-dir> <task.yaml> "<command>" | --tool <Name> \'<json input>\'');
  process.exit(2);
}
const policy = new Policy(loadManifest(taskFile), loadConfig(`${dir}/config.yaml`));
const v = rest[0] === "--tool"
  ? policy.evaluate({ tool: rest[1], input: JSON.parse(rest[2] ?? "{}") })
  : policy.evaluate({ tool: "Bash", input: { command: rest.join(" ") } });
console.log(JSON.stringify(v, null, 2));

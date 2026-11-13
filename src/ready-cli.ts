// npm run ready -- <task.yaml>   exits 1 if manual setup is outstanding
import { loadManifest, startBlockers } from "./manifest.js";
const m = loadManifest(process.argv[2] ?? "");
const b = startBlockers(m);
if (b.length) { console.error(["NOT READY to start task " + m.task, ...b].join("\n")); process.exit(1); }
console.log(`task ${m.task}: ready to start${m.checkpoint_after ? " (after it: " + m.checkpoint_after + ")" : ""}`);

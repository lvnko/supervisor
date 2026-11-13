import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePlaybook } from "../playbook.js";
import type { Manifest } from "../types.js";

export interface RepoContext { contextFiles: { path: string; text: string }[]; playbookEntry: string; }

/** Reads the manifest's context lists (and the task's playbook entry) from the project repo. Missing files are skipped, not fatal. */
export function loadRepoContext(repo: string, m: Manifest): RepoContext {
  const rd = (p: string) => { const f = join(repo, p); return existsSync(f) ? readFileSync(f, "utf8") : null; };
  const always = [...new Set(["CLAUDE.md", ...(m.context?.always ?? [])])];
  const reference = (m.context?.reference ?? []).filter((p) => !always.includes(p));
  const contextFiles: { path: string; text: string }[] = [];
  for (const p of always) { const t = rd(p); if (t) contextFiles.push({ path: p, text: t }); }
  // reference files can be long: the judge only gets their first part. It can ask the worker to cite sections.
  for (const p of reference) { const t = rd(p); if (t) contextFiles.push({ path: p, text: t.slice(0, 12000) }); }
  const pb = rd("docs/build-playbook.md");
  const task = pb ? parsePlaybook(pb).find((t) => t.id === m.task) : undefined;
  const playbookEntry = task ? `Task ${task.id} ${task.title} (${task.model})\nGoal: ${task.goal}\nRead: ${task.read}\nBuild: ${task.build}\nDone when: ${task.doneWhen}` : `(no playbook entry found for ${m.task})`;
  return { contextFiles, playbookEntry };
}

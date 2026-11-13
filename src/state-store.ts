import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newState, type State } from "./policy.js";

interface Saved { staged: string[]; commitsDone: number; done?: number[]; dryRun: string[]; }

/** Policy state has to survive between hook processes, so it lives in a small JSON file per task. */
export function loadState(file: string): State {
  if (!existsSync(file)) return newState();
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Saved;
    return { staged: new Set(s.staged ?? []), commitsDone: s.commitsDone ?? 0, done: new Set(s.done ?? []), dryRun: new Set(s.dryRun ?? []) };
  } catch { return newState(); }
}
export function saveState(file: string, s: State): void {
  mkdirSync(dirname(file), { recursive: true });
  const out: Saved = { staged: [...s.staged], commitsDone: s.commitsDone, done: [...s.done], dryRun: [...s.dryRun] };
  writeFileSync(file, JSON.stringify(out, null, 1));
}

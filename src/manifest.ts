import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Config, Manifest } from "./types.js";

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function parseManifest(text: string): Manifest {
  const y = (parse(text) ?? {}) as Record<string, any>;
  return {
    task: String(y.task ?? "unknown"),
    edits: arr(y.edits),
    commits: Array.isArray(y.commits)
      ? y.commits.map((c: any) => ({ message: String(c.message ?? ""), paths: arr(c.paths) }))
      : [],
    packages: arr(y.packages),
    deletions: arr(y.deletions),
    preapproved: arr(y.preapproved),
    gates: arr(y.gates),
    human_gates: arr(y.human_gates),
    manual_setup: arr(y.manual_setup),
    setup_done: y.setup_done === true,
    model: y.model ? String(y.model).toLowerCase() : "",
    checkpoint_after: y.checkpoint_after ? String(y.checkpoint_after) : "",
    context: y.context ? { always: arr(y.context.always), reference: arr(y.context.reference) } : undefined,
  };
}
export const loadManifest = (file: string) => parseManifest(readFileSync(file, "utf8"));

export function parseConfig(text: string): Config {
  const y = (parse(text) ?? {}) as Record<string, any>;
  return { frozen: arr(y.frozen), human_paths: arr(y.human_paths), judge_paths: arr(y.judge_paths), scratch: arr(y.scratch) };
}
export const loadConfig = (file: string) => parseConfig(readFileSync(file, "utf8"));

/** Reasons the supervisor must not start this task yet. */
export function startBlockers(m: Manifest): string[] {
  return m.manual_setup.length && !m.setup_done
    ? ["Manual setup is not marked done (setup_done: false):", ...m.manual_setup]
    : [];
}

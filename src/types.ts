export type Verdict =
  | { kind: "allow"; reason: string }
  | { kind: "deny"; reason: string; redirect: string }
  | { kind: "ask_judge"; reason: string }
  | { kind: "human"; reason: string };

export interface CommitSpec { message: string; paths: string[]; }

export interface Manifest {
  task: string;
  edits: string[];            // globs the worker may edit
  commits: CommitSpec[];      // expected commits, in order
  packages: string[];         // exact "name@version" allowed to install
  deletions: string[];        // paths allowed to be removed
  preapproved: string[];      // regexes (full-command) pre-approved for this task
  gates: string[];            // local-destructive commands this task allows, e.g. "supabase db reset"
  human_gates: string[];      // steps only Kin can do
  manual_setup: string[];     // Kin's setup before the task starts
  setup_done: boolean;        // the supervisor refuses to start while this is false and manual_setup is non-empty
  model: string;              // worker model: "opus" or "sonnet" (from the playbook's Model line); empty = Claude Code default
  checkpoint_after: string;   // e.g. "Checkpoint 0 (§6)." shown when the task ends
  context?: { always: string[]; reference: string[] };
}

export interface Config {
  frozen: string[];           // globs: never edit
  human_paths: string[];      // globs: Kin decides
  judge_paths: string[];      // globs: judge decides unless in manifest
  scratch?: string[];         // extra path prefixes where shell redirection is harmless
}

export interface ToolCall { tool: string; input: Record<string, unknown>; }

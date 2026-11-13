import { matchAny } from "./glob.js";
import { parseShell, words } from "./shell.js";
import type { Config, Manifest, ToolCall, Verdict } from "./types.js";

const allow = (reason: string): Verdict => ({ kind: "allow", reason });
const deny = (reason: string, redirect: string): Verdict => ({ kind: "deny", reason, redirect });
const judge = (reason: string): Verdict => ({ kind: "ask_judge", reason });
const human = (reason: string): Verdict => ({ kind: "human", reason });

const RANK = { allow: 0, ask_judge: 1, human: 2, deny: 3 } as const;
/** Most restrictive verdict wins. */
function worst(vs: Verdict[]): Verdict {
  return vs.reduce((a, b) => (RANK[b.kind] > RANK[a.kind] ? b : a));
}

const READ_ONLY = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "pwd", "echo", "sort", "uniq", "diff", "stat",
  "file", "which", "tree", "cut", "tr", "jq", "date", "basename", "dirname", "realpath", "test",
  "true", "false", "[", "cd", "printf", "nl", "du", "comm", "column", "less", "more",
]);
const SAFE_SCRIPTS = new Set(["typecheck", "lint", "test", "build", "ds:compare", "db:test"]);
const DOC_DOMAINS = ["supabase.com", "docs.netlify.com", "docs.github.com", "www.npmjs.com", "npmjs.com"];
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;
const isEnvFile = (w: string) => /(^|\/)\.env(\.[\w.-]+)?$/.test(w) && !/\.env\.example$/.test(w);

export interface State {
  staged: Set<string>;
  commitsDone: number;      // how many planned commits are done (= done.size)
  done: Set<number>;        // indexes of manifest commits already made (order does not matter)
  dryRun: Set<string>;   // package specs that passed a dry-run
}
export const cloneState = (s: State): State => ({ staged: new Set(s.staged), commitsDone: s.commitsDone, done: new Set(s.done), dryRun: new Set(s.dryRun) });
export const newState = (): State => ({ staged: new Set(), commitsDone: 0, done: new Set(), dryRun: new Set() });

export class Policy {
  constructor(
    public manifest: Manifest,
    public config: Config,
    public state: State = newState(),
    public root = "",
  ) {}

  evaluate(call: ToolCall): Verdict {
    return call.tool === "Bash" ? this.bash(String(call.input.command ?? "")) : this.tool(call);
  }

  // ---------- non-Bash tools ----------
  private rel(p: string): string {
    let x = p;
    if (this.root && x.startsWith(this.root)) x = x.slice(this.root.length);
    return x.replace(/^\.?\/+/, "").replace(/^\.\//, "");
  }

  private tool(call: ToolCall): Verdict {
    const t = call.tool, i = call.input;
    const path = String(i.file_path ?? i.path ?? i.notebook_path ?? "");
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(t)) {
      const outside = path.startsWith("/") && !(this.root && path.startsWith(this.root));
      if (outside && this.isScratch(path)) return allow("scratch file outside the repo");
      const p = this.rel(path);
      if (matchAny(this.config.frozen, p)) return deny(`frozen path ${p}`, `${p} is frozen. Don't edit it. Report the need instead.`);
      if (matchAny(this.config.human_paths, p)) return human(`${p} is a protected file`);
      if (isEnvFile(p)) return human(`.env file ${p}`);
      if (matchAny(this.manifest.edits, p)) return allow(`${p} is in the task manifest`);
      if (matchAny(this.config.judge_paths, p)) return judge(`${p} is sensitive config and not in the manifest`);
      return judge(`${p} is outside the manifest edit list`);
    }
    if (t === "Read" || t === "Glob" || t === "Grep") {
      if (isEnvFile(path)) return human("reading a .env file");
      return allow("read-only");
    }
    if (t === "WebFetch") {
      try {
        const h = new URL(String(i.url)).hostname;
        if (DOC_DOMAINS.some((d) => h === d || h.endsWith("." + d))) return allow(`docs domain ${h}`);
      } catch { /* fall through */ }
      return judge("web fetch outside the docs allow-list");
    }
    if (t === "WebSearch") return allow("search");
    if (["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "Task", "Agent"].includes(t)) return allow("planning tool");
    if (t === "ExitPlanMode") return judge("plan review");
    if (t === "AskUserQuestion") return judge("question from worker");
    if (t === "ToolSearch") return allow("looks up tool definitions, read-only");
    return judge(`unknown tool ${t}`);
  }

  // ---------- Bash ----------
  bash(command: string): Verdict {
    const cmd = command.trim();
    if (!cmd) return allow("empty");
    if (/\$\{?PIPESTATUS|\bPIPESTATUS\[/.test(cmd)) return deny("PIPESTATUS is bash-only", "The shell is zsh. Run each check as its own command and print $?.");

    const snap = cloneState(this.state);
    const parsed = parseShell(cmd);

    // Global flag denies work even inside heredocs / complex commands.
    const g = this.globalDeny(cmd);
    if (g) return g;

    // A pre-approved pattern must match a WHOLE command (or whole segment), and never overrides a hard deny.
    const wholePre = this.preapproved(cmd);
    if (wholePre) {
      const hard = parsed.segments.map((s) => this.segment(words(s), s)).find((v) => v.kind === "deny");
      this.state = snap;
      if (hard) return hard;
      return allow(`pre-approved by manifest: ${wholePre}`);
    }

    // git commit with a heredoc message is the one complex form we understand.
    if (parsed.heredoc || parsed.complex) {
      const c = this.complexCommit(cmd);
      if (c) {
        if (c.kind === "allow") this.markCommit(this.heredocMessage(cmd));
        return c;
      }
      return judge("heredoc, subshell or substitution: needs a read");
    }

    if (parsed.segments.length === 0) return allow("empty");
    const vars = new Map<string, string>();
    const vs = parsed.segments.map((s) => {
      let w = words(s).map((x) => x.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => vars.get(a ?? b) ?? m));
      const assigns = w.filter((x) => /^[A-Za-z_]\w*=/.test(x));
      if (assigns.length && assigns.length === w.length) { assigns.forEach((x) => vars.set(x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1))); return allow("assignment"); }
      let v = this.segment(w, s);
      const pre = v.kind === "deny" ? null : this.preapproved(s);
      if (pre) v = allow(`pre-approved by manifest: ${pre}`);
      return v;
    });
    let v = worst(vs);
    if (v.kind === "allow" && parsed.redirectsToFile && !parsed.redirectTargets.every((t) => this.isScratch(t)))
      v = judge("writes to a file via redirection");
    if (v.kind === "allow") this.commit(parsed.segments);
    else this.state = snap; // nothing ran, undo staging bookkeeping
    return v;
  }

  /** perl is allowed only as a read-only filter: -n/-p-free one-liner that prints matches, no -i, nothing that runs, writes or deletes. */
  private perl(args: string[]): Verdict {
    const flagWithE = args.findIndex((a) => /^-[a-zA-Z]*e$/.test(a));
    if (flagWithE < 0 || args.some((a) => /^-[a-zA-Z]*[ipx]/.test(a) && !/^-[nlaw]*e?$/.test(a)) || args.some((a) => /^-[a-zA-Z]*i/.test(a)))
      return judge("perl can run or write arbitrary things");
    const script = args[flagWithE + 1] ?? "";
    if (/\b(system|exec|open|close|unlink|rename|mkdir|rmdir|qx|require|eval|fork|kill|syswrite|truncate|chmod|chown|print\s*\{?\s*(STDERR|STDOUT)?\s*>)\b|`|%ENV|\$ENV|__END__|<\s*STDIN|>\s*[\w"'$]/.test(script))
      return judge("perl script does more than filter and print");
    return allow("perl one-liner, read-only filter");
  }

  private isScratch(t: string): boolean {
    const defaults = [/^\/tmp\//, /^\/private\/tmp\//, /^\/var\/folders\//, /^\$TMPDIR\//, /^\$\{TMPDIR\}\//, /^\[SCRATCH\]\//,
      /^(\/Users\/[^/]+|\/home\/[^/]+|~)\/\.claude\/plans\/[^/]+\.md$/];   // Claude Code's own plan files
    return defaults.some((r) => r.test(t)) || (this.config.scratch ?? []).some((pre) => t.startsWith(pre));
  }

  /** Update staging bookkeeping for a command that actually ran, whatever the verdict was (used by the shadow hook). */
  observe(command: string): void {
    for (const seg of parseShell(command).segments) {
      const w = gitWords(words(seg));
      if (w[0] === "git" && w[1] === "add") {
        for (const f of w.slice(2).filter((x) => !x.startsWith("-"))) {
          const p = f.replace(/^\.\//, "").replace(/\/$/, "");
          const under = this.pendingPaths().filter((x) => x.startsWith(p + "/"));
          if (under.length) under.forEach((x) => this.state.staged.add(x)); else this.state.staged.add(p);
        }
      } else if (w[0] === "git" && w[1] === "commit") { this.markCommit(this.commitMessage(command, w)); }
      else if (w[0] === "npm" && ["install", "i", "add"].includes(w[1]) && w.includes("--dry-run"))
        w.slice(2).filter((x) => !x.startsWith("-")).forEach((x) => this.state.dryRun.add(x));
    }
  }

  /** Manifest patterns match a whole command (or whole segment). Use `.*` for "any arguments". */
  private preapproved(cmd: string): string | null {
    for (const r of this.manifest.preapproved) {
      try { if (new RegExp("^(?:" + r + ")$").test(cmd.trim())) return r; } catch { /* bad regex ignored */ }
    }
    return null;
  }

  private globalDeny(cmd: string): Verdict | null {
    const ws = parseShell(cmd).segments.flatMap(words);
    const has = (f: string) => ws.includes(f);
    if (has("--no-verify")) return deny("--no-verify", "Never skip hooks. Fix the failing hook instead.");
    if (has("--force") || has("--force-with-lease")) return deny("--force", "Don't force. Report the conflict.");
    if (has("--legacy-peer-deps")) return deny("--legacy-peer-deps", "Don't use --legacy-peer-deps. Report the peer conflict.");
    if (has("--amend")) return deny("--amend", "No amend. Make a new commit if one is expected, otherwise report.");
    return null;
  }

  private complexCommit(cmd: string): Verdict | null {
    if (!/\bgit\s+commit\b/.test(cmd)) return null;
    if (/&&|;|\|\|/.test(cmd.replace(/<<'?EOF'?[\s\S]*?\nEOF/g, ""))) return null; // commit bundled with other work
    const m = cmd.match(/<<-?\s*'?"?(\w+)"?'?\n([\s\S]*?)\n\s*\1/);
    if (!m) return null;
    return this.checkCommitMessage(m[2].split("\n")[0].trim());
  }

  private pendingSpecs() { return this.manifest.commits.map((c, i) => ({ c, i })).filter(({ i }) => !this.state.done.has(i)); }
  private pendingPaths(): string[] { return this.pendingSpecs().flatMap(({ c }) => c.paths.map((p) => p.replace(/^\.\//, ""))); }

  private checkCommitMessage(first: string): Verdict {
    const hit = this.pendingSpecs().find(({ c }) => c.message.split("\n")[0].trim() === first);
    if (!hit) return judge(`commit "${first.slice(0, 60)}" is not one of the manifest's planned commits`);
    const want = new Set(hit.c.paths.map((p) => p.replace(/^\.\//, "")));
    const have = this.state.staged;
    if (have.size === 0) return judge("commit with no tracked staged list: can't verify paths");
    const extra = [...have].filter((p) => !want.has(p));
    const missing = [...want].filter((p) => !have.has(p));
    if (extra.length || missing.length)
      return judge(`staged list differs from manifest (extra: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`);
    return allow("commit matches manifest");
  }

  /** A commit ran: mark the matching planned commit done (if it was planned) and clear staging. */
  private markCommit(first: string | null) {
    const hit = first ? this.pendingSpecs().find(({ c }) => c.message.split("\n")[0].trim() === first) : undefined;
    if (hit) this.state.done.add(hit.i);
    this.state.commitsDone = this.state.done.size;
    this.state.staged.clear();
  }
  private heredocMessage(cmd: string): string | null {
    const m = cmd.match(/<<-?\s*'?"?(\w+)"?'?\n([\s\S]*?)\n\s*\1/);
    return m ? m[2].split("\n")[0].trim() : null;
  }
  private commitMessage(cmd: string, w: string[]): string | null {
    const i = w.findIndex((x) => x === "-m" || x === "--message");
    if (i >= 0 && w[i + 1]) return w[i + 1].split("\n")[0].trim();
    return this.heredocMessage(cmd);
  }

  private commit(segs: string[]) {
    for (const s of segs) {
      const w = gitWords(words(s));
      if (w[0] === "git" && w[1] === "commit") this.markCommit(this.commitMessage(s, w));
    }
  }

  private segment(w0: string[], raw: string): Verdict {
    let w = w0;
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    if (!w.length) return allow("assignment");
    const bin = w[0].replace(/^.*\//, "");
    const args = w.slice(1);

    // Secrets
    if (bin === "env" && args.length === 0 || bin === "printenv") return human("prints environment (may hold secrets)");
    if (bin === "echo" && args.some((a) => /\$\{?\w*/.test(a) && SECRET_NAME.test(a))) return human("echoes a secret variable");
    if (args.some(isEnvFile) && !["git"].includes(bin)) return human("touches a .env file");
    if (bin === "strings") return deny("binary string extraction", "Don't extract strings from binaries. Use docs, changelogs or --help; otherwise say 'can't tell'.");
    if (args.some((a) => /node_modules\/\S*\/bin\/\S+/.test(a)) && !["ls", "stat", "file", "tree", "npx", "node", "git", "which"].includes(bin))
      return deny("binary search in node_modules", "Don't search binaries. Read the package docs or changelog; otherwise say 'can't tell'.");

    switch (bin) {
      case "git": return this.git(gitWords(w), raw);
      case "npm": return this.npm(args);
      case "npx": return this.npx(args);
      case "supabase": return this.supabase(args);
      case "docker": return this.docker(args);
      case "curl": return this.curl(args);
      case "gh": return this.gh(args);
      case "netlify": return deny("netlify CLI", "Never run Netlify commands. Production deploys are manual, from main, by the user.");
      case "pkill": case "kill": case "killall":
        return deny("kills a process", "Never start, stop or kill processes. If a check needs the dev server, curl -I once; if it fails, ask the user to start it and wait.");
      case "lsof": return args.some((a) => /^-i/.test(a)) || args.length ? allow("lsof read-only") : allow("lsof");
      case "rm": case "rmdir": case "unlink": return this.rm(args);
      case "mv": case "cp": case "mkdir": case "touch": return this.fsWrite(args);
      case "sed": return args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "--in-place") ? this.sedInPlace(args) : allow("sed read-only");
      case "find": return args.some((a) => ["-delete", "-exec", "-execdir", "-ok"].includes(a)) ? judge("find with action") : allow("find read-only");
      case "node": return args[0] === "-e" || args[0] === "--eval" ? judge("node -e runs inline code")
        : args[0] === "scripts/ds-compare.mjs" ? allow("ds-compare") : judge("runs a node script");
      case "python3": case "python": return judge("runs Python");
      case "perl": return this.perl(args);
      case "awk": case "xargs": case "tee": case "bash": case "sh": case "zsh": case "eval": case "source": case ".": case "export":
        return judge(`${bin} can run or write arbitrary things`);
      case "actionlint": return allow("actionlint");
      case "sudo": case "chmod": case "chown": return human(`${bin}`);
    }
    if (READ_ONLY.has(bin)) return allow("read-only utility");
    return judge(`unknown command ${bin}`);
  }

  /** sed -i is fine on files the manifest lets the worker edit, as long as the script can't write or run anything. */
  private sedInPlace(args: string[]): Verdict {
    const scripts: string[] = [], rest: string[] = [];
    let sawE = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === "--in-place" || /^-i/.test(a)) { if (a === "-i" && args[k + 1] === "") k++; continue; } // BSD form: -i ''
      if (a === "-e") { scripts.push(args[++k] ?? ""); sawE = true; continue; }
      if (["-n", "-E", "-r", "--regexp-extended"].includes(a)) continue;
      if (a.startsWith("-")) return judge("sed -i with unusual options");
      rest.push(a);
    }
    if (!sawE) { const s = rest.shift(); if (s === undefined) return judge("sed -i without a script"); scripts.push(s); }
    if (!rest.length) return judge("sed -i without files");
    if (scripts.some((s) => /(^|[;{\s])[we]\s|\/[0-9gpI]*[we]\b/.test(s))) return judge("sed script may write files or run commands");
    const bad = rest.filter((f) => !matchAny(this.manifest.edits, this.rel(f)) || matchAny(this.config.frozen, this.rel(f)));
    return bad.length ? judge(`sed -i on files outside the manifest: ${bad.join(", ")}`) : allow("sed -i on manifest files");
  }

  // ---------- git ----------
  private git(w: string[], raw: string): Verdict {
    const sub = w[1];
    const a = w.slice(2);
    switch (sub) {
      case "status": case "log": case "show": case "diff": case "ls-files": case "check-ignore": case "rev-parse":
      case "blame": case "shortlog": case "describe": case "ls-tree": case "cat-file": case "rev-list": case "grep":
        return allow(`git ${sub} is read-only`);
      case "branch": return a.every((x) => /^(--show-current|-a|-r|-v|-vv|--list|--contains)$/.test(x)) ? allow("git branch read-only") : judge("git branch changes refs");
      case "remote": return a.length === 0 || a[0] === "-v" || a[0] === "show" ? allow("remote read-only") : judge("remote change");
      case "config": return a[0] === "--get" || a[0] === "--list" || a[0] === "-l" ? allow("config read-only") : judge("config change");
      case "stash": return a[0] === "list" || a[0] === "show" ? allow("stash read-only") : judge("stash changes the working tree");
      case "restore": return a.includes("--staged") && !a.includes("--worktree") ? allow("unstage only") : judge("restore discards changes");
      case "rm": {
        const targets = a.filter((x) => !x.startsWith("-"));
        return targets.length && targets.every((t) => matchAny(this.manifest.deletions, this.rel(t))) ? allow("git rm of manifest-listed deletions") : human("git rm of files not listed in the manifest");
      }
      case "mv": {
        const targets = a.filter((x) => !x.startsWith("-"));
        const ok = targets.length === 2 && targets.every((t) => matchAny([...this.manifest.edits, ...this.manifest.deletions], this.rel(t)) && !matchAny(this.config.frozen, this.rel(t)));
        return ok ? allow("git mv within the manifest") : judge("git mv outside the manifest");
      }
      case "push": return deny("git push", "The agent never pushes (tags included). Stop and report; the user pushes.");
      case "add": return this.gitAdd(a);
      case "commit": return this.gitCommit(a);
      case "checkout": case "switch":
        return a.some((x) => /^(main|master)$/.test(x)) ? deny("switch to main", "Agents stay off main. Stay on the task branch.") : judge(`git ${sub} moves branches or discards changes`);
      case "merge": return deny("git merge", "Don't merge. Report and let the user decide.");
      case "tag": return a.length === 0 || a[0] === "-l" || a[0] === "--list" ? allow("tag list") : deny("git tag", "The agent doesn't tag. Report instead.");
      case "reset": case "clean": case "rebase": case "cherry-pick": case "revert":
        return judge(`git ${sub} rewrites state`);
      default: return judge(`git ${sub ?? ""}`);
    }
  }

  private gitAdd(a: string[]): Verdict {
    if (a.some((x) => ["-A", "--all", ".", "-u", "--update", ":/"].includes(x)))
      return deny("blanket git add", "Stage by name. List the files, then `git add <file> <file>`; don't use -A, . or -u.");
    const files = a.filter((x) => !x.startsWith("-"));
    if (!files.length) return judge("git add with no paths");
    if (files.some((f) => /[*?\[]/.test(f))) return judge("git add with a glob");
    const allowedPaths = this.pendingPaths();
    const expanded: string[] = [];
    const bad: string[] = [];
    for (const f0 of files) {
      const f = f0.replace(/^\.\//, "").replace(/\/$/, "");
      if (allowedPaths.includes(f)) expanded.push(f);
      else {
        const under = allowedPaths.filter((p) => p.startsWith(f + "/"));
        if (under.length) expanded.push(...under); else bad.push(f0);
      }
    }
    if (bad.length) return judge(`staging paths not listed in any planned commit: ${bad.join(", ")}`);
    expanded.forEach((f) => this.state.staged.add(f));
    return allow("staged paths match the manifest");
  }

  private gitCommit(a: string[]): Verdict {
    if (a.some((x) => x === "-a" || x === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(x) && x !== "-m"))
      return deny("git commit -a", "Stage by name, then `git commit -m`. No -a.");
    const i = a.findIndex((x) => x === "-m" || x === "--message");
    if (i < 0 || !a[i + 1]) return judge("commit without -m");
    return this.checkCommitMessage(a[i + 1].split("\n")[0].trim());
  }

  // ---------- npm / npx ----------
  private npm(a: string[]): Verdict {
    const sub = a[0];
    const rest = a.slice(1);
    switch (sub) {
      case "test": case "t": return allow("npm test");
      case "run": case "run-script": {
        const s = rest[0] ?? "";
        if (SAFE_SCRIPTS.has(s) || /^e2e(:|$)/.test(s)) return allow(`npm run ${s}`);
        if (/^(dev|start)(:|$)/.test(s)) return deny("npm run dev/start", "The user runs the dev server. Never start it. Use `curl -I http://127.0.0.1:3000` once; if it fails, ask the user to start it.");
        if (/^db:seed-dev/.test(s)) return deny("db:seed-dev", "db:seed-dev resets the hosted dev project. Never run it.");
        if (s === "db:reset") return this.gated("npm run db:reset", "local DB reset");
        return judge(`npm run ${s} is not on the safe list`);
      }
      case "view": case "info": case "ls": case "list": case "outdated": case "explain": case "why": case "config":
        return sub === "config" && rest[0] !== "get" && rest[0] !== "list" ? judge("npm config change") : allow(`npm ${sub} is read-only`);
      case "audit": return rest[0] === "fix" ? deny("npm audit fix", "Never run audit fix. Report the advisories.") : allow("npm audit");
      case "ci": return rest.includes("--dry-run") ? allow("ci dry run") : judge("npm ci changes node_modules");
      case "install": case "i": case "add": return this.npmInstall(rest);
      case "uninstall": case "remove": case "rm": case "un": return judge("removes a package");
      default: return judge(`npm ${sub ?? ""}`);
    }
  }

  private npmInstall(a: string[]): Verdict {
    const pkgs = a.filter((x) => !x.startsWith("-"));
    const dry = a.includes("--dry-run");
    if (pkgs.length === 0)
      return dry ? allow("install dry run") : deny("bare npm install", "No bare `npm install`. Run `npm view <pkg>@<ver> version peerDependencies`, then `npm install --dry-run <pkg>@<exact>`, report conflicts, then install with --save-exact only if the package is on the task's Build line.");
    if (dry) { pkgs.forEach((p) => this.state.dryRun.add(p)); return allow("install dry run"); }
    if (!a.includes("--save-exact") && !a.includes("-E")) return deny("unpinned install", "Install with --save-exact and an exact version.");
    const notExact = pkgs.filter((p) => !/@\d+\.\d+\.\d+/.test(p));
    if (notExact.length) return deny("version not exact", `Use exact versions: ${notExact.join(", ")}.`);
    const notListed = pkgs.filter((p) => !this.manifest.packages.includes(p));
    if (notListed.length) return judge(`package not in the manifest: ${notListed.join(", ")}`);
    const noDry = pkgs.filter((p) => !this.state.dryRun.has(p));
    if (noDry.length) return deny("no dry run first", `Run \`npm install --dry-run ${noDry.join(" ")}\` first and report any conflict.`);
    return allow("manifest package, dry-run done, exact");
  }

  private npx(a: string[]): Verdict {
    const t = a.filter((x) => !x.startsWith("-"))[0];
    const rest = a.slice(a.indexOf(t) + 1);
    switch (t) {
      case "supabase": return this.supabase(rest);
      case "netlify": case "netlify-cli": return deny("netlify CLI", "Never run Netlify commands. Production deploys are manual, from main, by the user.");
      case "serve": case "vite": return deny(`npx ${t}`, "The user runs the servers. Never start them.");
      case "eslint": return rest.includes("--stdin") || rest.includes("--print-config") || rest.includes("--max-warnings") ? allow("eslint check") : judge("eslint (may --fix)");
      case "tsc": return rest.includes("--noEmit") ? allow("tsc --noEmit") : judge("tsc may emit files");
      case "prettier": return rest.includes("--check") ? allow("prettier --check") : judge("prettier may write");
      case "actionlint": return allow("actionlint");
      case "vitest": return rest[0] === "run" ? allow("vitest run") : judge("vitest watch mode");
      default: return judge(`npx ${t ?? ""}`);
    }
  }

  private supabase(a: string[]): Verdict {
    const all = a.join(" ");
    if (/(^|\s)(link|secrets|functions\s+deploy|stop)(\s|$)/.test(all) || /db\s+push/.test(all) || a.includes("--linked") || a.some((x) => x.startsWith("--db-url")))
      return deny("hosted supabase command", "Never run commands against hosted Supabase. For docs questions, verify from supabase.com docs and say if unconfirmed.");
    if (a[0] === "db" && a[1] === "query") {
      if (a.includes("--help") && a.length <= 3) return allow("supabase db query --help");
      const sql = a.filter((x) => !x.startsWith("-"))[2] ?? "";
      const bad = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|into|copy|call|do|vacuum|set_config|dblink|lo_\w+|pg_(read|ls|sleep|terminate|cancel|stat_reset)\w*|nextval|setval)\b|;|`|\$\(/i;
      if (a.includes("--local") && a.filter((x) => !x.startsWith("-")).length === 3 && /^\s*(select|with)\b/i.test(sql) && !bad.test(sql))
        return allow("read-only select against the local DB");
      return judge("supabase db query that is not a plain local select");
    }
    if (a.includes("--version") || a[0] === "status" || (a[0] === "test" && a[1] === "db")) return allow("supabase read/test");
    if (a[0] === "start") return this.gated("supabase start", "starts local Supabase");
    if (a[0] === "db" && a[1] === "reset") return this.gated("supabase db reset", "resets the local DB");
    return judge(`supabase ${all}`);
  }

  private gated(gate: string, why: string): Verdict {
    return this.manifest.gates.includes(gate) ? allow(`${gate} is pre-approved in the manifest`) : human(`${why}; not pre-approved in the manifest`);
  }

  // ---------- docker, curl, gh, fs ----------
  private docker(a: string[]): Verdict {
    const sub = a[0];
    if (sub === "ps" || sub === "images" || sub === "logs" || sub === "inspect") return allow(`docker ${sub}`);
    if (["rm", "volume", "prune", "system", "stop", "kill", "rmi", "network", "compose"].includes(sub)) return deny(`docker ${sub}`, "Don't modify docker state. Report what you need.");
    if (sub === "exec") {
      const joined = a.join(" ");
      if (/\bpsql\b/.test(joined) && /-c\s+["']?\s*select\b/i.test(joined) && !/\b(insert|update|delete|drop|alter|truncate|create|grant)\b/i.test(joined)) return allow("local psql select");
      return judge("docker exec");
    }
    return judge(`docker ${sub ?? ""}`);
  }

  private curl(a: string[]): Verdict {
    const url = a.find((x) => /^https?:\/\//.test(x)) ?? "";
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url);
    const mutating = a.some((x) => /^(-X|--request|-d|--data.*|-F|--form|-T|-o|-O)$/.test(x));
    if (local && !mutating) return allow("local GET/HEAD");
    return judge("curl outside local read-only");
  }

  private gh(a: string[]): Verdict {
    if (a[0] === "--version" || (a[0] === "auth" && a[1] === "status")) return allow("gh read");
    if (a[0] === "run" && ["list", "view", "watch"].includes(a[1])) return allow("gh run read");
    if (a[0] === "workflow" && a[1] === "run") return deny("gh workflow run", "Production deploys are manual by the user. Never dispatch workflows.");
    if (["pr", "release", "secret", "variable", "repo", "issue"].includes(a[0])) return deny(`gh ${a[0]}`, "Don't run GitHub write commands. Report what you need.");
    return judge(`gh ${a.join(" ")}`);
  }

  private rm(a: string[]): Verdict {
    const targets = a.filter((x) => !x.startsWith("-"));
    if (targets.length && targets.every((t) => matchAny(this.manifest.deletions, this.rel(t)))) return allow("deletion listed in manifest");
    return human("deletes files not listed in the manifest");
  }

  private fsWrite(a: string[]): Verdict {
    const targets = a.filter((x) => !x.startsWith("-"));
    if (targets.length && targets.every((t) => matchAny(this.manifest.edits, this.rel(t)) && !matchAny(this.config.frozen, this.rel(t)))) return allow("paths in manifest");
    return judge("file operation outside the manifest edit list");
  }
}

/** Strip `git -C dir` / `-c k=v` options so w[1] is the subcommand. */
function gitWords(w: string[]): string[] {
  if (w[0] !== "git") return w;
  const out = ["git"];
  let i = 1;
  while (i < w.length && w[i].startsWith("-")) { if (["-C", "-c"].includes(w[i])) i += 2; else i++; }
  return out.concat(w.slice(i));
}

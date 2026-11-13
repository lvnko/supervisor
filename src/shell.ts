/** Quote-aware shell splitting. Not a full parser: anything unusual is flagged `complex`. */
export interface ParsedShell {
  segments: string[];     // simple commands, trimmed
  complex: boolean;       // $(..), backticks, subshell, redirection into files handled separately
  heredoc: boolean;
  redirectsToFile: boolean;
  redirectTargets: string[];   // file targets of > and >> (excluding /dev/null and fd dups)
}

export function parseShell(cmd: string): ParsedShell {
  const segments: string[] = [];
  let cur = "";
  let q: "'" | '"' | null = null;
  let complex = false, heredoc = false, redirectsToFile = false;
  const redirectTargets: string[] = [];
  const push = () => { if (cur.trim()) segments.push(cur.trim()); cur = ""; };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1];
    if (q) {
      if (c === "\\" && q === '"') { cur += c + (n ?? ""); i++; continue; }
      if (q === '"' && (c === "`" || (c === "$" && n === "("))) complex = true;
      if (c === q) q = null;
      cur += c; continue;
    }
    if (c === "\\") { cur += c + (n ?? ""); i++; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "`" || (c === "$" && n === "(") || c === "(" || c === ")") { complex = true; cur += c; continue; }
    if (c === "<" && n === "<" && cmd[i + 2] !== "<") { heredoc = true; cur += c; continue; }
    if (c === ">") {
      const rest = cmd.slice(i);
      const isDup = /^>&\d/.test(rest) || (cmd[i - 1] === "&"); // 2>&1, &>
      const m = rest.match(/^>{1,2}\s*(\S+)/);
      if (!isDup && m && m[1] !== "/dev/null" && !/^&/.test(m[1])) { redirectsToFile = true; redirectTargets.push(m[1].replace(/^["']|["']$/g, "")); }
    }
    if (c === "&" && n === "&") { push(); i++; continue; }
    if (c === "|" && n === "|") { push(); i++; continue; }
    if (c === "|" || c === ";" || c === "\n") { push(); continue; }
    if (c === "&" && cmd[i - 1] !== ">" && cmd[i - 1] !== "<") { push(); continue; }
    cur += c;
  }
  push();
  return { segments, complex, heredoc, redirectsToFile, redirectTargets };
}

/** Split a simple command into words, honouring quotes. */
export function words(seg: string): string[] {
  const out: string[] = [];
  let cur = "", q: string | null = null, has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"' && i + 1 < seg.length) cur += seg[++i]; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === "\\" && i + 1 < seg.length) { cur += seg[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ""; has = false; continue; }
    cur += c; has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}

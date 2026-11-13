/** Minimal glob: ** any depth, * within a segment, ? one char. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
export function normPath(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\/+/, (m) => m).replace(/\/+/g, "/");
}
export function matchAny(globs: string[], path: string): boolean {
  const p = normPath(path);
  return globs.some((g) => globToRegExp(g).test(p));
}

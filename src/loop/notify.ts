import { spawn } from "node:child_process";

/** macOS notification, plus an ntfy.sh push if NTFY_TOPIC is set. Never throws. */
export async function notify(title: string, body: string): Promise<void> {
  try {
    if (process.platform === "darwin") {
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 200);
      spawn("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], { stdio: "ignore" }).on("error", () => {});
    }
    const topic = process.env.NTFY_TOPIC;
    if (topic) await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: "POST", body: body.slice(0, 500), headers: { Title: title } }).catch(() => {});
  } catch { /* notifications are best-effort */ }
}

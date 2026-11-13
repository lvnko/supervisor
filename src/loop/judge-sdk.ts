import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { JUDGE_SYSTEM_PROMPT } from "../judge/prompt.js";
import { MessageQueue } from "./queue.js";

export interface Judge { decide(message: string): Promise<string>; sessionId?: string; close(): void }

/** One long-lived Sonnet session per task, run through the Agent SDK so it draws on the Pro plan (no API key). */
export class SdkJudge implements Judge {
  sessionId?: string;
  private q = new MessageQueue();
  private pending: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
  private started = false;
  constructor(private opts: { cwd: string; model?: string; resume?: string }) {}

  private start() {
    this.started = true;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ANTHROPIC_API_KEY") env[k] = v;
    const stream = query({
      prompt: this.q,
      options: {
        cwd: this.opts.cwd,
        model: this.opts.model ?? "sonnet",
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        settingSources: [],
        permissionMode: "dontAsk",
        canUseTool: async () => ({ behavior: "deny", message: "The judge has no tools." }),
        resume: this.opts.resume,
        env,
      },
    });
    void this.consume(stream);
  }

  private async consume(stream: AsyncIterable<SDKMessage>) {
    try {
      for await (const m of stream) {
        if (m.type === "system" && (m as { subtype?: string }).subtype === "init") this.sessionId = (m as { session_id?: string }).session_id;
        if (m.type === "result") {
          const r = m as { subtype: string; result?: string };
          const p = this.pending; this.pending = null;
          if (r.subtype === "success") p?.resolve(r.result ?? ""); else p?.reject(new Error(`judge ended with ${r.subtype}`));
        }
      }
    } catch (e) {
      this.pending?.reject(e instanceof Error ? e : new Error(String(e)));
    }
    this.pending?.reject(new Error("judge session closed"));
  }

  decide(message: string): Promise<string> {
    if (!this.started) this.start();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; reject(new Error("judge timed out after 150 s")); }, 150_000);
      this.pending = { resolve: (s) => { clearTimeout(timer); resolve(s); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      this.q.push(message);
    });
  }
  close() { this.q.close(); }
}

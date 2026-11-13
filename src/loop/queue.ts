import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** Lets us feed user turns into a running SDK session one at a time (streaming input mode). */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(text: string): void {
    const m = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false }); else this.items.push(m);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const v = this.items.shift();
        if (v) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

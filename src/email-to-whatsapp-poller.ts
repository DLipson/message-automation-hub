import type { EmailInbox } from "./ports/email-inbox.js";

type UnreadEmailProcessor = {
  processUnread(): Promise<void>;
};

export class EmailToWhatsAppPoller {
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private started = false;
  private stopWatching: (() => Promise<void>) | undefined;

  constructor(
    private readonly processor: UnreadEmailProcessor,
    private readonly inbox: EmailInbox,
    private readonly fallbackPollMs: number,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopWatching = await this.inbox.watchNewMail(() => {
      void this.poll();
    });
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopWatching) {
      await this.stopWatching();
      this.stopWatching = undefined;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.started) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.processor.processUnread();
    } catch (error) {
      console.error(`Email automation poll failed: ${formatError(error)}`);
    } finally {
      this.polling = false;
      this.scheduleNext(this.fallbackPollMs);
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error) ?? String(error);
}

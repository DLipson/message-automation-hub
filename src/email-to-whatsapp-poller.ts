type UnreadEmailProcessor = {
  processUnread(): Promise<void>;
};

export class EmailToWhatsAppPoller {
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private started = false;

  constructor(
    private readonly processor: UnreadEmailProcessor,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, 0);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
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
      if (this.started) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.poll();
        }, this.intervalMs);
      }
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error) ?? String(error);
}

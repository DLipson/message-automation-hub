type UnreadEmailProcessor = {
  processUnread(): Promise<void>;
};

export class EmailToWhatsAppPoller {
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly processor: UnreadEmailProcessor,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      console.warn(
        "Email automation poll skipped because the previous poll is still running.",
      );
      return;
    }

    this.polling = true;

    try {
      await this.processor.processUnread();
    } catch (error) {
      console.error(
        `Email automation poll failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    } finally {
      this.polling = false;
    }
  }
}

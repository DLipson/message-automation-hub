import { ForwardEmailToWhatsApp } from "./use-cases/forward-email-to-whatsapp.js";

export class EmailToWhatsAppPoller {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly forwarder: ForwardEmailToWhatsApp,
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
    try {
      await this.forwarder.processUnread();
    } catch (error) {
      console.error(
        `Email to WhatsApp poll failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }
}

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { EmailMessage, EmailSender } from "../../ports/email-sender.js";

export type SmtpEmailSenderConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
};

export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;

  constructor(config: SmtpEmailSenderConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail(message);
  }
}

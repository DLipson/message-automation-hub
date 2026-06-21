import type { AppConfig } from "../config.js";

export type AppSettings = {
  whatsappPhoneNumber: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  emailFrom: string;
  emailTo: string;
};

export const emptyAppSettings: AppSettings = {
  whatsappPhoneNumber: "",
  smtpHost: "smtp.gmail.com",
  smtpPort: "465",
  smtpSecure: true,
  smtpUser: "",
  emailFrom: "",
  emailTo: "",
};

export function appSettingsToEnv(settings: AppSettings): Record<string, string> {
  return {
    WHATSAPP_PHONE_NUMBER: settings.whatsappPhoneNumber,
    SMTP_HOST: settings.smtpHost,
    SMTP_PORT: settings.smtpPort,
    SMTP_SECURE: String(settings.smtpSecure),
    SMTP_USER: settings.smtpUser,
    EMAIL_FROM: settings.emailFrom,
    EMAIL_TO: settings.emailTo,
  };
}

export function envToAppSettings(
  env: Record<string, string | undefined>,
): AppSettings {
  return {
    whatsappPhoneNumber:
      env.WHATSAPP_PHONE_NUMBER ?? emptyAppSettings.whatsappPhoneNumber,
    smtpHost: env.SMTP_HOST ?? emptyAppSettings.smtpHost,
    smtpPort: env.SMTP_PORT ?? emptyAppSettings.smtpPort,
    smtpSecure: (env.SMTP_SECURE ?? "true").toLowerCase() === "true",
    smtpUser: env.SMTP_USER ?? emptyAppSettings.smtpUser,
    emailFrom: env.EMAIL_FROM ?? emptyAppSettings.emailFrom,
    emailTo: env.EMAIL_TO ?? emptyAppSettings.emailTo,
  };
}

export function settingsToRuntimeEnv(
  settings: AppSettings,
): NodeJS.ProcessEnv {
  return appSettingsToEnv(settings);
}

export function settingsToEmailConfig(
  settings: AppSettings,
  smtpPassword: string,
): AppConfig {
  return {
    whatsapp: {
      phoneNumber: settings.whatsappPhoneNumber,
    },
    smtp: {
      host: settings.smtpHost,
      port: Number(settings.smtpPort),
      secure: settings.smtpSecure,
      user: settings.smtpUser,
      pass: smtpPassword,
    },
    email: {
      from: settings.emailFrom,
      to: settings.emailTo,
    },
  };
}

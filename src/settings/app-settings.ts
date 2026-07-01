import type { AppConfig } from "../config.js";

export type AppSettings = {
  whatsappPhoneNumber: string;
  messageHubSecretStore: string;
  messageHubSecretFile: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  emailFrom: string;
  emailTo: string;
  emailToWhatsappEnabled: boolean;
  emailToWhatsappSubjectPrefix: string;
  emailToWhatsappPollSeconds: string;
  transactionCategoryRequestEnabled: boolean;
  transactionCategoryRequestSubjectPrefix: string;
  transactionCategoryRequestRecipientPhoneNumber: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  imapUser: string;
};

export const emptyAppSettings: AppSettings = {
  whatsappPhoneNumber: "",
  messageHubSecretStore: "auto",
  messageHubSecretFile: "",
  smtpHost: "smtp.gmail.com",
  smtpPort: "465",
  smtpSecure: true,
  smtpUser: "",
  emailFrom: "",
  emailTo: "",
  emailToWhatsappEnabled: false,
  emailToWhatsappSubjectPrefix: "WA:",
  emailToWhatsappPollSeconds: "30",
  transactionCategoryRequestEnabled: false,
  transactionCategoryRequestSubjectPrefix: "TXCAT:",
  transactionCategoryRequestRecipientPhoneNumber: "",
  imapHost: "imap.gmail.com",
  imapPort: "993",
  imapSecure: true,
  imapUser: "",
};

export function appSettingsToEnv(settings: AppSettings): Record<string, string> {
  return {
    WHATSAPP_PHONE_NUMBER: settings.whatsappPhoneNumber,
    MESSAGE_HUB_SECRET_STORE: settings.messageHubSecretStore,
    MESSAGE_HUB_SECRET_FILE: settings.messageHubSecretFile,
    SMTP_HOST: settings.smtpHost,
    SMTP_PORT: settings.smtpPort,
    SMTP_SECURE: String(settings.smtpSecure),
    SMTP_USER: settings.smtpUser,
    EMAIL_FROM: settings.emailFrom,
    EMAIL_TO: settings.emailTo,
    EMAIL_TO_WHATSAPP_ENABLED: String(settings.emailToWhatsappEnabled),
    EMAIL_TO_WHATSAPP_SUBJECT_PREFIX: settings.emailToWhatsappSubjectPrefix,
    EMAIL_TO_WHATSAPP_POLL_SECONDS: settings.emailToWhatsappPollSeconds,
    TRANSACTION_CATEGORY_REQUEST_ENABLED: String(
      settings.transactionCategoryRequestEnabled,
    ),
    TRANSACTION_CATEGORY_REQUEST_SUBJECT_PREFIX:
      settings.transactionCategoryRequestSubjectPrefix,
    TRANSACTION_CATEGORY_REQUEST_RECIPIENT_PHONE_NUMBER:
      settings.transactionCategoryRequestRecipientPhoneNumber,
    IMAP_HOST: settings.imapHost,
    IMAP_PORT: settings.imapPort,
    IMAP_SECURE: String(settings.imapSecure),
    IMAP_USER: settings.imapUser,
  };
}

export function envToAppSettings(
  env: Record<string, string | undefined>,
): AppSettings {
  return {
    whatsappPhoneNumber:
      env.WHATSAPP_PHONE_NUMBER ?? emptyAppSettings.whatsappPhoneNumber,
    messageHubSecretStore:
      env.MESSAGE_HUB_SECRET_STORE ?? emptyAppSettings.messageHubSecretStore,
    messageHubSecretFile:
      env.MESSAGE_HUB_SECRET_FILE ?? emptyAppSettings.messageHubSecretFile,
    smtpHost: env.SMTP_HOST ?? emptyAppSettings.smtpHost,
    smtpPort: env.SMTP_PORT ?? emptyAppSettings.smtpPort,
    smtpSecure: (env.SMTP_SECURE ?? "true").toLowerCase() === "true",
    smtpUser: env.SMTP_USER ?? emptyAppSettings.smtpUser,
    emailFrom: env.EMAIL_FROM ?? emptyAppSettings.emailFrom,
    emailTo: env.EMAIL_TO ?? emptyAppSettings.emailTo,
    emailToWhatsappEnabled:
      (env.EMAIL_TO_WHATSAPP_ENABLED ?? "false").toLowerCase() === "true",
    emailToWhatsappSubjectPrefix:
      env.EMAIL_TO_WHATSAPP_SUBJECT_PREFIX ??
      emptyAppSettings.emailToWhatsappSubjectPrefix,
    emailToWhatsappPollSeconds:
      env.EMAIL_TO_WHATSAPP_POLL_SECONDS ??
      emptyAppSettings.emailToWhatsappPollSeconds,
    transactionCategoryRequestEnabled:
      (env.TRANSACTION_CATEGORY_REQUEST_ENABLED ?? "false").toLowerCase() ===
      "true",
    transactionCategoryRequestSubjectPrefix:
      env.TRANSACTION_CATEGORY_REQUEST_SUBJECT_PREFIX ??
      emptyAppSettings.transactionCategoryRequestSubjectPrefix,
    transactionCategoryRequestRecipientPhoneNumber:
      env.TRANSACTION_CATEGORY_REQUEST_RECIPIENT_PHONE_NUMBER ??
      emptyAppSettings.transactionCategoryRequestRecipientPhoneNumber,
    imapHost: env.IMAP_HOST ?? emptyAppSettings.imapHost,
    imapPort: env.IMAP_PORT ?? emptyAppSettings.imapPort,
    imapSecure: (env.IMAP_SECURE ?? "true").toLowerCase() === "true",
    imapUser: env.IMAP_USER ?? emptyAppSettings.imapUser,
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
    imap: {
      host: settings.imapHost,
      port: Number(settings.imapPort),
      secure: settings.imapSecure,
      user: settings.imapUser || settings.smtpUser,
      pass: smtpPassword,
    },
    emailToWhatsapp: {
      enabled: settings.emailToWhatsappEnabled,
      subjectPrefix: settings.emailToWhatsappSubjectPrefix,
      pollIntervalMs: Number(settings.emailToWhatsappPollSeconds) * 1000,
    },
    transactionCategoryRequest: {
      enabled: settings.transactionCategoryRequestEnabled,
      subjectPrefix: settings.transactionCategoryRequestSubjectPrefix,
      recipientPhoneNumber:
        settings.transactionCategoryRequestRecipientPhoneNumber.replace(/\D/g, ""),
    },
  };
}

import {
  appDefaults,
  loadConfig,
  type AppConfig,
} from "../config.js";
import {
  isSecretStoreMode,
  type SecretStoreMode,
} from "../adapters/secrets/secret-store-factory.js";

export type AppSettings = {
  whatsappPhoneNumber: string;
  messageHubSecretStore: SecretStoreMode;
  messageHubSecretFile: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  emailFrom: string;
  emailTo: string;
  emailMessageIdDomain: string;
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
  messageHubSecretStore: appDefaults.messageHubSecretStore,
  messageHubSecretFile: "",
  smtpHost: appDefaults.smtpHost,
  smtpPort: String(appDefaults.smtpPort),
  smtpSecure: appDefaults.smtpSecure,
  smtpUser: "",
  emailFrom: "",
  emailTo: "",
  emailMessageIdDomain: appDefaults.emailMessageIdDomain,
  emailToWhatsappEnabled: false,
  emailToWhatsappSubjectPrefix: appDefaults.emailToWhatsappSubjectPrefix,
  emailToWhatsappPollSeconds: String(appDefaults.emailToWhatsappPollSeconds),
  transactionCategoryRequestEnabled: false,
  transactionCategoryRequestSubjectPrefix:
    appDefaults.transactionCategoryRequestSubjectPrefix,
  transactionCategoryRequestRecipientPhoneNumber: "",
  imapHost: appDefaults.imapHost,
  imapPort: String(appDefaults.imapPort),
  imapSecure: appDefaults.imapSecure,
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
    EMAIL_MESSAGE_ID_DOMAIN: settings.emailMessageIdDomain,
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
    messageHubSecretStore: readSecretStoreMode(env.MESSAGE_HUB_SECRET_STORE),
    messageHubSecretFile:
      env.MESSAGE_HUB_SECRET_FILE ?? emptyAppSettings.messageHubSecretFile,
    smtpHost: env.SMTP_HOST ?? emptyAppSettings.smtpHost,
    smtpPort: env.SMTP_PORT ?? emptyAppSettings.smtpPort,
    smtpSecure: readBoolean(
      env.SMTP_SECURE,
      "SMTP_SECURE",
      emptyAppSettings.smtpSecure,
    ),
    smtpUser: env.SMTP_USER ?? emptyAppSettings.smtpUser,
    emailFrom: env.EMAIL_FROM ?? emptyAppSettings.emailFrom,
    emailTo: env.EMAIL_TO ?? emptyAppSettings.emailTo,
    emailMessageIdDomain:
      env.EMAIL_MESSAGE_ID_DOMAIN ?? emptyAppSettings.emailMessageIdDomain,
    emailToWhatsappEnabled: readBoolean(
      env.EMAIL_TO_WHATSAPP_ENABLED,
      "EMAIL_TO_WHATSAPP_ENABLED",
      emptyAppSettings.emailToWhatsappEnabled,
    ),
    emailToWhatsappSubjectPrefix:
      env.EMAIL_TO_WHATSAPP_SUBJECT_PREFIX ??
      emptyAppSettings.emailToWhatsappSubjectPrefix,
    emailToWhatsappPollSeconds:
      env.EMAIL_TO_WHATSAPP_POLL_SECONDS ??
      emptyAppSettings.emailToWhatsappPollSeconds,
    transactionCategoryRequestEnabled: readBoolean(
      env.TRANSACTION_CATEGORY_REQUEST_ENABLED,
      "TRANSACTION_CATEGORY_REQUEST_ENABLED",
      emptyAppSettings.transactionCategoryRequestEnabled,
    ),
    transactionCategoryRequestSubjectPrefix:
      env.TRANSACTION_CATEGORY_REQUEST_SUBJECT_PREFIX ??
      emptyAppSettings.transactionCategoryRequestSubjectPrefix,
    transactionCategoryRequestRecipientPhoneNumber:
      env.TRANSACTION_CATEGORY_REQUEST_RECIPIENT_PHONE_NUMBER ??
      emptyAppSettings.transactionCategoryRequestRecipientPhoneNumber,
    imapHost: env.IMAP_HOST ?? emptyAppSettings.imapHost,
    imapPort: env.IMAP_PORT ?? emptyAppSettings.imapPort,
    imapSecure: readBoolean(
      env.IMAP_SECURE,
      "IMAP_SECURE",
      emptyAppSettings.imapSecure,
    ),
    imapUser: env.IMAP_USER ?? emptyAppSettings.imapUser,
  };
}

export function validateAppSettings(settings: AppSettings): void {
  assertString(settings.whatsappPhoneNumber, "WHATSAPP_PHONE_NUMBER");
  assertString(settings.messageHubSecretStore, "MESSAGE_HUB_SECRET_STORE");
  assertString(settings.messageHubSecretFile, "MESSAGE_HUB_SECRET_FILE");
  assertString(settings.smtpHost, "SMTP_HOST");
  assertPositiveIntegerString(settings.smtpPort, "SMTP_PORT");
  assertBoolean(settings.smtpSecure, "SMTP_SECURE");
  assertString(settings.smtpUser, "SMTP_USER");
  assertString(settings.emailFrom, "EMAIL_FROM");
  assertString(settings.emailTo, "EMAIL_TO");
  assertString(settings.emailMessageIdDomain, "EMAIL_MESSAGE_ID_DOMAIN");
  assertBoolean(settings.emailToWhatsappEnabled, "EMAIL_TO_WHATSAPP_ENABLED");
  assertString(
    settings.emailToWhatsappSubjectPrefix,
    "EMAIL_TO_WHATSAPP_SUBJECT_PREFIX",
  );
  assertPositiveIntegerString(
    settings.emailToWhatsappPollSeconds,
    "EMAIL_TO_WHATSAPP_POLL_SECONDS",
  );
  assertBoolean(
    settings.transactionCategoryRequestEnabled,
    "TRANSACTION_CATEGORY_REQUEST_ENABLED",
  );
  assertString(
    settings.transactionCategoryRequestSubjectPrefix,
    "TRANSACTION_CATEGORY_REQUEST_SUBJECT_PREFIX",
  );
  assertString(
    settings.transactionCategoryRequestRecipientPhoneNumber,
    "TRANSACTION_CATEGORY_REQUEST_RECIPIENT_PHONE_NUMBER",
  );
  assertString(settings.imapHost, "IMAP_HOST");
  assertPositiveIntegerString(settings.imapPort, "IMAP_PORT");
  assertBoolean(settings.imapSecure, "IMAP_SECURE");
  assertString(settings.imapUser, "IMAP_USER");

  if (!isSecretStoreMode(settings.messageHubSecretStore)) {
    throw new Error(
      "MESSAGE_HUB_SECRET_STORE must be auto, windows-credential, or file",
    );
  }
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
  return loadConfig(appSettingsToEnv(settings), { smtpPassword });
}

function readSecretStoreMode(value: string | undefined): SecretStoreMode {
  const mode = value ?? emptyAppSettings.messageHubSecretStore;

  if (!isSecretStoreMode(mode)) {
    throw new Error(
      "MESSAGE_HUB_SECRET_STORE must be auto, windows-credential, or file",
    );
  }

  return mode;
}

function readBoolean(
  value: string | undefined,
  key: string,
  defaultValue: boolean,
): boolean {
  const normalized = value?.toLowerCase();

  if (!normalized) {
    return defaultValue;
  }

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new Error(`${key} must be true or false`);
}

function assertString(value: unknown, key: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
}

function assertBoolean(value: unknown, key: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be true or false`);
  }
}

function assertPositiveIntegerString(value: unknown, key: string): void {
  assertString(value, key);

  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
}

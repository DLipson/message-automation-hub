import { appDefaults } from "../config.js";

export type FieldDef = {
  readonly key: string;
  readonly env: string;
  readonly parser: "string" | "boolean" | "secretStoreMode";
  readonly defaultValue: string | boolean;
};

export const fields: readonly FieldDef[] = [
  { key: "whatsappPhoneNumber", env: "WHATSAPP_PHONE_NUMBER", parser: "string", defaultValue: "" },
  { key: "messageHubSecretStore", env: "MESSAGE_HUB_SECRET_STORE", parser: "secretStoreMode", defaultValue: appDefaults.messageHubSecretStore },
  { key: "messageHubSecretFile", env: "MESSAGE_HUB_SECRET_FILE", parser: "string", defaultValue: "" },
  { key: "smtpHost", env: "SMTP_HOST", parser: "string", defaultValue: appDefaults.smtpHost },
  { key: "smtpPort", env: "SMTP_PORT", parser: "string", defaultValue: String(appDefaults.smtpPort) },
  { key: "smtpSecure", env: "SMTP_SECURE", parser: "boolean", defaultValue: appDefaults.smtpSecure },
  { key: "smtpUser", env: "SMTP_USER", parser: "string", defaultValue: "" },
  { key: "emailFrom", env: "EMAIL_FROM", parser: "string", defaultValue: "" },
  { key: "emailTo", env: "EMAIL_TO", parser: "string", defaultValue: "" },
  { key: "emailMessageIdDomain", env: "EMAIL_MESSAGE_ID_DOMAIN", parser: "string", defaultValue: appDefaults.emailMessageIdDomain },
  { key: "whatsappForwardStatusesEnabled", env: "WHATSAPP_FORWARD_STATUSES_ENABLED", parser: "boolean", defaultValue: false },
  { key: "whatsappForwardStatusWhitelist", env: "WHATSAPP_FORWARD_STATUS_WHITELIST", parser: "string", defaultValue: "" },
  { key: "whatsappForwardStatusBlacklist", env: "WHATSAPP_FORWARD_STATUS_BLACKLIST", parser: "string", defaultValue: "" },
  { key: "whatsappForwardGroupsEnabled", env: "WHATSAPP_FORWARD_GROUPS_ENABLED", parser: "boolean", defaultValue: false },
  { key: "whatsappForwardGroupWhitelist", env: "WHATSAPP_FORWARD_GROUP_WHITELIST", parser: "string", defaultValue: "" },
  { key: "whatsappForwardGroupBlacklist", env: "WHATSAPP_FORWARD_GROUP_BLACKLIST", parser: "string", defaultValue: "" },
  { key: "emailToWhatsappEnabled", env: "EMAIL_TO_WHATSAPP_ENABLED", parser: "boolean", defaultValue: false },
  { key: "emailToWhatsappSubjectPrefix", env: "EMAIL_TO_WHATSAPP_SUBJECT_PREFIX", parser: "string", defaultValue: appDefaults.emailToWhatsappSubjectPrefix },
  { key: "emailToWhatsappPollSeconds", env: "EMAIL_TO_WHATSAPP_POLL_SECONDS", parser: "string", defaultValue: String(appDefaults.emailToWhatsappPollSeconds) },
  { key: "transactionCategoryRequestEnabled", env: "TRANSACTION_CATEGORY_REQUEST_ENABLED", parser: "boolean", defaultValue: false },
  { key: "transactionCategoryRequestSubjectPrefix", env: "TRANSACTION_CATEGORY_REQUEST_SUBJECT_PREFIX", parser: "string", defaultValue: appDefaults.transactionCategoryRequestSubjectPrefix },
  { key: "transactionCategoryRequestRecipientPhoneNumber", env: "TRANSACTION_CATEGORY_REQUEST_RECIPIENT_PHONE_NUMBER", parser: "string", defaultValue: "" },
  { key: "imapHost", env: "IMAP_HOST", parser: "string", defaultValue: appDefaults.imapHost },
  { key: "imapPort", env: "IMAP_PORT", parser: "string", defaultValue: String(appDefaults.imapPort) },
  { key: "imapSecure", env: "IMAP_SECURE", parser: "boolean", defaultValue: appDefaults.imapSecure },
  { key: "imapUser", env: "IMAP_USER", parser: "string", defaultValue: "" },
];

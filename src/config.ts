import "dotenv/config";

export type AppConfig = {
  whatsapp: {
    phoneNumber: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  email: {
    from: string;
    to: string;
  };
};

export function loadConfig(env = process.env): AppConfig {
  return {
    whatsapp: {
      phoneNumber: requireEnv(env, "WHATSAPP_PHONE_NUMBER"),
    },
    smtp: {
      host: requireEnv(env, "SMTP_HOST"),
      port: readPort(env),
      secure: readBoolean(env, "SMTP_SECURE"),
      user: requireEnv(env, "SMTP_USER"),
      pass: requireEnv(env, "SMTP_PASS"),
    },
    email: {
      from: requireEnv(env, "EMAIL_FROM"),
      to: requireEnv(env, "EMAIL_TO"),
    },
  };
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function readPort(env: NodeJS.ProcessEnv): number {
  const value = Number(requireEnv(env, "SMTP_PORT"));

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("SMTP_PORT must be a positive integer");
  }

  return value;
}

function readBoolean(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = requireEnv(env, key).toLowerCase();

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${key} must be true or false`);
}

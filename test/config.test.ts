import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  WHATSAPP_PHONE_NUMBER: "12025550108",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "bot@example.com",
  SMTP_PASS: "secret",
  EMAIL_FROM: "bot@example.com",
  EMAIL_TO: "me@example.com",
};

describe("loadConfig", () => {
  it("loads required settings from environment variables", () => {
    expect(loadConfig(validEnv)).toEqual({
      whatsapp: {
        phoneNumber: "12025550108",
      },
      smtp: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        user: "bot@example.com",
        pass: "secret",
      },
      email: {
        from: "bot@example.com",
        to: "me@example.com",
      },
    });
  });

  it("fails fast when a required setting is missing", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        SMTP_PASS: "",
      }),
    ).toThrow("Missing required environment variable: SMTP_PASS");
  });

  it("rejects invalid SMTP ports", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        SMTP_PORT: "abc",
      }),
    ).toThrow("SMTP_PORT must be a positive integer");
  });
});

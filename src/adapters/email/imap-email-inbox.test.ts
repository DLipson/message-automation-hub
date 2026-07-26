import { describe, expect, it } from "vitest";
import { isAuthenticationFailure } from "./imap-email-inbox.js";

describe("isAuthenticationFailure", () => {
  it("detects imapflow auth errors", () => {
    expect(isAuthenticationFailure(Object.assign(new Error("bad creds"), { authenticationFailed: true }))).toBe(true);
    expect(isAuthenticationFailure(Object.assign(new Error("nope"), { serverResponseCode: "AUTHENTICATIONFAILED" }))).toBe(true);
  });

  it("treats transient errors and non-errors as retryable", () => {
    expect(isAuthenticationFailure(new Error("ETIMEDOUT"))).toBe(false);
    expect(isAuthenticationFailure(undefined)).toBe(false);
  });
});

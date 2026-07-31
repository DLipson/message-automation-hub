import { errorMessage, formatError } from "./errors.js";

/**
 * Startup runs under top-level await, so anything that throws there surfaces as an
 * unhandled rejection: a bare stack with no indication that the app failed to start
 * or why. Leads with one line that says both, and keeps the stack for anything that
 * is not an already-explained server response.
 */
export function reportStartupFailure(
  error: unknown,
  log: (message: string) => void = console.error,
): void {
  const responseText = (error as { responseText?: string } | null)?.responseText;
  const summary = responseText
    ? `${errorMessage(error)}: ${responseText}`
    : errorMessage(error);

  log(`Message Automation Hub failed to start: ${summary}`);

  if (!responseText) {
    log(formatError(error));
  }
}

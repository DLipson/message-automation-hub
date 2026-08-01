/**
 * Error formatting shared by adapters, use cases, and plugins.
 *
 * `formatError` is for logs and notification emails, where a stack is worth the
 * noise. `errorMessage` is for high-frequency paths (IMAP reconnect loops) where
 * a stack per retry would flood the journal.
 */

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isFileMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

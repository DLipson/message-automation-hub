import { createPluginContext } from "../../src/core/plugin-runtime.js";
import type { EmailAutomationHandler } from "../../src/use-cases/process-email-automations.js";
import { ProcessEmailAutomations } from "../../src/use-cases/process-email-automations.js";
import type { EmailInbox } from "../../src/ports/email-inbox.js";

export function runWithEmailHandler(
  inbox: EmailInbox,
  handler: EmailAutomationHandler,
): ProcessEmailAutomations {
  const ctx = createPluginContext();
  ctx.on("email.received", ({ email, batch }) => handler.handle(email, batch));
  return new ProcessEmailAutomations(inbox, ctx);
}

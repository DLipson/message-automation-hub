import { createPluginContext } from "../../../core/src/core/plugin-runtime.js";
import type { EmailAutomationHandler } from "@message-automation/core/api/index.js";
import { ProcessEmailAutomations } from "../../../core/src/use-cases/process-email-automations.js";
import type { EmailInbox } from "@message-automation/core/api/index.js";

export function runWithEmailHandler(
  inbox: EmailInbox,
  handler: EmailAutomationHandler,
): ProcessEmailAutomations {
  const ctx = createPluginContext();
  ctx.on("email.received", ({ email, batch }) => handler.handle(email, batch));
  return new ProcessEmailAutomations(inbox, ctx);
}

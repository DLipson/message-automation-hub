import type { InboundEmail } from "../domain/email.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailInbox, EmailLabeler, EmailStatusMarker } from "../ports/email-inbox.js";
import type { EmailSender } from "../ports/email-sender.js";
import type { InboundChannel } from "../ports/inbound-channel.js";
import type { WhatsAppChatSender, WhatsAppPairing, WhatsAppSender } from "../ports/whatsapp-sender.js";
import type { EmailAutomationBatch } from "../use-cases/process-email-automations.js";
import type { WhatsAppEmailThreadStore } from "../use-cases/whatsapp-email-thread-store.js";
import { errorMessage } from "../errors.js";
import { parseSubjectCommand } from "../use-cases/process-email-automations.js";
import type { PluginContext, HubPlugin } from "../api/index.js";

export interface Capabilities {
  "app.logger": AppLogger;
  "email.labels": EmailLabeler;
  "email.receive": EmailInbox;
  "email.send": EmailSender;
  "email.status": EmailStatusMarker;
  "thread.map": WhatsAppEmailThreadStore;
  "whatsapp.chat.send": WhatsAppChatSender;
  "whatsapp.pairing": WhatsAppPairing;
  "whatsapp.receive": InboundChannel;
  "whatsapp.send": WhatsAppSender;
}

export type CapabilityName = keyof Capabilities;

export interface EventMap {
  "email.received": { email: InboundEmail; batch: EmailAutomationBatch };
}

export type EventName = keyof EventMap;
export type EventHandler<E extends EventName> = (payload: EventMap[E]) => Promise<boolean>;

function assertName(value: string, label: string): string {
  const name = value.trim();
  if (!name) throw new Error(`${label} is required.`);
  return name;
}

export function createPluginContext(pluginConfig: Record<string, unknown> = {}): PluginContext {
  const caps = new Map<string, unknown>();
  const handlers = new Map<string, Array<(payload: unknown) => Promise<boolean>>>();

  return {
    provide(name, capability) {
      const key = assertName(name, "Capability name");
      if (caps.has(key)) throw new Error(`Capability "${key}" has already been provided.`);
      caps.set(key, capability);
    },
    require(name) {
      const key = assertName(name, "Capability name");
      if (!caps.has(key)) throw new Error(`Capability "${key}" not provided.`);
      return caps.get(key) as any;
    },
    has(name) { return caps.has(assertName(name, "Capability name")); },
    on(event, handler) {
      const key = assertName(event, "Event name");
      const list = handlers.get(key) ?? [];
      list.push(handler as any);
      handlers.set(key, list);
    },
    async emit(event, payload) {
      const key = assertName(event, "Event name");
      for (const handler of [...(handlers.get(key) ?? [])]) {
        if (await handler(payload)) return true;
      }
      return false;
    },
    hasListeners(event) {
      return (handlers.get(assertName(event, "Event name"))?.length ?? 0) > 0;
    },
    config: pluginConfig,
    formatError: (err) => errorMessage(err),
    parseSubjectCommand: (subject, prefix) => parseSubjectCommand(subject, prefix),
  };
}

export async function registerPlugins(
  plugins: HubPlugin[],
  contextOrConfig: PluginContext | Record<string, unknown> = {},
): Promise<PluginContext> {
  const context = isPluginContext(contextOrConfig)
    ? contextOrConfig
    : createPluginContext(contextOrConfig);
  const registered = new Set<string>();
  for (const plugin of plugins) {
    const name = assertName(plugin.name, "Plugin name");
    if (registered.has(name)) throw new Error(`Duplicate plugin "${name}".`);
    registered.add(name);
    await plugin.onLoad(context);
  }
  return context;
}

function isPluginContext(value: unknown): value is PluginContext {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PluginContext).provide === "function" &&
    typeof (value as PluginContext).require === "function"
  );
}

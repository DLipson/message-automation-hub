import type { InboundEmail } from "../domain/email.js";
import type { AppLogger } from "../ports/app-logger.js";
import type {
  EmailInbox,
  EmailLabeler,
  EmailStatusMarker,
} from "../ports/email-inbox.js";
import type { EmailSender } from "../ports/email-sender.js";
import type { InboundChannel } from "../ports/inbound-channel.js";
import type {
  WhatsAppChatSender,
  WhatsAppPairing,
  WhatsAppSender,
} from "../ports/whatsapp-sender.js";
import type { EmailAutomationBatch } from "../use-cases/process-email-automations.js";
import type { WhatsAppEmailThreadStore } from "../use-cases/whatsapp-email-thread-store.js";

/**
 * Every capability name paired with the contract behind it. This is the one
 * place the pairing is written down, so provide()/require() can check it
 * instead of trusting a caller-supplied type argument.
 */
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

/**
 * Event registry — plugins communicate via named events instead of pushing
 * into capability arrays. emit() calls handlers in registration order and
 * stops at the first one that returns true (first-wins / chain of
 * responsibility). Handlers return false to pass the event to the next
 * registered handler.
 */
export interface EventMap {
  "email.received": { email: InboundEmail; batch: EmailAutomationBatch };
}

export type EventName = keyof EventMap;

export type EventHandler<E extends EventName> = (
  payload: EventMap[E],
) => Promise<boolean>;

export type HubPlugin = {
  id: string;
  requires?: CapabilityName[];
  register(context: PluginContext): void | Promise<void>;
};

export type PluginContext = {
  provide<K extends CapabilityName>(name: K, capability: Capabilities[K]): void;
  require<K extends CapabilityName>(name: K): Capabilities[K];
  has(name: CapabilityName): boolean;
  on<E extends EventName>(event: E, handler: EventHandler<E>): void;
  emit<E extends EventName>(event: E, payload: EventMap[E]): Promise<boolean>;
};

export function createPluginContext(): PluginContext {
  const capabilities = new Map<string, unknown>();
  const eventHandlers = new Map<string, Array<(payload: unknown) => Promise<boolean>>>();

  return {
    provide<K extends CapabilityName>(name: K, capability: Capabilities[K]): void {
      const key = requiredName(name, "Capability name");

      if (capabilities.has(key)) {
        throw new Error(`Capability "${key}" has already been provided.`);
      }

      capabilities.set(key, capability);
    },

    require<K extends CapabilityName>(name: K): Capabilities[K] {
      const key = requiredName(name, "Capability name");

      if (!capabilities.has(key)) {
        throw new Error(`Capability "${key}" has not been provided.`);
      }

      return capabilities.get(key) as Capabilities[K];
    },

    has(name: CapabilityName): boolean {
      return capabilities.has(requiredName(name, "Capability name"));
    },

    on<E extends EventName>(event: E, handler: EventHandler<E>): void {
      const key = requiredName(event, "Event name");
      const list = eventHandlers.get(key) ?? [];
      list.push(handler as (payload: unknown) => Promise<boolean>);
      eventHandlers.set(key, list);
    },

    async emit<E extends EventName>(event: E, payload: EventMap[E]): Promise<boolean> {
      const key = requiredName(event, "Event name");
      const list = eventHandlers.get(key) ?? [];

      for (const handler of list) {
        if (await handler(payload)) {
          return true;
        }
      }

      return false;
    },
  };
}

export async function registerPlugins(
  plugins: HubPlugin[],
  context: PluginContext = createPluginContext(),
): Promise<PluginContext> {
  const registeredPluginIds = new Set<string>();

  for (const plugin of plugins) {
    const pluginId = requiredName(plugin.id, "Plugin id");

    if (registeredPluginIds.has(pluginId)) {
      throw new Error(`Duplicate plugin id "${pluginId}".`);
    }

    registeredPluginIds.add(pluginId);

    for (const capability of plugin.requires ?? []) {
      if (!context.has(capability)) {
        throw new Error(
          `Plugin "${pluginId}" requires missing capability "${capability}".`,
        );
      }
    }

    await plugin.register(context);
  }

  return context;
}

function requiredName(value: string, label: string): string {
  const name = value.trim();

  if (!name) {
    throw new Error(`${label} is required.`);
  }

  return name;
}

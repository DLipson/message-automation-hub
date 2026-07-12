export type HubPlugin = {
  id: string;
  requires?: string[];
  register(context: PluginContext): void | Promise<void>;
};

export type PluginContext = {
  provide<T>(name: string, capability: T): void;
  require<T>(name: string): T;
  has(name: string): boolean;
};

export function createPluginContext(): PluginContext {
  const capabilities = new Map<string, unknown>();

  return {
    provide<T>(name: string, capability: T): void {
      const key = requiredName(name, "Capability name");

      if (capabilities.has(key)) {
        throw new Error(`Capability "${key}" has already been provided.`);
      }

      capabilities.set(key, capability);
    },

    require<T>(name: string): T {
      const key = requiredName(name, "Capability name");

      if (!capabilities.has(key)) {
        throw new Error(`Capability "${key}" has not been provided.`);
      }

      return capabilities.get(key) as T;
    },

    has(name: string): boolean {
      return capabilities.has(requiredName(name, "Capability name"));
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

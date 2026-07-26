import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

// Entrypoints run work at import time (connect to Gmail, prompt for a password), so importing them
// here would execute the app. Their dependencies are all covered by the other modules below.
const entrypoints = ["index.ts", "settings/settings-server.ts", "tools/set-smtp-password.ts"];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

// ponytail: import-only smoke test. Proves every module loads — bad/missing named imports, import cycles,
// throws at module scope — not that anything works. Boot with fakes if wiring bugs start slipping through.
describe("every source module imports cleanly", async () => {
  const modules = (await sourceFiles(srcDir))
    .map(path => relative(srcDir, path).replaceAll("\\", "/"))
    .filter(module => !entrypoints.includes(module));

  expect(modules.length).toBeGreaterThan(20);

  for (const module of modules) {
    // Relative specifier, not a file:// URL — Vite cannot resolve the percent-encoded spaces in this path.
    it(module, async () => {
      await expect(import(`../src/${module}`)).resolves.toBeDefined();
    });
  }
});

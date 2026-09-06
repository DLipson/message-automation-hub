import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcHtml = readFileSync(
  join(__dirname, "..", "src", "settings", "settings-page.html"),
  "utf-8",
);

describe("settings-page.html", () => {
  it("contains all three placeholders", () => {
    expect(srcHtml).toContain("__TOKEN__");
    expect(srcHtml).toContain("__SECRET_STORE_OPTIONS__");
    expect(srcHtml).toContain("__POLL_INTERVAL__");
  });

  it("has no unescaped template expressions", () => {
    expect(srcHtml).not.toMatch(/\$\{/);
  });

  it("build artifact exists", () => {
    const distHtml = join(
      __dirname,
      "..",
      "dist",
      "settings",
      "settings-page.html",
    );
    expect(existsSync(distHtml)).toBe(true);
  });
});

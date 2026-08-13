import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultWhatsAppCatchUpStorePath,
  JsonWhatsAppCatchUpStore,
} from "../src/adapters/whatsapp/json-whatsapp-catch-up-store.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(dir => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "whatsapp-catch-up-"));
  tempDirs.push(dir);
  return join(dir, name);
}

describe("JsonWhatsAppCatchUpStore", () => {
  it("starts uninitialized when no state file exists", async () => {
    const store = new JsonWhatsAppCatchUpStore(await tempPath("missing.json"));

    await expect(store.load()).resolves.toEqual({
      initialized: false,
      chats: {},
    });
  });

  it("round-trips saved state", async () => {
    const store = new JsonWhatsAppCatchUpStore(await tempPath("state.json"));
    const state = { initialized: true, chats: { "123@g.us": 1_700_000_000 } };

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
  });

  it("serializes concurrent saves so the last one wins", async () => {
    const filePath = await tempPath("state.json");
    const store = new JsonWhatsAppCatchUpStore(filePath);

    await Promise.all([
      store.save({ initialized: true, chats: { a: 1 } }),
      store.save({ initialized: true, chats: { b: 2 } }),
    ]);

    const state = await store.load();
    expect(state.initialized).toBe(true);
    expect(Object.keys(state.chats).length).toBe(1);
    expect(state.chats.a ?? state.chats.b).toBeDefined();
  });

  it("defaults the store path under the env file directory", () => {
    const result = defaultWhatsAppCatchUpStorePath({
      MESSAGE_HUB_ENV_FILE: "C:/app/data/production.env",
    });
    expect(result).toBe(
      join(dirname("C:/app/data/production.env"), "whatsapp-catch-up.json"),
    );
  });

  it("lets WHATSAPP_CATCH_UP_STORE_FILE override the path", () => {
    expect(
      defaultWhatsAppCatchUpStorePath({
        WHATSAPP_CATCH_UP_STORE_FILE: "C:/app/catch-up.json",
      }),
    ).toBe("C:/app/catch-up.json");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultWhatsAppEmailThreadStorePath,
  JsonWhatsAppEmailThreadStore,
} from "../src/adapters/email/json-whatsapp-email-thread-store.js";
import {
  forwardedMessageId,
  replyMarker,
  replyTextFor,
  tokenFromMessageId,
  tokenFromSubject,
} from "../src/use-cases/whatsapp-email-thread-store.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(dir => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

describe("JsonWhatsAppEmailThreadStore", () => {
  it("persists and finds a WhatsApp email thread", async () => {
    const filePath = await tempPath("threads.json");
    const store = new JsonWhatsAppEmailThreadStore(filePath);

    const thread = await store.getOrCreate("127513921597547@lid", "Dovid");
    const sameThread = await new JsonWhatsAppEmailThreadStore(filePath)
      .getOrCreate("127513921597547@lid", "Dovid changed");

    expect(sameThread).toEqual(thread);
    await expect(store.findByToken(thread.token)).resolves.toEqual(thread);
    await expect(store.findByMessageId(thread.rootMessageId)).resolves.toEqual(thread);
    expect(thread.subject).toBe(`WhatsApp: Dovid [wa:${thread.token}]`);
  });

  it("returns null when no stored thread matches", async () => {
    const store = new JsonWhatsAppEmailThreadStore(await tempPath("missing.json"));

    await expect(store.findByToken("missing")).resolves.toBeNull();
    await expect(store.findByMessageId("<missing@example.com>")).resolves.toBeNull();
  });

  it("cleans display names before putting them in email subjects", async () => {
    const store = new JsonWhatsAppEmailThreadStore(await tempPath("threads.json"));

    const thread = await store.getOrCreate("12025550108@c.us", "\n A Friend\r\n");

    expect(thread.subject).toBe(`WhatsApp: A Friend [wa:${thread.token}]`);
  });

  it("uses an explicit thread store path when configured", () => {
    expect(defaultWhatsAppEmailThreadStorePath({
      EMAIL_THREAD_STORE_FILE: "C:\\secrets\\threads.json",
    })).toBe("C:\\secrets\\threads.json");
  });

  it("defaults the thread store next to the configured env file", () => {
    expect(defaultWhatsAppEmailThreadStorePath({
      MESSAGE_HUB_ENV_FILE: "C:\\secrets\\message-hub\\.env",
    })).toBe(join("C:\\secrets\\message-hub", "whatsapp-email-threads.json"));
  });
});

describe("WhatsApp email thread helpers", () => {
  it("extracts thread tokens from subjects and generated message ids", () => {
    const thread = {
      token: "abc_123-x",
      chatId: "127513921597547@lid",
      subject: "WhatsApp: Dovid [wa:abc_123-x]",
      rootMessageId: "<wa.abc_123-x@message-automation-hub.local>",
    };

    expect(tokenFromSubject("Re: WhatsApp: Dovid [wa:abc_123-x]")).toBe("abc_123-x");
    expect(tokenFromMessageId(forwardedMessageId(thread, "message-1"))).toBe("abc_123-x");
    expect(tokenFromMessageId(thread.rootMessageId)).toBe("abc_123-x");
  });

  it("returns null for non-thread subjects and message ids", () => {
    expect(tokenFromSubject("Re: WhatsApp: Dovid")).toBeNull();
    expect(tokenFromMessageId("<ordinary@example.com>")).toBeNull();
  });

  it("keeps only the author's reply above the marker", () => {
    expect(replyTextFor([" Yes ", "", replyMarker, "", "quoted"].join("\n"))).toBe("Yes");
  });
});

async function tempPath(fileName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "message-automation-hub-"));
  tempDirs.push(dir);
  return join(dir, fileName);
}

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSecretStore } from "../src/adapters/secrets/file-secret-store.js";
import {
  defaultSecretFilePath,
  selectSecretStore,
} from "../src/adapters/secrets/secret-store-factory.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(dir => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

describe("selectSecretStore", () => {
  it("uses Windows Credential Manager by default on Windows", () => {
    expect(selectSecretStore({}, "win32")).toEqual({
      kind: "windows-credential",
    });
  });

  it("uses a file secret store by default on Linux", () => {
    expect(selectSecretStore({}, "linux")).toEqual({
      kind: "file",
      filePath: defaultSecretFilePath(),
    });
  });

  it("allows explicitly choosing file storage", () => {
    expect(
      selectSecretStore(
        {
          MESSAGE_HUB_SECRET_STORE: "file",
          MESSAGE_HUB_SECRET_FILE: "/srv/message-hub/secrets.json",
        },
        "win32",
      ),
    ).toEqual({
      kind: "file",
      filePath: "/srv/message-hub/secrets.json",
    });
  });

  it("uses the default file path when the configured secret file is blank", () => {
    expect(
      selectSecretStore(
        {
          MESSAGE_HUB_SECRET_STORE: "file",
          MESSAGE_HUB_SECRET_FILE: "",
        },
        "linux",
      ),
    ).toEqual({
      kind: "file",
      filePath: defaultSecretFilePath(),
    });
  });
});

describe("FileSecretStore", () => {
  it("stores, reads, and deletes secrets from a protected JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "message-hub-secrets-"));
    tempDirs.push(dir);
    const filePath = join(dir, "secrets.json");
    const store = new FileSecretStore(filePath);
    const ref = { service: "message-automation-hub", account: "smtp-password" };

    await expect(store.get(ref)).resolves.toBeNull();

    await store.set(ref, "secret");

    await expect(store.get(ref)).resolves.toBe("secret");
    await expect(stat(filePath)).resolves.toMatchObject({ mode: expect.any(Number) });

    await expect(store.delete(ref)).resolves.toBe(true);
    await expect(store.get(ref)).resolves.toBeNull();
  });
});

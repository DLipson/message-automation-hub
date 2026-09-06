import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicJsonFile } from "../../src/adapters/atomic/atomic-json-file.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(dir => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atomic-json-file-"));
  tempDirs.push(dir);
  return join(dir, name);
}

describe("AtomicJsonFile", () => {
  it("reads null when the file does not exist", async () => {
    const file = new AtomicJsonFile<{ count: number }>(await tempPath("missing.json"));

    expect(await file.readRaw()).toBeNull();
  });

  it("round-trips saved data", async () => {
    const file = new AtomicJsonFile<{ count: number }>(await tempPath("data.json"));

    await file.save({ count: 42 });

    expect(await file.readRaw()).toEqual({ count: 42 });
  });

  it("writes pretty-printed JSON with a trailing newline", async () => {
    const filePath = await tempPath("pretty.json");
    const file = new AtomicJsonFile<{ count: number }>(filePath);

    await file.save({ count: 1 });

    const raw = await readFile(filePath, "utf8");
    expect(raw).toBe(JSON.stringify({ count: 1 }, null, 2) + "\n");
  });

  it("creates parent directories if missing", async () => {
    const filePath = await tempPath("nested/deep/data.json");
    const file = new AtomicJsonFile<{ value: string }>(filePath);

    await file.save({ value: "ok" });

    expect(await file.readRaw()).toEqual({ value: "ok" });
  });

  it("serializes concurrent enqueued saves so the last one wins", async () => {
    const file = new AtomicJsonFile<{ n: number }>(await tempPath("race.json"));

    await Promise.all([
      file.enqueue(() => file.save({ n: 1 })),
      file.enqueue(() => file.save({ n: 2 })),
    ]);

    const data = await file.readRaw();
    expect(data).toEqual({ n: 2 });
  });

  it("rethrows invalid JSON instead of treating it as missing", async () => {
    const filePath = await tempPath("corrupt.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, "not json");

    await expect(new AtomicJsonFile(filePath).readRaw()).rejects.toThrow();
  });
});

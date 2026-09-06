import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isFileMissing } from "../../errors.js";

/**
 * Atomic JSON file with a single write queue carried by this class.
 *
 * `save()` is deliberately NOT queued: a self-enqueuing save nested inside an
 * `enqueue()` read-modify-write would wait on itself and deadlock. Wrap the whole
 * read-modify-write cycle in `enqueue()` and never call `save()` inside one.
 */
export class AtomicJsonFile<T> {
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async save(data: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tempPath, this.filePath);
  }

  async readRaw(): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as T;
    } catch (error) {
      if (isFileMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  enqueue<U>(operation: () => Promise<U>): Promise<U> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
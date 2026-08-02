import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultEnvFilePath } from "../../config.js";
import { isFileMissing } from "../../errors.js";
import type {
  PendingGroupInvite,
  PendingGroupInviteStore,
} from "../../use-cases/pending-group-invite-store.js";

export class JsonPendingGroupInviteStore implements PendingGroupInviteStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async put(token: string, inviteCode: string): Promise<void> {
    await this.enqueue(async () => {
      const invites = await this.readInvites();
      const next = [...invites.filter(invite => invite.token !== token), { token, inviteCode }];
      await this.writeInvites(next);
    });
  }

  async findByToken(token: string): Promise<PendingGroupInvite | null> {
    return (await this.readInvites()).find(invite => invite.token === token) ?? null;
  }

  async remove(token: string): Promise<void> {
    await this.enqueue(async () => {
      const invites = await this.readInvites();
      await this.writeInvites(invites.filter(invite => invite.token !== token));
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return await result;
  }

  private async readInvites(): Promise<PendingGroupInvite[]> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as PendingGroupInvite[];
    } catch (error) {
      if (isFileMissing(error)) {
        return [];
      }

      throw error;
    }
  }

  private async writeInvites(invites: PendingGroupInvite[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(invites, null, 2)}\n`);
    await rename(tempPath, this.filePath);
  }
}

export function defaultPendingGroupInviteStorePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.PENDING_GROUP_INVITE_STORE_FILE ?? join(
    dirname(env.MESSAGE_HUB_ENV_FILE ?? defaultEnvFilePath()),
    "pending-group-invites.json",
  );
}

// ponytail: single pending invite per token; a second invite to the same thread
// replaces the first. Add per-token lists if overlapping invites ever matter.

import { dirname, join } from "node:path";
import { defaultEnvFilePath } from "../../config.js";
import type {
  PendingGroupInvite,
  PendingGroupInviteDetails,
  PendingGroupInviteStore,
} from "../../use-cases/pending-group-invite-store.js";
import { AtomicJsonFile } from "../atomic/atomic-json-file.js";

export class JsonPendingGroupInviteStore implements PendingGroupInviteStore {
  private readonly file: AtomicJsonFile<PendingGroupInvite[]>;

  constructor(filePath: string) {
    this.file = new AtomicJsonFile<PendingGroupInvite[]>(filePath);
  }

  async put(token: string, invite: PendingGroupInviteDetails): Promise<void> {
    await this.file.enqueue(async () => {
      const invites = await this.readInvites();
      const next = [...invites.filter(existing => existing.token !== token), { token, ...invite }];
      await this.file.save(next);
    });
  }

  async findByToken(token: string): Promise<PendingGroupInvite | null> {
    return (await this.readInvites()).find(invite => invite.token === token) ?? null;
  }

  async remove(token: string): Promise<void> {
    await this.file.enqueue(async () => {
      const invites = await this.readInvites();
      await this.file.save(invites.filter(invite => invite.token !== token));
    });
  }

  private async readInvites(): Promise<PendingGroupInvite[]> {
    return (await this.file.readRaw()) ?? [];
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

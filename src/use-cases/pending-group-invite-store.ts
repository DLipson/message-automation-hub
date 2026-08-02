export type PendingGroupInvite = {
  token: string;
  inviteCode: string;
};

export interface PendingGroupInviteStore {
  put(token: string, inviteCode: string): Promise<void>;
  findByToken(token: string): Promise<PendingGroupInvite | null>;
  remove(token: string): Promise<void>;
}

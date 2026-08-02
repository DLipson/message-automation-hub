import type { WhatsAppGroupInviteV4 } from "../ports/whatsapp-sender.js";

export type PendingGroupInviteDetails = {
  inviteCode?: string;
  inviteV4?: WhatsAppGroupInviteV4;
};

export type PendingGroupInvite = {
  token: string;
} & PendingGroupInviteDetails;

export interface PendingGroupInviteStore {
  put(token: string, invite: PendingGroupInviteDetails): Promise<void>;
  findByToken(token: string): Promise<PendingGroupInvite | null>;
  remove(token: string): Promise<void>;
}

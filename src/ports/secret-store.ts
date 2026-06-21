export type SecretRef = {
  service: string;
  account: string;
};

export interface SecretStore {
  get(ref: SecretRef): Promise<string | null>;
  set(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<boolean>;
}

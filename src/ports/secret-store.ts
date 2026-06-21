export type SecretRef = {
  service: string;
  account: string;
};

export interface SecretStore {
  get(ref: SecretRef): Promise<string | null>;
}

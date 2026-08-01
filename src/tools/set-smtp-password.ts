import { stdin, stdout } from "node:process";
import { createSecretStore } from "../adapters/secrets/secret-store-factory.js";
import { loadRuntimeEnv, SMTP_PASSWORD_SECRET } from "../config.js";

loadRuntimeEnv();

const password = await readPassword("SMTP app password: ");

if (!password.trim()) {
  throw new Error("Password cannot be empty");
}

const secretStore = await createSecretStore();
await secretStore.set(SMTP_PASSWORD_SECRET, password);

stdout.write(
  `Saved ${SMTP_PASSWORD_SECRET.service}/${SMTP_PASSWORD_SECRET.account} to the configured secret store.\n`,
);

async function readPassword(prompt: string): Promise<string> {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let value = "";

  return new Promise((resolve, reject) => {
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      resolve(value);
    };

    stdin.on("data", keyInput => {
      const key = String(keyInput);

      if (key === "\u0003") {
        stdin.setRawMode(false);
        stdin.pause();
        reject(new Error("Cancelled"));
        return;
      }

      if (key === "\r" || key === "\n") {
        finish();
        return;
      }

      if (key === "\b" || key === "\u007f") {
        value = value.slice(0, -1);
        return;
      }

      value += key;
    });
  });
}

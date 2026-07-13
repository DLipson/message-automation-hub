import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseEnv } from "node:util";
import {
  appSettingsToEnv,
  emptyAppSettings,
  envToAppSettings,
  type AppSettings,
} from "./app-settings.js";

export class EnvFileSettingsStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<AppSettings> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return envToAppSettings(parseEnv(content));
    } catch (error) {
      if (isFileMissing(error)) {
        return emptyAppSettings;
      }

      throw error;
    }
  }

  async write(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, this.serialize(settings), "utf8");
    await rename(tempPath, this.filePath);
  }

  private serialize(settings: AppSettings): string {
    return `${Object.entries(appSettingsToEnv(settings))
      .map(([key, value]) => `${key}=${formatEnvValue(value)}`)
      .join("\n")}\n`;
  }
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9@._:+/-]*$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function isFileMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}


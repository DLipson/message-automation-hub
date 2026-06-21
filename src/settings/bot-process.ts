import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

export type BotStatus = "stopped" | "starting" | "running" | "crashed";

export type BotProcessSnapshot = {
  status: BotStatus;
  logs: string[];
};

const maxLogLines = 300;

export type RunningBotProcess = EventEmitter & {
  pid?: number | undefined;
  stdout: Readable;
  stderr: Readable;
  kill(): boolean;
};

export type BotProcessDependencies = {
  spawnProcess?: (options: BotProcessOptions) => RunningBotProcess;
  killProcessTree?: (process: RunningBotProcess) => void;
};

export type BotProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export class BotProcess {
  private child: RunningBotProcess | undefined;
  private status: BotStatus = "stopped";
  private logs: string[] = [];
  private readonly spawnProcess: (options: BotProcessOptions) => RunningBotProcess;
  private readonly killProcessTree: (process: RunningBotProcess) => void;

  constructor(
    private readonly options: BotProcessOptions,
    dependencies: BotProcessDependencies = {},
  ) {
    this.spawnProcess = dependencies.spawnProcess ?? spawnBotProcess;
    this.killProcessTree = dependencies.killProcessTree ?? killBotProcessTree;
  }

  start(): BotProcessSnapshot {
    if (this.child) {
      return this.snapshot();
    }

    this.status = "starting";
    this.appendLog("Starting bot...");

    const child = this.spawnProcess(this.options);
    this.child = child;

    child.stdout.on("data", data => {
      this.status = "running";
      this.appendLog(String(data));
    });

    child.stderr.on("data", data => {
      this.appendLog(String(data));
    });

    child.on("exit", code => {
      if (this.child !== child) {
        return;
      }

      this.appendLog(`Bot exited with code ${code ?? "unknown"}.`);
      this.status = code === 0 ? "stopped" : "crashed";
      this.child = undefined;
    });

    return this.snapshot();
  }

  stop(): BotProcessSnapshot {
    if (!this.child) {
      this.status = "stopped";
      return this.snapshot();
    }

    this.appendLog("Stopping bot...");
    this.killProcessTree(this.child);
    this.child = undefined;
    this.status = "stopped";
    return this.snapshot();
  }

  snapshot(): BotProcessSnapshot {
    return {
      status: this.status,
      logs: [...this.logs],
    };
  }

  addLog(message: string): void {
    this.appendLog(message);
  }

  private appendLog(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        this.logs.push(line);
      }
    }

    this.logs = this.logs.slice(-maxLogLines);
  }
}

function spawnBotProcess(options: BotProcessOptions): RunningBotProcess {
  return spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: true,
  });
}

function killBotProcessTree(botProcess: RunningBotProcess): void {
  if (process.platform === "win32" && botProcess.pid) {
    spawn("taskkill", ["/PID", String(botProcess.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => {
      botProcess.kill();
    });
    return;
  }

  botProcess.kill();
}

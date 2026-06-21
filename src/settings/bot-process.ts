import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type BotStatus = "stopped" | "starting" | "running" | "crashed";

export type BotProcessSnapshot = {
  status: BotStatus;
  logs: string[];
};

const maxLogLines = 300;

export class BotProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private status: BotStatus = "stopped";
  private logs: string[] = [];

  constructor(
    private readonly options: {
      command: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ) {}

  start(): BotProcessSnapshot {
    if (this.child) {
      return this.snapshot();
    }

    this.status = "starting";
    this.appendLog("Starting bot...");

    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: true,
    });

    this.child.stdout.on("data", data => {
      this.status = "running";
      this.appendLog(String(data));
    });

    this.child.stderr.on("data", data => {
      this.appendLog(String(data));
    });

    this.child.on("exit", code => {
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
    this.child.kill();
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

  private appendLog(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        this.logs.push(line);
      }
    }

    this.logs = this.logs.slice(-maxLogLines);
  }
}

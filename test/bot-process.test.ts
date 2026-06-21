import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BotProcess, type RunningBotProcess } from "../src/settings/bot-process.js";

class FakeRunningProcess extends EventEmitter implements RunningBotProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("BotProcess", () => {
  it("stops the full process tree for the running bot", () => {
    const child = new FakeRunningProcess();
    const killedProcesses: RunningBotProcess[] = [];
    const bot = new BotProcess(
      {
        command: "npm",
        args: ["run", "dev"],
        cwd: "C:\\project",
        env: {},
      },
      {
        spawnProcess: () => child,
        killProcessTree: process => {
          killedProcesses.push(process);
        },
      },
    );

    bot.start();
    const snapshot = bot.stop();

    expect(killedProcesses).toEqual([child]);
    expect(snapshot.status).toBe("stopped");
  });

  it("does not mark the bot as crashed when a stopped child exits later", () => {
    const child = new FakeRunningProcess();
    const bot = new BotProcess(
      {
        command: "npm",
        args: ["run", "dev"],
        cwd: "C:\\project",
        env: {},
      },
      {
        spawnProcess: () => child,
        killProcessTree: () => {},
      },
    );

    bot.start();
    bot.stop();
    child.emit("exit", 1);

    expect(bot.snapshot().status).toBe("stopped");
  });
});

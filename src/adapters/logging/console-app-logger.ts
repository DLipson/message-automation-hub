import type { AppLogger } from "../../ports/app-logger.js";

export class ConsoleAppLogger implements AppLogger {
  info(message: string): void {
    console.log(message);
  }
}

export interface AppLogger {
  info(message: string): void;
}

export const silentLogger: AppLogger = {
  info() {},
};

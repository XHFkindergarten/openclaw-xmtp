const DEBUG = process.argv.includes("--debug") || process.env.DEBUG === "1";

type Level = "INFO" | "DEBUG" | "ERROR";

function formatMsg(level: Level, msg: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.padEnd(5)}] ${msg}`;
}

export function info(msg: string): void {
  console.log(formatMsg("INFO", msg));
}

export function debug(msg: string): void {
  if (DEBUG) {
    console.log(formatMsg("DEBUG", msg));
  }
}

export function error(msg: string, err?: unknown): void {
  console.error(formatMsg("ERROR", msg));
  if (err && DEBUG) {
    console.error(err);
  }
}

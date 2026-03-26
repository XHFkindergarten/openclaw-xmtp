import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type XMTPCursorState = {
  since: number;
  seenAtSince: string[];
};

const DEFAULT_STATE: XMTPCursorState = {
  since: 0,
  seenAtSince: [],
};

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function stateFilePath(stateDir: string, accountId: string): string {
  return join(stateDir, `${accountId}.json`);
}

export function loadCursorState(stateDir: string, accountId: string): XMTPCursorState {
  try {
    const raw = readFileSync(stateFilePath(stateDir, accountId), "utf-8");
    const parsed = JSON.parse(raw) as Partial<XMTPCursorState>;
    return {
      since: typeof parsed.since === "number" ? parsed.since : 0,
      seenAtSince: Array.isArray(parsed.seenAtSince) ? parsed.seenAtSince.map(String) : [],
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveCursorState(stateDir: string, accountId: string, state: XMTPCursorState): void {
  ensureDir(stateDir);
  writeFileSync(stateFilePath(stateDir, accountId), JSON.stringify(state, null, 2));
}

export function updateCursorState(
  current: XMTPCursorState,
  messageKey: string,
  timestamp: number,
): XMTPCursorState {
  if (timestamp > current.since) {
    return {
      since: timestamp,
      seenAtSince: [messageKey],
    };
  }
  if (timestamp === current.since) {
    const nextSeen = current.seenAtSince.includes(messageKey)
      ? current.seenAtSince
      : [...current.seenAtSince, messageKey];
    return {
      since: current.since,
      seenAtSince: nextSeen,
    };
  }
  return current;
}

export function shouldProcessMessage(
  current: XMTPCursorState,
  messageKey: string,
  timestamp: number,
): boolean {
  if (timestamp < current.since) {
    return false;
  }
  if (timestamp > current.since) {
    return true;
  }
  return !current.seenAtSince.includes(messageKey);
}

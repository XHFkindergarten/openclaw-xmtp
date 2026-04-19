import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatermarkStore } from "../src/domains/daemon/watermark-store.js";

describe("WatermarkStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wm-"));
    file = join(dir, "watermarks.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("load on missing file initializes empty", () => {
    const s = new WatermarkStore(file);
    s.load();
    expect(s.get("any")).toBe(0n);
    expect(s.snapshot().size).toBe(0);
  });

  it("get returns 0n for unknown conversationId", () => {
    const s = new WatermarkStore(file);
    expect(s.get("conv-x")).toBe(0n);
  });

  it("ack monotonically advances and persists", () => {
    const s = new WatermarkStore(file);
    expect(s.ack("conv-1", 100n)).toBe(true);
    expect(s.get("conv-1")).toBe(100n);
    expect(existsSync(file)).toBe(true);

    const s2 = new WatermarkStore(file);
    s2.load();
    expect(s2.get("conv-1")).toBe(100n);
  });

  it("ack rejects equal or older ns (no regression)", () => {
    const s = new WatermarkStore(file);
    s.ack("conv-1", 200n);
    expect(s.ack("conv-1", 200n)).toBe(false);
    expect(s.ack("conv-1", 100n)).toBe(false);
    expect(s.get("conv-1")).toBe(200n);
  });

  it("multiple conversations are independent", () => {
    const s = new WatermarkStore(file);
    s.ack("a", 10n);
    s.ack("b", 20n);
    s.ack("a", 15n);
    expect(s.get("a")).toBe(15n);
    expect(s.get("b")).toBe(20n);
  });

  it("preserves bigint precision beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = (2n ** 60n) + 7n;
    const s = new WatermarkStore(file);
    s.ack("c", huge);

    const reload = new WatermarkStore(file);
    reload.load();
    expect(reload.get("c")).toBe(huge);
  });

  it("rejects unsupported schema version", () => {
    writeFileSync(file, JSON.stringify({ version: 999, entries: {} }));
    const s = new WatermarkStore(file);
    expect(() => s.load()).toThrow(/schema version/);
  });

  it("atomic write: tmp file is removed after successful flush", () => {
    const s = new WatermarkStore(file);
    s.ack("c", 1n);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it("written file uses string-encoded bigints", () => {
    const s = new WatermarkStore(file);
    s.ack("conv-1", 12345n);
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(typeof parsed.entries["conv-1"]).toBe("string");
    expect(parsed.entries["conv-1"]).toBe("12345");
  });

  it("flushSync is no-op when not dirty", () => {
    const s = new WatermarkStore(file);
    s.flushSync();
    expect(existsSync(file)).toBe(false);
  });

  it("snapshot returns a copy (mutation does not leak)", () => {
    const s = new WatermarkStore(file);
    s.ack("conv-1", 5n);
    const snap = s.snapshot() as Map<string, bigint>;
    snap.set("conv-1", 999n);
    expect(s.get("conv-1")).toBe(5n);
  });
});

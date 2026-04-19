import { describe, it, expect, vi } from "vitest";
import { SessionQueue } from "../src/domains/daemon/queue.js";

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe("SessionQueue – edge cases", () => {
  it("multiple pending entries for the same taskId are promoted one by one", async () => {
    const q = new SessionQueue<string>({ maxConcurrentChats: 2 });
    const order: string[] = [];

    let release1!: () => void;
    let release2!: () => void;
    let release3!: () => void;

    // task-a gets 3 messages; task-b occupies the second slot
    q.enqueue("task-a", "a1", async () => {
      await new Promise<void>((r) => { release1 = r; });
      order.push("a1");
    });
    q.enqueue("task-b", "b1", async () => {
      await new Promise<void>((r) => { release2 = r; });
      order.push("b1");
    });
    q.enqueue("task-a", "a2", async () => {
      await new Promise<void>((r) => { release3 = r; });
      order.push("a2");
    });
    q.enqueue("task-a", "a3", async () => { order.push("a3"); });

    // a1 and b1 are active; a2, a3 are pending
    await delay(10);
    expect(q.activeCount).toBe(2);
    expect(q.pendingCount).toBe(2);

    // Release a1 → a2 promoted (task-b still active)
    release1();
    await delay(20);
    expect(order).toContain("a1");
    expect(q.activeCount).toBe(2); // b1 + a2

    // Release a2 → a3 promoted
    release3();
    await delay(20);
    expect(order).toContain("a2");

    release2();
    await delay(20);
    expect(order).toContain("a3");
    expect(order).toContain("b1");
    expect(q.activeCount).toBe(0);
    expect(q.pendingCount).toBe(0);
  });

  it("drain is no-op when all pending taskIds are still active", async () => {
    const q = new SessionQueue<string>({ maxConcurrentChats: 2 });
    const order: string[] = [];

    let releaseA!: () => void;
    let releaseB!: () => void;

    q.enqueue("task-a", "a1", async () => {
      await new Promise<void>((r) => { releaseA = r; });
      order.push("a1");
    });
    q.enqueue("task-b", "b1", async () => {
      await new Promise<void>((r) => { releaseB = r; });
      order.push("b1");
    });
    // Both slots occupied by task-a and task-b
    q.enqueue("task-a", "a2", async () => { order.push("a2"); });
    q.enqueue("task-b", "b2", async () => { order.push("b2"); });

    await delay(10);
    expect(q.activeCount).toBe(2);
    expect(q.pendingCount).toBe(2);
    // Neither a2 nor b2 can be promoted — all pending taskIds are active
    expect(order).toEqual([]);

    releaseA();
    await delay(20);
    // a1 done → a2 promoted (not b2, because task-a slot freed and a2 is first non-active)
    expect(order).toContain("a1");
    expect(order).toContain("a2");

    releaseB();
    await delay(20);
    expect(order).toContain("b1");
    expect(order).toContain("b2");
  });

  it("10 different tasks all start concurrently at maxConcurrentChats=10", async () => {
    const q = new SessionQueue<string>({ maxConcurrentChats: 10 });
    const starts: string[] = [];

    const releases: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      const taskId = `task-${i}`;
      q.enqueue(taskId, `p${i}`, async () => {
        await new Promise<void>((r) => { releases[i] = r; });
        starts.push(taskId);
      });
    }

    await delay(10);
    expect(q.activeCount).toBe(10);
    expect(q.pendingCount).toBe(0);

    releases.forEach((r) => r());
    await delay(20);
    expect(q.activeCount).toBe(0);
    expect(starts).toHaveLength(10);
  });

  it("11th task queues when maxConcurrentChats=10", async () => {
    const q = new SessionQueue<string>({ maxConcurrentChats: 99 }); // capped at 10
    const releases: Array<() => void> = [];

    for (let i = 0; i < 10; i++) {
      q.enqueue(`task-${i}`, `p${i}`, async () => {
        await new Promise<void>((r) => { releases[i] = r; });
      });
    }
    q.enqueue("task-overflow", "extra", vi.fn().mockResolvedValue(undefined));

    await delay(10);
    expect(q.activeCount).toBe(10);
    expect(q.pendingCount).toBe(1);

    releases.forEach((r) => r?.());
    await delay(20);
    expect(q.activeCount).toBe(0);
    expect(q.pendingCount).toBe(0);
  });
});

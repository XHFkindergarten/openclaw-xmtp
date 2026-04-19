import { describe, it, expect, vi } from "vitest";
import { SessionQueue } from "../src/domains/daemon/queue.js";

describe("SessionQueue", () => {
  it("enforces maxConcurrentChats lower bound of 1", () => {
    const q = new SessionQueue<string>({ maxConcurrentChats: 0 });
    expect(q.activeCount).toBe(0);
  });

  it("enforces maxConcurrentChats upper bound of 10", () => {
    const q = new SessionQueue<string>({ maxConcurrentChats: 99 });
    expect(q.activeCount).toBe(0);
  });

  it("runs handler immediately when slot available", async () => {
    const q = new SessionQueue<string>({ maxConcurrentChats: 2 });
    const order: string[] = [];

    let resolveA!: () => void;
    const handlerA = vi.fn(async () => {
      await new Promise<void>((r) => { resolveA = r; });
      order.push("A");
    });

    q.enqueue("task-a", "payload-a", handlerA);
    expect(q.activeCount).toBe(1);
    expect(handlerA).toHaveBeenCalledOnce();

    resolveA();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["A"]);
    expect(q.activeCount).toBe(0);
  });

  it("queues handler when max slots occupied", async () => {
    const q = new SessionQueue<string>({ maxConcurrentChats: 1 });
    const order: string[] = [];

    let resolveA!: () => void;
    const handlerA = vi.fn(async () => {
      await new Promise<void>((r) => { resolveA = r; });
      order.push("A");
    });
    const handlerB = vi.fn(async () => { order.push("B"); });

    q.enqueue("task-a", "payload-a", handlerA);
    q.enqueue("task-b", "payload-b", handlerB);

    expect(q.activeCount).toBe(1);
    expect(q.pendingCount).toBe(1);
    expect(handlerB).not.toHaveBeenCalled();

    resolveA();
    await new Promise((r) => setTimeout(r, 20));

    expect(order).toEqual(["A", "B"]);
    expect(q.activeCount).toBe(0);
    expect(q.pendingCount).toBe(0);
  });

  it("runs same taskId serially even with capacity available", async () => {
    const q = new SessionQueue<string>({ maxConcurrentChats: 2 });
    const order: string[] = [];

    let resolveA1!: () => void;
    const handler1 = vi.fn(async () => {
      await new Promise<void>((r) => { resolveA1 = r; });
      order.push("A1");
    });
    const handler2 = vi.fn(async () => { order.push("A2"); });

    q.enqueue("task-a", "payload-1", handler1);
    q.enqueue("task-a", "payload-2", handler2);

    expect(q.activeCount).toBe(1);
    expect(q.pendingCount).toBe(1);

    resolveA1();
    await new Promise((r) => setTimeout(r, 20));

    expect(order).toEqual(["A1", "A2"]);
  });

  it("handler errors do not block the queue", async () => {
    const q = new SessionQueue<string>({ maxConcurrentChats: 1 });
    const order: string[] = [];

    const badHandler = vi.fn(async () => { throw new Error("boom"); });
    const goodHandler = vi.fn(async () => { order.push("good"); });

    q.enqueue("task-a", "bad", badHandler);
    q.enqueue("task-b", "good", goodHandler);

    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["good"]);
  });
});

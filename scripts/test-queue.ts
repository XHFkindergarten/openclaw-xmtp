/**
 * Phase 5 验收：SessionQueue 并发控制集成测试（不依赖 XMTP 网络）
 */
import { SessionQueue } from "../src/domains/daemon/queue.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Test 1: maxConcurrentChats=2，三条消息，前两条并发，第三条等待 ──
{
  const q = new SessionQueue<string>({ maxConcurrentChats: 2 });
  const order: string[] = [];

  let releaseA!: () => void;
  let releaseB!: () => void;

  q.enqueue("task-a", "payload-a", async () => {
    await new Promise<void>((r) => { releaseA = r; });
    order.push("A");
  });
  q.enqueue("task-b", "payload-b", async () => {
    await new Promise<void>((r) => { releaseB = r; });
    order.push("B");
  });
  q.enqueue("task-c", "payload-c", async () => { order.push("C"); });

  await delay(20);
  if (q.activeCount !== 2) throw new Error(`Test1 fail: expected 2 active, got ${q.activeCount}`);
  if (q.pendingCount !== 1) throw new Error(`Test1 fail: expected 1 pending, got ${q.pendingCount}`);
  console.log("[test1] 2 active + 1 pending ✓");

  releaseA();
  releaseB();
  await delay(20);
  const activeAfterDrain = q.activeCount as number;
  if (activeAfterDrain !== 0) throw new Error(`Test1 fail: expected 0 active after drain: ${activeAfterDrain}`);
  if (!order.includes("A") || !order.includes("B") || !order.includes("C")) {
    throw new Error(`Test1 fail: not all handlers ran: ${order.join(",")}`);
  }
  console.log(`[test1] all handlers completed in order: ${order.join(",")} ✓`);
}

// ── Test 2: 同一 taskId 同时入队，必须串行 ──
{
  const q = new SessionQueue<string>({ maxConcurrentChats: 5 });
  const order: string[] = [];

  let release1!: () => void;
  q.enqueue("task-x", "p1", async () => {
    await new Promise<void>((r) => { release1 = r; });
    order.push("x1");
  });
  q.enqueue("task-x", "p2", async () => { order.push("x2"); });

  await delay(20);
  if (q.pendingCount !== 1) throw new Error(`Test2 fail: expected 1 pending, got ${q.pendingCount}`);
  console.log("[test2] same taskId serialized ✓");

  release1();
  await delay(20);
  if (order[0] !== "x1" || order[1] !== "x2") throw new Error(`Test2 fail: order wrong: ${order}`);
  console.log("[test2] serial execution order correct ✓");
}

// ── Test 3: handler 抛错后队列继续 drain ──
{
  const q = new SessionQueue<string>({ maxConcurrentChats: 1 });
  const order: string[] = [];

  q.enqueue("task-err", "bad", async () => { throw new Error("intentional"); });
  q.enqueue("task-ok", "good", async () => { order.push("ok"); });

  await delay(20);
  if (!order.includes("ok")) throw new Error(`Test3 fail: task-ok did not run after error`);
  console.log("[test3] queue drains after handler error ✓");
}

console.log("\ntest-queue PASSED");

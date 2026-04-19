/**
 * 验证 TestOnChainOSClient + XmtpClient 依赖注入路径是否正常工作。
 */
import { TestOnChainOSClient } from "../test/helpers/test-onchainos.js";
import { XmtpClient } from "../src/domains/xmtp/xmtp.js";

const onchainOS = new TestOnChainOSClient("alice");

// 1. 地址和 Signer（直接验证 onchainOS 接口）
console.log("XLayer address:", await onchainOS.getXLayerAddress());
const signer = onchainOS.createXmtpSigner();
console.log("Signer type:   ", signer.type);
console.log("Identifier:    ", (await signer.getIdentifier()).identifier);

// 2. 通过 XmtpClient DI 初始化 XMTP Agent
const xmtp = new XmtpClient(onchainOS, { env: "dev", dbDir: "data/alice" });
await xmtp.connect();

const agent = xmtp.agent;
console.log("inboxId:       ", agent.client.inboxId);
console.log("installationId:", agent.client.installationId);
console.log("address:       ", xmtp.address);

await xmtp.disconnect();
console.log("\ntest-onchainos-client PASSED");

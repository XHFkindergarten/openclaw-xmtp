/**
 * peer.id 编解码。
 *
 * 背景：OpenClaw 的 sessionKey 由 (agentId, channel, accountId, peer.id, dmScope) 派生，
 * 但不原生支持 taskId 维度。利用 peer.id 字符串的自由度，把 taskId 以 URL query string
 * 形式编进 peer.id，配合 dmScope="per-account-channel-peer" 实现按 task 的 session 隔离。
 *
 * 形态：`0xADDRESS?taskId=xxx&k=v&...`
 * 好处：标准 URLSearchParams，kv 自解释，未来扩展字段零成本。
 */

export interface PeerIdParams {
  taskId?: string;
  [key: string]: string | undefined;
}

export function encodePeerId(
  address: `0x${string}`,
  params: PeerIdParams = {}
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, v);
  }
  const suffix = qs.toString();
  return suffix ? `${address}?${suffix}` : address;
}

export function decodePeerId(id: string): {
  address: `0x${string}`;
  params: PeerIdParams;
} {
  const qIdx = id.indexOf("?");
  if (qIdx === -1) return { address: id as `0x${string}`, params: {} };
  const address = id.slice(0, qIdx) as `0x${string}`;
  const qs = new URLSearchParams(id.slice(qIdx + 1));
  const params: PeerIdParams = {};
  for (const [k, v] of qs) params[k] = v;
  return { address, params };
}

import type { Address, Hex } from "viem";

export interface RpcTransport {
  call(request: { to: Address; data: Hex }): Promise<Hex>;
  getBlockTimestamp?(): Promise<bigint>;
  getStorageAt?(address: Address, slot: Hex): Promise<Hex>;
}

export type FetchLike = typeof fetch;

export function createRpcTransport(rpcUrl: string, fetcher: FetchLike = fetch): RpcTransport {
  let requestId = 0;

  return {
    async getBlockTimestamp() {
      const response = await fetcher(rpcUrl, {
        body: JSON.stringify({ id: ++requestId, jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["latest", false] }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) throw new Error(`Robinhood RPC returned HTTP ${response.status}`);
      const payload = (await response.json()) as { error?: { message?: string }; result?: { timestamp?: Hex } };
      if (payload.error) throw new Error(payload.error.message ?? "Robinhood RPC block read failed");
      if (!payload.result?.timestamp) throw new Error("Robinhood RPC block response did not contain a timestamp");
      return BigInt(payload.result.timestamp);
    },
    async getStorageAt(address, slot) {
      const response = await fetcher(rpcUrl, {
        body: JSON.stringify({ id: ++requestId, jsonrpc: "2.0", method: "eth_getStorageAt", params: [address, slot, "latest"] }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) throw new Error(`Robinhood RPC returned HTTP ${response.status}`);
      const payload = (await response.json()) as { error?: { message?: string }; result?: Hex };
      if (payload.error || !payload.result) throw new Error(payload.error?.message ?? "Robinhood RPC storage read failed");
      return payload.result;
    },
    async call({ to, data }) {
      const response = await fetcher(rpcUrl, {
        body: JSON.stringify({
          id: ++requestId,
          jsonrpc: "2.0",
          method: "eth_call",
          params: [{ data, to }, "latest"]
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

      if (!response.ok) throw new Error(`Robinhood RPC returned HTTP ${response.status}`);

      const payload = (await response.json()) as { error?: { message?: string }; result?: Hex };
      if (payload.error) throw new Error(payload.error.message ?? "Robinhood RPC call failed");
      if (!payload.result) throw new Error("Robinhood RPC response did not contain a result");
      return payload.result;
    }
  };
}

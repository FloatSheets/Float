import type { Address, Hex } from "viem";

export interface RpcTransport {
  call(request: { to: Address; data: Hex }): Promise<Hex>;
}

export type FetchLike = typeof fetch;

export function createRpcTransport(rpcUrl: string, fetcher: FetchLike = fetch): RpcTransport {
  let requestId = 0;

  return {
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

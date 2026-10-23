import { expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from "viem";

import { marketId } from "../src/chain/protocol";
import type { RpcTransport } from "../src/chain/rpc";
import { maxNewPosition, readCapacities } from "../src/markets/capacity";

const usdg = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));

test("sizes new positions by the contract's skew, open-interest and global limits", () => {
  // Copper today: a $440 vault, no open interest, a $40 cap. Skew room is $44, so the cap binds.
  expect(maxNewPosition({ vaultUsdg: usdg(440), market: { longOi: 0n, shortOi: 0n }, globalOiUsdg: 0n, positionCapUsdg: usdg(40) }))
    .toEqual({ longUsdg: usdg(40), shortUsdg: usdg(40) });

  // $30 already long: a long can only add $14 of skew (less 1% safety); a short can take
  // the $30 back plus $44, but market open interest ($66 limit, $30 used) caps it at $36.
  const skewed = maxNewPosition({ vaultUsdg: usdg(440), market: { longOi: usdg(30), shortOi: 0n }, globalOiUsdg: usdg(30), positionCapUsdg: usdg(1_000) });
  expect(skewed).toEqual({ longUsdg: usdg(13.86), shortUsdg: usdg(35.64) });

  // Every other market filled the 50% global limit: nothing new fits.
  expect(maxNewPosition({ vaultUsdg: usdg(440), market: { longOi: 0n, shortOi: 0n }, globalOiUsdg: usdg(220), positionCapUsdg: usdg(40) }))
    .toEqual({ longUsdg: 0n, shortUsdg: 0n });

  // An empty vault takes nothing.
  expect(maxNewPosition({ vaultUsdg: 0n, market: { longOi: 0n, shortOi: 0n }, globalOiUsdg: 0n, positionCapUsdg: usdg(40) }))
    .toEqual({ longUsdg: 0n, shortUsdg: 0n });
});

test("reads every registered market so global open interest counts other markets", async () => {
  const abi = parseAbi([
    "function vault() view returns (address)", "function totalAssets() view returns (uint256)",
    "function marketCount() view returns (uint256)", "function marketIdAt(uint256) view returns (bytes32)",
    "function marketExposure(bytes32) view returns (uint256,uint256)",
    "function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"
  ]);
  const WYFI = marketId("WYFI");
  const DJT = marketId("DJT");
  const VAULT = "0x920f5eec51e0361615fc0b861a1fe0c1f4cf62f0" as Address;
  const rpc: RpcTransport = {
    call: async ({ data }) => {
      const { functionName, args } = decodeFunctionData({ abi, data });
      const result = (() => {
        switch (functionName) {
          case "vault": return VAULT;
          case "totalAssets": return usdg(1_000);
          case "marketCount": return 2n;
          case "marketIdAt": return [WYFI, DJT][Number(args![0])];
          // DJT holds 30 shares long at $10 = $300; WYFI is empty.
          case "marketExposure": return args![0] === DJT ? [30n * 10n ** 18n, 0n] : [0n, 0n];
          case "getPrice": return [10n * 10n ** 18n, 0n, 0n, 0n, 1n, 1n, false];
          default: throw new Error(functionName);
        }
      })();
      return encodeFunctionResult({ abi, functionName, result } as never) as Hex;
    }
  };
  const capacities = await readCapacities(rpc, "0xd81e638b19e2e4fff0c88958f9e0b6d0969acffe", "0x4533f3a3bff4df0060810186182520a903a5d656",
    new Map([[WYFI.toLowerCase(), usdg(500)], [DJT.toLowerCase(), usdg(500)]]));
  // WYFI: skew room is 10% of $1,000 = $100 (global room $200 is looser), so $99 after 1% safety.
  expect(capacities.get(WYFI.toLowerCase())).toEqual({ longUsdg: usdg(99), shortUsdg: usdg(99), vaultUsdg: usdg(1_000) });
  // DJT is already $300 long: its market open interest ($150 limit) is exceeded, so nothing fits.
  expect(capacities.get(DJT.toLowerCase())).toEqual({ longUsdg: 0n, shortUsdg: 0n, vaultUsdg: usdg(1_000) });
});

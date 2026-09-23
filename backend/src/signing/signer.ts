import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Address, type Hex } from "viem";

import { CLEARING_DOMAIN_NAME, EIP712_VERSION, ORACLE_DOMAIN_NAME, priceAttestationTypes, tradeQuoteTypes, type PriceAttestation, type TradeQuote } from "./types";

export function oracleDomain(verifyingContract: Address) {
  return { chainId: 4663, name: ORACLE_DOMAIN_NAME, verifyingContract, version: EIP712_VERSION } as const;
}

export function clearingDomain(verifyingContract: Address) {
  return { chainId: 4663, name: CLEARING_DOMAIN_NAME, verifyingContract, version: EIP712_VERSION } as const;
}

export async function signPriceAttestation(privateKey: Hex, verifyingContract: Address, value: PriceAttestation): Promise<Hex> {
  return privateKeyToAccount(privateKey).signTypedData({ domain: oracleDomain(verifyingContract), primaryType: "PriceAttestation", types: priceAttestationTypes, message: value });
}

export async function signTradeQuote(privateKey: Hex, verifyingContract: Address, value: TradeQuote): Promise<Hex> {
  return privateKeyToAccount(privateKey).signTypedData({ domain: clearingDomain(verifyingContract), primaryType: "TradeQuote", types: tradeQuoteTypes, message: value });
}

export async function verifyTradeQuote(signer: Address, verifyingContract: Address, value: TradeQuote, signature: Hex): Promise<boolean> {
  return verifyTypedData({ address: signer, domain: clearingDomain(verifyingContract), primaryType: "TradeQuote", types: tradeQuoteTypes, message: value, signature });
}

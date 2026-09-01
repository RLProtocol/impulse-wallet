import type { Address } from "viem";
import { getItem, setItem } from "./storage";
import { tokenMeta } from "./wallet";
import { DEFAULT_CHAIN, type ChainKey } from "./chains";

const TOKENS_KEY = "strix.tokens.v1";

export type TrackedToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  addedAt: number;
  source: "custom" | "trade";
  /** Absent on entries saved before multi-chain — those are all Robinhood. */
  chain?: ChainKey;
};

export const tokenChain = (t: TrackedToken): ChainKey => t.chain || DEFAULT_CHAIN;

export async function listTokens(chain?: ChainKey): Promise<TrackedToken[]> {
  const all = (await getItem<TrackedToken[]>(TOKENS_KEY)) || [];
  return chain ? all.filter((t) => tokenChain(t) === chain) : all;
}

export async function addToken(
  address: Address,
  source: TrackedToken["source"] = "custom",
  meta?: { symbol: string; name: string; decimals: number },
  chain: ChainKey = DEFAULT_CHAIN,
): Promise<TrackedToken> {
  const list = await listTokens();
  // Same address can legitimately exist on several chains, so identity is the
  // pair, not the address alone.
  const existing = list.find(
    (t) => t.address.toLowerCase() === address.toLowerCase() && tokenChain(t) === chain,
  );
  if (existing) return existing;
  const m = meta || (await tokenMeta(address, chain));
  const t: TrackedToken = { address, ...m, addedAt: Date.now(), source, chain };
  await setItem(TOKENS_KEY, [...list, t]);
  return t;
}

export async function removeToken(address: Address, chain?: ChainKey): Promise<void> {
  const list = await listTokens();
  await setItem(
    TOKENS_KEY,
    list.filter(
      (t) =>
        t.address.toLowerCase() !== address.toLowerCase() ||
        (chain !== undefined && tokenChain(t) !== chain),
    ),
  );
}

/**
 * Drop a token from the wallet once the position is actually closed.
 *
 * Called after a 100% sell, but it re-reads the balance rather than trusting
 * the percentage: a fee-on-transfer token, a partial fill, or a rounding
 * remainder can all leave a real balance behind, and untracking then hides
 * funds the user still owns. Dust below one unit at the token's own precision
 * is treated as closed, because that is unsellable anyway.
 *
 * Never removes a token the user added by hand — they asked to watch it, and
 * selling out is not the same as no longer caring.
 */
export async function untrackIfEmpty(
  address: Address, chain: ChainKey, balanceRaw: bigint,
): Promise<boolean> {
  if (balanceRaw > 0n) return false;
  const list = await listTokens();
  const t = list.find(
    (x) => x.address.toLowerCase() === address.toLowerCase() && tokenChain(x) === chain,
  );
  if (!t || t.source !== "trade") return false;
  await removeToken(address, chain);
  return true;
}

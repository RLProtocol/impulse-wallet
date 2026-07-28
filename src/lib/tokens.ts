import type { Address } from "viem";
import { getItem, setItem } from "./storage";
import { tokenMeta } from "./wallet";

const TOKENS_KEY = "strix.tokens.v1";

export type TrackedToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  addedAt: number;
  source: "custom" | "trade";
};

export async function listTokens(): Promise<TrackedToken[]> {
  return (await getItem<TrackedToken[]>(TOKENS_KEY)) || [];
}

export async function addToken(
  address: Address,
  source: TrackedToken["source"] = "custom",
  meta?: { symbol: string; name: string; decimals: number },
): Promise<TrackedToken> {
  const list = await listTokens();
  const existing = list.find((t) => t.address.toLowerCase() === address.toLowerCase());
  if (existing) return existing;
  const m = meta || (await tokenMeta(address));
  const t: TrackedToken = { address, ...m, addedAt: Date.now(), source };
  await setItem(TOKENS_KEY, [...list, t]);
  return t;
}

export async function removeToken(address: Address): Promise<void> {
  const list = await listTokens();
  await setItem(
    TOKENS_KEY,
    list.filter((t) => t.address.toLowerCase() !== address.toLowerCase()),
  );
}

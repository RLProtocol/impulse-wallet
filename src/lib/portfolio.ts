import type { Address } from "viem";
import { formatEther } from "viem";
import { RH_STOCKS, USDG, ERC20_ABI, publicClient } from "./chain";
import { nativeBalance, tokenBalance } from "./wallet";
import { listTokens } from "./tokens";
import { api } from "./dex";
import { formatUnitsNum } from "./format";

export type Row = {
  kind: "native" | "token" | "stock";
  symbol: string;
  name: string;
  address?: Address; // undefined for native
  balanceRaw: bigint;
  balance: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
};

export type Portfolio = { rows: Row[]; totalUsd: number | null };

export async function loadPortfolio(address: Address): Promise<Portfolio> {
  const rows: Row[] = [];

  // Native ETH + its price
  const [ethRaw, ethUsdWrap] = await Promise.all([
    nativeBalance(address).catch(() => 0n),
    api.nativePrice().catch(() => ({ usd: null as number | null })),
  ]);
  const ethUsd = ethUsdWrap.usd;
  const ethBal = Number(formatEther(ethRaw));
  rows.push({
    kind: "native",
    symbol: "ETH",
    name: "Ethereum",
    balanceRaw: ethRaw,
    balance: ethBal,
    decimals: 18,
    priceUsd: ethUsd,
    valueUsd: ethUsd == null ? null : ethBal * ethUsd,
  });

  // USDG stablecoin (a base asset on Robinhood Chain, always shown like ETH).
  try {
    const [usdgRaw, usdgDec] = await Promise.all([
      tokenBalance(USDG, address).catch(() => 0n),
      publicClient
        .readContract({ address: USDG, abi: ERC20_ABI, functionName: "decimals" })
        .catch(() => 6),
    ]);
    const usdgBal = formatUnitsNum(usdgRaw, Number(usdgDec));
    rows.push({
      kind: "token",
      symbol: "USDG",
      name: "Global Dollar",
      address: USDG,
      balanceRaw: usdgRaw,
      balance: usdgBal,
      decimals: Number(usdgDec),
      priceUsd: 1,
      valueUsd: usdgBal * 1,
    });
  } catch { /* skip usdg on rpc error */ }

  // Tracked tokens (custom + traded)
  const tracked = await listTokens();
  await Promise.all(
    tracked.map(async (t) => {
      const raw = await tokenBalance(t.address, address).catch(() => 0n);
      const bal = formatUnitsNum(raw, t.decimals);
      let price: number | null = null;
      try {
        const info = await api.tokenInfo(t.address);
        price = info.priceUsd;
      } catch { /* api offline */ }
      rows.push({
        kind: "token",
        symbol: t.symbol,
        name: t.name,
        address: t.address,
        balanceRaw: raw,
        balance: bal,
        decimals: t.decimals,
        priceUsd: price,
        valueUsd: price == null ? null : bal * price,
      });
    }),
  );

  // Stocks the user holds (balance > 0), priced via the API
  let stockPrices: Record<string, number | null> = {};
  try {
    const { stocks } = await api.stocks();
    stockPrices = Object.fromEntries(stocks.map((s) => [s.address.toLowerCase(), s.priceUsd]));
  } catch { /* api offline */ }
  await Promise.all(
    RH_STOCKS.map(async (s) => {
      const raw = await tokenBalance(s.address, address).catch(() => 0n);
      if (raw <= 0n) return;
      const bal = formatUnitsNum(raw, 18);
      const price = stockPrices[s.address.toLowerCase()] ?? null;
      rows.push({
        kind: "stock",
        symbol: s.symbol,
        name: s.name,
        address: s.address,
        balanceRaw: raw,
        balance: bal,
        decimals: 18,
        priceUsd: price,
        valueUsd: price == null ? null : bal * price,
      });
    }),
  );

  const known = rows.filter((r) => r.valueUsd != null);
  const totalUsd = known.length ? known.reduce((a, r) => a + (r.valueUsd || 0), 0) : null;
  return { rows, totalUsd };
}

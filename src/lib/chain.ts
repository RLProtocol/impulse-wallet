import { createPublicClient, defineChain, http, type Address } from "viem";

// ── Robinhood Chain (4663) - the only chain this wallet targets ────────────
export const RH_RPC =
  import.meta.env.VITE_ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com";
export const RH_EXPLORER = "https://robinhoodchain.blockscout.com";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RH_RPC] } },
  blockExplorers: { default: { name: "Blockscout", url: RH_EXPLORER } },
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(RH_RPC, { timeout: 15_000 }),
});

// Core token addresses (from robinhoodcode.py) ------------------------------
export const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const USDG: Address = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

// Tokenized stocks on Robinhood Chain - the RH_STOCKS set (18 decimals).
export type StockMeta = { symbol: string; name: string; address: Address };
export const RH_STOCKS: StockMeta[] = [
  { symbol: "AAPL", name: "Apple", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" },
  { symbol: "TSLA", name: "Tesla", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" },
  { symbol: "NVDA", name: "NVIDIA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
  { symbol: "MSFT", name: "Microsoft", address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74" },
  { symbol: "GOOGL", name: "Alphabet", address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3" },
  { symbol: "AMZN", name: "Amazon", address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54" },
  { symbol: "META", name: "Meta", address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35" },
  { symbol: "SPY", name: "S&P 500 ETF", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" },
];

export const STOCK_BY_ADDR: Record<string, StockMeta> = Object.fromEntries(
  RH_STOCKS.map((s) => [s.address.toLowerCase(), s]),
);
export const isStock = (addr?: string) =>
  !!addr && addr.toLowerCase() in STOCK_BY_ADDR;

export const ERC20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "transfer", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "s", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export const txUrl = (hash: string) => `${RH_EXPLORER}/tx/${hash}`;
export const addrUrl = (addr: string) => `${RH_EXPLORER}/address/${addr}`;

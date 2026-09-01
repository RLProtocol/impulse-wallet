// Supported EVM chains, and everything the trade engine needs per chain.
//
// Every address below was verified on-chain before being committed: each has
// bytecode, and each router/quoter was asked for its own WETH and returned the
// one this file lists. A wrong router here silently sends funds nowhere, so
// treat that check as mandatory when adding a chain.
//
// Robinhood values come from robinhoodcode.py; Ethereum and Base match the
// bot's EVM_CHAINS, with the V3 pair added (the bot never configured V3 off
// Robinhood, so it fell back to V2 on chains where most volume is V3).
import { createPublicClient, defineChain, http, type Address, type PublicClient } from "viem";
import { getItem, setItem } from "./storage";

export type ChainKey = "robinhood" | "eth" | "base" | "solana";

/** Which virtual machine a chain runs. Solana shares none of the EVM plumbing
 *  — different curve, address format, RPC and DEX — so code branches on this
 *  rather than pretending Solana has a Uniswap router. */
export type Vm = "evm" | "svm";

export type ChainCfg = {
  key: ChainKey;
  vm: Vm;
  id: number;
  name: string;
  /** Short label for chips and pickers. */
  short: string;
  rpc: string;
  explorer: string;
  /** How this chain is spelled in DexScreener's `chainId` field. */
  dexscreener: string;
  /** GeckoTerminal network slug, for chart candles. Differs from DexScreener's:
   *  Ethereum is "ethereum" there and "eth" here. */
  geckoterminal: string;
  nativeSymbol: string;
  weth: Address;
  v2Router: Address;
  v3Router: Address;
  v3Quoter: Address;
  universalRouter: Address;
  v4PoolManager: Address;
  /** V4 PositionManager. Its poolKeys(bytes25) mapping is the reliable way to
   *  resolve a PoolKey from a pool id — Robinhood's V4 fork routes through the
   *  PositionManager and emits no standard Initialize event, so a log scan
   *  alone misses pools that are perfectly tradable. */
  v4PositionManager: Address;
  v4Quoter: Address;
  permit2: Address;
  /** Robinhood launchpad factory. Tokens minted there trade on a per-token
   *  bonding curve until they graduate to a V4 pool; before that they have no
   *  Uniswap pool at all, so every pool-based route fails on them. */
  launchpadFactory?: Address;
  /** Colour for the chain chip. */
  tint: string;
};

const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ZERO_EVM: Address = "0x0000000000000000000000000000000000000000";

export const CHAINS: Record<ChainKey, ChainCfg> = {
  robinhood: {
    key: "robinhood",
    vm: "evm",
    id: 4663,
    name: "Robinhood Chain",
    short: "RH",
    rpc: import.meta.env.VITE_ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    dexscreener: "robinhood",
    geckoterminal: "robinhood",
    nativeSymbol: "ETH",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    v2Router: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba",
    v3Router: "0xCaf681a66D020601342297493863E78C959E5cb2",
    v3Quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
    universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
    v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    v4PositionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
    v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    permit2: PERMIT2,
    launchpadFactory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
    tint: "#a3e635",
  },
  eth: {
    key: "eth",
    vm: "evm",
    id: 1,
    name: "Ethereum",
    short: "ETH",
    rpc: import.meta.env.VITE_ETH_RPC || "https://eth.drpc.org",
    explorer: "https://etherscan.io",
    dexscreener: "ethereum",
    geckoterminal: "eth",
    nativeSymbol: "ETH",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    v2Router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    v3Router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    v3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    universalRouter: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
    v4PoolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    v4PositionManager: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e",
    v4Quoter: "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203",
    permit2: PERMIT2,
    tint: "#8fb3ff",
  },
  solana: {
    key: "solana",
    vm: "svm",
    id: 101,
    name: "Solana",
    short: "SOL",
    rpc: import.meta.env.VITE_SOL_RPC || "https://solana-rpc.publicnode.com",
    explorer: "https://solscan.io",
    dexscreener: "solana",
    geckoterminal: "solana",
    nativeSymbol: "SOL",
    // Unused on SVM; present so the record shape stays uniform.
    weth: ZERO_EVM, v2Router: ZERO_EVM, v3Router: ZERO_EVM, v3Quoter: ZERO_EVM,
    universalRouter: ZERO_EVM, v4PoolManager: ZERO_EVM, v4PositionManager: ZERO_EVM,
    v4Quoter: ZERO_EVM, permit2: ZERO_EVM,
    tint: "#9945FF",
  },
  base: {
    key: "base",
    vm: "evm",
    id: 8453,
    name: "Base",
    short: "BASE",
    rpc: import.meta.env.VITE_BASE_RPC || "https://mainnet.base.org",
    explorer: "https://basescan.org",
    dexscreener: "base",
    geckoterminal: "base",
    nativeSymbol: "ETH",
    weth: "0x4200000000000000000000000000000000000006",
    v2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    v3Router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    v3Quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    v4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    v4PositionManager: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
    v4Quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
    permit2: PERMIT2,
    tint: "#4f8cff",
  },
};

export const CHAIN_LIST: ChainCfg[] = [CHAINS.robinhood, CHAINS.eth, CHAINS.base, CHAINS.solana];

export const isEvm = (k: ChainKey) => CHAINS[k].vm === "evm";
export const isSvm = (k: ChainKey) => CHAINS[k].vm === "svm";
/** EVM chains only — for anything that takes a viem client. */
export const EVM_CHAINS: ChainCfg[] = CHAIN_LIST.filter((c) => c.vm === "evm");
export const DEFAULT_CHAIN: ChainKey = "robinhood";

export const isChainKey = (k?: string): k is ChainKey => !!k && k in CHAINS;
export const cfgFor = (k?: ChainKey | string): ChainCfg =>
  isChainKey(k) ? CHAINS[k] : CHAINS[DEFAULT_CHAIN];

/** DexScreener `chainId` -> our config, for resolving which chain a CA is on. */
export const chainByDexId = (dsId?: string): ChainCfg | null =>
  CHAIN_LIST.find((c) => c.dexscreener === dsId) || null;

export const viemChainFor = (k: ChainKey) => {
  const c = CHAINS[k];
  return defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: { name: "Ether", symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
    blockExplorers: { default: { name: "Explorer", url: c.explorer } },
  });
};

// One client per chain, built on first use. Recreating them per call would
// throw away viem's request batching and reconnect on every read.
const clients = new Map<ChainKey, PublicClient>();
export function clientFor(k: ChainKey): PublicClient {
  if (CHAINS[k].vm !== "evm") throw new Error(`${CHAINS[k].name} has no EVM client.`);
  let c = clients.get(k);
  if (!c) {
    c = createPublicClient({
      chain: viemChainFor(k),
      transport: http(CHAINS[k].rpc, { timeout: 15_000 }),
    }) as PublicClient;
    clients.set(k, c);
  }
  return c;
}

export const txUrlOn = (k: ChainKey, hash: string) => `${CHAINS[k].explorer}/tx/${hash}`;
export const addrUrlOn = (k: ChainKey, addr: string) =>
  `${CHAINS[k].explorer}/${CHAINS[k].vm === "svm" ? "account" : "address"}/${addr}`;

// ── active chain (the picker on Home) ───────────────────────────────────────
const ACTIVE_KEY = "strix.chain.v1";

export async function getActiveChain(): Promise<ChainKey> {
  const v = await getItem<string>(ACTIVE_KEY);
  return isChainKey(v) ? v : DEFAULT_CHAIN;
}
export async function setActiveChain(k: ChainKey): Promise<void> {
  await setItem(ACTIVE_KEY, k);
}

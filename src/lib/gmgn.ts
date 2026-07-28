// GMGN OpenAPI client (data endpoints, "exist" auth: X-APIKEY + timestamp +
// client_id query params — no request signature needed). Chain is always
// robinhood. Requires a user-supplied API key (Settings → GMGN API key,
// obtained at https://gmgn.ai/ai).
import { getItem, setItem } from "./storage";

const KEY_SLOT = "strix.gmgnKey";
const HOST = "https://openapi.gmgn.ai";
const CHAIN = "robinhood";

// Built-in data key shipped with the extension (data endpoints only — trading
// requires a request signature from a private key that is never shipped).
// Users can override it in Settings with their own key.
const DEFAULT_GMGN_KEY = "gmgn_dc0842fcb2417884af2c91aa53574ce6";

export async function getGmgnKey(): Promise<string> {
  return (await getItem<string>(KEY_SLOT)) || DEFAULT_GMGN_KEY;
}
export async function getCustomGmgnKey(): Promise<string> {
  return (await getItem<string>(KEY_SLOT)) || "";
}
export async function setGmgnKey(k: string): Promise<void> {
  await setItem(KEY_SLOT, k.trim());
}
export async function hasGmgnKey(): Promise<boolean> {
  return !!(await getGmgnKey());
}

const cache = new Map<string, { t: number; v: any }>();

async function req<T = any>(path: string, params: Record<string, string | number>, ttlMs = 60_000): Promise<T> {
  const key = await getGmgnKey();
  if (!key) throw new Error("Add your GMGN API key in Settings first.");
  const cacheKey = path + JSON.stringify(params);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v as T;

  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  q.set("timestamp", String(Math.floor(Date.now() / 1000)));
  q.set("client_id", crypto.randomUUID());

  const r = await fetch(`${HOST}${path}?${q.toString()}`, { headers: { "X-APIKEY": key } });
  const body: any = await r.json().catch(() => ({}));
  const code = body?.code;
  if (!r.ok || (code !== 0 && code !== "0" && code !== undefined && code !== null)) {
    const msg = body?.message || body?.error || `GMGN error ${r.status}`;
    throw new Error(String(msg).slice(0, 140));
  }
  // Some endpoints (e.g. market/rank) double-wrap: {code,data:{code,data:{...}}}.
  let data: any = body?.data ?? body;
  while (data && typeof data === "object" && !Array.isArray(data) && "data" in data && ("code" in data || "message" in data)) {
    data = data.data;
  }
  cache.set(cacheKey, { t: Date.now(), v: data });
  return data as T;
}

export type HolderSort = "amount_percentage" | "profit" | "unrealized_profit";
export type WalletTag = "renowned" | "smart_degen" | "dev" | "sniper" | "rat_trader" | "bundler" | "fresh_wallet";

// GMGN is case-sensitive on addresses (checksummed input returns empty holder
// lists) — always send lowercase.
export const gmgn = {
  security: (ca: string) => req("/v1/token/security", { chain: CHAIN, address: ca.toLowerCase() }, 5 * 60_000),
  info: (ca: string) => req("/v1/token/info", { chain: CHAIN, address: ca.toLowerCase() }, 60_000),
  topHolders: (ca: string, orderBy: HolderSort, tag?: WalletTag) =>
    req("/v1/market/token_top_holders", {
      // NOTE: the param is `order_by` — GMGN silently ignores `orderby`.
      chain: CHAIN, address: ca.toLowerCase(), limit: 100, order_by: orderBy, direction: "desc",
      ...(tag ? { tag } : {}),
    }, 60_000),
  topTraders: (ca: string, orderBy: HolderSort, tag?: WalletTag) =>
    req("/v1/market/token_top_traders", {
      // NOTE: the param is `order_by` — GMGN silently ignores `orderby`.
      chain: CHAIN, address: ca.toLowerCase(), limit: 100, order_by: orderBy, direction: "desc",
      ...(tag ? { tag } : {}),
    }, 60_000),
};

// ── defensive readers (GMGN field names vary slightly across chains) ────────
export function pick(obj: any, keys: string[]): any {
  for (const k of keys) {
    const v = k.split(".").reduce((o: any, p: string) => (o == null ? undefined : o[p]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}
// "yes"/"1"/1/true → true; "no"/"0"/0/false → false; unknown → undefined
export function asBool(v: any): boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (["1", "yes", "true"].includes(s)) return true;
  if (["0", "no", "false"].includes(s)) return false;
  return undefined;
}
// Tax may arrive as fraction (0.05) or percent (5). Normalize to percent.
export function asPct(v: any): number | undefined {
  const n = Number(v);
  if (!isFinite(n) || v === undefined || v === null || v === "") return undefined;
  return n <= 1 ? n * 100 : n;
}
export function rowsOf(d: any): any[] {
  if (Array.isArray(d)) return d;
  return d?.list || d?.holders || d?.traders || d?.items || d?.rank || [];
}
export function walletAddrOf(row: any): string {
  return pick(row, ["wallet_address", "address", "account_address", "wallet"]) || "";
}
export function tagsOf(row: any): string[] {
  // Merge both tag arrays GMGN returns (`tags`: kol/smart_degen/fresh_wallet/…,
  // `maker_token_tags`: whale/bundler/sniper/…).
  const out: string[] = [];
  for (const key of ["tags", "wallet_tags", "maker_token_tags"]) {
    const t = row?.[key];
    if (Array.isArray(t)) for (const x of t) if (x && !out.includes(String(x))) out.push(String(x));
  }
  return out;
}
// A "holder" row that is actually a DEX pool / contract, not a person.
export function isPoolRow(row: any): boolean {
  return !!row?.exchange || row?.addr_type === 2;
}
export const TAG_LABEL: Record<string, string> = {
  kol: "KOL",
  renowned: "KOL",
  smart_degen: "Smart $",
  dev: "Dev",
  creator: "Dev",
  whale: "Whale",
  sniper: "Sniper",
  bundler: "Bundler",
  rat_trader: "Insider",
  wash_trader: "Wash",
  fresh_wallet: "Fresh",
  dex_bot: "Bot",
  bluechip_owner: "Bluechip",
};

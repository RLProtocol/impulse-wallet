// FOMO data, served by our own backend.
//
// The extension no longer talks to FOMO directly. A small always-on service
// (see the fomo-backend project) keeps one logged-in FOMO session in a real
// browser behind a residential proxy — the only way to clear FOMO's Cloudflare
// wall reliably — and answers a handful of read routes. This client hits that
// service, so every user gets the same live data with nothing to connect and no
// per-user token to paste.
//
// The exported names mirror the old per-user client on purpose: fomo.ts and
// trader.ts call thesisForToken / userByHandle / userBalances / userSwaps and
// map the FOMO shapes those return, so swapping the source is an import change.
//
// The key here is a shared, spend-limited access key, not a secret: a published
// extension can be unpacked, so treat it as public and rely on the backend's own
// rate limiting rather than on hiding it. Override both via the build env.

const BASE = String(import.meta.env.VITE_FOMO_BACKEND_URL || "https://backend.getimpulse.online");
const KEY = String(import.meta.env.VITE_FOMO_BACKEND_KEY || "a9ac56c0a3a317d15fb9ed819e91eae4fda25fbe3b15471498928fceb57ebe96");

export type FomoResult<T> = { v: T } | { error: string };

/** networkId as FOMO numbers the chains — for callers that map from it. */
export const FOMO_NETWORK: Record<string, number> = {
  robinhood: 4663, base: 8453, eth: 1, bnb: 56, solana: 1399811149,
};

/** FOMO matches EVM addresses in lowercase; the backend normalises too, but
 *  doing it here keeps cache keys consistent. Solana mints are case-sensitive. */
const normAddr = (a: string) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);

/**
 * One GET against the backend. Returns the unwrapped payload the backend put
 * under `v`, or an error string. Every route answers `{ v }` on success and
 * `{ error }` on failure, and a non-2xx (including a 503 when the backend's
 * session is temporarily walled) becomes an error the caller can fall back on.
 */
async function get<T = any>(path: string): Promise<FomoResult<T>> {
  let r: Response;
  try {
    r = await fetch(BASE + path, { headers: { "x-api-key": KEY, accept: "application/json" } });
  } catch (e: any) {
    return { error: (e?.message || String(e)).slice(0, 140) };
  }
  let body: any;
  try { body = await r.json(); } catch { return { error: `backend HTTP ${r.status}` }; }
  if (!r.ok) return { error: String(body?.error || `backend HTTP ${r.status}`).slice(0, 160) };
  return "v" in body ? { v: body.v as T } : { error: "backend returned no data" };
}

/** Thesis feed for a token — the backend maps chain → networkId itself. */
export async function thesisForToken(tokenAddress: string, chain = "robinhood", threshold = 0): Promise<FomoResult<any>> {
  return await get(`/thesis?ca=${encodeURIComponent(normAddr(tokenAddress))}&chain=${encodeURIComponent(chain)}&threshold=${threshold}`);
}

/** Resolve a handle to the FOMO user object (id, name, wallets, twitter…). */
export async function userByHandle(handle: string): Promise<FomoResult<any>> {
  return await get(`/trader?handle=${encodeURIComponent(handle)}`);
}

/** A user's holdings, by FOMO id. */
export async function userBalances(id: string): Promise<FomoResult<any>> {
  return await get(`/balances/${encodeURIComponent(id)}`);
}

/** A user's recent swaps, by FOMO id. */
export async function userSwaps(id: string): Promise<FomoResult<any>> {
  return await get(`/swaps/${encodeURIComponent(id)}`);
}

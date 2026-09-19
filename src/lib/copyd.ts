// Copytrade service client — talks to `copyd` (the always-on FOMO copytrade
// backend). Called from the background worker; the popup reaches it via
// STRIX_COPY_* messages.
//
// copyd resolves a FOMO handle to the trader's real wallet, provisions an
// ISOLATED copy wallet the user funds, and replicates that trader's buys in real
// time. The resolved KOL wallet is never returned to the client — the UI shows
// only "resolved ✓" and a confidence. The key here is shared/spend-limited like
// the other backend keys; override via build env.

const BASE = String(import.meta.env.VITE_COPYD_URL || "https://copyd-production.up.railway.app");
const KEY = String(import.meta.env.VITE_COPYD_KEY || "710faeb1dc70e4d5d153767e6acc4a020d40631e53356a7b228877894ced67b3");

export type CopyEvent = { t: number; kind: string; token?: string; ok?: boolean; usd?: number; mcap?: number };
export type CopyJob = {
  id: string;
  owner: string;
  handle: string;
  confidence: "high" | "medium" | "none";
  copyWallet: string;
  balanceEth: number | null;
  amountEth: number;
  minCopyUsd: number;
  maxMcapUsd: number;
  copySells: boolean;
  minConfidence: "medium" | "high";
  spent: { today: number; total: number; dayStamp?: string };
  status: "active" | "paused" | "stopped" | "low_balance";
  firstCopyAt: number | null;
  events: CopyEvent[];
  createdAt: number;
  fund?: { address: string; note: string };
};

type R<T> = { v: T } | { error: string };

async function req<T = any>(method: "GET" | "POST", path: string, body?: any): Promise<R<T>> {
  let r: Response;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: {
        "x-api-key": KEY,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e: any) {
    return { error: (e?.message || String(e)).slice(0, 140) };
  }
  let j: any;
  try { j = await r.json(); } catch { return { error: `copyd HTTP ${r.status}` }; }
  if (!r.ok) return { error: String(j?.error || `copyd HTTP ${r.status}`).slice(0, 200) };
  return "v" in j ? { v: j.v as T } : { error: "copyd returned no data" };
}

/** Preview resolution — returns only { resolved, confidence }, never the wallet. */
export const resolveHandle = (handle: string) =>
  req<{ handle: string; resolved: boolean; confidence: string }>(
    "GET", `/copy/resolve?handle=${encodeURIComponent(handle.replace(/^@/, ""))}`);

export type CopyHolding = { token: string; symbol: string; amount: number; usd: number | null };
export type CopyWallet = {
  exists: boolean;
  address?: string;
  balanceEth?: number | null;
  holdings?: CopyHolding[];
  createdAt?: number;
  // Present only in the create response, first time the wallet is made:
  isNew?: boolean;
  pk?: string;
};

/** Create a copy job. On the FIRST job for a user, the response's `wallet` carries
 *  `isNew: true` and the wallet `pk` (shown once). Later jobs reuse the wallet. */
export const createJob = (body: {
  owner: string; handle: string; amountEth: number;
  maxMcapUsd?: number; copySells?: boolean; minConfidence?: "medium" | "high";
}) => req<CopyJob & { wallet: CopyWallet }>("POST", "/copy/job", body);

export const listJobs = (owner: string) =>
  req<CopyJob[]>("GET", `/copy/jobs?owner=${encodeURIComponent(owner)}`);

export const getJob = (id: string) => req<CopyJob>("GET", `/copy/job/${encodeURIComponent(id)}`);

export const stopJob = (id: string) => req<CopyJob>("POST", `/copy/job/${encodeURIComponent(id)}/stop`);

/** Toggle buys-only vs also-mirror-sells on an existing job. */
export const setMode = (id: string, copySells: boolean) =>
  req<CopyJob>("POST", `/copy/job/${encodeURIComponent(id)}/mode`, { copySells });

// ── the one reusable per-user copy wallet ────────────────────────────────────
export const getWallet = (owner: string) =>
  req<CopyWallet>("GET", `/copy/wallet?owner=${encodeURIComponent(owner)}`);

/** Reveal the copy wallet's private key to its owner. */
export const revealWallet = (owner: string) =>
  req<{ address: string; pk: string }>("POST", "/copy/wallet/reveal", { owner });

/** Sell one token (pct%) or all held tokens from the copy wallet back to ETH. */
export const sellWallet = (owner: string, body: { token?: string; pct?: number; all?: boolean }) =>
  req<any>("POST", "/copy/wallet/sell", { owner, ...body });

/** Sweep the copy wallet's ETH back to the owner's main wallet. */
export const withdrawWallet = (owner: string) =>
  req<{ ok: boolean; tx: string; to: string }>("POST", "/copy/wallet/withdraw", { owner });

/** Re-encrypt the copy wallet to a password so it can be imported elsewhere. */
export const exportWallet = (owner: string, password: string) =>
  req<{ address: string; keystore: any }>("POST", "/copy/wallet/export", { owner, password });

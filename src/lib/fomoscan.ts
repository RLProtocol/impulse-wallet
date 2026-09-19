// FomoScan Identity API client — https://api.fomoscan.sh
//
// Why this replaced api.fomoapi.io: coverage. The old anonymous endpoint did
// not know most of the handles people actually look up — @catinvests, the case
// that prompted the switch, 404s there and resolves here with both wallets
// attached. FomoScan is the platform's identity layer rather than a mirror of
// its feed, and it is the only source that answers "who is this handle on
// chain" with a verified match.
//
// The cost of that is a metered key, and metering is the thing this file exists
// to manage. Read the table before adding a call:
//
//   /v2/thesis/*, /v2/pump/*, /v2/leaderboard/*      250 CU  per call
//   /v2/user/handle/{h}         2,500 CU on a hit,   250 CU  on a 404
//   /v2/user/handle/{h}/pnl     2,500 CU             every call, 404 included
//   /v2/user/wallet/{addr}     50,000 CU on a hit
//   /v2/user/handle/{h}/resolve 100,000 CU           every call
//   /v2/ws                     20,000 CU per minute held open
//
// The plan on this key is 250,000 CU a month. That is 100 profile lookups, or
// 1,000 thesis pages, for EVERY user of the extension put together — and an
// hour on the websocket would be 1,200,000 CU, five months of allowance, which
// is why nothing here opens one. Every call therefore goes through this module,
// and every call is cached to disk.
//
// Caching to chrome.storage.local rather than a Map is load-bearing, not an
// optimisation. An MV3 service worker is torn down after ~30s idle, taking any
// in-memory cache with it, so a user opening the same token twice in a minute
// would otherwise pay twice. Identity does not move and the PnL sweep behind
// /pnl runs daily, so holding these for hours is also simply more correct than
// re-asking.

const HOST = "https://api.fomoscan.sh";

/**
 * The key, from the build environment.
 *
 * Not a literal in the source. This repo has a public mirror and
 * scripts/audit-bundle.py refuses to package a build containing an `fsk_live_`
 * string, both of which would turn a commit into a disclosure. It lives in
 * .env.local, which .gitignore and the bundler's skip list already cover.
 *
 * None of that makes it secret in the SHIPPED extension: a published zip can be
 * unpacked and read by anyone, so the key in a store build is a public key with
 * a spend limit attached. Treat rotation as routine rather than exceptional.
 */
const BUILD_KEY = String(import.meta.env.VITE_FOMOSCAN_KEY || "");

/**
 * A key in storage wins over the build-time one.
 *
 * There is no Settings field for this yet — the path exists so a key can be
 * rotated, or a user's own key substituted, by writing `fomoscanKey` to
 * chrome.storage.local without shipping a new build. Given the allowance is
 * shared by every install, per-user keys are the honest way to scale this.
 */
let liveKey: string | null = null;

export async function fomoscanKey(): Promise<string> {
  if (liveKey !== null) return liveKey;
  try {
    const s = await chrome.storage.local.get("fomoscanKey");
    const k = String(s?.fomoscanKey || "").trim();
    liveKey = k || BUILD_KEY;
  } catch {
    liveKey = BUILD_KEY;
  }
  return liveKey;
}

/** Set the override at runtime. Pass null to fall back to the build key. */
export function setFomoscanKey(k: string | null): void {
  liveKey = k && k.trim() ? k.trim() : BUILD_KEY;
}

export const hasFomoscanKey = () => Boolean(BUILD_KEY || liveKey);

/* ── the cache ─────────────────────────────────────────────────────────────*/

type Entry = { t: number; v: any };

const mem = new Map<string, Entry>();
const PREFIX = "fs$";
/** Storage.local is 10MB and these are a few KB each; prune well under it. */
const MAX_ENTRIES = 240;

async function readCache(k: string, ttl: number): Promise<any | undefined> {
  const hit = mem.get(k);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  try {
    const s = await chrome.storage.local.get(PREFIX + k);
    const e = s?.[PREFIX + k] as Entry | undefined;
    if (e && Date.now() - e.t < ttl) {
      mem.set(k, e);
      return e.v;
    }
  } catch { /* storage unavailable — treat as a miss */ }
  return undefined;
}

async function writeCache(k: string, v: any): Promise<void> {
  const e: Entry = { t: Date.now(), v };
  mem.set(k, e);
  try {
    await chrome.storage.local.set({ [PREFIX + k]: e });
    // Prune on write rather than on a timer: a service worker has no reliable
    // timer, and this is the only moment we know the store just grew.
    const all = await chrome.storage.local.get(null);
    const ours = Object.keys(all).filter((x) => x.startsWith(PREFIX));
    if (ours.length > MAX_ENTRIES) {
      ours.sort((a, b) => (all[a]?.t ?? 0) - (all[b]?.t ?? 0));
      await chrome.storage.local.remove(ours.slice(0, ours.length - MAX_ENTRIES));
    }
  } catch { /* over quota or unavailable — the memory layer still works */ }
}

/* ── the spend guard ───────────────────────────────────────────────────────
   /v2/me is free, so the remaining allowance can be checked without spending
   any of it. Below the floor, only cheap calls are allowed through: a key with
   8,000 CU left is one profile lookup away from empty, or thirty token panels,
   and the thirty are worth more than the one.

   The floor is also what stops a browsing session from draining the month. The
   profile check fires on every X profile visited, whether or not anyone asked
   for it, so without a brake it spends until there is nothing left. */

const RESERVE = 20_000;
/** Anything at or above this is "expensive" and subject to the reserve. */
const EXPENSIVE = 1_000;

let budget: { left: number; at: number } | null = null;
const BUDGET_TTL = 5 * 60_000;

async function creditsLeft(): Promise<number | null> {
  if (budget && Date.now() - budget.at < BUDGET_TTL) return budget.left;
  const me = await fomoscanUsage();
  const n = Number(me?.usage?.unitsRemaining);
  if (!Number.isFinite(n)) return null;
  budget = { left: n, at: Date.now() };
  return n;
}

/** Keep the local count honest between polls, so one page of activity does not
 *  spend the reserve four times over before the next /v2/me. */
function spend(cu: number): void {
  if (budget) budget.left = Math.max(0, budget.left - cu);
}

export async function fomoscanCredits(): Promise<number | null> {
  return await creditsLeft();
}

/* ── the call ──────────────────────────────────────────────────────────────*/

export type FsResult<T> = { v: T } | { error: string };

export type FsOpts = {
  /** How long a successful response stays good. */
  ttl: number;
  /**
   * What this path costs, in CU.
   *
   * Declared so the guard below can refuse an expensive call when the
   * allowance is nearly gone. Without it the 2,500 CU endpoints drain the key
   * and then every feature fails at once, including the 250 CU ones that could
   * still have run hundreds of times.
   */
  cost?: number;
  /**
   * How long a 404 stays good.
   *
   * Cached deliberately: a miss on /v2/user/handle costs 250 CU and a hit costs
   * 2,500, so a handle we have already failed to resolve is the cheap case to
   * remember. Shorter than `ttl` because a trader who joins after we looked
   * should not stay invisible for a day.
   */
  negTtl?: number;
};

/**
 * One GET against FomoScan, cached both ways.
 *
 * A 404 is returned as `{ v: null }` rather than an error: for every endpoint
 * here it means "we do not know this", which is an answer the caller renders,
 * not a failure it should retry or apologise for.
 */
export async function fsGet<T = any>(path: string, opts: FsOpts): Promise<FsResult<T | null>> {
  const key = await fomoscanKey();
  if (!key) return { error: "No FomoScan API key configured." };

  const negTtl = opts.negTtl ?? Math.min(opts.ttl, 30 * 60_000);
  const cached = await readCache(path, opts.ttl);
  if (cached !== undefined) {
    // A cached miss is stored as the sentinel below so it is distinguishable
    // from a cached null body.
    if (cached && cached.__miss) {
      return Date.now() - (cached.__at || 0) < negTtl ? { v: null } : await live<T>(path, key, opts);
    }
    return { v: cached as T };
  }
  return await live<T>(path, key, opts);
}

async function live<T>(path: string, key: string, o: FsOpts): Promise<FsResult<T | null>> {
  const cu = o.cost ?? 250;
  if (cu >= EXPENSIVE) {
    const left = await creditsLeft();
    if (left !== null && left < RESERVE) {
      return { error: `FomoScan credits low (${left.toLocaleString()} left) — held back to keep token panels working.` };
    }
  }

  let r: Response;
  try {
    r = await fetch(HOST + path, {
      headers: { "x-api-key": key, accept: "application/json" },
    });
  } catch (e: any) {
    return { error: (e?.message || String(e)).slice(0, 140) };
  }

  if (r.status === 404) {
    await writeCache(path, { __miss: true, __at: Date.now() });
    return { v: null };
  }
  // 401/403 mean the key is wrong or spent. Said plainly, because the fix is
  // the user's (rotate or top up) and a generic "couldn't load" hides that.
  if (r.status === 401 || r.status === 403) return { error: "FomoScan key rejected — check or rotate it." };
  // Out of credits. Recorded locally so the next expensive call is refused by
  // the guard above rather than spending a round trip to be told again.
  if (r.status === 402) {
    budget = { left: 0, at: Date.now() };
    return { error: "FomoScan credits exhausted — top up at partner.fomoscan.sh." };
  }
  if (r.status === 429) return { error: "FomoScan rate limit — try again shortly." };
  if (!r.ok) return { error: `FomoScan HTTP ${r.status}` };

  try {
    const v = await r.json();
    spend(cu);
    await writeCache(path, v);
    return { v: v as T };
  } catch {
    return { error: "FomoScan returned malformed JSON." };
  }
}

/** Remaining allowance on the key. Costs 0 CU. Diagnostics only. */
export async function fomoscanUsage(): Promise<any | null> {
  const key = await fomoscanKey();
  if (!key) return null;
  try {
    const r = await fetch(`${HOST}/v2/me`, { headers: { "x-api-key": key } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/* ── avatars ───────────────────────────────────────────────────────────────
   Shared by the thesis feed and the profile page, and security-critical in two
   ways that were both audit findings.

   The URL arrives inside third-party JSON and a profile picture is user-set, so
   it is attacker-influenced: fetching it unchecked let a crafted profile point
   the background worker at any address it liked, including a LAN host, where
   the request still fires even though the response cannot be read. Scheme and
   host are checked against a fixed list before anything is requested.

   The Content-Type is likewise chosen by whoever served the bytes, and it used
   to be pasted straight into `data:${ct};base64,…`. A header of
   `image/png" onerror="…` passes a startsWith("image/") test and closes the src
   attribute early, turning a profile picture into script execution. The type is
   matched against an exact pattern rather than merely inspected. */

export const AVATAR_HOSTS = new Set([
  "prod-fomo-profile-pics.s3.amazonaws.com",
  "pump.mypinata.cloud",
  "socialimages.pump.fun",
]);

const MIME_OK = /^image\/(png|jpeg|jpg|gif|webp|avif)$/;

/**
 * Fetch a remote avatar and inline it as a data: URI.
 *
 * NOT left as a remote URL. The panel renders inside the host page's document,
 * so an <img src> pointing at Amazon loads under THAT page's img-src policy —
 * and x.com's blocks it, which is why avatars silently never appeared. The
 * extension can reach the host, so the bytes are inlined and the page is never
 * asked to reach out at all.
 */
export async function inlineAvatar(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  let u: URL;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:" || !AVATAR_HOSTS.has(u.hostname)) return null;
  try {
    const r = await fetch(u.toString());
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!MIME_OK.test(ct)) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 300_000) return null;
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return `data:${ct};base64,${btoa(bin)}`;
  } catch { return null; }
}

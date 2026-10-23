// Impulse Wallet - X (Twitter) inline trading terminal.
// Detects Robinhood Chain token addresses in tweets and mounts a live buy/sell
// panel in an isolated Shadow DOM (so x.com's CSS and CSP can't touch it).
// All reads, images, and the trade itself are delegated to the extension's
// background service worker - the private key never enters this page.

const ADDR_RE = /(?<![0-9a-fA-Fx])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/g;
// Solana mints are base58, 32-44 chars, and the alphabet excludes 0/O/I/l.
// Deliberately narrow: base58 also matches ordinary words, so the pattern
// demands a mixed-case run of at least 32 and every hit is still verified as a
// real mint by STRIX_ISTOKEN before anything mounts.
const SOL_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const looksLikeMint = (s: string) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[1-9]/.test(s);
// Cashtags. The old cap of six letters silently dropped some of the biggest
// tokens on every chain we support — $CASHCAT (7), $MOODENG (7), $FARTCOIN (8)
// all matched nothing at all. Ten covers real tickers, and digits are allowed
// after the first character so $SHIB2 resolves instead of failing the
// trailing-character guard. Over-matching is cheap: a symbol still has to
// clear the liquidity, volume and trade floors before anything mounts.
const TICKER_RE = /(?<![A-Za-z0-9$])\$([A-Za-z][A-Za-z0-9]{0,9})(?![A-Za-z0-9])/g;
const STOCK_TICKERS: Record<string, string> = {
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  MSFT: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
  GOOGL: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  AMZN: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
  META: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
  SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
};
// Cashtags we never resolve (stables/fiat/majors — no useful RH token to trade).
const TICKER_SKIP = new Set([
  "USD", "USDC", "USDT", "USDG", "DAI", "FDUSD", "TUSD", "PYUSD", "USDE",
  "EUR", "GBP", "JPY", "CNY", "INR", "BTC", "ETH", "WETH", "WBTC", "BNB", "SOL", "XRP",
]);
const SOLANA_MARK = `<svg viewBox="0 0 398 312" width="11" height="9" aria-hidden="true" style="display:block">
  <defs><linearGradient id="sg" x1="360" y1="-37" x2="141" y2="384" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#00FFA3"/><stop offset="1" stop-color="#DC1FFF"/>
  </linearGradient></defs>
  <path fill="url(#sg)" d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z"/>
  <path fill="url(#sg)" d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z"/>
  <path fill="url(#sg)" d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z"/>
</svg>`;

/** The chain's own mark. A two-letter chip said "RH" to people who already
 *  know what RH is; a logo is recognised without reading. */
const chainLogo = (key: string, size = 14) =>
  `<img src="${chrome.runtime.getURL(`icons/chain-${key}.png`)}" width="${size}" height="${size}" ` +
  `style="display:block;border-radius:50%;flex:0 0 auto" alt=""/>`;

const CHAIN_LABEL: Record<string, { short: string; name: string; tint: string; mark?: string; explorer: string; acct: string; logo: string }> = {
  robinhood: { short: "RH", name: "Robinhood Chain", tint: "#a3e635", explorer: "https://robinhoodchain.blockscout.com", acct: "address" , logo: "robinhood" },
  solana: { short: "SOL", name: "Solana", tint: "#1a1030", mark: SOLANA_MARK, explorer: "https://solscan.io", acct: "account" , logo: "solana" },
  eth: { short: "ETH", name: "Ethereum", tint: "#8fb3ff", explorer: "https://etherscan.io", acct: "address" , logo: "ethereum" },
  base: { short: "BASE", name: "Base", tint: "#4f8cff", explorer: "https://basescan.org", acct: "address" , logo: "base" },
};

const MARK = "data-strix-scanned";
const HOST_ATTR = "data-strix-host";
const BUY_AMOUNTS = ["0.01", "0.05", "0.1", "0.25"];
const SELL_PCTS = [25, 50, 100];

type Msg = Record<string, any>;
const send = (msg: Msg): Promise<any> =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
        else resolve(r || {});
      });
    } catch (e) { resolve({ error: String(e) }); }
  });

const fmtUsd = (n: any) => {
  const v = Number(n);
  if (!isFinite(v) || n == null) return "-";
  if (v === 0) return "$0";
  const a = Math.abs(v);
  if (a >= 1) return "$" + v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (a >= 0.01) return "$" + v.toFixed(4);
  // Sub-cent: show ~3 significant figures without exponential notation.
  const decimals = Math.min(14, Math.ceil(-Math.log10(a)) + 2);
  return "$" + v.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
};
const fmtCompact = (n: any) => {
  const v = Number(n);
  if (!isFinite(v) || n == null) return "-";
  return "$" + Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(v);
};
const fmtNum = (n: any) => {
  const v = Number(n);
  if (!isFinite(v)) return "0";
  return v.toLocaleString(undefined, { maximumFractionDigits: v < 1 ? 6 : 4 });
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// Escapes ' as well as <>&" so the helper stays safe if a future edit ever
// interpolates into a single-quoted attribute. Cheap now, silent XSS later.
const esc = (s: string) =>
  (s || "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c] || c));

const LOGO = `<img src="${chrome.runtime.getURL("icons/mascot.png")}" width="16" height="16" style="border-radius:8px;display:block" alt=""/>`;
/** Order ticket. A receipt/slip shape reads as "trade" without a dollar sign. */
const TRADEI = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3v18l2.5-1.6L10 21l2-1.6L14 21l2.5-1.6L19 21V3z"/><path d="M9 8h6M9 12h6"/></svg>`;
const CANDLES = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4v3"/><rect x="7" y="7" width="4" height="9" rx="1"/><path d="M9 16v3"/><path d="M17 2v4"/><rect x="15" y="6" width="4" height="7" rx="1"/><path d="M17 13v4"/></svg>`;

const SHIELD = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>`;
const PEOPLE = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
// FOMO's own mark, keyed to white — it doubles as attribution for whose data
// the tab is showing, which a generic icon would not.
/**
 * Trader theses (FomoScan) are built and working, but held back from this
 * release. Flip to true to ship it; nothing else needs changing.
 *
 * Keep in step with three other things when you do: re-add
 * "https://api.fomoscan.sh/*" to host_permissions in vite.config.ts, restore
 * the section in the store description, and put the Theses section back on the
 * website. Shipping the code while the listing stays quiet is fine; the
 * reverse is not.
 */
const FOMO_ENABLED = true;

const FOMO_MARK = `<img src="${chrome.runtime.getURL("icons/fomo.png")}" width="17" height="17" style="display:block;opacity:.92" alt=""/>`;
const FOMO_MARK_SM = `<img src="${chrome.runtime.getURL("icons/fomo.png")}" width="15" height="15" style="display:block;opacity:.95" alt=""/>`;
/**
 * Pump.fun callouts.
 *
 * Behind its own flag, separate from FOMO's. This reads a private, undocumented
 * API that can move on any pump.fun deploy, so the switch has to be flippable
 * without touching the thesis feed.
 */
const CALLOUTS_ENABLED = false; // pump.fun removed the public per-token callout endpoint; feature retired

/**
 * Opt-in trace of why a panel did or did not mount.
 *
 * Turn on from the page console with
 *   localStorage.impulseDebug = "1"
 * then reload. Off by default and silent, so it costs nothing in normal use.
 *
 * It exists because the failure mode here is silence: an address is found, a
 * check comes back negative, and nothing appears — with no way to tell whether
 * the scanner missed it, the token was rejected, or a panel mounted somewhere
 * invisible. Guessing between those three wastes far more time than logging
 * them does.
 */
const DEBUG = (() => {
  try { return localStorage.getItem("impulseDebug") === "1"; } catch { return false; }
})();
const dlog = (...a: any[]) => {
  if (DEBUG) console.log("%c[impulse]", "background:#b6f03c;color:#000;padding:1px 4px;border-radius:6px", ...a);
};
const PUMP_MARK = `<img src="${chrome.runtime.getURL("icons/pumpfun.png")}" width="17" height="17" style="display:block;border-radius:8px" alt=""/>`;
const PUMP_MARK_SM = `<img src="${chrome.runtime.getURL("icons/pumpfun.png")}" width="15" height="15" style="display:block;border-radius:6px" alt=""/>`;
const LOGO_LG = `<img src="${chrome.runtime.getURL("icons/mascot.png")}" width="34" height="34" style="border-radius:14px;display:block" alt=""/>`;
const BUBBLES = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="9" r="4.5"/><circle cx="17" cy="7" r="2.5"/><circle cx="15.5" cy="16.5" r="3.5"/><path d="M11.5 11.8 13 14"/><path d="M12.3 8.2 14.6 7.6"/></svg>`;

// Premium duotone icons for the overlay strip (currentColor drives both the
// solid accent and the low-opacity fill, so they read crisp at 22px).
const IC_CHART = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="M3 17.5 9 11l4 3.5L21 6" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 17.5 9 11l4 3.5L21 6V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill="currentColor" opacity=".16"/><circle cx="21" cy="6" r="2" fill="currentColor"/></svg>`;
const IC_HOLDERS = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><circle cx="9" cy="8" r="3.4" fill="currentColor" opacity=".18"/><circle cx="9" cy="8" r="3.4" stroke="currentColor" stroke-width="1.9"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M16 5.2A3.2 3.2 0 0 1 16 11m1.4 3.3c2.2.5 3.9 2.3 3.9 4.7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`;
const IC_NEW = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><circle cx="10" cy="8" r="3.4" fill="currentColor" opacity=".18"/><circle cx="10" cy="8" r="3.4" stroke="currentColor" stroke-width="1.9"/><path d="M4 19c0-3.1 2.7-5.2 6-5.2 1 0 2 .2 2.8.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M18.5 13.5v5M16 16h5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const IC_BUBBLES = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><circle cx="8.5" cy="10" r="5" fill="currentColor" opacity=".18"/><circle cx="8.5" cy="10" r="5" stroke="currentColor" stroke-width="1.9"/><circle cx="17.5" cy="7" r="2.6" fill="currentColor" opacity=".3"/><circle cx="17.5" cy="7" r="2.6" stroke="currentColor" stroke-width="1.7"/><circle cx="16.5" cy="16.5" r="3.4" fill="currentColor" opacity=".24"/><circle cx="16.5" cy="16.5" r="3.4" stroke="currentColor" stroke-width="1.8"/></svg>`;

// ── GMGN helpers (safety checks, holder tags) ───────────────────────────────
const gPick = (obj: any, keys: string[]): any => {
  for (const k of keys) {
    const v = k.split(".").reduce((o: any, p: string) => (o == null ? undefined : o[p]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};
const gBool = (v: any): boolean | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return ["1", "yes", "true"].includes(s) ? true : ["0", "no", "false"].includes(s) ? false : undefined;
};
const gPct = (v: any): number | undefined => {
  const n = Number(v);
  if (!isFinite(n) || v === undefined || v === null || v === "") return undefined;
  return n <= 1 ? n * 100 : n;
};
type SecCheck = { label: string; value: string; level: "ok" | "warn" | "bad" | "na" };
function secChecks(d: any): { checks: SecCheck[]; verdict: "ok" | "warn" | "bad" } {
  const honeypot = gBool(gPick(d, ["is_honeypot", "honeypot"]));
  const buyTax = gPct(gPick(d, ["buy_tax"]));
  const sellTax = gPct(gPick(d, ["sell_tax"]));
  const verified = gBool(gPick(d, ["is_open_source", "open_source", "verified"]));
  const renounced = gBool(gPick(d, ["is_renounced", "renounced", "owner_renounced"]));
  const locked = gBool(gPick(d, ["lock_summary.is_locked", "is_locked", "locked"]));
  const lockPct = gPct(gPick(d, ["lock_summary.lock_percent", "lock_percent"]));
  const top10 = gPct(gPick(d, ["top_10_holder_rate", "top10_holder_rate"]));
  const rugRaw = gPick(d, ["rug_ratio"]);
  const rug = Number(rugRaw);
  const tax = (t?: number) => (t == null ? "?" : `${t.toFixed(t < 10 ? 1 : 0)}%`);
  const checks: SecCheck[] = [
    // Honeypot row only shown when it actually IS one — hidden otherwise.
    ...(honeypot === true ? [{ label: "Honeypot", value: "YES — can't sell", level: "bad" } as SecCheck] : []),
    { label: "Buy tax", value: tax(buyTax), level: buyTax == null ? "na" : buyTax > 10 ? "bad" : buyTax > 3 ? "warn" : "ok" },
    { label: "Sell tax", value: tax(sellTax), level: sellTax == null ? "na" : sellTax > 10 ? "bad" : sellTax > 3 ? "warn" : "ok" },
    { label: "Verified", value: verified == null ? "Unknown" : verified ? "Yes" : "No", level: verified == null ? "na" : verified ? "ok" : "warn" },
    { label: "Renounced", value: renounced == null ? "Unknown" : renounced ? "Yes" : "No", level: renounced == null ? "na" : renounced ? "ok" : "warn" },
  ];
  if (locked != null) checks.push({ label: "Liq. locked", value: locked ? (lockPct != null ? `Yes (${lockPct.toFixed(0)}%)` : "Yes") : "No", level: locked ? "ok" : "warn" });
  if (top10 != null) checks.push({ label: "Top 10 hold", value: `${top10.toFixed(1)}%`, level: top10 > 50 ? "bad" : top10 > 30 ? "warn" : "ok" });
  if (rugRaw != null && isFinite(rug)) checks.push({ label: "Rug risk", value: `${(rug <= 1 ? rug * 100 : rug).toFixed(0)}%`, level: rug > 0.3 ? "bad" : rug > 0.1 ? "warn" : "ok" });
  const verdict = checks.some((c) => c.level === "bad") ? "bad" : checks.some((c) => c.level === "warn") ? "warn" : "ok";
  return { checks, verdict };
}
const SEC_VERDICT = { ok: "No red flags", warn: "Caution", bad: "High risk" } as const;

const gRows = (d: any): any[] => (Array.isArray(d) ? d : d?.list || d?.holders || d?.traders || []);
const gIsPool = (r: any): boolean => !!r?.exchange || r?.addr_type === 2;
const gTags = (r: any): string[] => {
  const out: string[] = [];
  for (const key of ["tags", "maker_token_tags"]) {
    const t = r?.[key];
    if (Array.isArray(t)) for (const x of t) if (x && !out.includes(String(x))) out.push(String(x));
  }
  return out;
};
const G_TAG: Record<string, { label: string; cls: string }> = {
  kol: { label: "KOL", cls: "kol" }, renowned: { label: "KOL", cls: "kol" },
  smart_degen: { label: "Smart $", cls: "smart" }, whale: { label: "Whale", cls: "mut" },
  dev: { label: "Dev", cls: "bad" }, creator: { label: "Dev", cls: "bad" },
  rat_trader: { label: "Insider", cls: "bad" }, wash_trader: { label: "Wash", cls: "bad" },
  sniper: { label: "Sniper", cls: "mut" }, bundler: { label: "Bundler", cls: "mut" },
  fresh_wallet: { label: "Fresh", cls: "mut" },
};
function gSocials(d: any): { label: string; url: string }[] {
  if (!d) return [];
  const link = gPick(d, ["link", "links", "social_links"]) || d;
  const out: { label: string; url: string }[] = [];
  const web = gPick(link, ["website", "official_website"]);
  if (web) out.push({ label: "Web", url: String(web) });
  const tw = gPick(link, ["twitter_username", "twitter"]);
  if (tw) out.push({ label: "𝕏", url: String(tw).startsWith("http") ? String(tw) : `https://x.com/${String(tw).replace(/^@/, "")}` });
  const tg = gPick(link, ["telegram"]);
  if (tg) out.push({ label: "Telegram", url: String(tg).startsWith("http") ? String(tg) : `https://t.me/${String(tg).replace(/^@/, "")}` });
  const dc = gPick(link, ["discord"]);
  if (dc && String(dc).startsWith("http")) out.push({ label: "Discord", url: String(dc) });
  return out.filter((s) => /^https?:\/\//.test(s.url)).slice(0, 4);
}

/**
 * One wallet row.
 *
 * `maxPct` scales the supply bar against the biggest holder on screen rather
 * than against 100%, because real distributions are long-tailed — bar widths
 * measured against 100 would all collapse to a hairline and show nothing.
 */
/**
 * One holder, as a table row.
 *
 * The supply share is the row's background rather than a separate bar beneath
 * the name. A column of percentages hides concentration — 8.2% and 2.1% look
 * alike in text and nothing like each other as width — and a bar drawn under
 * every row doubled the row height to say what the row could have said itself.
 * Scaled to the largest holder on screen so the shape is comparative.
 */
type Candle = [number, number, number, number, number, number]; // ts,o,h,l,c,v

const fmtAxis = (v: number) => {
  if (!isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (v / 1e3).toFixed(2) + "K";
  if (a >= 1) return "$" + v.toFixed(3);
  if (a >= 0.001) return "$" + v.toFixed(5);
  return "$" + v.toPrecision(3);
};

const STYLES = `

  :host{ all:initial; }

  /* Bundled rather than named. The old stack asked for Sora and Inter, neither
     of which exists on a normal machine, so every install quietly fell through
     to Segoe UI or Arial — the panel was running on the system default and no
     amount of tuning the stack would have changed that. IBM Plex ships with
     the extension: drawn for technical interfaces, with a mono cut whose
     figures line up with the sans, which is what a screen full of prices
     needs. 150KB for type that is actually the type we designed against. */
  @font-face{font-family:"ImpulseSans";font-style:normal;font-weight:400;font-display:swap;
    src:url("${chrome.runtime.getURL("fonts/plexsans-400.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-style:normal;font-weight:500;font-display:swap;
    src:url("${chrome.runtime.getURL("fonts/plexsans-500.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-style:normal;font-weight:600;font-display:swap;
    src:url("${chrome.runtime.getURL("fonts/plexsans-600.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-style:normal;font-weight:700;font-display:swap;
    src:url("${chrome.runtime.getURL("fonts/plexsans-700.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseMono";font-style:normal;font-weight:400;font-display:swap;
    src:url("${chrome.runtime.getURL("fonts/plexmono-400.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseMono";font-style:normal;font-weight:500;font-display:swap;
    src:url("${chrome.runtime.getURL("fonts/plexmono-500.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseMono";font-style:normal;font-weight:600;font-display:swap;
    src:url("${chrome.runtime.getURL("fonts/plexmono-600.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseMono";font-style:normal;font-weight:700;font-display:swap;
    src:url("${chrome.runtime.getURL("fonts/plexmono-700.woff2")}") format("woff2")}
  *{ box-sizing:border-box; font-family:"ImpulseSans",-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
     -webkit-font-smoothing:antialiased; }

  /* Floating dock: used where the address is in the URL rather than in a post,

     so there is no element to anchor under. Bottom-right on desktop, bottom

     edge on phones, and never wider than the viewport. */

  .dock{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;

    align-items:flex-end;gap:0;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px)}

  .dock .pill{margin-top:0;order:2;box-shadow:0 6px 18px -6px rgba(0,0,0,.6)}
  .dock .pill + .pill{margin-top:6px}

  .dock .panel{order:1;margin-top:0;margin-bottom:9px;max-height:calc(100vh - 96px);overflow-y:auto;

    box-shadow:0 24px 60px -20px rgba(0,0,0,.85)}

  .dockx{order:3;margin-top:6px;align-self:flex-end;background:none;border:0;cursor:pointer;

    font:500 10.5px "ImpulseMono",ui-monospace,monospace;color:#8fa088;letter-spacing:.08em;padding:3px 5px;border-radius:8px;transition:.12s}

  .dockx:hover{color:#b6f03c}

  @media (max-width:520px){

    .dock{right:10px;left:10px;bottom:10px;align-items:stretch;max-width:none}

    .dock .pill{align-self:center}

    .dock .panel{max-width:none}

  }

  /* The one control we put on somebody else's page. It has to read as a
     trading control rather than an ad: the gradient, the 999px capsule and the
     lime glow were all badge language, and next to a terminal they looked like
     something bolted on. Flat accent, the drawer's own corner radius, and the
     label set in the bundled type at the weight the drawer uses. The caret is
     the only decoration and it earns its place — it says this opens a panel
     rather than firing a trade, which on a buy button is worth being clear
     about. */
  .pill{display:inline-flex;align-items:center;gap:7px;margin-top:8px;
    padding:7px 11px 7px 8px;border-radius:9px;
    background:#b6f03c;border:1px solid #a9db2c;color:#0a1005;
    font-family:"ImpulseSans",-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
    font-size:12px;font-weight:600;line-height:1;letter-spacing:-.005em;
    cursor:pointer;transition:background .12s,transform .12s,box-shadow .12s;
    box-shadow:0 1px 2px rgba(0,0,0,.28)}
  .pill img{width:17px;height:17px;border-radius:8px;flex:0 0 auto}
  .pill span{white-space:nowrap}
  .pill::after{content:"›";margin-left:1px;font-size:14px;line-height:1;
    color:rgba(10,16,5,.5);transition:transform .12s,color .12s}
  /* The secondary action in a dock that has two. Same geometry so the pair
     reads as one control group, without a second lime button competing for the
     eye — there is only ever one primary thing to do here. */
  .pill.alt{background:var(--surface,#151a21);border-color:#2f3947;color:#e8edf4;
    box-shadow:0 1px 2px rgba(0,0,0,.3)}
  .pill.alt::after{color:rgba(232,237,244,.45)}
  .pill.alt:hover{background:#1b222b;border-color:#3f4c5c}
  .pill.alt:hover::after{color:rgba(232,237,244,.85)}
  .pill.alt:active{background:#12171d}
  .pill.hidden{display:none}
  .pill:hover{background:#d4ff5b;transform:translateY(-1px);
    box-shadow:0 4px 12px -4px rgba(120,190,20,.55)}
  .pill:hover::after{transform:translateX(2px);color:rgba(10,16,5,.8)}
  .pill:active{transform:translateY(0);background:#b8e43c;box-shadow:0 1px 2px rgba(0,0,0,.3)}
  .pill:focus-visible{outline:2px solid #b6f03c;outline-offset:2px}
  .pill svg{opacity:.9}

  /* Buy pill + the "who holds this" thesis avatars, one row with a gap. */
  .pillrow{display:flex;align-items:center;gap:14px;margin-top:8px;flex-wrap:wrap}
  .pillrow .pill{margin-top:0}
  /* Avatar cluster: the top thesis authors on this token, lightly overlapped. */
  .tstrip{display:inline-flex;align-items:center;padding-left:2px}
  .tstrip.empty{display:none}
  /* Scoped under .tstrip — there is ANOTHER .tav (24px, the drawer author avatar)
     later in this stylesheet; without the scope it would override these. */
  .tstrip .tav{position:relative;width:48px;height:48px;border-radius:50%;margin-left:-14px;
    border:2.5px solid #0a0d07;background:#141810;overflow:visible;flex:0 0 auto;
    transition:transform .12s;cursor:default}
  .tstrip .tav:first-child{margin-left:0}
  .tstrip .tav:hover{transform:translateY(-2px) scale(1.1);z-index:5}
  .tstrip .tav img,.tstrip .tav .tavfb{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}
  .tstrip .tav .tavfb{display:flex;align-items:center;justify-content:center;
    font:700 18px "ImpulseSans",sans-serif;color:#0a1005;background:#b6f03c}
  /* pump.fun / FOMO toggle — SAME size as the avatars, set off by a small gap */
  .tstrip .tavtoggle{position:relative;width:48px;height:48px;border-radius:50%;margin-left:12px;
    align-self:center;border:2.5px solid #0a0d07;background:#12160c;display:flex;align-items:center;
    justify-content:center;cursor:pointer;flex:0 0 auto;padding:0;transition:transform .12s,background .12s,box-shadow .12s}
  .tstrip .tavtoggle:hover{transform:translateY(-2px);background:#1a2010;z-index:6}
  .tstrip .tavtoggle.on{background:#171c0f;box-shadow:0 0 0 2px rgba(182,240,60,.4) inset}
  .tstrip .tavtoggle img{width:28px;height:28px;border-radius:8px;display:block}
  /* Tool icons (chart / holders / new / bubbles) — a tight group after the toggle */
  .tstrip .tavtool{color:#b6f03c;margin-left:7px}
  .tstrip .tavtool:hover{color:#d4ff5e;background:#1a2010}
  .tstrip .tavtool svg{width:22px;height:22px;display:block}
  .tstrip .tavnote{align-self:center;margin:0 4px 0 6px;
    font:600 13px "ImpulseSans",-apple-system,sans-serif;color:#8a927e;white-space:nowrap}
  .tav .tavmore{background:#171c0f;color:#b6f03c;font-size:9.5px}
  /* Hover card: their thesis + how much they hold. */
  .ttip{position:absolute;bottom:135%;left:50%;transform:translateX(-50%) translateY(4px);
    width:230px;padding:9px 11px;border-radius:12px;background:#0a0d07;border:1px solid #20261a;
    box-shadow:0 16px 40px -14px rgba(0,0,0,.9);opacity:0;pointer-events:none;
    transition:opacity .12s,transform .12s;z-index:2147483000}
  .tav:hover .ttip{opacity:1;transform:translateX(-50%) translateY(0)}
  .ttip::after{content:"";position:absolute;top:100%;left:50%;transform:translateX(-50%);
    border:5px solid transparent;border-top-color:#0a0d07}
  .ttip .tth{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}
  .ttip .ttname{font:600 12px "ImpulseSans",sans-serif;color:#f3f7ec;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ttip .tthold{font:700 11px "ImpulseMono",monospace;color:#b6f03c;white-space:nowrap;flex:0 0 auto}
  .ttip .tthold.dn{color:#ff6b6b}
  .ttip .ttbody{font:400 11.5px/1.45 "ImpulseSans",sans-serif;color:#c7cebb;
    display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
  .ttip .ttempty{font:400 11.5px "ImpulseSans",sans-serif;color:#8a927e;font-style:italic}

  .panel{margin-top:9px;width:100%;max-width:436px;border-radius:24px;overflow:hidden;color:#ffffff;

    background:linear-gradient(180deg,#101c13,#0a110c);border:1px solid #223528;

    box-shadow:0 18px 48px -18px rgba(0,0,0,.75), inset 0 1px 0 rgba(255,255,255,.035), 0 0 0 1px rgba(163,230,53,.05);

    animation:rise .22s cubic-bezier(.22,1,.36,1) both}

  @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

  .badge.stk{color:#8fd0ff;background:rgba(93,169,255,.12);border-color:rgba(93,169,255,.32)}

  /* Which network a trade will actually settle on. Always shown: the same

     ticker exists on several chains and the wrong one is unrecoverable. */

  .chainchip{font-size:8.5px;font-weight:900;letter-spacing:.07em;text-transform:uppercase;

    padding:2px 5px;border-radius:9px;color:#0b140c}

  .chainchip.withmark{display:inline-flex;align-items:center;gap:3px;border:1px solid rgba(153,69,255,.5)}

  .stockline{margin:0 14px 12px;background:#111d15;border:1px solid #1e2f24;border-radius:16px;padding:9px 11px;

    font-size:11.5px;color:#dfeeda;text-align:center}

  .stockline b{color:#ffffff}

  .head{display:flex;align-items:center;gap:11px;padding:14px 14px 12px}

  .logo{width:42px;height:42px;border-radius:17px;object-fit:cover;flex:0 0 auto;background:#16241a;

    border:1px solid #2a3f30;display:grid;place-items:center;color:#a3e635}

  .hd{min-width:0;flex:1}

  .symrow{display:flex;align-items:center;gap:6px}

  .sym{font-weight:800;font-size:16px;color:#fff;letter-spacing:-.01em;white-space:nowrap}

  .badge{font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#bff45f;

    background:rgba(163,230,53,.12);border:1px solid rgba(163,230,53,.32);border-radius:10px;padding:2px 5px}

  .name{font-size:11.5px;color:#dfeeda;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .carow{margin-top:3px;font-size:9.5px;color:#c8dcc0;font-family:ui-monospace,monospace;

    display:flex;align-items:center;gap:5px;width:fit-content}

  .carow a{color:inherit;text-decoration:none;cursor:pointer}

  .carow a:hover{color:#bff45f;text-decoration:underline}

  .carow span{cursor:pointer}

  .carow span:hover{color:#bff45f}

  .carow b{color:#bff45f;font-weight:700}

  /* Cashtag ambiguity notice — amber, not red: this is "check me", not "danger". */

  .ambig{display:flex;align-items:center;gap:7px;padding:7px 13px;font-size:10.5px;line-height:1.35;

    color:#ffe6a3;background:rgba(251,191,36,.09);border-bottom:1px solid rgba(251,191,36,.22)}

  .ambigi{flex:0 0 auto;width:14px;height:14px;border-radius:50%;display:grid;place-items:center;

    background:rgba(251,191,36,.9);color:#1a1206;font-weight:900;font-size:10px}

  .ambig a{color:#fbbf24;font-weight:800;text-decoration:none;cursor:pointer;white-space:nowrap}

  .ambig a:hover{text-decoration:underline}

  .price{text-align:right;flex:0 0 auto}

  .pval{font-weight:800;font-size:16px;color:#fff;display:flex;align-items:center;gap:6px;justify-content:flex-end}

  .live{width:6px;height:6px;border-radius:999px;background:#59e08a;box-shadow:0 0 8px #59e08a;animation:pulse 1.6s infinite}

  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}

  .chg{font-weight:800;font-size:12px;margin-top:3px}

  .up{color:#59e08a} .dn{color:#ff7a7a}

  .stats{display:flex;gap:7px;padding:0 14px 12px}

  .stat{flex:1;background:#111d15;border:1px solid #1e2f24;border-radius:16px;padding:8px 6px;text-align:center}

  .stat span{display:block;font-size:8.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#c8dcc0;margin-bottom:3px}

  .stat b{font-weight:800;font-size:13px;color:#ffffff}

  .hold{margin:0 14px 11px;background:rgba(163,230,53,.07);border:1px solid rgba(163,230,53,.18);border-radius:16px;

    padding:8px 11px;font-size:12px;color:#dfeeda}

  .hold b{color:#fff}

  .seg{display:flex;gap:5px;margin:0 14px 10px;background:#111d15;border:1px solid #1e2f24;border-radius:16px;padding:4px}

  .seg button{flex:1;border:0;background:transparent;color:#dfeeda;font-weight:800;font-size:13px;padding:8px 0;

    border-radius:13px;cursor:pointer;transition:.15s}

  .seg button.chartbtn{flex:0 0 48px;display:grid;place-items:center;padding:7px 0}

  .seg button.chartbtn:hover{color:#bff45f}

  .tfrow{display:flex;gap:5px;margin:0 14px 10px;align-items:center}

  .tfbtn{flex:1;padding:6px 0;border-radius:13px;background:#111d15;color:#dfeeda;border:1px solid #1e2f24;

    font-weight:700;font-size:11.5px;cursor:pointer;transition:.12s}

  .tfbtn:hover{border-color:#31503a;color:#ffffff}

  .tfbtn.on{background:rgba(163,230,53,.15);border-color:rgba(163,230,53,.5);color:#bff45f}

  .tfchg{flex:0 0 auto;font-size:11.5px;font-weight:800;padding:0 4px}

  .chartbox{margin:0 14px 12px;background:#0d1712;border:1px solid #1e2f24;border-radius:16px;overflow:hidden;min-height:120px}

  .socials{display:flex;gap:12px;margin:-4px 14px 10px;font-size:11px}

  .socials a{color:#dfeeda;text-decoration:none;font-weight:700}

  .socials a:hover{color:#bff45f;text-decoration:underline}

  .secbar{margin:0 14px 11px;display:flex;align-items:center;gap:7px;border-radius:16px;border:1px solid #1e2f24;

    padding:8px 11px;font-size:12px;font-weight:800;cursor:pointer}

  .secbar i{margin-left:auto;font-style:normal;font-weight:600;font-size:10.5px;opacity:.75}

  /* The author's picture, used by every card feed. */
  .tav{flex:0 0 auto;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;
    overflow:hidden;user-select:none;border:1px solid #26382b}

  /* Still used by the trader profile page, which is unchanged. */
  .tver{font-size:9px;font-weight:900;color:#59e08a;line-height:1}

  /* Coming-soon panel. Centred and quiet — it is a promise, not a feature, and

     should not compete with the tabs that actually do something. */

  .soon{padding:22px 18px 20px;text-align:center;display:flex;flex-direction:column;

    align-items:center;gap:0}

  .soonlogo{width:52px;height:52px;border-radius:20px;display:grid;place-items:center;

    background:#111d15;border:1px solid #1e2f24;margin-bottom:12px}

  .soonttl{font-size:15px;font-weight:800;color:#fff;letter-spacing:-.015em}

  .soonpill{margin-top:7px;font-size:8.5px;font-weight:800;letter-spacing:.14em;

    text-transform:uppercase;padding:3px 9px;border-radius:99px;

    background:rgba(163,230,53,.1);border:1px solid rgba(163,230,53,.3);color:#bff45f}

  .soontxt{margin:12px 0 0;font-size:11px;line-height:1.55;color:#c8dcc0;max-width:34ch}

  .soonrow{margin-top:14px;display:flex;flex-wrap:wrap;gap:5px;justify-content:center}

  .soonchip{font-size:9px;font-weight:700;padding:3px 8px;border-radius:11px;

    background:#111d15;border:1px solid #1e2f24;color:#9fbf8f}

  /* ── trader profile panel ─────────────────────────────────────────── */

  /* ── the trader profile ──────────────────────────────────────────────
     Opens as the same right-hand drawer as everything else. It used to be a
     bottom-right card in its own green palette, which made the one screen that
     reads a PERSON look like a different product from the screen that reads a
     token — and it capped the numbers at a 462px card while a page of PnL,
     positions and trades wanted the height.

     The components are deliberately the ones the token drawer already uses:
     the .hsum strip, the .tclabel section headers, the .tfseg tab control and
     the .hrow row with its .hfill width bar. A position is read the same way
     here as in the holders table because it is the same kind of fact. */
  .drawer .tp{display:flex;flex-direction:column}

  .drawer .tphead{display:flex;align-items:center;gap:11px;padding:13px 14px;
    border-bottom:1px solid var(--line);background:var(--bg);
    position:sticky;top:20px;z-index:2}
  .drawer .tpav{width:38px;height:38px;border-radius:50%;overflow:hidden;flex:0 0 auto;
    background:var(--surface);border:1px solid var(--line);display:grid;place-items:center}
  .drawer .tpmeta{min-width:0;flex:1}
  .drawer .tpname{display:flex;align-items:center;gap:6px;font-size:15px;font-weight:600;
    color:var(--text);letter-spacing:-.01em;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .drawer .tphandle{margin-top:1px;font-size:11.5px;color:var(--muted);font-weight:500}
  .drawer .hchain{position:relative;flex:0 0 auto;font-size:8.5px;font-weight:600;
    letter-spacing:.06em;text-transform:uppercase;padding:2px 5px;border-radius:6px;
    background:var(--surface);border:1px solid var(--line);color:var(--faint)}
  /* Chain badge as a logo (positions & history) instead of a text abbreviation. */
  .drawer .hchainlogo{position:relative;flex:0 0 auto;display:inline-flex;align-items:center;
    margin-right:2px;opacity:.95}
  .drawer .hchainlogo img{box-shadow:0 0 0 1px rgba(255,255,255,.06)}
  /* ── Timeline ticker scan — its own polished layout ─────────────────────── */
  .scanpop{width:min(420px,94vw)}
  .drawer .ssum{display:grid;grid-template-columns:repeat(3,1fr);margin:12px 14px 4px;
    border:1px solid var(--line);border-radius:13px;overflow:hidden;background:var(--surface)}
  .drawer .ssumcell{padding:11px 12px;text-align:center;border-right:1px solid var(--line)}
  .drawer .ssumcell:last-child{border-right:0}
  .drawer .ssumcell b{display:block;font:700 23px "ImpulseMono",ui-monospace,monospace;color:var(--text);
    font-variant-numeric:tabular-nums;line-height:1.1}
  .drawer .ssumcell b.ac{color:var(--accent)}
  .drawer .ssumcell span{font-size:9.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
  .drawer .scap{margin:16px 16px 9px;font-size:10.5px;font-weight:700;letter-spacing:.09em;
    text-transform:uppercase;color:var(--faint)}
  .drawer .slist{display:flex;flex-direction:column;margin:0 12px}
  .drawer .sgroup{position:relative;border-radius:13px;overflow:hidden;background:#0e130a;
    border:1px solid #1e2712;transition:border-color .12s}
  .drawer .sgroup + .sgroup{margin-top:8px}
  .drawer .sgroup:hover{border-color:#33421d}
  .drawer .sgroup.top{background:linear-gradient(92deg,rgba(182,240,60,.06),transparent 62%),#0e130a;border-color:#2c3a17}
  .drawer .srow{position:relative;display:flex;align-items:center;gap:11px;padding:12px 13px;cursor:pointer;isolation:isolate}
  .drawer .sfill{position:absolute;inset:0 auto 0 0;z-index:-1;
    background:linear-gradient(90deg,rgba(182,240,60,.13),transparent 82%);opacity:.9}
  .drawer .sfill.dim{background:linear-gradient(90deg,rgba(143,179,255,.12),transparent 82%)}
  .drawer .srank{flex:0 0 auto;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;
    font:700 10px "ImpulseMono",ui-monospace,monospace;color:var(--faint);
    background:var(--surface2);border:1px solid var(--line)}
  .drawer .sgroup.top .srank{color:#0a1005;background:var(--accent);border-color:var(--accent)}
  .drawer .slogo{flex:0 0 auto;width:32px;height:32px;border-radius:50%;overflow:hidden;display:block;
    background:#141810;border:1px solid #232b36}
  .drawer .slogo img{width:100%;height:100%;object-fit:cover;display:block}
  .drawer .sfb{width:100%;height:100%;display:flex;align-items:center;justify-content:center;
    font:800 12px "ImpulseSans",-apple-system,sans-serif}
  .drawer .sopen{position:relative;z-index:1;display:flex;align-items:center;gap:10px;flex:1;min-width:0;
    text-decoration:none;color:inherit;border-radius:8px}
  .drawer a.sopen{cursor:pointer}
  .drawer a.sopen:hover .ssym{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
  .drawer .smeta{min-width:0;display:flex;flex-direction:column;gap:1px}
  .drawer .ssym{min-width:0;font:700 16px "ImpulseSans",-apple-system,sans-serif;color:var(--text);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.15}
  .drawer .ssym.mono{font-family:"ImpulseMono",ui-monospace,monospace;font-size:13.5px;color:var(--muted)}
  .drawer .smc{font:600 11.5px "ImpulseMono",ui-monospace,monospace;color:var(--faint);
    white-space:nowrap;font-variant-numeric:tabular-nums;min-height:13px}
  .drawer .smc b{color:var(--muted);font-weight:700}
  .drawer .scount{flex:0 0 auto;font:700 15.5px "ImpulseMono",ui-monospace,monospace;color:var(--text);
    font-variant-numeric:tabular-nums}
  .drawer .scount i{font-style:normal;font-size:11px;color:var(--faint);margin-left:1px}
  .drawer .sbuy{flex:0 0 auto;display:inline-flex;align-items:center;gap:3px;padding:5px 12px;border-radius:999px;
    background:var(--accent);color:#0a1005;font:700 12px "ImpulseSans",sans-serif;
    opacity:0;transform:translateX(4px);transition:opacity .12s,transform .12s;pointer-events:none}
  .drawer .sgroup:hover .sbuy{opacity:1;transform:none}
  .drawer .sbuy .sgo{font-size:10px}
  .drawer .srow.resolving{opacity:.6}
  .drawer .srow.resolving .sbuy{opacity:1;transform:none}
  .drawer .srow.resolving .scount{visibility:hidden}
  .drawer .srow.scanna{opacity:.42}
  .drawer .srow.scanna .scount{color:var(--down)}
  .drawer .srow.scanna .sbuy{display:none}
  .drawer .sempty{padding:44px 20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:7px}
  .drawer .sempty .semoji{font-size:34px;opacity:.7;margin-bottom:2px}
  .drawer .sempty b{font-size:17px;font-weight:700;color:var(--text)}
  .drawer .sempty span{font-size:13px;color:var(--faint)}
  /* Scanning progress view. */
  .drawer .sprog{padding:30px 20px 34px;display:flex;flex-direction:column;align-items:center;gap:20px}
  .drawer .sprogbar{width:100%;height:5px;border-radius:99px;background:var(--surface);overflow:hidden;position:relative}
  .drawer .sprogbar span{position:absolute;top:0;bottom:0;width:38%;border-radius:99px;
    background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:sprogslide 1.15s ease-in-out infinite}
  @keyframes sprogslide{0%{left:-40%}100%{left:100%}}
  .drawer .sprognums{display:flex;gap:34px}
  .drawer .spn{text-align:center}
  .drawer .spn b{display:block;font:700 34px "ImpulseMono",ui-monospace,monospace;color:var(--text);
    font-variant-numeric:tabular-nums;line-height:1}
  .drawer .spn b.ac{color:var(--accent)}
  .drawer .spn span{display:block;margin-top:6px;font-size:11px;font-weight:700;letter-spacing:.06em;
    text-transform:uppercase;color:var(--muted)}
  .drawer .sprognote{font-size:13px;color:var(--faint)}
  /* FOMO thesis avatars, inside the card and indented under the ticker. */
  .drawer .rfomo{padding:0 13px 11px 48px;display:flex;align-items:center;min-height:0}
  .drawer .rfomo .tstrip{display:inline-flex;align-items:center}
  .drawer .rfomo .tstrip .tav{width:28px;height:28px;margin-left:-9px;border-width:2px}
  .drawer .rfomo .tstrip .tav:first-child{margin-left:0}
  .drawer .rfomo .tstrip .tav .tavfb{font-size:11px}
  .drawer .tpfol{flex:0 0 auto;text-align:right;margin-right:2px}
  .drawer .tpfol b{display:block;font-size:14px;font-weight:600;color:var(--text);
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .drawer .tpfol span{font-size:9px;font-weight:600;letter-spacing:.07em;
    text-transform:uppercase;color:var(--muted)}
  .drawer .srcchip{display:inline-flex;align-items:center;gap:5px;font-size:9.5px;
    font-weight:500;padding:3px 6px;border-radius:6px;background:var(--surface);
    border:1px solid var(--line);color:var(--muted)}
  .drawer .tpsrc{display:flex;gap:5px;flex-wrap:wrap;padding:9px 14px 0}

  /* The link strip is the panel's honesty: how sure we are that this profile
     belongs to the handle on screen. A coloured left edge rather than a filled
     card, because it is a qualifier on everything below it, not an alert. */
  .drawer .tvbadge{font-size:11px;line-height:1.45;font-weight:500;
    margin:11px 14px 0;padding:8px 11px;border-radius:6px;
    background:var(--surface);border-left:2px solid #e0b252;color:var(--muted)}
  .drawer .tvbadge b{color:#e0b252;font-weight:600}
  .drawer .tvbadge.ok{border-left-color:var(--up)}
  .drawer .tvbadge.ok b{color:var(--up)}
  .drawer .tvbadge.mid{border-left-color:#8fc0ff}
  .drawer .tvbadge.mid b{color:#8fc0ff}

  .drawer .tpsec{display:flex;flex-direction:column}
  .drawer .tpempty{font-size:11.5px;color:var(--faint);padding:26px 14px;text-align:center}

  /* Realised profit by window, and the track-record grid. Both are figure
     tiles, so they share one cell style and differ only in column count. */
  .drawer .pgrid{display:grid;grid-template-columns:repeat(3,1fr);
    border-bottom:1px solid var(--line)}
  .drawer .sgrid{display:grid;grid-template-columns:repeat(3,1fr);
    border-bottom:1px solid var(--line)}
  .drawer .pcell,.drawer .scell{padding:10px 12px;border-right:1px solid var(--line);
    display:flex;flex-direction:column;gap:3px;min-width:0}
  .drawer .pgrid .pcell:nth-child(3n),.drawer .sgrid .scell:nth-child(3n){border-right:0}
  .drawer .sgrid .scell:nth-child(n+4){border-top:1px solid #1a212a}
  .drawer .plbl{font-size:9.5px;font-weight:600;letter-spacing:.06em;
    text-transform:uppercase;color:var(--muted);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .drawer .pval,.drawer .sval{display:block;font-size:14px;font-weight:600;color:var(--text);
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums;
    letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .drawer .sval{font-size:13px}
  .drawer .pval.up{color:var(--up)} .drawer .pval.dn{color:var(--down)}

  /* Positions and trades: the token drawer's row, so a holding reads the same
     way on a person as on a token. */
  .drawer .hlist{display:flex;flex-direction:column}
  .drawer .hrow2{position:relative;display:flex;align-items:center;gap:9px;
    padding:9px 14px;border-bottom:1px solid #1a212a;text-decoration:none;
    overflow:hidden;transition:background .12s}
  .drawer .hrow2.link{cursor:pointer}
  .drawer .hrow2.link:hover{background:rgba(255,255,255,.05)}
  .drawer .hrow2.link:hover .hsym{color:#8fc0ff}
  .drawer .hrow2.link:hover .hgo{opacity:1;transform:translate(1px,-1px)}
  .drawer .hsym{position:relative;flex:1;min-width:0;font-size:12.5px;font-weight:600;
    color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    transition:color .12s}
  .drawer .hval2{position:relative;font-size:12.5px;font-weight:600;color:var(--text);
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .drawer .hchg{position:relative;width:58px;text-align:right;font-size:11.5px;font-weight:600;
    color:var(--muted);
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .drawer .hchg.up{color:var(--up)} .drawer .hchg.dn{color:var(--down)}
  .drawer .hgo{position:relative;flex:0 0 auto;font-size:10px;color:var(--faint);
    opacity:0;transition:opacity .12s,transform .12s}
  .drawer .twhen2{position:relative;width:30px;text-align:right;font-size:10px;
    font-weight:500;color:var(--faint);font-variant-numeric:tabular-nums}
  .drawer .tstatus{position:relative;font-size:9px;font-weight:600;letter-spacing:.05em;
    text-transform:uppercase;padding:2px 5px;border-radius:6px;
    background:var(--surface);border:1px solid var(--line);color:var(--muted)}
  .drawer .tstatus.open{color:var(--accent);border-color:rgba(198,242,74,.3)}
  .drawer .tstatus.up{color:var(--up);border-color:rgba(140,224,74,.32)}
  .drawer .tstatus.dn{color:var(--down);border-color:rgba(246,70,93,.3)}

  /* Round token thumbnail on each holding row. */
  .drawer .htokimg{position:relative;width:24px;height:24px;border-radius:50%;flex:0 0 auto;
    object-fit:cover;background:#141810;border:1px solid #232b36}
  .drawer .htokfb{position:relative;width:24px;height:24px;border-radius:50%;flex:0 0 auto;
    display:flex;align-items:center;justify-content:center;font:800 10.5px "ImpulseSans",sans-serif}

  /* Source switch (FOMO / pump.fun), shown when both platforms know the handle. */
  .drawer .tsrcseg{display:flex;gap:6px;margin:0 14px 12px;padding:4px;background:var(--surface);
    border:1px solid var(--line);border-radius:12px}
  .drawer .tsrcseg button{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;
    padding:8px 10px;border:0;border-radius:9px;background:transparent;cursor:pointer;
    font-size:12.5px;font-weight:700;color:var(--muted);transition:background .12s,color .12s}
  .drawer .tsrcseg button:hover{color:var(--text)}
  .drawer .tsrcseg button.on{background:var(--surface2);color:var(--text);box-shadow:0 1px 0 rgba(0,0,0,.3)}
  .drawer .tsrcseg button img{width:15px;height:15px;border-radius:5px;display:block}

  .drawer .tpbio{margin:2px 14px 12px;font-size:12.5px;line-height:1.5;color:var(--muted);white-space:pre-line}
  /* Biggest-wins strip: a horizontal, scrollable row of the trader's top trades. */
  .drawer .ttlabel{margin:2px 14px 7px;font-size:9.5px;font-weight:700;letter-spacing:.08em;
    text-transform:uppercase;color:var(--faint)}
  .drawer .ttrades{display:flex;gap:8px;overflow-x:auto;padding:0 14px 12px;
    scrollbar-width:thin;scrollbar-color:#2b3542 transparent;-webkit-overflow-scrolling:touch}
  .drawer .ttrades::-webkit-scrollbar{height:6px}
  .drawer .ttrades::-webkit-scrollbar-thumb{background:#2b3542;border-radius:6px}
  .drawer .ttcard{flex:0 0 auto;width:118px;padding:9px 10px;border-radius:12px;
    background:var(--surface);border:1px solid var(--line)}
  .drawer .ttcard .tthd{font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
    color:var(--faint);margin-bottom:7px}
  .drawer .ttcard .ttrow{display:flex;align-items:center;gap:6px;margin-bottom:6px}
  .drawer .ttcard .ttrow .htokimg,.drawer .ttcard .ttrow .htokfb{width:20px;height:20px}
  .drawer .ttcard .ttsym{font-size:12px;font-weight:700;color:var(--text);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .drawer .ttcard .ttfoot{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
  .drawer .ttcard .ttpnl{font:700 13px "ImpulseMono",ui-monospace,monospace;color:var(--up);
    font-variant-numeric:tabular-nums}
  .drawer .ttcard .ttpct{font:700 10px "ImpulseMono",ui-monospace,monospace;color:var(--up)}
  .drawer .tpext{display:flex;align-items:center;gap:9px;padding:11px 14px;text-decoration:none;
    font-size:13px;font-weight:700;color:var(--text)}
  .drawer .tpext:hover{background:rgba(255,255,255,.05)}
  .drawer .tpext img{width:16px;height:16px;border-radius:6px;display:block}
  .drawer .tpext .hgo2{margin-left:auto;color:var(--faint);font-size:12px}

  .drawer .liveh{display:flex;align-items:center;gap:6px;padding:8px 14px;
    border-bottom:1px solid var(--line);font-size:9.5px;font-weight:600;
    letter-spacing:.07em;text-transform:uppercase;color:var(--up)}
  .drawer .livedot{width:5px;height:5px;border-radius:99px;background:var(--up);
    box-shadow:0 0 7px var(--up);animation:pulse 1.6s infinite}
  .drawer .hlist + .liveh{border-top:1px solid var(--line)}

  /* The wallets, last, in mono — they are identifiers, not prose. */
  .drawer .wsec{padding:10px 14px 14px;gap:6px;border-top:1px solid var(--line)}
  .drawer .wrow{display:flex;align-items:center;gap:9px}
  .drawer .wtag{font-size:8.5px;font-weight:600;letter-spacing:.08em;
    color:var(--faint);width:28px;flex:0 0 auto}
  .drawer .waddr{font-family:"ImpulseMono",ui-monospace,monospace;font-size:11px;
    font-weight:500;color:var(--muted);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .secbar.ok{color:#bff45f;border-color:rgba(163,230,53,.35);background:rgba(163,230,53,.07)}

  .secbar.warn{color:#fbbf24;border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.07)}

  .secbar.bad{color:#ff7a7a;border-color:rgba(255,122,122,.4);background:rgba(255,122,122,.08)}

  .secbar.na{color:#dfeeda;background:#111d15;font-weight:600;cursor:pointer}

  .secgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0 14px 10px}

  .seccell{display:flex;justify-content:space-between;gap:6px;background:#111d15;border:1px solid #1e2f24;border-radius:14px;padding:7px 10px;font-size:11px}

  .seccell span{color:#c8dcc0}

  .seccell b.ok{color:#59e08a}.seccell b.warn{color:#fbbf24}.seccell b.bad{color:#ff7a7a}.seccell b.na{color:#dfeeda}

  .tabs2{display:flex;gap:5px;margin:0 14px 8px;background:#111d15;border:1px solid #1e2f24;border-radius:14px;padding:3px}

  .tabs2 button{flex:1;border:0;background:transparent;color:#dfeeda;font-weight:800;font-size:11.5px;padding:6px 0;border-radius:12px;cursor:pointer}

  .tabs2 button.on{background:#a3e635;color:#0b140c}

  .chips{display:flex;gap:5px;margin:0 14px 9px}

  .chip2{padding:4px 10px;border-radius:12px;background:#111d15;border:1px solid #1e2f24;color:#dfeeda;font-size:10.5px;font-weight:700;cursor:pointer}

  .chip2.on{background:rgba(163,230,53,.15);border-color:rgba(163,230,53,.5);color:#bff45f}

  .kolline{margin:0 14px 8px;padding:6px 10px;font-size:10.5px;color:#dfeeda;

    background:#111d15;border:1px solid #1e2f24;border-radius:13px;display:flex;gap:10px;align-items:center}

  .kolline b{color:#fbbf24}

  .hrow{display:flex;align-items:center;gap:9px;margin:0 14px 6px;background:#111d15;border:1px solid #1e2f24;

    border-radius:15px;padding:8px 10px;transition:border-color .12s,background .12s}

  .hrow:hover{border-color:#31503a;background:#16241a}

  .hrank{flex:0 0 auto;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;

    background:#0f1a12;border:1px solid #24382b;color:#c8dcc0;font-size:9.5px;font-weight:800}

  .hrow.top .hrank{background:rgba(163,230,53,.14);border-color:rgba(163,230,53,.4);color:#bff45f}

  .hmain{flex:1;min-width:0}

  .hline{display:flex;align-items:center;gap:5px;min-width:0}

  .haddr{color:#ffffff;font-size:11.5px;font-weight:700;text-decoration:none;

    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}

  .haddr:hover{color:#bff45f;text-decoration:underline}

  /* Concentration at a glance — a column of numbers hides who actually owns it. */

  .hbar{margin-top:5px;height:3px;border-radius:5px;background:#0f1a12;overflow:hidden}

  .hbar i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#a3e635,#bff45f)}

  .hrow.pool .hbar i{background:#31503a}

  .htag{flex:0 0 auto;padding:1px 5px;border-radius:9px;border:1px solid #2a3f30;font-size:8px;font-weight:800;

    text-transform:uppercase;letter-spacing:.04em;color:#dfeeda;background:#16241a}

  .htag.kol{color:#fbbf24;border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.1)}

  .htag.smart{color:#bff45f;border-color:rgba(163,230,53,.4);background:rgba(163,230,53,.1)}

  .htag.bad{color:#ff7a7a;border-color:rgba(255,122,122,.4);background:rgba(255,122,122,.1)}

  .hsub{color:#c8dcc0;font-size:9.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .hval{flex:0 0 auto;text-align:right;min-width:62px}

  .hpct{font-size:12.5px;font-weight:800;color:#ffffff;line-height:1.1}

  .hpnl{font-size:10px;font-weight:800;margin-top:2px}

  .hval .p{font-weight:800}

  .up2{color:#59e08a}.dn2{color:#ff7a7a}

  .gsrc{margin:2px 14px 10px;text-align:right;font-size:8.5px;color:#83a077}

  /* Shared by every paginated view in the drawer. Missed in the earlier
     passes and still wearing the old green, which is why Prev/Next looked
     borrowed from a different app than the rows above them. The custom
     properties inherit from .drawer, so this needs no extra scoping. */
  .pager{display:flex;align-items:center;justify-content:center;gap:12px;
    padding:10px 14px;border-bottom:1px solid var(--line)}
  .pager button{border:1px solid var(--line);background:var(--surface);color:var(--muted);
    font-family:"ImpulseSans",-apple-system,"Segoe UI",Arial,sans-serif;
    font-weight:600;font-size:11px;padding:5px 10px;border-radius:8px;cursor:pointer;
    transition:background .12s,color .12s,border-color .12s}
  .pager button:hover:not(:disabled){background:var(--surface2);color:var(--text);border-color:#3a4756}
  .pager span{font-size:10.5px;font-weight:500;color:var(--faint);
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .pager button:disabled{opacity:.35;cursor:default}

  .pager span{font-size:10.5px;font-weight:700;color:#c8dcc0}

  .bubblebox{margin:0 14px 4px;border-radius:16px;overflow:hidden;border:1px solid #1e2f24;background:#0d1712}

  .bubbleframe{display:block;width:100%;height:420px;border:0}

  .seg button.on-buy{background:#a3e635;color:#0b140c;box-shadow:0 3px 12px -3px rgba(163,230,53,.55)}

  .seg button.on-sell{background:#ff7a7a;color:#160b0b;box-shadow:0 3px 12px -3px rgba(255,122,122,.5)}

  .seg button:disabled{opacity:.35;cursor:default}

  .bar{padding:0 14px 14px}

  .amts{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:9px}

  .amts.pcts{grid-template-columns:repeat(3,1fr)}

  .amt{padding:9px 0;border-radius:14px;background:#111d15;color:#dfeeda;border:1px solid #1e2f24;font-weight:700;

    font-size:12.5px;cursor:pointer;transition:.12s}

  .amt:hover{border-color:#31503a;color:#ffffff}

  .amt.on{background:rgba(163,230,53,.15);border-color:rgba(163,230,53,.5);color:#bff45f}

  .cinrow{position:relative;margin-bottom:9px}

  .cin{width:100%;padding:9px 42px 9px 11px;border-radius:14px;background:#111d15;border:1px solid #1e2f24;

    color:#ffffff;font-weight:700;font-size:13px;font-family:inherit;outline:none;font-variant-numeric:tabular-nums}

  .cin:focus{border-color:rgba(163,230,53,.55)}

  .cin::placeholder{color:#83a077;font-weight:600}

  .cunit{position:absolute;right:11px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:800;color:#c8dcc0}

  .go{width:100%;padding:13px;border:0;border-radius:17px;font-weight:800;font-size:14.5px;cursor:pointer;transition:.15s}

  .go.buy{background:linear-gradient(180deg,#b6f24a,#96d92e);color:#0b140c;box-shadow:0 10px 24px -10px rgba(163,230,53,.65)}

  .go.sell{background:linear-gradient(180deg,#ff8a8a,#f76b6b);color:#160b0b;box-shadow:0 10px 24px -10px rgba(255,122,122,.55)}

  .go:hover{filter:brightness(1.06)}

  .go:active,.amt:active,.seg button:active{transform:scale(.98)}

  .go:disabled{opacity:.5;cursor:default;box-shadow:none;filter:none}

  .go.locked{background:#16241a;color:#ffffff;border:1px solid #2a3f30;box-shadow:none}

  .note{padding:12px 14px;font-size:12.5px;color:#dfeeda;text-align:center;line-height:1.45}

  .ok{color:#bff45f} .err{color:#ff7a7a} .u{text-decoration:underline}

  .foot{display:flex;justify-content:space-between;align-items:center;padding:9px 14px;border-top:1px solid #172319;

    font-weight:700;font-size:11px;color:#c8dcc0;background:rgba(0,0,0,.18)}

  .foot a{color:#bff45f;text-decoration:none;cursor:pointer}

  .foot a:hover{text-decoration:underline}

  .spin{display:inline-block;width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;

    border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:6px}

  @keyframes sp{to{transform:rotate(360deg)}}


/* ══════════════════════════════════════════════════════════════════════════
   TERMINAL SHELL — right-hand drawer
   ══════════════════════════════════════════════════════════════════════════
   The palette here is deliberately colourless. The old surface was a green
   gradient, which is the single thing that made this read as a crypto landing
   page rather than a trading screen: a tinted ground competes with the only
   two colours that carry meaning, up and down. Chrome is neutral; green and
   red are reserved for direction, and the brand lime appears once, on the
   primary action.                                                          */
  .drawer{
    --bg:#0b0e11; --surface:#151a21; --surface2:#1b222b; --line:#28303c;
    --text:#ffffff; --muted:#c2cad6; --faint:#9aa5b4;
    --up:#8ce04a; --down:#f6465d; --accent:#b6f03c;
    position:fixed;top:12px;right:12px;bottom:12px;width:440px;max-width:calc(100vw - 24px);
    z-index:2147483001;
    display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden;
    background:var(--bg);border:1px solid var(--line);border-radius:22px;color:var(--text);
    box-shadow:0 30px 70px -24px rgba(0,0,0,.92);
    animation:slidein .18s cubic-bezier(.22,1,.36,1) both;
    scrollbar-width:thin;scrollbar-color:#2b3542 transparent}
  .drawer::-webkit-scrollbar{width:8px}
  .drawer::-webkit-scrollbar-thumb{background:#2b3542;border-radius:8px}
  @keyframes slidein{from{transform:translateX(16px);opacity:0}to{transform:none;opacity:1}}
  @media (max-width:520px){ .drawer{inset:8px;width:auto;max-width:none;border-radius:18px} }
  /* Drag handle: a grabber bar pinned to the very top of the drawer. It's a CSS
     pseudo-element so it survives the innerHTML re-renders and works in every
     view. Grab it to fling the panel anywhere; double-click it to redock. */
  .drawer::before{content:"";position:sticky;top:0;z-index:6;display:block;
    height:20px;min-height:20px;flex:0 0 20px;cursor:grab;
    background-color:var(--surface);border-bottom:1px solid var(--line);
    background-image:linear-gradient(var(--faint),var(--faint));
    background-size:38px 4px;background-position:center;background-repeat:no-repeat}
  .drawer.dragging{user-select:none;cursor:grabbing}
  .drawer.dragging::before{cursor:grabbing}

  /* Numbers are the typography here. Tabular figures so a ticking price does
     not shift the layout under the cursor. */
  .drawer .sym,.drawer .pval,.drawer .stat b,.drawer .amt,.drawer .cin,
  .drawer .qval,.drawer .hold b,.drawer .tfrow button,.drawer .waddr{
    font-variant-numeric:tabular-nums;font-family:"ImpulseMono",ui-monospace,monospace}

  /* ── header ─────────────────────────────────────────────────────────── */
  .drawer .head{position:sticky;top:20px;z-index:3;display:flex;align-items:center;gap:11px;
    padding:14px 16px 12px;background:var(--bg);border-bottom:1px solid var(--line)}
  .drawer .logo{width:34px;height:34px;border-radius:10px;border:1px solid var(--line);background:var(--surface)}
  .drawer .sym{font-size:15px;font-weight:700;letter-spacing:.01em;color:var(--text)}
  .drawer .name{font-size:11.5px;color:var(--muted);font-weight:500}
  .drawer .badge,.drawer .chainchip{font-size:9px;font-weight:700;letter-spacing:.06em;
    text-transform:uppercase;padding:2px 5px;border-radius:6px;background:var(--surface2);
    color:var(--muted);border:1px solid var(--line)}
  .drawer .xclose{flex:0 0 auto;align-self:flex-start;margin-left:8px;width:24px;height:24px;
    display:grid;place-items:center;border:1px solid var(--line);border-radius:8px;
    background:var(--surface);color:var(--muted);font-size:11px;line-height:1;cursor:pointer;
    transition:.12s;padding:0}
  .drawer .xclose:hover{background:var(--surface2);color:var(--text);border-color:#3a4756}
  .drawer .chainmark{display:inline-flex;align-items:center;padding:2px;border-radius:50%;
    background:var(--surface2);border:1px solid var(--line)}
  .drawer .golbl{display:inline-flex;align-items:center;justify-content:center;gap:6px}
  .drawer .carow a,.drawer .carow span{font-size:10.5px;color:var(--muted)}
  .drawer .price{margin-left:auto;text-align:right}
  .drawer .pval{font-size:22px;font-weight:700;letter-spacing:-.02em;line-height:1.1}
  .drawer .chg{font-size:12px;font-weight:700;margin-top:2px}
  .drawer .chg.up{color:var(--up)} .drawer .chg.dn{color:var(--down)}
  .drawer .live{background:var(--up);box-shadow:0 0 6px var(--up)}

  /* ── stat strip ─────────────────────────────────────────────────────── */
  .drawer .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:0;
    border-bottom:1px solid var(--line);background:var(--bg)}
  .drawer .stat{display:flex;flex-direction:column;gap:3px;padding:10px 14px;
    border-right:1px solid var(--line);background:none;border-radius:0}
  .drawer .stat:last-child{border-right:0}
  .drawer .stat span{font-size:10px;font-weight:600;letter-spacing:.07em;
    text-transform:uppercase;color:var(--muted)}
  .drawer .stat b{font-size:14px;font-weight:600;color:var(--text)}

  /* ── popularity strip: how hot this token is across all users ───────── */
  .drawer .buzz{display:flex;align-items:center;gap:9px;padding:11px 16px;
    border-bottom:1px solid var(--line);background:var(--bg);font-size:13.5px;color:var(--muted)}
  .drawer .buzz img{width:18px;height:18px;border-radius:6px;flex:0 0 auto}
  .drawer .buzzn b{font-size:15px;color:var(--text);font-weight:700;
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .drawer .buzzd{color:var(--faint)}
  .drawer .buzztag{margin-left:auto;font-size:9.5px;font-weight:700;letter-spacing:.09em;
    text-transform:uppercase;color:var(--accent);opacity:.9}

  /* ── tabs: text with an underline, not floating icon buttons ────────── */
  .drawer .seg{display:flex;align-items:stretch;gap:0;margin:0;padding:0 8px;
    border-bottom:1px solid var(--line);background:var(--bg);overflow-x:auto;
    scrollbar-width:none}
  .drawer .seg::-webkit-scrollbar{display:none}
  .drawer .seg > button{flex:0 0 auto;background:none;border:0;border-bottom:2px solid transparent;
    border-radius:0;padding:11px 12px;color:var(--muted);font-size:12px;font-weight:600;
    cursor:pointer;transition:color .12s,border-color .12s;display:flex;align-items:center;gap:6px}
  .drawer .seg > button:hover{color:var(--text)}
  .drawer .seg > button.on-buy,.drawer .seg > button.on-sell{color:var(--text);
    border-bottom-color:var(--accent);background:none}
  .drawer .chartbtn{padding:11px 10px!important}
  .drawer .chartbtn img,.drawer .chartbtn svg{opacity:.7}
  .drawer .chartbtn:hover img,.drawer .chartbtn:hover svg{opacity:1}

  /* ── order entry ────────────────────────────────────────────────────── */
  .drawer .bar{padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:none}
  .drawer .amts{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
  .drawer .amt{padding:9px 0;border-radius:8px;background:var(--surface);
    border:1px solid var(--line);color:var(--muted);font-size:12px;font-weight:600;
    cursor:pointer;transition:.12s}
  .drawer .amt:hover{border-color:#33404f;color:var(--text)}
  .drawer .amt.on{background:var(--surface2);border-color:var(--accent);color:var(--text)}
  .drawer .cinrow{position:relative}
  .drawer .cin{width:100%;padding:11px 46px 11px 12px;border-radius:8px;background:var(--surface);
    border:1px solid var(--line);color:var(--text);font-size:14px;font-weight:600}
  .drawer .cin:focus{outline:0;border-color:#3a4756}
  .drawer .cunit{position:absolute;right:12px;top:50%;transform:translateY(-50%);
    font-size:11.5px;font-weight:700;color:var(--muted);letter-spacing:.04em}

  /* The two lines that turn a buy button into an order ticket: what you get,
     and what it costs you in impact. Both are already computed for the exit
     proof; not showing them was leaving the work on the floor. */
  .drawer .quote{display:flex;flex-direction:column;gap:6px;padding:10px 12px;
    background:var(--surface);border:1px solid var(--line);border-radius:8px}
  .drawer .qrow{display:flex;align-items:baseline;justify-content:space-between;font-size:11.5px}
  .drawer .qlbl{color:var(--muted);font-weight:600}
  .drawer .qval{color:var(--text);font-weight:600}
  .drawer .qval.warn{color:#e0b252}

  .drawer .go{width:100%;padding:13px;border:0;border-radius:8px;font-size:14px;
    font-weight:700;letter-spacing:.01em;cursor:pointer;transition:.12s}
  .drawer .go.buy{background:var(--accent);color:#0a1005}
  .drawer .go.buy:hover{filter:brightness(1.08)}
  .drawer .go.sell{background:var(--down);color:#1a0206}
  .drawer .go.sell:hover{filter:brightness(1.08)}
  .drawer .go.locked{background:var(--surface2);color:var(--text);border:1px solid var(--line)}
  .drawer .go:disabled{opacity:.4;cursor:not-allowed;filter:none}

  /* ── supporting rows ────────────────────────────────────────────────── */
  .drawer .hold{margin:0;padding:10px 16px;font-size:11.5px;color:var(--muted);
    border-bottom:1px solid var(--line);background:none}
  .drawer .hold b{color:var(--text);font-weight:600}
  .drawer .secbar{margin:0;padding:10px 16px;border:0;border-bottom:1px solid var(--line);
    border-radius:0;font-size:11.5px;font-weight:600;background:none}
  .drawer .socials{margin:0;padding:9px 16px;border-bottom:1px solid var(--line)}
  .drawer .socials a{font-size:10.5px;color:var(--muted);border:1px solid var(--line);
    background:var(--surface);border-radius:6px}
  .drawer .note{margin:0 16px 12px;border-radius:8px;font-size:11.5px}
  .drawer .ambig{margin:0;padding:9px 16px;border:0;border-bottom:1px solid var(--line);
    border-radius:0;font-size:10.5px}

  /* ── footer, pinned ─────────────────────────────────────────────────── */
  .drawer .foot{position:sticky;bottom:0;margin-top:auto;padding:11px 16px;
    background:var(--bg);border-top:1px solid var(--line);border-radius:0;
    font-size:11px;color:var(--muted)}
  .drawer .foot a{color:var(--accent);font-weight:600}

  /* ── Impulse Thesis: the community feed, written by holders ──────────── */
  /* Holder gate */
  .drawer .igate{display:flex;align-items:center;gap:12px;margin:14px 16px;padding:14px 16px;
    border:1px solid var(--line);border-radius:16px;background:var(--surface)}
  .drawer .igateico{flex:0 0 auto;color:var(--muted);display:grid;place-items:center}
  .drawer .igateico svg{width:20px;height:20px}
  .drawer .igatetxt{display:flex;flex-direction:column;gap:3px}
  .drawer .igatetxt b{font-size:14px;font-weight:600;color:var(--text)}
  .drawer .igatetxt span{font-size:12.5px;line-height:1.45;color:var(--muted)}

  /* Setup + compose cards */
  .drawer .isetup,.drawer .icompose{margin:14px 16px;padding:15px;border:1px solid var(--line);
    border-radius:18px;background:var(--surface);display:flex;flex-direction:column;gap:13px}
  .drawer .ihead{display:flex;flex-direction:column;gap:3px}
  .drawer .ihtitle{font-size:15px;font-weight:700;color:var(--text);letter-spacing:-.01em}
  .drawer .ihsub{font-size:12px;color:var(--muted)}
  .drawer .idprow{display:flex;align-items:center;gap:13px}
  .drawer .idpprev{width:54px;height:54px;border-radius:50%;overflow:hidden;flex:0 0 auto;border:1px solid var(--line)}
  .drawer .idpprev img{width:100%;height:100%;object-fit:cover;display:block}
  .drawer .idpprev .tav{width:100%;height:100%}
  .drawer .idpprev .tav svg,.drawer .idpprev .tav img{width:22px;height:22px}
  .drawer .idpcol{display:flex;flex-direction:column;gap:5px}
  .drawer .idpbtn{align-self:flex-start;font-size:12.5px;font-weight:600;color:var(--text);
    background:var(--surface2);border:1px solid var(--line);border-radius:11px;padding:9px 15px;cursor:pointer;transition:.12s}
  .drawer .idpbtn:hover{border-color:#3a4756}
  .drawer .idphint{font-size:11px;color:var(--faint)}
  .drawer .iuname{width:100%;padding:12px 14px;border-radius:12px;background:var(--bg);
    border:1px solid var(--line);color:var(--text);font-size:14.5px;font-family:inherit;outline:none;transition:border-color .12s}
  .drawer .iuname::placeholder{color:var(--faint)}
  .drawer .iuname:focus{border-color:var(--accent)}
  .drawer .go.ifull{width:100%;font-size:14px}

  /* Compose identity row */
  .drawer .iwho{display:flex;align-items:center;gap:11px}
  .drawer .iwhoav .tav{width:36px;height:36px}
  .drawer .iwhoname{font-size:14.5px;font-weight:600;color:var(--text)}
  .drawer .ihold{margin-left:auto;font-size:12px;font-weight:600;color:var(--up);
    font-family:"ImpulseMono",ui-monospace,monospace;background:rgba(140,224,74,.1);
    border:1px solid rgba(140,224,74,.25);border-radius:999px;padding:4px 11px}
  .drawer .idraft{width:100%;min-height:92px;resize:vertical;padding:13px 14px;border-radius:12px;
    background:var(--bg);border:1px solid var(--line);color:var(--text);font-size:14.5px;
    font-family:inherit;line-height:1.55;outline:none;transition:border-color .12s}
  .drawer .idraft::placeholder{color:var(--faint)}
  .drawer .idraft:focus{border-color:var(--accent)}
  .drawer .icfoot{display:flex;align-items:center;gap:12px}
  .drawer .ihint{flex:1;font-size:11.5px;color:var(--faint)}
  .drawer .go.ipost{width:auto;padding:11px 22px;flex:0 0 auto;font-size:13.5px}
  .drawer .imsg{font-size:12px}
  .drawer .imsg.err{color:var(--down)}

  /* Section label + feed */
  .drawer .ilabel{display:flex;align-items:center;gap:9px;padding:8px 16px 12px;
    font-size:10.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
  .drawer .ilabel span{font-family:"ImpulseMono",ui-monospace,monospace;color:var(--faint);
    background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:2px 9px;letter-spacing:0}
  .drawer .iempty{padding:38px 22px;text-align:center;font-size:13.5px;line-height:1.65;color:var(--muted)}
  .drawer .ilist{display:flex;flex-direction:column}
  .drawer .irow2{display:flex;gap:12px;padding:15px 16px;border-top:1px solid var(--line);transition:background .12s}
  .drawer .irow2:hover{background:rgba(255,255,255,.02)}
  .drawer .irow2.mine{background:rgba(182,240,60,.05)}
  .drawer .iav{flex:0 0 auto;cursor:pointer}
  .drawer .iav .tav{width:42px;height:42px;transition:transform .12s}
  .drawer .iav:hover .tav{transform:scale(1.06)}
  .drawer .ibody{min-width:0;flex:1}
  .drawer .itop{display:flex;align-items:center;gap:8px}
  .drawer .iname{font-size:14.5px;font-weight:600;color:var(--text);cursor:pointer;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color .12s}
  .drawer .iname:hover{color:var(--accent);text-decoration:underline}
  .drawer .imine{font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
    color:var(--accent);border:1px solid rgba(182,240,60,.35);border-radius:6px;padding:1px 5px;flex:0 0 auto}
  .drawer .iheld{font-size:11.5px;font-weight:600;color:var(--up);
    font-family:"ImpulseMono",ui-monospace,monospace;flex:0 0 auto}
  .drawer .iwhen{margin-left:auto;color:var(--faint);font-size:11px;flex:0 0 auto}
  .drawer .itext{margin-top:6px;font-size:14.5px;line-height:1.6;color:var(--text);
    white-space:pre-wrap;word-break:break-word}

  /* ── view tabs: present in every view, not only on the trade screen ─── */
  .drawer .vtabs{display:flex;gap:0;padding:0 6px;background:var(--bg);
    border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
  .drawer .vtabs::-webkit-scrollbar{display:none}
  .drawer .vtab{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:10px 11px;
    background:none;border:0;border-bottom:2px solid transparent;border-radius:0;
    color:var(--muted);font-size:12px;font-weight:600;cursor:pointer;
    transition:color .12s,border-color .12s;white-space:nowrap}
  .drawer .vtab img,.drawer .vtab svg{width:14px;height:14px;opacity:.85;flex:0 0 auto}
  .drawer .vtab:hover{color:var(--text)}
  .drawer .vtab:hover img,.drawer .vtab:hover svg{opacity:.9}
  .drawer .vtab.on{color:var(--text);border-bottom-color:var(--accent)}
  .drawer .vtab.on img,.drawer .vtab.on svg{opacity:1}

  /* ── direction: the loudest control on the panel ─────────────────────── */
  .drawer .dirseg{display:grid;grid-template-columns:1fr 1fr;gap:6px;
    padding:14px 16px 0;background:none;border:0;margin:0}
  .drawer .dirseg button{padding:11px 0;border-radius:8px;border:1px solid var(--line);
    background:var(--surface);color:var(--muted);font-size:13.5px;font-weight:700;
    cursor:pointer;transition:.12s}
  .drawer .dirseg button:hover:not(:disabled){color:var(--text);border-color:#33404f}
  .drawer .dirseg button.on-buy{background:var(--accent);border-color:var(--accent);color:#0a1005}
  .drawer .dirseg button.on-sell{background:var(--down);border-color:var(--down);color:#1a0206}
  .drawer .dirseg button:disabled{opacity:.35;cursor:not-allowed}

  /* A refusal is prose, so it gets a block rather than a value column. */
  .drawer .qblock{margin-top:2px;padding:9px 10px;border-radius:8px;
    background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.25);
    font-size:11px;line-height:1.5;color:#f0a0aa;text-align:left}
  .drawer .qblock b{display:block;margin-bottom:3px;color:var(--down);
    font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}

  /* ── holders ─────────────────────────────────────────────────────────── */
  .drawer .hctl{display:flex;gap:8px;flex-wrap:wrap;padding:12px 14px;
    border-bottom:1px solid var(--line);background:var(--bg)}
  .drawer .hctl .tfseg button{min-width:0;padding:6px 11px}

  /* Concentration is what this tab is for, and it used to be the one number
     the view never computed — you had to add the column up yourself. */
  .drawer .hsum{display:grid;grid-template-columns:repeat(3,1fr);
    border-bottom:1px solid var(--line);background:var(--bg)}
  .drawer .hsumcell{padding:11px 14px;border-right:1px solid var(--line);
    display:flex;flex-direction:column;gap:3px}
  .drawer .hsumcell:last-child{border-right:0}
  .drawer .hsumcell span{font-size:10px;font-weight:600;letter-spacing:.07em;
    text-transform:uppercase;color:var(--muted)}
  .drawer .hsumcell b{font-size:15px;font-weight:600;color:var(--text);
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .drawer .hsumcell b.hi{color:var(--down)}
  .drawer .hsumcell b.mid{color:#e0b252}
  .drawer .hsumcell b.lo{color:var(--up)}

  .drawer .hhead{display:flex;align-items:center;gap:9px;padding:8px 14px;
    border-bottom:1px solid var(--line);font-size:9.5px;font-weight:600;
    letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
  .drawer .hhead span:nth-child(1){width:20px}
  .drawer .hhead span:nth-child(2){flex:1}
  .drawer .hhead span.r{width:62px;text-align:right}

  .drawer .hrow{position:relative;display:flex;align-items:center;gap:9px;
    padding:9px 14px;border-bottom:1px solid #1a212a;text-decoration:none;
    overflow:hidden;transition:background .12s}
  .drawer .hrow:hover{background:rgba(255,255,255,.05)}
  .drawer .hrow:hover .hname{color:#8fc0ff;text-decoration:underline;
    text-underline-offset:2px;text-decoration-color:rgba(143,192,255,.5)}
  .drawer .hrow::after{content:"97";position:absolute;right:6px;top:50%;
    transform:translateY(-50%);font-size:9px;color:var(--faint);opacity:0;transition:opacity .12s}
  .drawer .hrow:hover::after{opacity:1}
  .drawer .hrow.pool{opacity:.62}
  /* Supply share as the row itself. A column of percentages hides
     concentration; width does not. Scaled to the largest holder on screen. */
  .drawer .hfill{position:absolute;left:0;top:0;bottom:0;
    background:linear-gradient(90deg,rgba(182,240,60,.18),rgba(182,240,60,.04));
    pointer-events:none}
  .drawer .hrank{position:relative;width:20px;flex:0 0 auto;font-size:10.5px;
    font-weight:600;color:var(--muted);
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .drawer .hwho{position:relative;flex:1;min-width:0;display:flex;align-items:center;gap:6px}
  .drawer .hname{font-size:12.5px;font-weight:600;color:var(--text);min-width:64px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color .12s}
  .drawer .hsold{position:relative;flex:0 0 auto;font-size:10px;color:var(--muted);
    white-space:nowrap}
  .drawer .hpct,.drawer .hpnl{position:relative;width:62px;flex:0 0 auto;text-align:right;
    font-size:12px;font-weight:600;
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .drawer .hpct{color:var(--text)}
  .drawer .hpnl.up{color:var(--up)} .drawer .hpnl.dn{color:var(--down)}
  .drawer .hpnl.mut{color:var(--faint)}
  .drawer .htag{position:relative;flex:0 0 auto;font-size:8.5px;font-weight:700;
    letter-spacing:.06em;padding:2px 5px;border-radius:6px;border:1px solid var(--line);
    background:var(--surface);color:var(--muted);text-transform:uppercase}
  .drawer .htag.kol{color:#e0b252;border-color:rgba(224,178,82,.35)}
  .drawer .htag.smart{color:var(--up);border-color:rgba(14,203,129,.35)}

  /* ── trader theses ───────────────────────────────────────────────────
     A thesis is worth reading in proportion to the money standing behind it,
     so the position leads the card and sets the row's fill width — the same
     device the holders table uses, so both tabs are read the same way. The old
     cards were a green-tinted social feed with the sentence on top and the
     position tucked underneath in small text; that ordering makes talk look
     like the product. */
  .drawer .tclabel{display:flex;align-items:center;gap:7px;padding:8px 14px;
    border-bottom:1px solid var(--line);font-size:9.5px;font-weight:600;
    letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
  .drawer .tclabel img{opacity:.9;border-radius:6px}
  .drawer .tclabel .r{margin-left:auto;letter-spacing:.04em;color:var(--faint);font-weight:500}
  .drawer .tclabel:has(.tfseg){padding:9px 14px}

  .drawer .tcard{position:relative;padding:11px 14px 10px;
    border-bottom:1px solid #1a212a;overflow:hidden;transition:background .12s}
  .drawer .tcard:hover{background:rgba(255,255,255,.03)}
  .drawer .tcard .hfill{background:linear-gradient(90deg,rgba(182,240,60,.15),rgba(182,240,60,.02))}

  .drawer .tctop{position:relative;display:flex;align-items:center;gap:8px}
  .drawer .tcrank{width:18px;flex:0 0 auto;font-size:10.5px;font-weight:600;color:var(--faint);
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .drawer .tctop .tav{width:22px;height:22px;border-radius:50%;flex:0 0 auto;
    display:grid;place-items:center;overflow:hidden;border:1px solid var(--line)}
  .drawer .tcname{font-size:12.5px;font-weight:600;color:var(--text);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
  .drawer .tcfollow{flex:0 0 auto;margin-left:8px;padding:3px 10px;border-radius:999px;
    background:var(--accent);color:var(--accent-ink,#0a1005);border:0;cursor:pointer;
    font-family:inherit;font-size:10.5px;font-weight:700;letter-spacing:.01em;transition:filter .12s,transform .12s}
  .drawer .tcfollow:hover{filter:brightness(1.07)}
  .drawer .tcfollow:active{transform:scale(.96)}
  .drawer .tcwhen{margin-left:auto;flex:0 0 auto;font-size:10px;color:var(--faint);
    white-space:nowrap;font-variant-numeric:tabular-nums}

  /* The figures line, at reading size. */
  .drawer .tcnum{position:relative;display:flex;align-items:baseline;gap:8px;
    margin:7px 0 0;padding-left:26px;flex-wrap:wrap}
  .drawer .tckind{font-size:9.5px;font-weight:600;letter-spacing:.07em;
    text-transform:uppercase;color:var(--muted)}
  .drawer .tcpos{font-size:16px;font-weight:600;color:var(--text);letter-spacing:-.01em;
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .drawer .tcpos.mut{color:var(--faint);font-size:12px;font-weight:500;letter-spacing:0}
  .drawer .tcpct{font-size:12px;font-weight:600;padding:1px 5px;border-radius:6px;
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .drawer .tcpct.up{color:var(--up);background:rgba(14,203,129,.1)}
  .drawer .tcpct.dn{color:var(--down);background:rgba(246,70,93,.1)}
  .drawer .tctook{font-size:10.5px;color:var(--muted);white-space:nowrap;
    font-family:"ImpulseMono",ui-monospace,monospace}

  .drawer .tctext{position:relative;margin:7px 0 0;padding-left:26px;
    font-size:12.5px;line-height:1.5;color:#e8edf4;white-space:pre-wrap;
    overflow-wrap:anywhere}
  .drawer .tctext a{color:#8fc0ff;text-decoration:none}
  .drawer .tctext a:hover{text-decoration:underline;text-underline-offset:2px}
  .drawer .tcfoot{position:relative;margin:8px 0 0;padding-left:26px;
    display:flex;align-items:center;gap:13px}
  .drawer .tcfoot .tstat{display:inline-flex;align-items:center;gap:4px;
    font-size:10.5px;font-weight:500;color:var(--faint);font-variant-numeric:tabular-nums}
  .drawer .tcfoot .tstat svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:2}

  /* Callouts share the card, but the figure that leads it is an outcome, not a
     size — so the multiple carries the colour and the fill runs green or red
     instead of the blue used for holdings. A call is judged on where it went;
     a thesis is weighted by what is behind it. */
  .drawer .tcpos.up{color:var(--up)} .drawer .tcpos.dn{color:var(--down)}
  .drawer .tcard.up .hfill{background:linear-gradient(90deg,rgba(14,203,129,.15),rgba(14,203,129,.02))}
  .drawer .tcard.dn .hfill{background:linear-gradient(90deg,rgba(246,70,93,.14),rgba(246,70,93,.02))}
  .drawer .tcat{font-size:11.5px;font-weight:500;color:var(--muted);white-space:nowrap;
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
  .drawer .tcver{flex:0 0 auto;width:13px;height:13px;border-radius:50%;display:grid;
    place-items:center;background:rgba(14,203,129,.14);color:var(--up);
    font-size:8px;font-weight:700;line-height:1}
  .drawer .tcx{flex:0 0 auto;font-size:10.5px;font-weight:500;color:#8fc0ff;
    text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px}
  .drawer .tcx:hover{text-decoration:underline;text-underline-offset:2px}

  /* ── the last of the old palette ─────────────────────────────────────
     These render inside the drawer but were never scoped to it, so they kept
     the green card look through every redesign: the security grid and the
     source lines on the main trade tab, the stock banner, the bubble map, and
     the whole Impulse Thesis panel. Same tokens as everything else now. */

  .drawer .secgrid{display:grid;grid-template-columns:1fr 1fr;gap:0;margin:0;
    border-bottom:1px solid var(--line)}
  .drawer .seccell{display:flex;justify-content:space-between;align-items:center;gap:8px;
    background:none;border:0;border-right:1px solid var(--line);border-top:1px solid #1a212a;
    border-radius:0;padding:9px 14px;font-size:11.5px;color:var(--muted)}
  .drawer .secgrid .seccell:nth-child(2n){border-right:0}
  .drawer .secgrid .seccell:nth-child(-n+2){border-top:0}
  .drawer .seccell b{color:var(--text);font-weight:600;
    font-family:"ImpulseMono",ui-monospace,monospace;font-variant-numeric:tabular-nums}

  .drawer .gsrc{margin:0;padding:8px 14px 10px;text-align:right;font-size:10px;
    color:var(--faint);letter-spacing:.02em}

  .drawer .stockline{margin:0;padding:9px 14px;background:var(--surface);
    border:0;border-bottom:1px solid var(--line);border-radius:0;
    font-size:11.5px;color:var(--muted)}
  .drawer .stockline b{color:var(--text);font-weight:600}

  .drawer .bubblebox{margin:0;border-radius:0;border:0;
    border-bottom:1px solid var(--line);background:var(--bg)}
  .drawer .bubbleframe{height:460px}

  .drawer .ambigi{background:#e0b252;color:#12160b;font-weight:700}

  /* Coming-soon panel. Centred and quiet — it is a promise, not a feature, and
     should not compete with the tabs that actually do something. */
  .drawer .soon{padding:34px 22px 30px;gap:0}
  .drawer .soonlogo{width:46px;height:46px;border-radius:12px;background:var(--surface);
    border:1px solid var(--line);margin-bottom:14px}
  .drawer .soonttl{font-size:16px;font-weight:600;color:var(--text);letter-spacing:-.01em}
  .drawer .soonpill{margin-top:8px;font-size:9px;font-weight:600;letter-spacing:.08em;
    padding:3px 8px;border-radius:6px;background:var(--surface2);
    border:1px solid var(--line);color:var(--muted)}
  .drawer .soontxt{margin:14px 0 0;font-size:12px;line-height:1.6;color:var(--muted);max-width:36ch}
  .drawer .soonrow{margin-top:16px;gap:5px}
  .drawer .soonchip{font-size:9.5px;font-weight:500;padding:3px 7px;border-radius:6px;
    background:var(--surface);border:1px solid var(--line);color:var(--muted)}

  /* ── the chart, inline in the order ticket ───────────────────────────── */
  .drawer .chartbox{margin:0;padding:10px 8px 4px;background:var(--bg);
    border-bottom:1px solid var(--line);border-radius:0;border-left:0;border-right:0;border-top:0}
  .drawer .tfrow{display:flex;margin:0;padding:2px 14px 12px;
    border-bottom:1px solid var(--line);background:var(--bg)}
  .drawer .tfseg{display:inline-flex;gap:2px;padding:2px;border-radius:10px;
    background:#0f141a;border:1px solid var(--line)}
  /* Scoped to the track, not to one row that happens to contain one. The
     holders control uses the same track inside .hctl, and scoping these to
     .tfrow meant those buttons matched no rule at all and rendered as plain
     browser buttons — white boxes in a black panel. */
  .drawer .tfseg button{min-width:42px;padding:6px 10px;border:0;border-radius:8px;
    background:none;color:var(--muted);cursor:pointer;transition:background .12s,color .12s;
    font:600 11px/1 "ImpulseMono",ui-monospace,monospace;letter-spacing:.02em;
    font-variant-numeric:tabular-nums;white-space:nowrap;text-transform:none}
  .drawer .tfseg button:hover{color:var(--text);background:rgba(255,255,255,.05)}
  .drawer .tfseg button.on{background:var(--surface2);color:var(--text);
    box-shadow:0 1px 2px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.05)}
  .drawer .chartwait{display:flex;align-items:center;justify-content:center;height:168px;
    color:var(--faint);font-size:11px;gap:8px}

`;

const DRAWER_ATTR = "data-strix-drawer";
let drawerRoot: HTMLElement | null = null;
let drawerCa: string | null = null;

function holderRowHtml(r: any, rank: number, maxPct = 0, chain = "robinhood"): string {
  const lbl = CHAIN_LABEL[chain] || CHAIN_LABEL.robinhood;
  const addr = String(gPick(r, ["wallet_address", "address", "account_address"]) || "");
  const pool = gIsPool(r);
  const tags = pool ? [] : gTags(r);
  const name = pool
    ? `${String(r.exchange || "DEX").replace(/_/g, " ")} pool`
    : gPick(r, ["name", "twitter_username", "twitter_name"]);

  const supply = Number(gPick(r, ["amount_percentage"]));
  const pct = isFinite(supply) && supply > 0 ? (supply <= 1 ? supply * 100 : supply) : 0;
  const pctStr = pct > 0 ? `${pct.toFixed(2)}%` : "—";

  const sold = Number(gPick(r, ["sell_amount_percentage"]));
  const soldPct = isFinite(sold) && sold > 0 ? Math.min(100, sold <= 1 ? sold * 100 : sold) : 0;

  const profit = pool ? NaN : Number(gPick(r, ["profit", "realized_profit"]));
  const pnl = isFinite(profit) && profit !== 0
    ? `<span class="hpnl ${profit >= 0 ? "up" : "dn"}">${profit >= 0 ? "+" : "-"}${fmtCompact(Math.abs(profit))}</span>`
    : `<span class="hpnl mut">—</span>`;

  const tagHtml = (pool ? `<span class="htag mut">POOL</span>` : "") +
    tags.filter((t) => G_TAG[t]).slice(0, 2)
      .map((t) => `<span class="htag ${G_TAG[t].cls}">${G_TAG[t].label}</span>`).join("");

  const label = name ? esc(String(name)) : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  const width = maxPct > 0 ? Math.max(1.5, Math.min(100, (pct / maxPct) * 100)) : 0;

  return `<a class="hrow${pool ? " pool" : ""}" href="${lbl.explorer}/${lbl.acct}/${esc(addr)}"
      target="_blank" rel="noreferrer" title="${esc(addr)}">
    <span class="hfill" style="width:${width.toFixed(1)}%"></span>
    <span class="hrank">${rank}</span>
    <span class="hwho"><span class="hname">${label}</span>${tagHtml}</span>
    <span class="hsold">${soldPct > 0 ? `sold ${soldPct.toFixed(0)}%` : ""}</span>
    <span class="hpct">${pctStr}</span>
    ${pnl}
  </a>`;
}

function chartSvg(cs: Candle[], tf: string, height = 250): string {
  const W = 424, H = height, L = 8, R = 66, T = 12, B = 18;
  const VOL = Math.round((H - T - B) * 0.2);
  const GAP = 6;
  const pw = W - L - R;
  const ph = H - T - B - VOL - GAP;

  const closes = cs.map((c) => c[4]).filter((v) => isFinite(v) && v > 0);
  if (closes.length < 2) return "";
  let lo = Math.min(...closes), hi = Math.max(...closes);
  let vmax = 0;
  for (const c of cs) if ((c[5] || 0) > vmax) vmax = c[5] || 0;

  const pad = (hi - lo) * 0.12 || hi * 0.06;
  hi += pad;
  lo = Math.max(0, lo - pad);          // a price floor of zero, always
  if (hi <= lo) hi = lo + (lo || 1) * 0.01;

  const y = (v: number) => T + ph - ((v - lo) / (hi - lo)) * ph;
  const n = cs.length;
  const step = pw / Math.max(1, n - 1);
  const x = (i: number) => L + i * step;

  const LINE = "#b6f03c", AXIS = "#b3bdcc", GRID = "#2a3442";
  const MONO = "ImpulseMono,ui-monospace,SFMono-Regular,Menlo,monospace";
  let out = `<defs><linearGradient id="ig" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${LINE}" stop-opacity="0.26"/>
    <stop offset="1" stop-color="${LINE}" stop-opacity="0"/></linearGradient></defs>`;

  // grid + price axis
  for (let i = 0; i <= 3; i++) {
    const pr = lo + ((hi - lo) * i) / 3;
    const yy = y(pr).toFixed(1);
    out += `<line x1="${L}" y1="${yy}" x2="${L + pw}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`;
    out += `<text x="${L + pw + 7}" y="${Number(yy) + 3.2}" fill="${AXIS}" font-size="9.5" font-family="${MONO}">${fmtAxis(pr)}</text>`;
  }
  out += `<line x1="${L}" y1="${H - B}" x2="${L + pw}" y2="${H - B}" stroke="${GRID}" stroke-width="1"/>`;

  // volume, one flat colour so it stays background
  if (vmax > 0) {
    const bw = Math.max(1, Math.min(6, (pw / n) * 0.55));
    for (let i = 0; i < n; i++) {
      const v = cs[i][5] || 0;
      if (!v) continue;
      const hgt = (v / vmax) * VOL;
      out += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(H - B - hgt).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.6, hgt).toFixed(1)}" fill="${LINE}" opacity="0.2"/>`;
    }
  }

  // the line, and the area under it
  const pts = cs.map((c, i) => `${x(i).toFixed(1)},${y(c[4]).toFixed(1)}`);
  out += `<path d="M${L},${(T + ph).toFixed(1)} L${pts.join(" L")} L${(L + pw).toFixed(1)},${(T + ph).toFixed(1)} Z" fill="url(#ig)"/>`;
  out += `<polyline points="${pts.join(" ")}" fill="none" stroke="${LINE}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/>`;

  // time axis
  const fmtT = (ts: number) => {
    const d = new Date(ts * 1000);
    return tf === "15m" || tf === "1H"
      ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  for (const fr of [0.06, 0.5, 0.94]) {
    const idx = Math.min(n - 1, Math.floor(fr * (n - 1)));
    out += `<text x="${x(idx).toFixed(1)}" y="${H - 5}" fill="${AXIS}" font-size="9.5" text-anchor="middle" font-family="${MONO}">${fmtT(cs[idx][0])}</text>`;
  }

  // where it ends: a dot on the line, a chip on the axis
  const last = closes[closes.length - 1];
  const yl = y(last);
  out += `<line x1="${L}" y1="${yl.toFixed(1)}" x2="${L + pw}" y2="${yl.toFixed(1)}" stroke="${LINE}" stroke-dasharray="2 3" opacity="0.45"/>`;
  out += `<circle cx="${(L + pw).toFixed(1)}" cy="${yl.toFixed(1)}" r="3" fill="${LINE}"/>`;
  const label = fmtAxis(last);
  const chipW = Math.max(38, label.length * 5.8 + 10);
  out += `<rect x="${L + pw + 3}" y="${(yl - 8).toFixed(1)}" width="${chipW.toFixed(0)}" height="16" rx="3" fill="${LINE}"/>`;
  out += `<text x="${(L + pw + 3 + chipW / 2).toFixed(1)}" y="${(yl + 3.6).toFixed(1)}" fill="#04101f" font-size="9.5" font-weight="700" text-anchor="middle" font-family="${MONO}">${label}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-hidden="true">${out}</svg>`;
}

/** Remembered drawer geometry for this page session, so the panel stays where
 *  the user flung it when they open a different token. Cleared on redock. */
let dragPos: { left: number; top: number; w: number; h: number } | null = null;

/**
 * Make a drawer draggable by the grip bar at its top.
 *
 * The listeners live on the .drawer element itself, not its children, so they
 * survive the innerHTML re-renders each view does. The top 20px is the grip
 * (the ::before bar); a pointerdown there frees the panel from its docked edge
 * and moves it with the cursor, clamped to keep a corner on screen. Double-click
 * the grip to snap back to the right edge.
 */
function makeDrawerDraggable(drawer: HTMLElement) {
  const BAR = 20;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  let drag: { dx: number; dy: number; w: number; h: number } | null = null;

  const onGrip = (e: MouseEvent) => e.clientY - drawer.getBoundingClientRect().top <= BAR;

  // Re-apply a remembered position, clamped to the current viewport.
  if (dragPos) {
    const w = Math.min(dragPos.w, window.innerWidth - 16);
    const h = Math.min(dragPos.h, window.innerHeight - 16);
    drawer.style.right = "auto"; drawer.style.bottom = "auto";
    drawer.style.width = `${w}px`; drawer.style.height = `${h}px`;
    drawer.style.left = `${clamp(dragPos.left, 64 - w, window.innerWidth - 64)}px`;
    drawer.style.top = `${clamp(dragPos.top, 8, window.innerHeight - 40)}px`;
  }

  drawer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !onGrip(e)) return;
    const r = drawer.getBoundingClientRect();
    // Freeze current geometry, then switch from edge-docking to free x/y.
    drawer.style.top = `${r.top}px`; drawer.style.left = `${r.left}px`;
    drawer.style.right = "auto"; drawer.style.bottom = "auto";
    drawer.style.width = `${r.width}px`; drawer.style.height = `${r.height}px`;
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
    drawer.classList.add("dragging");
    try { drawer.setPointerCapture(e.pointerId); } catch { /* older engines */ }
    e.preventDefault();
  });

  drawer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const left = clamp(e.clientX - drag.dx, 64 - drag.w, window.innerWidth - 64);
    const top = clamp(e.clientY - drag.dy, 8, window.innerHeight - 40);
    drawer.style.left = `${left}px`; drawer.style.top = `${top}px`;
  });

  const end = (e: PointerEvent) => {
    if (!drag) return;
    const r = drawer.getBoundingClientRect();
    dragPos = { left: r.left, top: r.top, w: r.width, h: r.height };
    drag = null;
    drawer.classList.remove("dragging");
    try { drawer.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
  };
  drawer.addEventListener("pointerup", end);
  drawer.addEventListener("pointercancel", end);

  drawer.addEventListener("dblclick", (e) => {
    if (!onGrip(e)) return;
    for (const p of ["top", "left", "right", "bottom", "width", "height"]) drawer.style.removeProperty(p);
    dragPos = null;
  });
}

/* ── popularity ─────────────────────────────────────────────────────────────
   How often a token is seen (its pill appears) and opened (its panel opens),
   counted across all users so the overlay can show how hot it is. Deduped per
   page session per token per kind, so one browser adds at most +1 of each and
   the number reads like reach, not one person refreshing. */
const trackedSeen = new Set<string>();
const trackedOpen = new Set<string>();
function trackImpulse(ca: string, kind: "seen" | "open") {
  const k = (ca || "").toLowerCase();
  if (!k) return;
  const set = kind === "open" ? trackedOpen : trackedSeen;
  if (set.has(k)) return;
  set.add(k);
  try {
    chrome.runtime.sendMessage({ type: "STRIX_ITRACK", ca, kind }, () => void chrome.runtime.lastError);
  } catch { /* worker asleep / context gone — a popularity tick is not worth a retry */ }
}

type DrawerOpts = { view?: string; holdTab?: string };
function openDrawer(ca: string, viaCashtag: boolean, chainHint: string | null, opts?: DrawerOpts) {
  trackImpulse(ca, "open");
  // Clicking the same token again closes it; a different token swaps content.
  if (drawerRoot && drawerCa === ca) { closeDrawer(); return; }
  closeDrawer();

  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.setAttribute(DRAWER_ATTR, "");
  host.style.cssText = "all:initial;position:fixed;inset:0 0 0 auto;z-index:2147483000;";
  ["click", "pointerdown", "mousedown", "mouseup", "keydown"].forEach((ev) =>
    host.addEventListener(ev, (e) => e.stopPropagation()));

  const sh = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  sh.appendChild(style);

  const drawer = document.createElement("div");
  drawer.className = "drawer";
  sh.appendChild(drawer);
  document.body.appendChild(host);
  makeDrawerDraggable(drawer);

  drawerRoot = host;
  drawerCa = ca;
  runPanel(ca, drawer, viaCashtag, chainHint, opts);

  // Escape closes, the way every drawer does.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { closeDrawer(); window.removeEventListener("keydown", onKey, true); }
  };
  window.addEventListener("keydown", onKey, true);
}

function closeDrawer() {
  document.querySelectorAll(`[${DRAWER_ATTR}]`).forEach((el) => el.remove());
  drawerRoot = null;
  drawerCa = null;
}

function mountHost(ca: string, afterEl: Element, pillLabel = "Trade on Impulse", viaCashtag = false, chainHint: string | null = null) {
  trackImpulse(ca, "seen");
  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.style.cssText = "all:initial;display:block;"; // CSSOM set = CSP-safe
  // Stop X from hijacking clicks (it navigates on tweet click).
  ["click", "pointerdown", "mousedown", "mouseup", "keydown"].forEach((ev) =>
    host.addEventListener(ev, (e) => e.stopPropagation()));

  // Closed, not open. With an open root the host page can reach in via
  // host.shadowRoot, find the Buy button and call .click() on it, spending the
  // user's funds on a token of the page's choosing while the wallet is
  // unlocked. Nothing here reads the root back off the element, so closing it
  // costs us nothing.
  const sh = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  sh.appendChild(style);
  const root = document.createElement("div");
  sh.appendChild(root);
  afterEl.insertAdjacentElement("afterend", host);
  if (DEBUG) {
    const r = host.getBoundingClientRect();
    dlog(`mounted after <${afterEl.tagName.toLowerCase()}.${(afterEl.className || "").toString().split(" ")[0]}>`,
      `rect ${Math.round(r.width)}x${Math.round(r.height)} @ ${Math.round(r.x)},${Math.round(r.y)}`,
      r.width && r.height ? "" : "  <= ZERO SIZE");
  }

  const rowEl = document.createElement("div");
  rowEl.className = "pillrow";
  root.appendChild(rowEl);

  const pill = document.createElement("button");
  pill.className = "pill";
  pill.innerHTML = `${LOGO}<span>${pillLabel}</span>`;
  rowEl.appendChild(pill);

  pill.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    openDrawer(ca, viaCashtag, chainHint);
  });

  // The "who holds this" cluster: circular avatars of the top FOMO thesis authors
  // on this token, hover for their thesis + position. Lazy (only when the pill is
  // visible) and deduped per token, so a busy feed never bursts FOMO calls.
  if (FOMO_ENABLED) {
    const strip = document.createElement("div");
    strip.className = "tstrip empty";
    rowEl.appendChild(strip);
    observeOnce(host, () => loadThesisStrip(ca, chainHint, strip));
  }
}

// Fire `cb` once, when `el` first scrolls into view (falls back to immediate).
function observeOnce(el: Element, cb: () => void) {
  try {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.disconnect(); cb(); }
    }, { rootMargin: "150px" });
    io.observe(el);
  } catch { cb(); }
}

// Shared per-token fetches (dedup across every pill for the same CA on a page).
const thesisStripCache = new Map<string, Promise<any[]>>();
const calloutStripCache = new Map<string, Promise<any[]>>();

function cachedFomoTop(key: string, ca: string, chainHint: string | null): Promise<any[]> {
  let p = thesisStripCache.get(key);
  if (!p) {
    p = send({ type: "STRIX_FOMO_TOP", ca, chain: chainHint || tokenChains.get(key) || null, n: 5 })
      .then((r: any) => (r && Array.isArray(r.items)) ? r.items : []).catch(() => []);
    thesisStripCache.set(key, p);
  }
  return p;
}
function cachedCallouts(key: string, ca: string): Promise<any[]> {
  let p = calloutStripCache.get(key);
  if (!p) {
    p = send({ type: "STRIX_CALLOUTS", ca })
      .then((r: any) => (r && Array.isArray(r.items)) ? r.items : []).catch(() => []);
    calloutStripCache.set(key, p);
  }
  return p;
}

type StripState = { mode: "fomo" | "pump"; fomo?: any[]; calls?: any[] };

// The strip: top FOMO thesis authors, plus a pump.fun logo that toggles the
// cluster to the top pump.fun callouts for the same token. Lazy + cached.
function loadThesisStrip(ca: string, chainHint: string | null, strip: HTMLElement) {
  const key = ca.toLowerCase();
  const st: StripState = { mode: "fomo" };
  let callsReq = false;
  const draw = () => renderStrip(strip, st, toggle, ca, chainHint);
  function toggle() {
    if (st.mode === "fomo") {
      st.mode = "pump";
      if (!callsReq) { callsReq = true; cachedCallouts(key, ca).then((items) => { st.calls = items; if (st.mode === "pump") draw(); }); }
    } else {
      st.mode = "fomo";
    }
    draw();
  }
  cachedFomoTop(key, ca, chainHint).then((items) => { st.fomo = items; draw(); });
  draw();
}

// One tooltip card (used by both FOMO theses and pump.fun callouts).
function tipCardHtml(avatar: string | null, whoRaw: string, meta: string, metaCls: string, body: string, nameForInitial: string): string {
  const who = esc(whoRaw);
  const initial = esc((String(nameForInitial || whoRaw).replace(/^@/, "")[0] || "?").toUpperCase());
  const av = avatar ? `<img class="ttav" src="${esc(String(avatar))}" alt="">` : `<span class="ttavfb">${initial}</span>`;
  const bodyHtml = body ? `<div class="ttbody">${esc(String(body))}</div>` : `<div class="ttempty">No text</div>`;
  return `<div class="ttcard"><div class="tthead">${av}<span class="ttname">${who}</span>` +
    `<span class="${metaCls}">${esc(meta)}</span></div>${bodyHtml}</div>`;
}

// A circular avatar with a hover card. FOMO shows "holds $X" + thesis; pump.fun
// shows "called $Xmc · Nx" + the callout text.
function buildAvatar(t: any, mode: "fomo" | "pump"): HTMLElement {
  const av = document.createElement("div");
  av.className = "tav";
  const handle = String(t.authorHandle || t.handle || t.xHandle || "");
  const name = String(t.authorName || t.handle || handle || "trader");
  if (t.avatar) { const img = document.createElement("img"); img.src = t.avatar; img.alt = ""; av.appendChild(img); }
  else { const fb = document.createElement("span"); fb.className = "tavfb"; fb.textContent = (name[0] || "?").toUpperCase(); av.appendChild(fb); }
  const whoRaw = handle ? "@" + handle : name;
  let html: string;
  if (mode === "pump") {
    const mc = Number(t.calledAtMcap);
    const mult = Number(t.multiple);
    const parts: string[] = [];
    if (mc > 0) parts.push("called " + fmtCompact(mc));
    if (mult > 0) parts.push((mult >= 10 ? mult.toFixed(0) : mult.toFixed(1)) + "x");
    const metaCls = mult > 0 && mult < 1 ? "tthold dn" : "tthold";
    html = tipCardHtml(t.avatar, whoRaw, parts.join(" · ") || "call", metaCls, t.text, name);
  } else {
    const pos = Number(t.positionUsd);
    const kind = t.positionKind === "traded" ? "traded" : "holds";
    const meta = pos > 0 ? `${kind} ${fmtCompact(pos)}` : "position n/a";
    const pnl = Number(t.pnlPct);
    const metaCls = isFinite(pnl) && pnl < 0 ? "tthold dn" : "tthold";
    html = tipCardHtml(t.avatar, whoRaw, meta, metaCls, t.thesis, name);
  }
  av.addEventListener("mouseenter", () => showTip(av.getBoundingClientRect(), html));
  av.addEventListener("mouseleave", hideTip);
  return av;
}

function renderStrip(strip: HTMLElement, st: StripState, toggle: () => void, ca: string, chain: string | null) {
  const fomo = st.fomo;
  if (fomo === undefined) return;                                   // still loading — stay hidden
  if (fomo.length === 0) { strip.className = "tstrip empty"; strip.innerHTML = ""; return; }

  strip.innerHTML = "";
  if (st.mode === "fomo") {
    for (const t of fomo.slice(0, 5)) strip.appendChild(buildAvatar(t, "fomo"));
  } else if (st.calls === undefined) {
    const n = document.createElement("span"); n.className = "tavnote"; n.textContent = "loading callouts…"; strip.appendChild(n);
  } else if (st.calls.length === 0) {
    const n = document.createElement("span"); n.className = "tavnote"; n.textContent = "no pump.fun callouts"; strip.appendChild(n);
  } else {
    for (const t of st.calls.slice(0, 5)) strip.appendChild(buildAvatar(t, "pump"));
  }

  if (CALLOUTS_ENABLED) {
    const btn = document.createElement("button");
    btn.className = "tavtoggle" + (st.mode === "pump" ? " on" : "");
    btn.innerHTML = st.mode === "fomo" ? PUMP_MARK : LOGO;
    btn.title = st.mode === "fomo" ? "Show pump.fun callouts" : "Back to FOMO theses";
    btn.addEventListener("click", (e) => { if (!e.isTrusted) return; e.stopPropagation(); toggle(); });
    strip.appendChild(btn);
  }

  // Quick-access tools, each its own premium icon. Chart opens a page overlay;
  // holders / new holders / bubble map open the drawer straight to that view.
  const sym = String((fomo[0]?.tokenSymbol || fomo[0]?.symbol || "")).replace(/^\$/, "");
  const logo = fomo[0]?.tokenLogo || null;
  const tool = (icon: string, title: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.className = "tavtoggle tavtool";
    b.innerHTML = icon;
    b.title = title;
    b.addEventListener("click", (e) => { if (!e.isTrusted) return; e.stopPropagation(); onClick(); });
    strip.appendChild(b);
  };
  tool(IC_CHART, "Price chart", () => openChartPop(ca, chain, sym, logo));
  tool(IC_HOLDERS, "Top holders, smart money & KOLs", () => openHoldersPop(ca, chain, sym, logo, "holders"));
  tool(IC_NEW, "Newest holders", () => openHoldersPop(ca, chain, sym, logo, "new"));
  tool(IC_BUBBLES, "Holder bubble map", () => openBubblesPop(ca, sym, logo));

  strip.className = "tstrip";
}

// The hover card is rendered at document.body level (its own shadow) with fixed
// positioning, so X's overflow/containment on the tweet can never clip it.
const TIP_STYLES = `
  @font-face{font-family:"ImpulseSans";font-weight:400;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-400.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-weight:600;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-600.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-700.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseMono";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexmono-700.woff2")}") format("woff2")}
  *{font-family:"ImpulseSans",-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
  .ttcard{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:13px;background:#0a0d07;
    border:1px solid #20261a;box-shadow:0 18px 44px -14px rgba(0,0,0,.92)}
  .ttcard .tthead{display:flex;align-items:center;gap:8px;margin-bottom:7px}
  .ttcard .ttav{width:24px;height:24px;border-radius:50%;flex:0 0 auto;object-fit:cover;
    border:1.5px solid #20261a;display:block}
  .ttcard .ttavfb{width:24px;height:24px;border-radius:50%;flex:0 0 auto;display:flex;
    align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#0a1005;background:#b6f03c}
  .ttcard .ttname{flex:1;min-width:0;font-size:13px;font-weight:600;color:#f3f7ec;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ttcard .tthold{font-family:"ImpulseMono",ui-monospace,monospace;font-size:11.5px;font-weight:700;
    color:#b6f03c;white-space:nowrap;flex:0 0 auto}
  .ttcard .tthold.dn{color:#ff6b6b}
  .ttcard .ttbody{font-size:12.5px;line-height:1.5;color:#c7cebb;
    display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
  .ttcard .ttempty{font-size:12.5px;color:#8a927e;font-style:italic}`;

let _tip: { el: HTMLElement; root: HTMLElement } | null = null;
function tipEl() {
  if (_tip) return _tip;
  const el = document.createElement("div");
  el.style.cssText = "all:initial;position:fixed;z-index:2147483647;pointer-events:none;display:none;width:250px;";
  const sh = el.attachShadow({ mode: "closed" });
  const st = document.createElement("style"); st.textContent = TIP_STYLES; sh.appendChild(st);
  const root = document.createElement("div"); sh.appendChild(root);
  document.body.appendChild(el);
  _tip = { el, root };
  return _tip;
}
function showTip(rect: DOMRect, html: string) {
  const t = tipEl();
  t.root.innerHTML = html;
  t.el.style.display = "block";
  const W = 250, gap = 10;
  let left = rect.left + rect.width / 2 - W / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - W - 8));
  t.el.style.left = `${left}px`;
  const h = (t.root.firstElementChild as HTMLElement)?.offsetHeight || 90;
  let top = rect.top - h - gap;
  if (top < 8) top = rect.bottom + gap; // flip below if no room above
  t.el.style.top = `${top}px`;
}
function hideTip() { if (_tip) _tip.el.style.display = "none"; }

// ---- Chart popover -------------------------------------------------------
// A full chart, opened from the avatar strip, as its own body-level modal (own
// closed shadow, fixed backdrop) so X's overflow/containment can never clip it.
// Closes on the ✕, on a backdrop click, or on Escape.
const CHART_X = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const CHART_TFS = ["15m", "1H", "4H", "1D"];
const CHART_STYLES = `
  @font-face{font-family:"ImpulseSans";font-weight:400;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-400.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-weight:600;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-600.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-700.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseMono";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexmono-700.woff2")}") format("woff2")}
  *{font-family:"ImpulseSans",-apple-system,"Segoe UI",Roboto,Arial,sans-serif;box-sizing:border-box}
  .cbackdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
    padding:24px;background:rgba(4,6,3,.72);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
  .ccard{width:min(560px,94vw);background:#0a0d07;border:1px solid #20261a;border-radius:18px;
    box-shadow:0 34px 90px -22px rgba(0,0,0,.96);overflow:hidden}
  .chead{display:flex;align-items:center;gap:11px;padding:14px 16px;border-bottom:1px solid #171c11}
  .chead .clogo{width:32px;height:32px;border-radius:10px;object-fit:cover;display:block;
    background:#141810;border:1px solid #20261a;flex:0 0 auto}
  .chead .ctitle{flex:1;min-width:0}
  .chead .ctitle b{display:block;font-size:15.5px;font-weight:700;color:#f3f7ec;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .chead .ctitle span{display:block;font:700 11px "ImpulseMono",ui-monospace,monospace;color:#8a927e;margin-top:1px}
  .cclose{width:34px;height:34px;border-radius:10px;border:1px solid #20261a;background:#12160c;
    color:#c7cebb;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;
    padding:0;transition:background .12s,color .12s}
  .cclose:hover{background:#1a2010;color:#f3f7ec}
  .ctfs{display:flex;gap:6px;padding:12px 16px 2px}
  .ctf{flex:0 0 auto;padding:5px 13px;border-radius:9px;border:1px solid #20261a;background:#12160c;
    font:700 12px "ImpulseMono",ui-monospace,monospace;color:#8a927e;cursor:pointer;transition:all .12s}
  .ctf:hover{color:#e7edda;border-color:#2a3320}
  .ctf.on{background:#b6f03c;border-color:#b6f03c;color:#0a1005}
  .cbody{padding:8px 12px 16px;min-height:250px;display:flex;align-items:center;justify-content:center}
  .cbody svg{display:block}
  .cnote{font:600 13px "ImpulseSans",-apple-system,sans-serif;color:#8a927e;
    display:flex;align-items:center;gap:9px;text-align:center}
  .cspin{width:15px;height:15px;border-radius:50%;border:2px solid #2a3320;border-top-color:#b6f03c;
    animation:cspin .7s linear infinite;flex:0 0 auto}
  @keyframes cspin{to{transform:rotate(360deg)}}`;

let _chart: { el: HTMLElement; root: HTMLElement } | null = null;
let _chartReq = 0;                          // bumped on every open/close — invalidates stale fetches
function chartEl() {
  if (_chart) return _chart;
  const el = document.createElement("div");
  el.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;display:none;";
  const sh = el.attachShadow({ mode: "closed" });
  const st = document.createElement("style"); st.textContent = CHART_STYLES; sh.appendChild(st);
  const root = document.createElement("div"); sh.appendChild(root);
  document.body.appendChild(el);
  _chart = { el, root };
  return _chart;
}
function closeChartPop() {
  _chartReq++;
  if (_chart) { _chart.el.style.display = "none"; _chart.root.innerHTML = ""; }
  document.removeEventListener("keydown", chartKey, true);
}
function chartKey(e: KeyboardEvent) { if (e.key === "Escape") { e.stopPropagation(); closeChartPop(); } }

function openChartPop(ca: string, chain: string | null, symbol: string, logo?: string | null) {
  const c = chartEl();
  const my = ++_chartReq;                   // this open's token; a later open/close voids it
  const cache: Record<string, Candle[] | null | undefined> = {};
  let tf = "1H";
  let pool: string | null = null;
  let poolP: Promise<void> | null = null;
  const ensurePool = () => {
    if (!poolP) poolP = send({ type: "STRIX_PAIR", ca, chain }).then((pr) => { if (my === _chartReq) pool = pr?.pair || null; });
    return poolP;
  };

  const shell = (bodyHtml: string) => {
    if (my !== _chartReq) return;
    c.root.innerHTML =
      `<div class="cbackdrop"><div class="ccard">` +
        `<div class="chead">` +
          (logo ? `<img class="clogo" src="${esc(logo)}" alt="">` : `<div class="clogo"></div>`) +
          `<div class="ctitle"><b>${esc(symbol || short(ca))}</b><span>${esc(short(ca))}</span></div>` +
          `<button class="cclose" title="Close">${CHART_X}</button>` +
        `</div>` +
        `<div class="ctfs">${CHART_TFS.map((t) => `<button class="ctf${t === tf ? " on" : ""}" data-tf="${t}">${t}</button>`).join("")}</div>` +
        `<div class="cbody">${bodyHtml}</div>` +
      `</div></div>`;
    const bd = c.root.querySelector(".cbackdrop") as HTMLElement;
    bd.addEventListener("click", (e) => { if (e.target === bd) closeChartPop(); });
    (c.root.querySelector(".cclose") as HTMLElement).addEventListener("click", (e) => { e.stopPropagation(); closeChartPop(); });
    c.root.querySelectorAll(".ctf").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const nt = (b as HTMLElement).dataset.tf!;
        if (nt !== tf) { tf = nt; draw(); }
      }));
  };

  const draw = () => {
    if (cache[tf] === undefined) { shell(`<div class="cnote"><span class="cspin"></span>Loading chart…</div>`); fetchTf(tf); return; }
    const cs = cache[tf];
    const svg = cs && cs.length >= 2 ? chartSvg(cs, tf, 250) : "";
    shell(svg || `<div class="cnote">No chart data for this timeframe.</div>`);
  };

  const fetchTf = (which: string) => {
    ensurePool().then(() => {
      if (my !== _chartReq) return;
      if (!pool) { cache[which] = null; if (which === tf) draw(); return; }
      send({ type: "STRIX_CANDLES", pool, ca, tf: which, chain }).then((r) => {
        if (my !== _chartReq) return;
        cache[which] = Array.isArray(r?.candles) && r.candles.length ? r.candles : null;
        if (which === tf) draw();
      });
    });
  };

  c.el.style.display = "block";
  document.addEventListener("keydown", chartKey, true);
  draw();
}

// ---- Generic strip popover (holders / new holders / bubble map) ----------
// A body-level modal like the chart popover, but its shadow also loads the full
// drawer stylesheet so holder rows, tabs and the bubble map render exactly as
// they do in the drawer. The card body is a `.drawer` whose panel positioning
// is neutralised here, keeping only its colours and child styles.
const POP_STYLES = `
  .pbackdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
    padding:24px;background:rgba(4,6,3,.82);backdrop-filter:blur(10px) saturate(120%);-webkit-backdrop-filter:blur(10px) saturate(120%)}
  .pcard{width:min(460px,94vw);max-height:82vh;display:flex;flex-direction:column;
    background:#0b0e11;border:1px solid #28303c;border-radius:18px;overflow:hidden;
    box-shadow:0 34px 90px -22px rgba(0,0,0,.96)}
  .phead{display:flex;align-items:center;gap:12px;padding:15px 16px;border-bottom:1px solid #1b222b;flex:0 0 auto}
  .phead .plogo{width:34px;height:34px;border-radius:10px;object-fit:cover;display:block;
    background:#151a21;border:1px solid #28303c;flex:0 0 auto}
  .phead .plogo.scanlg{display:flex;align-items:center;justify-content:center;color:#b6f03c;
    background:#0c1207;border-color:#26331a}
  .phead .plogo.scanlg svg{width:19px;height:19px;display:block}
  .phead .ptitle{flex:1;min-width:0}
  .phead .ptitle b{display:block;font-size:17px;font-weight:700;color:#fff;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .phead .ptitle span{display:block;font:700 11.5px "ImpulseMono",ui-monospace,monospace;color:#8aa0b4;margin-top:2px;letter-spacing:.04em}
  .pclose{width:32px;height:32px;border-radius:9px;border:1px solid #28303c;background:#151a21;
    color:#c2cad6;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;padding:0;transition:.12s}
  .pclose:hover{background:#1b222b;color:#fff}
  .pbody{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:#2b3542 transparent}
  .pbody::-webkit-scrollbar{width:8px}
  .pbody::-webkit-scrollbar-thumb{background:#2b3542;border-radius:8px}
  /* Neutralise the side-panel geometry — keep the colours and child rules. */
  .pcard .drawer{position:static;inset:auto;top:auto;right:auto;bottom:auto;left:auto;
    width:auto;max-width:none;height:auto;z-index:auto;overflow:visible;border:0;border-radius:0;
    box-shadow:none;animation:none;background:transparent}
  .pbubblebox{padding:0;height:60vh;min-height:340px}
  .pbubbleframe{width:100%;height:100%;border:0;display:block;background:#0b0e11}`;

let _pop: { el: HTMLElement; root: HTMLElement } | null = null;
let _popReq = 0;                            // bumped on open/close — voids stale fetches
function popEl() {
  if (_pop) return _pop;
  const el = document.createElement("div");
  el.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;display:none;";
  const sh = el.attachShadow({ mode: "closed" });
  const st = document.createElement("style"); st.textContent = STYLES + POP_STYLES; sh.appendChild(st);
  const root = document.createElement("div"); sh.appendChild(root);
  document.body.appendChild(el);
  _pop = { el, root };
  return _pop;
}
function closePop() {
  _popReq++;
  if (_pop) { _pop.el.style.display = "none"; _pop.root.innerHTML = ""; }
  document.removeEventListener("keydown", popKey, true);
}
function popKey(e: KeyboardEvent) { if (e.key === "Escape") { e.stopPropagation(); closePop(); } }

// Renders the shell (backdrop + header + a scrollable `.drawer` body) and hands
// back the body element to fill. `token` guards against a stale reopen.
function popShell(sym: string, ca: string, logo: string | null | undefined, token: number): HTMLElement | null {
  if (token !== _popReq) return null;
  const p = popEl();
  p.root.innerHTML =
    `<div class="pbackdrop"><div class="pcard">` +
      `<div class="phead">` +
        (logo ? `<img class="plogo" src="${esc(logo)}" alt="">` : `<div class="plogo"></div>`) +
        `<div class="ptitle"><b>${esc(sym || short(ca))}</b><span>${esc(short(ca))}</span></div>` +
        `<button class="pclose" title="Close">${CHART_X}</button>` +
      `</div>` +
      `<div class="pbody"><div class="drawer"></div></div>` +
    `</div></div>`;
  const bd = p.root.querySelector(".pbackdrop") as HTMLElement;
  bd.addEventListener("click", (e) => { if (e.target === bd) closePop(); });
  (p.root.querySelector(".pclose") as HTMLElement).addEventListener("click", (e) => { e.stopPropagation(); closePop(); });
  p.el.style.display = "block";
  return p.root.querySelector(".pbody .drawer") as HTMLElement;
}

const gStartTs = (r: any): number => {
  const v = Number(gPick(r, ["start_holding_at", "first_buy_time", "created_time", "buy_time", "last_active_timestamp"]));
  return isFinite(v) && v > 0 ? v : 0;
};

// Holders / New holders overlay — top holders with KOL & smart-money filters,
// the same view the drawer shows, just opened above the tweet.
function openHoldersPop(ca: string, chain: string | null, sym: string, logo: string | null, initialTab: "holders" | "new") {
  const my = ++_popReq;
  const ch = chain || "robinhood";
  let holdTab: "holders" | "new" | "traders" = initialTab;
  let holdTag = "";
  let page = 0;
  const cache: Record<string, any[] | null | undefined> = {};
  const busy: Record<string, boolean> = {};
  const errs: Record<string, string> = {};
  document.addEventListener("keydown", popKey, true);

  const fetchRows = (force = false) => {
    const k = holdTab + ":" + holdTag;
    if (force) { delete cache[k]; delete errs[k]; }
    if (cache[k] !== undefined || busy[k]) return;
    busy[k] = true;
    const endpointTab = holdTab === "traders" ? "traders" : "holders";
    const orderBy = holdTab === "traders" ? "profit" : "amount_percentage";
    send({ type: "STRIX_GMGN", what: "holders", ca, tab: endpointTab, orderBy, tag: holdTag || undefined }).then((r) => {
      if (my !== _popReq) return;
      busy[k] = false;
      if (r?.noKey) { cache[k] = null; errs[k] = "GMGN key not configured."; }
      else if (r?.error) { cache[k] = null; errs[k] = String(r.error); }
      else {
        let rows = gRows(r?.data);
        if (holdTab === "new") rows = rows.slice().sort((a: any, b: any) => gStartTs(b) - gStartTs(a));
        cache[k] = rows;
      }
      draw();
    });
  };

  const draw = () => {
    const body = popShell(sym, ca, logo, my);
    if (!body) return;
    const k = holdTab + ":" + holdTag;
    const rows = cache[k];
    const tabWord = holdTab === "new" ? "new holders" : holdTab;
    const tabs = `<div class="hctl">
      <div class="tfseg">
        <button data-htab="holders" class="${holdTab === "holders" ? "on" : ""}">Holders</button>
        <button data-htab="new" class="${holdTab === "new" ? "on" : ""}">New</button>
        <button data-htab="traders" class="${holdTab === "traders" ? "on" : ""}">Traders</button>
      </div>
      <div class="tfseg">
        <button data-htag="" class="${holdTag === "" ? "on" : ""}">All</button>
        <button data-htag="renowned" class="${holdTag === "renowned" ? "on" : ""}">KOL</button>
        <button data-htag="smart_degen" class="${holdTag === "smart_degen" ? "on" : ""}">Smart</button>
      </div>
    </div>`;
    let inner: string;
    if (busy[k] || rows === undefined) {
      inner = `<div class="note"><span class="spin"></span>Loading ${tabWord}…</div>`;
    } else if (!rows || !rows.length) {
      const why = errs[k] ? `Couldn't load: ${esc(errs[k])}`
        : holdTag ? "None found in the top 100." : "No holder data for this token yet.";
      inner = `<div class="note">${why}<br/><br/><button class="amt" data-act="hretry" style="padding:7px 18px">Retry</button></div>`;
    } else {
      const pctOf = (r: any) => { const v = Number(gPick(r, ["amount_percentage"])); return isFinite(v) ? (v <= 1 ? v * 100 : v) : 0; };
      const maxPct = rows.reduce((m: number, r: any) => Math.max(m, pctOf(r)), 0);
      const kols = rows.filter((r: any) => { const t = gTags(r); return t.includes("kol") || t.includes("renowned"); }).length;
      const smart = rows.filter((r: any) => gTags(r).includes("smart_degen")).length;
      const top = rows.slice(0, 10).filter((r: any) => !gIsPool(r));
      const known = top.filter((r: any) => pctOf(r) > 0);
      const top10 = known.reduce((n: number, r: any) => n + pctOf(r), 0);
      const haveEnough = known.length >= Math.max(1, Math.ceil(top.length / 2));
      const conc = !haveEnough ? "" : top10 >= 50 ? "hi" : top10 >= 25 ? "mid" : "lo";
      const summary = `<div class="hsum">
        <div class="hsumcell"><span>Top 10 hold</span><b class="${conc}">${haveEnough ? `${top10.toFixed(1)}%` : "—"}</b></div>
        <div class="hsumcell"><span>KOLs</span><b>${kols}</b></div>
        <div class="hsumcell"><span>Smart money</span><b>${smart}</b></div>
      </div>`;
      const PAGE = 10;
      const maxPage = Math.max(1, Math.ceil(rows.length / PAGE));
      if (page >= maxPage) page = maxPage - 1;
      const start = page * PAGE;
      const slice = rows.slice(start, start + PAGE);
      const head = `<div class="hhead"><span>#</span><span>Wallet</span><span class="r">Supply</span><span class="r">PnL</span></div>`;
      const pager = maxPage > 1
        ? `<div class="pager">
            <button data-hpage="prev" ${page === 0 ? "disabled" : ""}>‹ Prev</button>
            <span>${start + 1}–${Math.min(start + PAGE, rows.length)} of ${rows.length}</span>
            <button data-hpage="next" ${page >= maxPage - 1 ? "disabled" : ""}>Next ›</button>
          </div>`
        : "";
      const src = holdTab === "traders" ? "ranked by realised profit" : holdTab === "new" ? "newest holders first" : "ranked by holdings";
      inner = summary + head +
        slice.map((r: any, i: number) => holderRowHtml(r, start + i + 1, maxPct, ch)).join("") +
        pager + `<div class="gsrc">${src} · via GMGN</div>`;
    }
    body.innerHTML = tabs + inner;

    const bind = (sel: string, fn: (el: HTMLElement) => void) =>
      body.querySelectorAll<HTMLElement>(sel).forEach((el) =>
        el.addEventListener("click", (ev) => { if (ev.isTrusted) fn(el); }));
    bind("[data-htab]", (el) => { holdTab = el.dataset.htab as any; page = 0; fetchRows(); draw(); });
    bind("[data-htag]", (el) => { holdTag = el.dataset.htag || ""; page = 0; fetchRows(); draw(); });
    bind("[data-hpage]", (el) => { page += el.dataset.hpage === "next" ? 1 : -1; if (page < 0) page = 0; draw(); });
    bind('[data-act="hretry"]', () => { fetchRows(true); draw(); });
  };

  fetchRows();
  draw();
}

// Bubble map overlay — the Bubblemaps iframe from our CSP-exempt page.
function openBubblesPop(ca: string, sym: string, logo: string | null) {
  const my = ++_popReq;
  document.addEventListener("keydown", popKey, true);
  const body = popShell(sym, ca, logo, my);
  if (!body) return;
  const src = chrome.runtime.getURL(`bubble.html?ca=${encodeURIComponent(ca)}`);
  body.innerHTML = `<div class="pbubblebox"><iframe class="pbubbleframe" src="${src}" allow="clipboard-write"></iframe></div>` +
    `<div class="gsrc">holder bubble map</div>`;
}


/**
 * Avatar for a thesis author.
 *
 * FomoScan carries a real profile picture, but only on the user record at
 * 250 CU a lookup — about 5,000 CU to fill one panel against a 100,000 monthly
 * allowance, and only 6 authors in 8 have one set. So every author wears the
 * FOMO mark instead, which is accurate (they are FOMO accounts) and free.
 *
 * The disc behind it is still tinted per author, seeded on the stable authorId
 * rather than the handle so a trader who renames keeps the same colour and the
 * rows stay scannable.
 */
/**
 * Escape thesis text, then turn bare URLs into links.
 *
 * Order matters and is the whole safety argument: the text is escaped FIRST, so
 * by the time URLs are matched there is no markup left to inject. Only http and
 * https are linked, and the href is taken from the already-escaped string, so a
 * javascript: or data: URL can never become a clickable target.
 */
function linkify(raw: string): string {
  const safe = esc(raw || "");
  return safe.replace(/https?:\/\/[^\s<]+/g, (u) => {
    // Trailing punctuation is almost always sentence punctuation, not URL.
    const trail = /[.,;:!?)\]]+$/.exec(u);
    const href = trail ? u.slice(0, -trail[0].length) : u;
    const tail = trail ? trail[0] : "";
    const label = href.replace(/^https?:\/\/(www\.)?/, "");
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>${tail}`;
  });
}

function authorAvatar(seed: string, url?: string | null, mark: string = FOMO_MARK_SM): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const tint = `hsl(${h % 360} 55% 30%)`;
  // The tinted disc stays underneath a real picture as well as replacing a
  // missing one: it fills the frame while the image loads, and it is what shows
  // if the image 404s. Seeded on the stable author id rather than the handle,
  // so a trader who renames keeps the same colour and the rows stay scannable.
  // `url` is a data: URI the extension already fetched and verified, so there is
  // no load to fail and no inline error handler — which the host page's CSP
  // would refuse to run anyway.
  if (url && url.startsWith("data:image/")) {
    return `<div class="tav" style="background:${tint}">` +
      `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/></div>`;
  }
  // Falls back to the mark of whichever platform the row came from, so a
  // pictureless caller still reads as a pump.fun caller rather than a FOMO one.
  return `<div class="tav" style="background:${tint}">${mark}</div>`;
}

function runPanel(ca: string, panel: HTMLElement, viaCashtag = false, chainHint: string | null = null, opts?: DrawerOpts) {
  // Which chain this contract lives on. Starts as a hint from cashtag
  // resolution, is confirmed by the first STRIX_TOKEN reply, and is then sent
  // with every call so a Base token is never quoted or signed on Robinhood.
  let chain: string | null = chainHint;
  let info: any = null, status: any = null, holding: any = null, logoData: string | null = null;
  let dir: "buy" | "sell" = "buy", amount = "0.05", pct = 100;
  let phase: "loading" | "ready" | "notfound" | "busy" | "done" | "error" = "loading";
  let message = "", hash = "";
  let timer: any = null;
  let editing = false;
  let pairAddr: string | null = null;
  let caCopied = false;
  let view: "trade" | "chart" | "safety" | "holders" | "bubbles" | "fomo" | "callouts" | "ithesis" =
    (opts?.view as any) || "trade";
  let tf = "1H";
  let chartLoading = false;
  // Per-timeframe candle cache: undefined = not fetched, null = no data.
  const candles: Record<string, Candle[] | null | undefined> = {};

  // GMGN state (loaded via background proxy; noKey → features hidden).
  // Its API is Robinhood-only, so on other chains it would answer for the
  // wrong token or not at all — worse than showing nothing, because a
  // "no red flags" verdict fetched for a different chain is actively
  // misleading on a screen people use to decide whether to buy.
  let gmgnKey = true; // assume until told otherwise
  let sec: any = undefined; // undefined = loading, null = unavailable
  let ginfo: any = null;
  // FOMO theses (FomoScan proxy). undefined = not fetched, null = unavailable.
  // The live quote for whatever amount is typed. undefined = not asked yet.
  let quote: any = undefined;
  let quoteFor = "";
  let quoteTimer: number | undefined;
  let fomoData: any = undefined;
  let fomoBusy = false;
  let fomoErr = "";
  let fomoPage = 0;
  let coData: any = undefined;
  let coBusy = false;
  let coErr = "";
  let coPage = 0;
  // Impulse Thesis (our own backend). undefined = not fetched, null = unavailable.
  let impData: any = undefined;      // { items, count }
  let impBusy = false;
  let impErr = "";
  let impProfile: any = undefined;   // undefined = unknown, null = none yet, obj = set
  let impWallet: string | null = null;
  let impSetup = false;              // show the profile setup form even if one exists
  let impDp: string | null = null;   // chosen display picture, as a data: URI
  let impDraft = "";                 // thesis text being written (kept across renders)
  let impUsername = "";              // username being chosen
  let impSaving = false;
  let impMsg = "";                   // inline error/status under the composer
  let impStats: { seen: number; opened: number } | null = null; // popularity from our backend
  let holdTab: "holders" | "traders" | "new" = (opts?.holdTab as any) || "holders";
  let holdTag = ""; // "" | "renowned" | "smart_degen"
  let holdPage = 0;
  const holdCache: Record<string, any[] | null | undefined> = {};
  const holdBusy: Record<string, boolean> = {};
  const holdErrs: Record<string, string> = {};

  const content = document.createElement("div");
  panel.appendChild(content);

  /**
   * Quote the current amount, debounced.
   *
   * Every keystroke would otherwise fire a routing pass and several RPC reads.
   * 450ms is long enough that typing "0.05" costs one quote rather than four,
   * and short enough that the number is there before a hand reaches the button.
   */
  function ensureQuote() {
    if (dir !== "buy" || !status?.unlocked) return;
    const amt = String(amount || "");
    if (!(Number(amt) > 0)) { quote = undefined; quoteFor = ""; return; }
    if (quoteFor === amt) return;
    if (quoteTimer) clearTimeout(quoteTimer);
    quoteTimer = window.setTimeout(() => {
      const asked = amt;
      send({ type: "STRIX_QUOTE", ca, amount: asked, chain }).then((r) => {
        // A reply for an amount the user has since changed is stale.
        if (String(amount || "") !== asked) return;
        quoteFor = asked;
        quote = r;
        if (view === "trade") render();
      }).catch(() => {});
    }, 450);
  }

  function ensureCallouts(force = false) {
    if (!CALLOUTS_ENABLED) return;
    if (force) { coData = undefined; coErr = ""; coPage = 0; }
    if (coData !== undefined || coBusy) return;
    coBusy = true;
    send({ type: "STRIX_CALLOUTS", ca }).then((r) => {
      coBusy = false;
      if (r?.error) { coData = null; coErr = String(r.error); }
      else coData = r;
      if (view === "callouts") render();
    }).catch((e) => {
      coBusy = false; coData = null; coErr = String(e?.message || e);
      if (view === "callouts") render();
    });
  }

  function ensureFomo(force = false) {
    if (!FOMO_ENABLED) return;
    if (force) { fomoData = undefined; fomoErr = ""; fomoPage = 0; }
    if (fomoData !== undefined || fomoBusy) return;
    fomoBusy = true;
    send({ type: "STRIX_FOMO", ca, chain: chainHint || tokenChains.get(ca.toLowerCase()) || null }).then((r) => {
      fomoBusy = false;
      if (r?.noKey) { fomoData = null; fomoErr = "No FomoScan key configured."; }
      else if (r?.error) { fomoData = null; fomoErr = String(r.error); }
      else fomoData = r;
      if (view === "fomo") render();
    });
  }

  function ensureImpulse(force = false) {
    if (force) { impData = undefined; impErr = ""; }
    // Who am I — loaded once so the composer knows whether to show setup.
    if (impProfile === undefined) {
      send({ type: "STRIX_ITHESIS_PROFILE" }).then((r: any) => {
        impWallet = r?.wallet || null;
        impProfile = r?.profile ?? null;
        if (view === "ithesis") render();
      }).catch(() => { impProfile = null; if (view === "ithesis") render(); });
    }
    if (impData !== undefined || impBusy) return;
    impBusy = true;
    send({ type: "STRIX_ITHESIS_LIST", ca, chain: chain || chainHint || null }).then((r: any) => {
      impBusy = false;
      if (r?.error) { impData = null; impErr = String(r.error); }
      else impData = r?.v || { items: [], count: 0 };
      if (view === "ithesis") render();
    }).catch((e: any) => {
      impBusy = false; impData = null; impErr = String(e?.message || e);
      if (view === "ithesis") render();
    });
  }

  // First-buy timestamp for a holder row, for the "New" ordering. GMGN names it
  // differently per chain; any of these means "when this wallet opened".
  const gStart = (r: any): number => {
    const v = Number(gPick(r, ["start_holding_at", "first_buy_time", "created_time", "buy_time", "last_active_timestamp"]));
    return isFinite(v) && v > 0 ? v : 0;
  };

  function ensureHolders(force = false) {
    const k = holdTab + ":" + holdTag;
    if (force) { delete holdCache[k]; delete holdErrs[k]; }
    if (holdCache[k] !== undefined || holdBusy[k]) return;
    holdBusy[k] = true;
    // Holders rank by current balance; traders rank by realized profit so
    // exited wallets surface (otherwise the two lists look identical). "New"
    // pulls the holder list and re-sorts newest-first, client side.
    const endpointTab = holdTab === "traders" ? "traders" : "holders";
    const orderBy = holdTab === "traders" ? "profit" : "amount_percentage";
    send({ type: "STRIX_GMGN", what: "holders", ca, tab: endpointTab, orderBy, tag: holdTag || undefined }).then((r) => {
      holdBusy[k] = false;
      if (r?.noKey) { gmgnKey = false; holdCache[k] = null; }
      else if (r?.error) { holdCache[k] = null; holdErrs[k] = String(r.error); }
      else {
        let rows = gRows(r?.data);
        if (holdTab === "new") {
          rows = rows.slice().sort((a: any, b: any) => gStart(b) - gStart(a));
        }
        holdCache[k] = rows;
      }
      if (view === "holders") render();
    });
  }

  function openChart() {
    if (!pairAddr) return;
    view = "chart";
    ensureCandles();
    render();
  }
  function ensureCandles() {
    if (!pairAddr || candles[tf] !== undefined || chartLoading) return;
    chartLoading = true;
    send({ type: "STRIX_CANDLES", pool: pairAddr, ca, tf, chain }).then((r) => {
      candles[tf] = Array.isArray(r?.candles) && r.candles.length ? r.candles : null;
      chartLoading = false;
      if (view === "chart") render();
    });
  }

  const render = () => {
    const h = Number(holding?.amount || 0);
    if (phase === "loading") { content.innerHTML = `<div class="note"><span class="spin"></span>Loading ${short(ca)}…</div>`; return; }
    if (phase === "notfound") { content.innerHTML = `<div class="note">Not a tradable Robinhood Chain token.</div>`; return; }

    const isStk = !!info?.isStock;
    const chg = Number(info?.priceChange24h);
    // Two decimals is right for a normal move and absurd for a launch: a real
    // token in testing showed +321953.00%, which is nine characters of noise
    // that shoved the price out of the header. Precision scales with size.
    const fmtPct = (v: number) =>
      Math.abs(v) >= 1000 ? Math.round(v).toLocaleString()
      : Math.abs(v) >= 100 ? v.toFixed(1)
      : v.toFixed(2);
    const chgHtml = isFinite(chg)
      ? `<div class="chg ${chg >= 0 ? "up" : "dn"}">${chg >= 0 ? "+" : ""}${fmtPct(chg)}%</div>`
      : "";
    const logo = logoData ? `<img class="logo" src="${logoData}"/>` : `<div class="logo">${LOGO}</div>`;
    const locked = !status?.unlocked;
    const statsHtml = isStk
      ? `<div class="stockline">Tokenized <b>${esc(info?.name || "")}</b> stock · trades via USDG, settles in ETH</div>`
      : `<div class="stats">
          <div class="stat"><span>Mcap</span><b>${fmtCompact(info?.mcap)}</b></div>
          <div class="stat"><span>Liq</span><b>${fmtCompact(info?.liquidityUsd)}</b></div>
          <div class="stat"><span>Vol 24h</span><b>${fmtCompact(info?.volume24h)}</b></div>
        </div>`;

    // The chart belongs on the screen where the order is placed. Sending it to
    // its own tab meant deciding blind or losing the ticket to look at price —
    // which is the one thing no terminal makes you do.
    const inlineChart = (() => {
      if (!pairAddr) return "";
      const cs = candles[tf];
      // One track with the active segment filled, rather than four separate
      // outlined pills. Four bordered boxes read as four independent controls;
      // a timeframe is one control with four states, and the shape should say
      // so. It is also how every charting tool draws this, so it needs no
      // explaining.
      const tfrow = `<div class="tfrow"><div class="tfseg">${["15m", "1H", "4H", "1D"]
        .map((t) => `<button data-tf="${t}" class="${t === tf ? "on" : ""}">${t}</button>`)
        .join("")}</div></div>`;
      const body = cs === undefined || chartLoading
        ? `<div class="chartbox chartwait"><span class="spin"></span></div>`
        : cs && cs.length > 1
          ? `<div class="chartbox">${chartSvg(cs, tf, 168)}</div>`
          : `<div class="chartbox chartwait">No price history yet</div>`;
      return body + tfrow;
    })();

    // Direction is the loudest control in the order area, filled green or red
    // the way every exchange does it. Mixing it into the view tabs made the
    // single most important choice on the panel look like a menu item.
    const seg = `<div class="dirseg">
      <button data-dir="buy" class="${dir === "buy" ? "on-buy" : ""}">Buy</button>
      <button data-dir="sell" class="${dir === "sell" ? "on-sell" : ""}" ${h <= 0 ? "disabled" : ""}>Sell</button>
    </div>`;

    // View navigation, rendered into the header so it is present in EVERY
    // view rather than only on the trade screen — reaching Holders from the
    // chart used to mean going back first.
    const vt = (act: string, label: string, icon: string, on: boolean, title: string) =>
      `<button data-act="${act}" class="vtab${on ? " on" : ""}" title="${title}">${icon}<span>${label}</span></button>`;
    const vtabs = `<div class="vtabs">
      ${vt("back", "Trade", TRADEI, view === "trade", "Order ticket")}
      ${gmgnKey && (!chain || chain === "robinhood") ? vt("holders", "Holders", PEOPLE, view === "holders", "Top holders & traders") : ""}
      ${vt("bubbles", "Map", BUBBLES, view === "bubbles", "Holder bubble map")}
      ${vt("ithesis", "Impulse", LOGO, view === "ithesis", "Impulse community theses — written by holders")}
      ${FOMO_ENABLED ? vt("fomo", "Thesis", FOMO_MARK_SM, view === "fomo", "Trader theses from FOMO") : ""}
      ${CALLOUTS_ENABLED ? vt("callouts", "Callouts", PUMP_MARK_SM, view === "callouts", "Callouts from pump.fun") : ""}
    </div>`;

    // GMGN extras for the trade view: socials row + safety verdict bar.
    const socials = gSocials(ginfo);
    const socialsHtml = socials.length
      ? `<div class="socials">${socials.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${s.label}</a>`).join("")}</div>`
      : "";
    let secbar = "";
    if (!gmgnKey) {
      secbar = "";
    } else if (sec === undefined) {
      secbar = `<div class="secbar na">${SHIELD}<span>Checking safety…</span></div>`;
    } else if (sec === null) {
      secbar = "";
    } else {
      const { verdict } = secChecks(sec);
      secbar = `<div class="secbar ${verdict}" data-act="safety">${SHIELD}<span>Safety: ${SEC_VERDICT[verdict]}</span><i>details ›</i></div>`;
    }
    const holdHtml = h > 0 ? `<div class="hold">Holding <b>${fmtNum(h)} ${esc(info?.symbol || "")}</b>${info?.priceUsd ? ` · ${fmtUsd(h * info.priceUsd)}` : ""}</div>` : "";

    let action = "";
    if (phase === "done") {
      // Explorer follows the chain the trade actually settled on — a Base or
      // Solana receipt linked to Robinhood's explorer just 404s.
      const exp = CHAIN_LABEL[chain || "robinhood"] || CHAIN_LABEL.robinhood;
      action = `<div class="note ok">Done ✓ <a class="ok u" href="${exp.explorer}/tx/${hash}" target="_blank">view tx</a></div>
        <div class="bar"><button class="go buy" data-act="again">Trade again</button></div>`;
    } else if (locked) {
      action = `<div class="bar"><button class="go locked" data-act="unlock">Unlock Impulse to trade</button></div>`;
    } else if (dir === "buy") {
      const amts = BUY_AMOUNTS.map((a) => `<button class="amt ${a === amount ? "on" : ""}" data-amt="${a}">${a}</button>`).join("");
      const cl = chain && CHAIN_LABEL[chain] ? chainLogo(CHAIN_LABEL[chain].logo, 15) : "";
      const lbl = phase === "busy"
        ? `<span class="spin"></span>${esc(message || "Buying…")}`
        : `<span class="golbl">Buy ${amount || "0"}${cl}ETH</span>`;
      // The ticket. Shown only once there is an amount to quote, so an idle
      // panel is not padded with empty rows.
      let ticket = "";
      if (Number(amount) > 0) {
        const dec = Number(info?.decimals) || 18;
        const out = quote?.expectedOut && quote.expectedOut !== "0"
          ? `${fmtNum(Number(quote.expectedOut) / 10 ** dec)} ${esc(info?.symbol || "")}`
          : quote?.error ? "—" : "…";
        // A refusal is a paragraph, not a value. Putting it in the right-hand
        // column of a label/value row wrapped it into a centred, mid-word mess
        // — "BlockedCouldn't price this buy, so it was not sent. No tradeable
        // liquidity was found for this tok" — which is worse than saying
        // nothing. It gets its own full-width block, unabridged.
        const blocked = quote?.error && quote.error !== "locked" ? String(quote.error) : "";
        ticket = `<div class="quote">
          <div class="qrow"><span class="qlbl">You receive</span><span class="qval">${blocked ? "—" : out}</span></div>
          ${quote?.venue && !blocked ? `<div class="qrow"><span class="qlbl">Route</span><span class="qval">${esc(String(quote.venue).toUpperCase())}</span></div>` : ""}
          ${blocked ? `<div class="qblock"><b>Trade blocked</b>${esc(blocked)}</div>` : ""}
        </div>`;
      }
      // The button sits above the quote, not below it. Putting the ticket first
      // pushed the only control that matters below the fold on a short window,
      // so buying meant scrolling past information you had already read.
      action = `<div class="bar"><div class="amts">${amts}</div>` +
        `<div class="cinrow"><input class="cin" data-cbuy inputmode="decimal" value="${esc(amount)}" placeholder="Custom amount"/><span class="cunit">ETH</span></div>` +
        `<button class="go buy" data-act="buy" ${phase === "busy" || !(Number(amount) > 0) ? "disabled" : ""}>${lbl}</button>` +
        ticket +
        `${phase === "error" ? `<div class="note err">${esc(message)}</div>` : ""}</div>`;
    } else {
      const pcts = SELL_PCTS.map((p) => `<button class="amt ${p === pct ? "on" : ""}" data-pct="${p}">${p}%</button>`).join("");
      const cls = chain && CHAIN_LABEL[chain] ? chainLogo(CHAIN_LABEL[chain].logo, 15) : "";
      const lbl = phase === "busy"
        ? `<span class="spin"></span>${esc(message || "Selling…")}`
        : `<span class="golbl">Sell ${pct}%${cls}${esc(info?.symbol || "")}</span>`;
      action = `<div class="bar"><div class="amts pcts">${pcts}</div>` +
        `<div class="cinrow"><input class="cin" data-csell inputmode="numeric" value="${pct}" placeholder="Custom percent"/><span class="cunit">%</span></div>` +
        `<button class="go sell" data-act="sell" ${phase === "busy" || h <= 0 || pct <= 0 ? "disabled" : ""}>${lbl}</button>${phase === "error" ? `<div class="note err">${esc(message)}</div>` : ""}</div>`;
    }

    // Cashtags are not identifiers — anyone can deploy a token calling itself
    // $SYM, and impostors of a trending ticker are the normal case, not the
    // exception. We rank hard to pick the real one, but ranking is a guess, so
    // say so and put the contract one click from DexScreener.
    const ambigHtml = viaCashtag
      ? `<div class="ambig" title="Several tokens can share the cashtag $${esc(info?.symbol || "")}. Impulse picks the one with socials and the deepest ETH-paired liquidity, but that is a best guess — open the contract on DexScreener and confirm it is the token you mean before trading.">
           <span class="ambigi">!</span>
           <span>Multiple tokens can use this cashtag — <a data-act="dexs">verify the contract ↗</a></span>
         </div>`
      : "";
    // Popularity strip: how many times this token has been seen and opened in
    // the overlay by everyone, so a reader can gauge how hot it is.
    const fmtCount = (n: number) => {
      n = Number(n) || 0;
      return n < 1000 ? String(n) : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
    };
    const buzzHtml = impStats && (impStats.opened || impStats.seen)
      ? `<div class="buzz" title="How many times this token was opened and seen in the Impulse overlay">${LOGO}<span class="buzzn"><b>${fmtCount(impStats.opened)}</b> opens</span><span class="buzzd">·</span><span class="buzzn"><b>${fmtCount(impStats.seen)}</b> seen</span><span class="buzztag">on Impulse</span></div>`
      : "";

    const headHtml = `
      <div class="head">${logo}
        <div class="hd">
          <div class="symrow"><span class="sym">${esc(info?.symbol || "TOKEN")}</span>${
            isStk ? `<span class="badge stk">STOCK</span>` : ""
          }${
            // The venue (V4/V3/V2) is routing detail, not identity. It is in
            // the ticket under "Route", where it belongs, so the header can
            // carry the one badge that changes what a trade means: the chain.
            chain && CHAIN_LABEL[chain]
              ? `<span class="chainmark" title="Trades settle on ${esc(CHAIN_LABEL[chain].name)}">${chainLogo(CHAIN_LABEL[chain].logo, 15)}</span>`
              : ""
          }</div>
          <div class="name">${esc(info?.name || short(ca))}</div>
          <div class="carow">
            <a data-act="dexs" title="Open this contract on DexScreener">${short(ca)} ↗</a>
            <span data-act="copyca" title="Copy contract address">${caCopied ? `<b>copied ✓</b>` : "⧉"}</span>
          </div>
        </div>
        <div class="price"><div class="pval"><span class="live"></span>${fmtUsd(info?.priceUsd)}</div>${chgHtml}</div>
        <button class="xclose" data-act="close" title="Close (Esc)" aria-label="Close">&#10005;</button>
      </div>${ambigHtml}${statsHtml}${buzzHtml}${vtabs}`;
    const footHtml = `<div class="foot"><span>${status?.unlocked ? `${esc(status.label || "Wallet")} · ${Number(status.eth).toFixed(4)} ${esc(status.symbol || "ETH")}` : "Impulse · locked"}</span><a data-act="open">Open wallet ↗</a></div>`;

    if (view === "chart") {
      // Chart view: replaces the trading controls; back button returns.
      const cs = candles[tf];
      let rangeChg = "";
      if (cs && cs.length > 1) {
        const chgPct = (cs[cs.length - 1][4] / cs[0][1] - 1) * 100;
        rangeChg = `<span class="tfchg ${chgPct >= 0 ? "up" : "dn"}">${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(2)}%</span>`;
      }
      const tfrow = `<div class="tfrow">${["15m", "1H", "4H", "1D"]
        .map((t) => `<button class="tfbtn ${t === tf ? "on" : ""}" data-tf="${t}">${t}</button>`)
        .join("")}${rangeChg}</div>`;
      const box = chartLoading || cs === undefined
        ? `<div class="chartbox"><div class="note"><span class="spin"></span>Loading chart…</div></div>`
        : cs
          ? `<div class="chartbox">${chartSvg(cs, tf)}</div>`
          : `<div class="chartbox"><div class="note">No chart data for this token yet.</div></div>`;
      content.innerHTML = `${headHtml}${tfrow}${box}
        <div class="bar"><button class="go locked" data-act="back">← Back to trading</button></div>${footHtml}`;
    } else if (view === "safety") {
      let body: string;
      if (sec == null) {
        body = `<div class="note">Safety data unavailable for this token.</div>`;
      } else {
        const { checks, verdict } = secChecks(sec);
        body = `<div class="secbar ${verdict}" style="cursor:default">${SHIELD}<span>Safety: ${SEC_VERDICT[verdict]}</span></div>
          <div class="secgrid">${checks.map((c) => `<div class="seccell"><span>${c.label}</span><b class="${c.level}">${esc(c.value)}</b></div>`).join("")}</div>`;
      }
      content.innerHTML = `${headHtml}${body}
        <div class="bar"><button class="go locked" data-act="back">← Back to trading</button></div>${footHtml}`;
    } else if (view === "holders") {
      const k = holdTab + ":" + holdTag;
      const rows = holdCache[k];
      const tabs = `<div class="hctl">
        <div class="tfseg">
          <button data-htab="holders" class="${holdTab === "holders" ? "on" : ""}">Holders</button>
          <button data-htab="new" class="${holdTab === "new" ? "on" : ""}">New</button>
          <button data-htab="traders" class="${holdTab === "traders" ? "on" : ""}">Traders</button>
        </div>
        <div class="tfseg">
          <button data-htag="" class="${holdTag === "" ? "on" : ""}">All</button>
          <button data-htag="renowned" class="${holdTag === "renowned" ? "on" : ""}">KOL</button>
          <button data-htag="smart_degen" class="${holdTag === "smart_degen" ? "on" : ""}">Smart</button>
        </div>
      </div>`;
      let body: string;
      const tabWord = holdTab === "new" ? "new holders" : holdTab;
      if (holdBusy[k] || rows === undefined) {
        body = `<div class="note"><span class="spin"></span>Loading ${tabWord}…</div>`;
      } else if (!rows || !rows.length) {
        const why = holdErrs[k]
          ? `Couldn't load: ${esc(holdErrs[k])}`
          : holdTag ? "None found in the top 100." : "No holder data for this token yet.";
        body = `<div class="note">${why}<br/><br/><button class="amt" data-act="hretry" style="padding:7px 18px">Retry</button></div>`;
      } else {
        const pctOf = (r: any) => { const v = Number(gPick(r, ["amount_percentage"])); return isFinite(v) ? (v <= 1 ? v * 100 : v) : 0; };
        const maxPct = rows.reduce((m: number, r: any) => Math.max(m, pctOf(r)), 0);
        const kols = rows.filter((r: any) => { const t = gTags(r); return t.includes("kol") || t.includes("renowned"); }).length;
        const smart = rows.filter((r: any) => gTags(r).includes("smart_degen")).length;

        // Concentration is the number people actually come to this tab for, and
        // it was the one thing the old view never computed — you had to add up
        // a column of percentages yourself.
        //
        // GMGN often returns no supply share at all for a wallet, and summing
        // those to "0.0%" reads as "the top ten hold nothing", which is a
        // stronger claim than the data supports and the opposite of the truth.
        // Missing is shown as missing.
        const top = rows.slice(0, 10).filter((r: any) => !gIsPool(r));
        const known = top.filter((r: any) => pctOf(r) > 0);
        const top10 = known.reduce((n: number, r: any) => n + pctOf(r), 0);
        const haveEnough = known.length >= Math.max(1, Math.ceil(top.length / 2));
        const conc = !haveEnough ? "" : top10 >= 50 ? "hi" : top10 >= 25 ? "mid" : "lo";
        const summary = `<div class="hsum">
          <div class="hsumcell"><span>Top 10 hold</span><b class="${conc}" ${
            haveEnough ? "" : `title="GMGN did not report a supply share for ${top.length - known.length} of these wallets"`
          }>${haveEnough ? `${top10.toFixed(1)}%` : "—"}</b></div>
          <div class="hsumcell"><span>KOLs</span><b>${kols}</b></div>
          <div class="hsumcell"><span>Smart money</span><b>${smart}</b></div>
        </div>`;

        const PAGE = 10;
        const maxPage = Math.max(1, Math.ceil(rows.length / PAGE));
        if (holdPage >= maxPage) holdPage = maxPage - 1;
        const start = holdPage * PAGE;
        const slice = rows.slice(start, start + PAGE);
        const head = `<div class="hhead"><span>#</span><span>Wallet</span><span class="r">Supply</span><span class="r">PnL</span></div>`;
        const pager = maxPage > 1
          ? `<div class="pager">
              <button data-hpage="prev" ${holdPage === 0 ? "disabled" : ""}>‹ Prev</button>
              <span>${start + 1}–${Math.min(start + PAGE, rows.length)} of ${rows.length}</span>
              <button data-hpage="next" ${holdPage >= maxPage - 1 ? "disabled" : ""}>Next ›</button>
            </div>`
          : "";
        body = summary + head +
          slice.map((r: any, i: number) => holderRowHtml(r, start + i + 1, maxPct, chain || "robinhood")).join("") +
          pager + `<div class="gsrc">${holdTab === "traders" ? "ranked by realised profit" : holdTab === "new" ? "newest holders first" : "ranked by holdings"} · via GMGN</div>`;
      }
      content.innerHTML = `${headHtml}${tabs}${body}${footHtml}`;
    } else if (view === "ithesis") {
      // Impulse Thesis — the community's own feed, written by holders of THIS
      // token. Whoever holds ≥1 can post; everyone can read. The header is the
      // composer (setup on first use, else the write box), the list is below.
      const sym = esc(info?.symbol || "");
      const holds = h > 0;
      const fmtAgo = (ms: number) => {
        const d = Date.now() - ms;
        return d < 60_000 ? "now" : d < 3_600_000 ? Math.floor(d / 60_000) + "m"
          : d < 86_400_000 ? Math.floor(d / 3_600_000) + "h" : Math.floor(d / 86_400_000) + "d";
      };

      let composer: string;
      if (impProfile === undefined) {
        composer = `<div class="ipanel"><div class="note"><span class="spin"></span>Loading…</div></div>`;
      } else if (!holds) {
        composer = `<div class="igate">
          <span class="igateico">${SHIELD}</span>
          <div class="igatetxt"><b>Holders write the thesis</b><span>Hold at least 1 ${sym || "token"} to share why you're in.</span></div>
        </div>`;
      } else if (impSetup || impProfile === null) {
        composer = `<div class="isetup">
          <div class="ihead"><span class="ihtitle">Set up your profile</span><span class="ihsub">How you'll appear on every thesis</span></div>
          <div class="idprow">
            <span class="idpprev">${impDp ? `<img src="${impDp}" alt=""/>` : (impWallet ? authorAvatar(impWallet, null, LOGO) : "")}</span>
            <div class="idpcol">
              <label class="idpbtn">Upload photo<input type="file" accept="image/png,image/jpeg,image/webp" data-idp style="display:none"/></label>
              <span class="idphint">Optional · a square image looks best</span>
            </div>
          </div>
          <input class="iuname" data-iuname placeholder="Choose a username" maxlength="24" autocomplete="off" spellcheck="false" value="${esc(impUsername)}"/>
          <button class="go buy ifull" data-act="isaveprofile" ${impSaving ? "disabled" : ""}>${impSaving ? `<span class="spin"></span>Saving…` : "Save & continue"}</button>
          ${impMsg ? `<div class="imsg err">${esc(impMsg)}</div>` : ""}
        </div>`;
      } else {
        composer = `<div class="icompose">
          <div class="iwho">
            <span class="iwhoav">${authorAvatar(impProfile.wallet, impProfile.dp, LOGO)}</span>
            <span class="iwhoname">${esc(impProfile.username)}</span>
            <span class="ihold">${fmtNum(h)} ${sym}</span>
          </div>
          <textarea class="idraft" data-idraft maxlength="600" placeholder="Why are you holding ${sym || "this"}? Share your thesis…">${esc(impDraft)}</textarea>
          <div class="icfoot">
            <span class="ihint">Public to everyone viewing ${sym || "this token"}</span>
            <button class="go buy ipost" data-act="ipost" ${impSaving ? "disabled" : ""}>${impSaving ? `<span class="spin"></span>` : "Post thesis"}</button>
          </div>
          ${impMsg ? `<div class="imsg err">${esc(impMsg)}</div>` : ""}
        </div>`;
      }

      const items: any[] = impData?.items || [];
      let list: string;
      if (impBusy || impData === undefined) {
        list = `<div class="note"><span class="spin"></span>Loading theses…</div>`;
      } else if (!items.length) {
        list = `<div class="iempty">${impErr ? `Couldn't load: ${esc(impErr)}` : `No theses on ${sym || "this token"} yet.${holds ? "<br/>Be the first to write one." : ""}`}</div>`;
      } else {
        const label = `<div class="ilabel">Community theses<span>${items.length}</span></div>`;
        list = label + `<div class="ilist">` + items.map((it: any) => {
          const held = Number(it.holdingAmount) || 0;
          const w = esc(it.author?.wallet || "");
          return `<div class="irow2${it.mine ? " mine" : ""}">
            <div class="iav" data-iauthor="${w}" title="View wallet on explorer">${authorAvatar(it.author?.wallet || it.id, it.author?.dp, LOGO)}</div>
            <div class="ibody">
              <div class="itop">
                <span class="iname" data-iauthor="${w}" title="View wallet on explorer">${esc(it.author?.username || "anon")}</span>
                ${it.mine ? `<span class="imine">you</span>` : ""}
                <span class="iheld">${fmtNum(held)} ${sym}</span>
                <span class="iwhen">${fmtAgo(it.createdAt)}</span>
              </div>
              <div class="itext">${esc(it.text)}</div>
            </div>
          </div>`;
        }).join("") + `</div>`;
      }

      content.innerHTML = `${headHtml}${composer}${list}${footHtml}`;
    } else if (view === "callouts") {
      const fmtAgo = (ms: number) => {
        const d = Date.now() - ms;
        if (d < 60_000) return "now";
        if (d < 3_600_000) return Math.floor(d / 60_000) + "m ago";
        if (d < 86_400_000) return Math.floor(d / 3_600_000) + "h ago";
        return Math.floor(d / 86_400_000) + "d ago";
      };
      let body: string;
      if (coBusy || coData === undefined) {
        body = `<div class="note"><span class="spin"></span>Loading callouts…</div>`;
      } else if (!coData || !coData.count) {
        body = `<div class="note">${coErr ? `Couldn't load: ${esc(coErr)}` : "Nobody has called this token on pump.fun yet."}<br/><br/><button class="amt" data-act="cretry" style="padding:7px 18px">Retry</button></div>`;
      } else {
        // Ranked on the outcome: how far it ran from the price it was called at.
        // That is the one thing a callout knows that a thesis does not.
        const all = coData.items || [];
        const PAGE = 5;
        const maxPage = Math.max(1, Math.ceil(all.length / PAGE));
        if (coPage >= maxPage) coPage = maxPage - 1;
        const start = coPage * PAGE;

        const multOf = (c: any) => { const n = Number(c.multiple); return isFinite(n) && n > 0 ? n : 0; };
        const best = all.reduce((m: number, c: any) => Math.max(m, multOf(c)), 0);
        // Twenty callouts from one account is a different signal from twenty
        // accounts, and the count alone cannot tell them apart.
        const callers = new Set(all.map((c: any) => String(c.handle || c.id || "")).filter(Boolean)).size;
        // The earliest call is the one worth knowing about: it says what cap
        // this was being talked about at before the chart existed.
        const caps = all.map((c: any) => Number(c.calledAtMcap)).filter((n: number) => isFinite(n) && n > 0);
        const firstAt = caps.length ? Math.min(...caps) : 0;

        const summary = `<div class="hsum">
          <div class="hsumcell"><span>Callouts</span><b>${all.length}</b></div>
          <div class="hsumcell"><span>Best</span><b class="${best >= 1.05 ? "lo" : ""}">${
            best > 0 ? `${best.toFixed(best >= 10 ? 0 : 1)}x` : "—"}</b></div>
          <div class="hsumcell"><span>Callers</span><b>${callers || "—"}</b></div>
        </div>`;
        const label = `<div class="tclabel">${PUMP_MARK}<span>Callouts</span>` +
          `<span class="r">${firstAt > 0 ? `earliest at ${fmtCompact(firstAt)} cap` : ""}</span></div>`;

        const rows = all.slice(start, start + PAGE).map((c: any, i: number) => {
          const rank = start + i + 1;
          const mult = multOf(c);
          // 1x is break-even, not zero — a call that went nowhere should read
          // neutral rather than green.
          const cls = mult === 0 ? "" : mult >= 1.05 ? "up" : mult <= 0.95 ? "dn" : "";
          const w = best > 0 && mult > 0 ? Math.max(1.5, Math.min(100, (mult / best) * 100)) : 0;
          const figure = mult > 0
            ? `<span class="tcpos ${cls}">${mult.toFixed(mult >= 10 ? 0 : 1)}x</span>` +
              `<span class="tckind">since call</span>`
            : `<span class="tcpos mut">no result yet</span>`;
          const at = c.calledAtMcap
            ? `<span class="tcat">called at ${fmtCompact(c.calledAtMcap)}</span>` : "";
          const av = authorAvatar(c.handle || c.id, c.avatar, PUMP_MARK_SM);
          const x = c.xHandle
            ? `<a class="tcx" href="https://x.com/${encodeURIComponent(c.xHandle)}" target="_blank" rel="noopener noreferrer">@${esc(c.xHandle)}</a>`
            : "";
          return `<div class="tcard ${cls}">
            <span class="hfill" style="width:${w.toFixed(1)}%"></span>
            <div class="tctop">
              <span class="tcrank">${rank}</span>${av}
              <span class="tcname">${esc(c.handle || "unknown")}</span>
              ${c.verified ? `<span class="tcver" title="Verified on pump.fun">✓</span>` : ""}
              ${x}
              <span class="tcwhen">${c.createdAt ? fmtAgo(Number(c.createdAt)) : ""}</span>
            </div>
            <div class="tcnum">${figure}${at}</div>
            ${c.text ? `<div class="tctext">${linkify(c.text)}</div>` : ""}
            ${c.peakAt ? `<div class="tcfoot"><span class="tstat">peaked ${fmtAgo(Number(c.peakAt))}</span></div>` : ""}
          </div>`;
        }).join("");

        const pager = maxPage > 1
          ? `<div class="pager">
              <button data-cpage="prev" ${coPage === 0 ? "disabled" : ""}>‹ Prev</button>
              <span>${start + 1}–${Math.min(start + PAGE, all.length)} of ${all.length}</span>
              <button data-cpage="next" ${coPage >= maxPage - 1 ? "disabled" : ""}>Next ›</button>
            </div>`
          : "";
        body = summary + label + rows + pager +
          `<div class="gsrc">ranked by multiple since the call · via pump.fun</div>`;
      }
      content.innerHTML = `${headHtml}${body}
        <div class="bar" style="margin-top:10px"><button class="go locked" data-act="back">← Back to trading</button></div>${footHtml}`;
    } else if (view === "fomo") {
      const fmtAgo = (ms: number) => {
        const d = Date.now() - ms;
        if (d < 60_000) return "now";
        if (d < 3_600_000) return Math.floor(d / 60_000) + "m ago";
        if (d < 86_400_000) return Math.floor(d / 3_600_000) + "h ago";
        return Math.floor(d / 86_400_000) + "d ago";
      };
      let body: string;
      if (fomoBusy || fomoData === undefined) {
        body = `<div class="note"><span class="spin"></span>Loading theses…</div>`;
      } else if (!fomoData || !fomoData.count) {
        body = `<div class="note">${fomoErr ? `Couldn't load: ${esc(fomoErr)}` : "No trader has written a thesis on this token yet."}<br/><br/><button class="amt" data-act="fretry" style="padding:7px 18px">Retry</button></div>`;
      } else {
        // Ranked by the size of the position behind the words, not by recency.
        // Conviction is cheap to type and expensive to hold, and sorting on the
        // position is what separates this from a comment section.
        const all = fomoData.items || [];
        const PAGE = 5;
        const maxPage = Math.max(1, Math.ceil(all.length / PAGE));
        if (fomoPage >= maxPage) fomoPage = maxPage - 1;
        const start = fomoPage * PAGE;

        const posOf = (t: any) => { const v = Number(t.positionUsd); return isFinite(v) && v > 0 ? v : 0; };
        const totalHeld = all.reduce((n: number, t: any) => n + posOf(t), 0);
        const maxPos = all.reduce((m: number, t: any) => Math.max(m, posOf(t)), 0);

        // The two numbers that decide whether this tab is worth reading: how
        // much money stands behind the theses, and whether that is one whale
        // or a crowd.
        const summary = `<div class="hsum">
          <div class="hsumcell"><span>Theses</span><b>${all.length}</b></div>
          <div class="hsumcell"><span>Backed by</span><b>${totalHeld > 0 ? fmtCompact(totalHeld) : "—"}</b></div>
          <div class="hsumcell"><span>Largest</span><b>${maxPos > 0 ? fmtCompact(maxPos) : "—"}</b></div>
        </div>`;
        const label = `<div class="tclabel">${FOMO_MARK}<span>Trader theses</span>` +
          `<span class="r">${esc(fomoData.symbol || "")}</span></div>`;

        const HEART = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.5-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.5-7 9-7 9z"/></svg>`;
        const REPLY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.3A8 8 0 1 1 21 12z"/></svg>`;

        const rows = all.slice(start, start + PAGE).map((t: any, i: number) => {
          const rank = start + i + 1;
          const pct = t.pnlPct;
          const up = pct == null ? true : Number(pct) >= 0;
          const pos = posOf(t);
          // Position as the card's width, scaled to the largest on screen — the
          // same reading the holders table asks for.
          const w = maxPos > 0 && pos > 0 ? Math.max(1.5, Math.min(100, (pos / maxPos) * 100)) : 0;
          // "holds" and "traded" are different claims: one is money still at
          // risk, the other is money that was committed and may already be out.
          // Saying the wrong one would misrepresent the author.
          const held = pos > 0
            ? `<span class="tckind">${t.positionKind === "traded" ? "traded" : "holds"}</span>` +
              `<span class="tcpos">${fmtCompact(pos)}</span>`
            : `<span class="tcpos mut">position not reported</span>`;
          const move = pct == null ? ""
            : `<span class="tcpct ${up ? "up" : "dn"}">${up ? "+" : "−"}${Math.abs(Number(pct)).toFixed(1)}%</span>`;
          // Realised profit is a different claim from an open position — they
          // have already taken some off the table.
          const took = t.realizedPnlUsd
            ? `<span class="tctook">took ${fmtCompact(t.realizedPnlUsd)}</span>` : "";
          const av = authorAvatar(t.authorId || t.authorHandle || "?", t.avatar);
          return `<div class="tcard">
            <span class="hfill" style="width:${w.toFixed(1)}%"></span>
            <div class="tctop">
              <span class="tcrank">${rank}</span>${av}
              <span class="tcname">${esc(t.authorName || t.authorHandle || "unknown")}</span>
              ${t.authorIsDev ? `<span class="htag kol">DEV</span>` : ""}
              <span class="tcwhen">${t.createdAt ? fmtAgo(Number(t.createdAt)) : ""}</span>
              ${/^[A-Za-z0-9_]{1,15}$/.test(String(t.authorHandle || "")) ? `<button class="tcfollow" data-follow="${esc(t.authorHandle)}" title="Copytrade @${esc(t.authorHandle)}">Follow</button>` : ""}
            </div>
            <div class="tcnum">${held}${move}${took}</div>
            ${t.thesis ? `<div class="tctext">${linkify(t.thesis)}</div>` : ""}
            <div class="tcfoot">
              <span class="tstat">${HEART}${t.likeCount || 0}</span>
              ${t.replyCount ? `<span class="tstat">${REPLY}${t.replyCount}</span>` : ""}
            </div>
          </div>`;
        }).join("");

        const pager = maxPage > 1
          ? `<div class="pager">
              <button data-fpage="prev" ${fomoPage === 0 ? "disabled" : ""}>‹ Prev</button>
              <span>${start + 1}–${Math.min(start + PAGE, all.length)} of ${all.length}</span>
              <button data-fpage="next" ${fomoPage >= maxPage - 1 ? "disabled" : ""}>Next ›</button>
            </div>`
          : "";
        body = summary + label + rows + pager +
          `<div class="gsrc">ranked by position size · via FOMO</div>`;
      }
      content.innerHTML = `${headHtml}${body}
        <div class="bar" style="margin-top:10px"><button class="go locked" data-act="back">← Back to trading</button></div>${footHtml}`;
    } else if (view === "bubbles") {
      // Holder bubble map (Bubblemaps) via our CSP-exempt extension page.
      const src = chrome.runtime.getURL(`bubble.html?ca=${encodeURIComponent(ca)}`);
      content.innerHTML = `${headHtml}
        <div class="bubblebox"><iframe class="bubbleframe" src="${src}" allow="clipboard-write"></iframe></div>
        <div class="gsrc">holder bubble map</div>
        <div class="bar"><button class="go locked" data-act="back">← Back to trading</button></div>${footHtml}`;
    } else {
      content.innerHTML = `${headHtml}${socialsHtml}${secbar}${inlineChart}${holdHtml}${seg}${action}${footHtml}`;
      ensureCandles();
      ensureQuote();
    }

    // Only real input counts. A synthetic .click() from page script reports
    // isTrusted === false, so even if the page reaches a control it cannot
    // drive a trade. Closing the shadow root is the lock; this is the bolt.
    const bind = (sel: string, fn: (el: HTMLElement) => void) =>
      content.querySelectorAll<HTMLElement>(sel).forEach((el) =>
        el.addEventListener("click", (ev) => { if (ev.isTrusted) fn(el); }),
      );
    bind("[data-dir]", (el) => { dir = el.dataset.dir as any; if (phase === "error") phase = "ready"; render(); });
    bind("[data-amt]", (el) => { amount = el.dataset.amt!; if (phase === "error") phase = "ready"; ensureQuote(); render(); });
    bind("[data-pct]", (el) => { pct = Number(el.dataset.pct); if (phase === "error") phase = "ready"; render(); });
    bind('[data-act="buy"]', doBuy);
    bind('[data-act="sell"]', doSell);
    bind("[data-tf]", (el) => { tf = el.dataset.tf!; ensureCandles(); render(); });
    bind('[data-act="back"]', () => { view = "trade"; render(); });
    bind('[data-act="close"]', () => closeDrawer());
    bind('[data-act="safety"]', () => { view = "safety"; render(); });
    bind('[data-act="holders"]', () => { view = "holders"; ensureHolders(); render(); });
    bind('[data-act="bubbles"]', () => { view = "bubbles"; render(); });
    bind("[data-htab]", (el) => { holdTab = el.dataset.htab as any; holdPage = 0; ensureHolders(); render(); });
    bind("[data-htag]", (el) => { holdTag = el.dataset.htag || ""; holdPage = 0; ensureHolders(); render(); });
    bind("[data-hpage]", (el) => { holdPage += el.dataset.hpage === "next" ? 1 : -1; if (holdPage < 0) holdPage = 0; render(); });
    bind('[data-act="hretry"]', () => { ensureHolders(true); render(); });
    if (FOMO_ENABLED) bind('[data-act="fomo"]', () => { view = "fomo"; ensureFomo(); render(); });
    if (CALLOUTS_ENABLED) bind('[data-act="callouts"]', () => { view = "callouts"; ensureCallouts(); render(); });
    bind('[data-act="ithesis"]', () => { view = "ithesis"; impMsg = ""; ensureImpulse(); render(); });
    bind('[data-act="isaveprofile"]', () => {
      const username = impUsername.trim();
      if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) { impMsg = "Username must be 3–24 letters, numbers or _"; render(); return; }
      impSaving = true; impMsg = ""; render();
      send({ type: "STRIX_ITHESIS_SETPROFILE", username, dp: impDp }).then((r: any) => {
        impSaving = false;
        if (r?.error) { impMsg = String(r.error); render(); return; }
        impProfile = r?.v || null; impSetup = false; impDp = null; impMsg = ""; render();
      }).catch((e: any) => { impSaving = false; impMsg = String(e?.message || e); render(); });
    });
    bind("[data-iauthor]", (el) => {
      const addr = el.getAttribute("data-iauthor");
      if (!addr) return;
      const exp = CHAIN_LABEL[chain || "robinhood"] || CHAIN_LABEL.robinhood;
      window.open(`${exp.explorer}/address/${addr}`, "_blank", "noopener,noreferrer");
    });
    bind('[data-act="ipost"]', () => {
      const text = impDraft.trim();
      if (text.length < 3) { impMsg = "Write a little more — say why you're in."; render(); return; }
      const priceUsd = Number(info?.priceUsd) || 0;
      impSaving = true; impMsg = ""; render();
      send({ type: "STRIX_ITHESIS_WRITE", ca, chain: chain || chainHint || null, text, holdingAmount: h, holdingUsd: priceUsd ? h * priceUsd : null }).then((r: any) => {
        impSaving = false;
        if (r?.error) { impMsg = String(r.error); render(); return; }
        if (impData?.items) impData.items.unshift(r.v); else impData = { items: [r.v], count: 1 };
        impDraft = ""; impMsg = ""; render();
      }).catch((e: any) => { impSaving = false; impMsg = String(e?.message || e); render(); });
    });
    bind('[data-act="cretry"]', () => ensureCallouts(true));
    bind("[data-cpage]", (el: any) => {
      const max = Math.max(1, Math.ceil((coData?.items?.length || 0) / 5));
      coPage += el.dataset.cpage === "next" ? 1 : -1;
      coPage = Math.max(0, Math.min(max - 1, coPage));
      const need = (coData?.items || []).slice(coPage * 5, coPage * 5 + 5)
        .filter((c: any) => c && c.avatar == null && c.avatarUrl);
      if (need.length) {
        send({ type: "STRIX_CALLOUT_AVATARS", urls: need.map((c: any) => c.avatarUrl) })
          .then((r: any) => {
            if (!r?.avatars) return;
            for (const c of coData?.items || []) {
              if (c.avatar == null && r.avatars[c.avatarUrl]) c.avatar = r.avatars[c.avatarUrl];
            }
            if (view === "callouts") render();
          }).catch(() => {});
      }
      render();
    });
    bind('[data-act="fretry"]', () => { ensureFomo(true); render(); });
    // Copytrade a FOMO trader: open the wallet's Copytrade screen with the handle
    // prefilled (funding + confirmation happen there, not on someone else's page).
    bind("[data-follow]", (el) => {
      const h = el.getAttribute("data-follow");
      if (h) send({ type: "STRIX_OPEN_COPY", handle: h });
    });
    bind("[data-fpage]", (el) => {
      fomoPage += el.dataset.fpage === "next" ? 1 : -1;
      if (fomoPage < 0) fomoPage = 0;
      // Pictures are resolved a page at a time, so ask for this page's before
      // it renders. Rows appear immediately either way; the avatars fill in.
      const need = (fomoData?.items || []).slice(fomoPage * 5, fomoPage * 5 + 5)
        .filter((t: any) => t && t.avatar == null && t.authorHandle);
      if (need.length) {
        send({ type: "STRIX_FOMO_AVATARS", handles: need.map((t: any) => t.authorHandle) })
          .then((r: any) => {
            if (!r?.avatars) return;
            for (const t of fomoData?.items || []) {
              if (t.avatar == null && r.avatars[t.authorHandle]) t.avatar = r.avatars[t.authorHandle];
            }
            if (view === "fomo") render();
          })
          .catch(() => {});
      }
      render();
    });
    bind('[data-act="again"]', () => { phase = "ready"; hash = ""; refreshHolding(); render(); });
    bind('[data-act="dexs"]', () => {
      // Token-address form; DexScreener redirects it to the deepest pair.
      window.open(`https://dexscreener.com/robinhood/${ca}`, "_blank", "noopener,noreferrer");
    });
    bind('[data-act="copyca"]', () => {
      navigator.clipboard?.writeText(ca).then(() => {
        caCopied = true; render();
        setTimeout(() => { caCopied = false; if (panel.isConnected && phase !== "busy" && !editing) render(); }, 1500);
      });
    });
    bind('[data-act="unlock"]', () => send({ type: "STRIX_OPEN" }));
    bind('[data-act="open"]', () => send({ type: "STRIX_OPEN_TRADE", ca }));

    // Custom amount / percent — edit without re-rendering so focus is kept.
    const cbuy = panel.querySelector<HTMLInputElement>("[data-cbuy]");
    if (cbuy) {
      cbuy.addEventListener("focus", () => { editing = true; });
      cbuy.addEventListener("blur", () => { editing = false; });
      cbuy.addEventListener("input", () => {
        amount = cbuy.value.replace(/[^\d.]/g, "");
        const btn = panel.querySelector<HTMLButtonElement>(".go.buy");
        if (btn && phase !== "busy") { btn.textContent = `Buy ${amount || "0"} ETH`; btn.disabled = !(Number(amount) > 0); }
        panel.querySelectorAll<HTMLElement>("[data-amt]").forEach((b) => b.classList.toggle("on", b.dataset.amt === amount));
        ensureQuote();
      });
    }
    // Impulse Thesis inputs: keep the typed text in state (so a re-render never
    // wipes it) and set `editing` so the 20s tick does not re-render mid-type.
    const iuname = panel.querySelector<HTMLInputElement>("[data-iuname]");
    if (iuname) {
      iuname.addEventListener("focus", () => { editing = true; });
      iuname.addEventListener("blur", () => { editing = false; });
      iuname.addEventListener("input", () => { impUsername = iuname.value; });
    }
    const idraft = panel.querySelector<HTMLTextAreaElement>("[data-idraft]");
    if (idraft) {
      idraft.addEventListener("focus", () => { editing = true; });
      idraft.addEventListener("blur", () => { editing = false; });
      idraft.addEventListener("input", () => { impDraft = idraft.value; });
    }
    const idp = panel.querySelector<HTMLInputElement>("[data-idp]");
    if (idp) idp.addEventListener("change", () => {
      const f = idp.files?.[0];
      if (!f) return;
      if (f.size > 6_000_000) { impMsg = "Image too large (max 6MB)."; render(); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          // Cover-crop to a 128×128 square and re-encode small, so the stored
          // data URI stays well under the backend's limit.
          const c = document.createElement("canvas");
          c.width = 128; c.height = 128;
          const g = c.getContext("2d");
          if (!g) return;
          const s = Math.min(img.width, img.height);
          g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
          try { impDp = c.toDataURL("image/jpeg", 0.85); } catch { impDp = null; }
          render();
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(f);
    });

    const csell = panel.querySelector<HTMLInputElement>("[data-csell]");
    if (csell) {
      csell.addEventListener("focus", () => { editing = true; });
      csell.addEventListener("blur", () => { editing = false; });
      csell.addEventListener("input", () => {
        pct = Math.max(0, Math.min(100, Math.floor(Number(csell.value) || 0)));
        const btn = panel.querySelector<HTMLButtonElement>(".go.sell");
        if (btn && phase !== "busy") { btn.textContent = `Sell ${pct}% ${info?.symbol || ""}`; btn.disabled = h <= 0 || pct <= 0; }
        panel.querySelectorAll<HTMLElement>("[data-pct]").forEach((b) => b.classList.toggle("on", Number(b.dataset.pct) === pct));
      });
    }
  };

  async function load() {
    const [t, s, pr] = await Promise.all([
      send({ type: "STRIX_TOKEN", ca, chain }),
      send({ type: "STRIX_STATUS", chain }),
      send({ type: "STRIX_PAIR", ca, chain }),
    ]);
    status = s;
    pairAddr = pr?.pair || null;
    // The background resolves the chain when we did not know it; keep the
    // answer so every later call (quote, holding, buy, sell) agrees.
    if (t?.chain) chain = t.chain;
    if (!t?.info) { phase = "notfound"; render(); return; }
    info = t.info;
    phase = "ready";
    render();
    // Opened straight to a data view (from the overlay strip icons)? Kick its fetch.
    if (view === "holders") ensureHolders();
    // GMGN extras (non-blocking): safety verdict + socials.
    if (chain && chain !== "robinhood") { sec = null; ginfo = null; }
    else send({ type: "STRIX_GMGN", what: "security", ca }).then((r) => {
      if (r?.noKey) { gmgnKey = false; sec = null; } else sec = r?.error ? null : r?.data ?? null;
      if (view === "trade" || view === "safety") render();
    });
    send({ type: "STRIX_GMGN", what: "info", ca }).then((r) => {
      if (r?.noKey) gmgnKey = false;
      else if (!r?.error && r?.data) { ginfo = r.data; if (view === "trade") render(); }
    });
    if (info.logo) send({ type: "STRIX_IMAGE", url: info.logo }).then((r) => { if (r?.data) { logoData = r.data; render(); } });
    // Popularity (non-blocking): the open we just tracked is already counted, so
    // this reflects it. Cheap and cached-friendly on the backend.
    send({ type: "STRIX_ISTATS", ca }).then((r: any) => {
      const v = r && "v" in r ? r.v : null;
      if (v && (v.opened || v.seen)) { impStats = v; render(); }
    }).catch(() => {});
    refreshHolding();
    // Live: refresh price + status every 20s while open.
    timer = setInterval(tick, 20_000);
  }
  async function refreshHolding() {
    holding = await send({ type: "STRIX_HOLDING", ca, chain });
    render();
  }
  async function tick() {
    if (!panel.isConnected) { clearInterval(timer); return; }
    const [t, s] = await Promise.all([send({ type: "STRIX_TOKEN", ca, chain }), send({ type: "STRIX_STATUS", chain })]);
    if (t?.info) info = t.info;
    status = s;
    // Skip re-render in the bubbles view — it would reload the vendor iframe.
    if (phase !== "busy" && !editing && view !== "bubbles") render();
  }

  // Log a completed trade for the profit leaderboard. Best-effort and
  // fire-and-forget — a failed log must never affect the trade itself.
  function logTrade(side: "buy" | "sell", tokenAmount: number) {
    const priceUsd = Number(info?.priceUsd) || 0;
    if (!(tokenAmount > 0) || !(priceUsd > 0)) return;
    send({
      type: "STRIX_ILOG", ca, chain: chain || chainHint || null,
      symbol: info?.symbol || "", side, tokenAmount, priceUsd,
      usdValue: tokenAmount * priceUsd,
    }).catch(() => {});
  }

  async function doBuy() {
    phase = "busy"; message = "Confirming…"; render();
    // Capture the expected token amount from the live quote before it clears.
    const dec = Number(info?.decimals) || 18;
    const boughtTokens = quote?.expectedOut && quote.expectedOut !== "0"
      ? Number(quote.expectedOut) / 10 ** dec : 0;
    const r = await send({ type: "STRIX_BUY", ca, amountEth: amount, chain });
    if (r?.error === "locked") { status = { unlocked: false }; phase = "ready"; render(); return; }
    if (r?.error) { phase = "error"; message = r.error; render(); return; }
    hash = r.hash; phase = "done"; render();
    logTrade("buy", boughtTokens);
    status = await send({ type: "STRIX_STATUS", chain }); refreshHolding();
  }
  async function doSell() {
    phase = "busy"; message = "Confirming…"; render();
    // Tokens sold = the current holding times the percentage.
    const soldTokens = (Number(holding?.amount) || 0) * (Math.max(0, Math.min(100, pct)) / 100);
    const r = await send({ type: "STRIX_SELL", ca, pct, chain });
    if (r?.error === "locked") { status = { unlocked: false }; phase = "ready"; render(); return; }
    if (r?.error) { phase = "error"; message = r.error; render(); return; }
    hash = r.hash; phase = "done"; render();
    logTrade("sell", soldTokens);
    status = await send({ type: "STRIX_STATUS", chain }); refreshHolding();
  }

  render();
  load();
}

async function resolveAndMount(sym: string, node: Element) {
  // Non-stock cashtag: ask the background to find a Robinhood Chain token with
  // that exact symbol (deepest liquidity). Mount only if one actually exists.
  const r = await send({ type: "STRIX_TICKER", symbol: sym });
  // Flagged as cashtag-resolved: the address was inferred from a symbol, so the
  // panel carries a "verify the contract" notice. Pinned stock tickers don't —
  // those addresses are hardcoded, not guessed.
  if (r?.address && node.isConnected) mountHost(r.address, node, `Buy $${sym}`, true, r.chain || null);
}

/**
 * Confirm an address is a tradable token before offering to trade it.
 *
 * Wallet addresses get posted constantly — tip jars, "gm send here", scam
 * bait — and putting a Buy button under someone's personal address is at best
 * noise and at worst dangerous. The background checks for bytecode and an
 * ERC-20 interface; anything else is silently ignored.
 *
 * Answers are cached per page so scrolling past the same address repeatedly
 * costs one lookup, not one per scan.
 */
const tokenChecked = new Map<string, Promise<boolean>>();
/** Chain each verified address was found on, so the panel opens on the right
 *  network instead of re-resolving it. */
const tokenChains = new Map<string, string>();
function isToken(ca: string, chainHint?: string): Promise<boolean> {
  const key = ca.toLowerCase();
  const hit = tokenChecked.get(key);
  if (hit) return hit;

  const p = send({ type: "STRIX_ISTOKEN", ca, chain: chainHint })
    .then((r) => {
      // "Could not reach the worker" is not the same answer as "not a token",
      // and only the second one may be remembered. send() resolves rather than
      // rejects on a transport failure, so a missing `ok` used to be cached as
      // false — and one cold service worker at page load then disabled the
      // button for that address for the entire life of the page. A dynamically
      // registered script hits exactly that race, which is why this showed up
      // on Telegram and never on X.
      dlog("STRIX_ISTOKEN", ca, "->", JSON.stringify(r));
      if (r?.error || typeof r?.ok !== "boolean") {
        tokenChecked.delete(key);
        return false;
      }
      if (r.chain) tokenChains.set(key, r.chain);
      return r.ok;
    })
    .catch(() => {
      tokenChecked.delete(key);
      return false;
    });

  tokenChecked.set(key, p);
  return p;
}

/** Mount only once the address is known to be a token. */
async function mountIfToken(ca: string, node: Element, label?: string, chainHint?: string) {
  const ok = await isToken(ca, chainHint);
  if (!ok) { dlog("mountIfToken:", ca, "-> STRIX_ISTOKEN said no, not mounting"); return; }
  if (!node.isConnected) { dlog("mountIfToken:", ca, "-> node left the DOM while checking"); return; }
  const chain = tokenChains.get(ca.toLowerCase()) || chainHint || null;
  dlog("mountIfToken:", ca, "-> mounting, chain =", chain);
  mountHost(ca, node, label, false, chain);
}

function scanNode(node: Element, text: string) {
  // Cashtags first: our supported stocks resolve instantly; everything else is
  // looked up on Robinhood Chain via DexScreener.
  const tickers = new Set<string>();
  for (const m of text.matchAll(TICKER_RE)) tickers.add(m[1].toUpperCase());
  const stocks: string[] = [];
  const others: string[] = [];
  for (const sym of tickers) {
    if (STOCK_TICKERS[sym]) stocks.push(sym);
    else if (sym.length >= 2 && !TICKER_SKIP.has(sym)) others.push(sym);
  }
  const hasTicker = stocks.length > 0 || others.length > 0;

  // Raw addresses ONLY when there's no ticker in the same post: a $TICKER and a
  // contract in one post are the same token, so we prefer the human-readable
  // ticker and skip mounting a second pill for the CA. (Verified before mounting
  // either way, so a wallet address never becomes a Buy button.)
  if (!hasTicker) {
    const addrs = Array.from(new Set(text.match(ADDR_RE) || []));
    if (DEBUG) dlog("scanNode: addresses =", addrs);
    addrs.slice(0, 2).forEach((ca) => { void mountIfToken(ca, node); });
    if (!addrs.length) {
      const mints = Array.from(new Set(text.match(SOL_RE) || [])).filter(looksLikeMint);
      mints.slice(0, 2).forEach((mint) => { void mountIfToken(mint, node, undefined, "solana"); });
    }
  }

  // Pinned stock addresses are known good — no check needed.
  stocks.slice(0, 2).forEach((sym) => mountHost(STOCK_TICKERS[sym], node, `Buy $${sym}`));
  others.slice(0, 2).forEach((sym) => resolveAndMount(sym, node));
}

/* ── addresses in the URL ──────────────────────────────────────────────────
   Token pages put the contract in the address bar: Pons, DexScreener,
   DexTools, pump.fun, GeckoTerminal, Birdeye, block explorers. On those pages
   the address often never appears as plain text at all — it sits inside a
   link, a truncated "0xb42f…538f" label, or a copy button — so the text
   scanner finds nothing and the user gets no buy button on the one page that
   is entirely about that token.

   This reads the address straight out of location, and mounts a floating dock
   rather than an inline pill because there is no post to sit under. */

// Non-global: matched with .test() against single segments, and a /g/ regex
// would carry lastIndex between calls and alternate its answer.
const URL_EVM = /^0x[a-fA-F0-9]{40}$/;
const URL_SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Chain hint from the site itself, so a Solana mint is not looked up on
 *  Robinhood first. Matched as a hostname suffix. */
const SITE_CHAIN: [RegExp, string][] = [
  [/(^|\.)ponsfamily\.com$/, "robinhood"],
  [/(^|\.)robinhoodchain\.blockscout\.com$/, "robinhood"],
  [/(^|\.)pump\.fun$/, "solana"],
  [/(^|\.)solscan\.io$/, "solana"],
  [/(^|\.)birdeye\.so$/, "solana"],
  [/(^|\.)etherscan\.io$/, "eth"],
  [/(^|\.)basescan\.org$/, "base"],
];

/** Chain named in the path, the form DexScreener, DexTools and GeckoTerminal
 *  use: /solana/<pair>, /ether/<pair>, /base/<pair>. */
const PATH_CHAIN: Record<string, string> = {
  solana: "solana", sol: "solana",
  ethereum: "eth", ether: "eth", eth: "eth",
  base: "base",
  robinhood: "robinhood", rh: "robinhood",
};

/** Query keys that carry a contract address on the sites we care about. */
const CA_PARAMS = ["ca", "address", "token", "tokenAddress", "mint", "contract", "outputCurrency", "a"];

type UrlHit = { ca: string; chain: string | null; pair?: boolean };

/** Sites that route by liquidity pool, not by token: the address in the URL is
 *  a pair/pool, so it must be resolved to its base token before trading. */
const PAIR_HOST = /(^|\.)(dexscreener\.com|dextools\.io|geckoterminal\.com)$/;
/** A pool address on these sites: an EVM contract/poolId (0x + 40 or more hex,
 *  so a 64-hex Robinhood V4 poolId counts) or a base58 pool on Solana. */
const isPoolAddr = (s: string) => /^0x[a-fA-F0-9]{40,}$/.test(s) || (URL_SOL.test(s) && looksLikeMint(s));

/**
 * The token this page is about, read from its URL, or null.
 *
 * Path segments first (the canonical form on every launchpad and scanner),
 * then query parameters, then the fragment — some routers keep the address
 * only in the hash.
 */
function urlToken(href: string): UrlHit | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }

  let chain: string | null = null;
  for (const [re, c] of SITE_CHAIN) if (re.test(u.hostname)) { chain = c; break; }

  const segs = u.pathname.split("/").filter(Boolean);
  for (const seg of segs) {
    const c = PATH_CHAIN[seg.toLowerCase()];
    if (c) { chain = c; break; }
  }

  // On pool-routed sites the trailing address is the pair, not the token — hand
  // it back flagged so the caller resolves it. GeckoTerminal also has real token
  // pages (/tokens/<ca>); those trade the address directly.
  if (PAIR_HOST.test(u.hostname)) {
    const last = segs[segs.length - 1] || "";
    if (isPoolAddr(last)) {
      const tokenPage = segs.some((s) => s.toLowerCase() === "tokens");
      return tokenPage ? { ca: last, chain } : { ca: last, chain, pair: true };
    }
  }

  const consider = (raw: string | null | undefined): UrlHit | null => {
    const v = (raw || "").trim();
    if (!v) return null;
    if (URL_EVM.test(v)) return { ca: v, chain };
    // Base58 also matches ordinary path words, so a Solana mint has to show the
    // same mixed-case shape the text scanner demands before it is worth a call.
    if (URL_SOL.test(v) && looksLikeMint(v)) return { ca: v, chain: chain || "solana" };
    return null;
  };

  // Last segment first: /launchpad/<ca> and /solana/<pair> both put it at the end.
  for (let i = segs.length - 1; i >= 0; i--) {
    const hit = consider(segs[i]);
    if (hit) return hit;
  }
  for (const k of CA_PARAMS) {
    const hit = consider(u.searchParams.get(k));
    if (hit) return hit;
  }
  if (u.hash) {
    for (const part of u.hash.replace(/^#\/?/, "").split(/[/?&=]/)) {
      const hit = consider(part);
      if (hit) return hit;
    }
  }
  return null;
}

/* ── trader lookup on an X profile ─────────────────────────────────────────
   Standing on someone's profile, the useful question is not what token is on
   screen — there isn't one — but whether this person trades, and how well. If
   FOMO or pump.fun knows the handle, a button offers to show it. */

/** Paths that are X's own, not people. A profile dock must never mount on one. */
const X_RESERVED = new Set([
  "home", "explore", "notifications", "messages", "compose", "search", "settings",
  "i", "intent", "share", "login", "logout", "signup", "tos", "privacy", "about",
  "download", "jobs", "hashtag", "topics", "lists", "bookmarks", "communities",
  "premium_sign_up", "account", "help", "status",
]);

/** Sub-pages that still belong to the profile above them. */
const X_PROFILE_TABS = new Set([
  "", "with_replies", "highlights", "articles", "media", "likes", "affiliates",
  "superfollows", "photo", "header_photo",
]);

/** The handle whose profile this URL shows, or null if it is not a profile. */
function xProfileHandle(href: string): string | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }
  if (!/(^|\.)(x|twitter)\.com$/.test(u.hostname)) return null;
  const segs = u.pathname.split("/").filter(Boolean);
  if (!segs.length || segs.length > 2) return null;
  const handle = segs[0];
  if (X_RESERVED.has(handle.toLowerCase())) return null;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (segs.length === 2 && !X_PROFILE_TABS.has(segs[1].toLowerCase())) return null;
  return handle;
}

/* ── a token named in the profile bio ──────────────────────────────────────
   Projects put the contract in the bio, not in a tweet — it is the one place
   it stays put while the timeline moves. The tweet scanner never sees it,
   because the bio is not a tweet, so a project account could sit there with
   its address on screen and no way to trade it.

   Read from the bio's text nodes rather than textContent: X renders the bio as
   a run of spans and emoji images, and textContent joins them with nothing at
   all, so "CA:" fused to the address and the trailing-character guard in
   ADDR_RE then rejected the match. Exactly the bug that hid the button on
   Telegram. Links in the bio are deliberately not followed: X truncates their
   display text to an ellipsis and rewrites the href to t.co, so neither half
   holds a full address, and guessing from a truncated one would be worse than
   not offering. */

type BioToken = { ca: string; chain: string | null; label: string; viaCashtag: boolean };

/** Resolve once `sel` exists, or null after `ms`. */
function waitFor(sel: string, ms = 4000): Promise<Element | null> {
  const hit = document.querySelector(sel);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const done = (el: Element | null) => { clearTimeout(t); ob.disconnect(); resolve(el); };
    const ob = new MutationObserver(() => {
      const el = document.querySelector(sel);
      if (el) done(el);
    });
    const t = setTimeout(() => done(null), ms);
    ob.observe(document.body, { childList: true, subtree: true });
  });
}

function xProfileBioText(): string {
  const parts: string[] = [];
  // The bio itself, plus the row under it — location, join date and the
  // website field, which is where the other half of these accounts put it.
  for (const sel of ['[data-testid="UserDescription"]', '[data-testid="UserProfileHeader_Items"]']) {
    document.querySelectorAll(sel).forEach((el) => parts.push(nodeText(el)));
  }
  return parts.join(String.fromCharCode(10));
}

/**
 * The first tradable token named in the bio, or null.
 *
 * Addresses are tried before cashtags because an address IS the token, while a
 * cashtag is a symbol that several tokens can share and has to be guessed at.
 * Offering the guess when the certainty is sitting in the same sentence would
 * be choosing the worse of two answers.
 *
 * Every candidate still goes through the same verification a tweet's would:
 * STRIX_ISTOKEN for an address, the liquidity floors in resolveTicker for a
 * symbol. A bio is not a trusted source just because it is a bio.
 */
async function findBioToken(handle: string): Promise<BioToken | null> {
  // X is a single-page app, so the URL changes before the new profile renders.
  // Reading straight away returns the PREVIOUS account's bio — which would put
  // a buy button for one person's token on somebody else's profile, the worst
  // way this feature could be wrong. So: wait for the header, then confirm the
  // handle it renders is the one we were asked about before reading a word.
  const head = await waitFor('[data-testid="UserName"]');
  if (!head) return null;
  if (!nodeText(head).toLowerCase().includes("@" + handle.toLowerCase())) return null;

  const text = xProfileBioText();
  if (!text) return null;

  const evm = text.match(ADDR_RE) || [];
  const sol = (text.match(SOL_RE) || []).filter(looksLikeMint);
  for (const ca of [...evm, ...sol].slice(0, 4)) {
    if (await isToken(ca)) {
      return { ca, chain: tokenChains.get(ca.toLowerCase()) || null, label: "Buy this token", viaCashtag: false };
    }
  }

  // Cashtags, in the order written. A bio commonly names the account's own
  // ticker first and the chains it trades on after.
  const tags: string[] = [];
  for (const m of text.matchAll(TICKER_RE)) if (m[1]) tags.push(m[1]);
  for (const sym of tags.slice(0, 3)) {
    const r = await send({ type: "STRIX_TICKER", symbol: sym }).catch(() => null);
    if (r?.address) {
      return { ca: String(r.address), chain: r.chain || null, label: `Buy $${sym.toUpperCase()}`, viaCashtag: true };
    }
  }
  return null;
}

const TRADER_ATTR = "data-strix-trader";
const traderDismissed = new Set<string>();
let traderHandle: string | null = null;
// The resolved trader for the profile currently on screen — read by the inline
// painters (PnL badge, holdings bar) and the Details button.
let traderState: { handle: string; data: any; token: BioToken | null } | null = null;
// Inlined holding logos (data URIs) keyed by source URL, so a rebuilt holdings
// bar paints them instantly instead of re-fetching or flashing letters.
const holdLogoCache: Record<string, string | null | undefined> = {};

// Notable-followers overlay: the biggest verified followers of a profile, from
// twitterapi.io via the backend. Independent of FOMO (works on any X profile),
// so it has its own per-handle cache. `null` = fetched, nothing worth showing.
type FollowerRow = { name: string; userName: string; avatar: string; followers: number; blue: boolean; url: string };
const topFollowersCache = new Map<string, FollowerRow[] | null>();
// Account vetting (legit-check) results, per handle. null = fetched, no data.
const vetCache = new Map<string, any | null>();

function removeTraderDock() {
  document.querySelectorAll(`[${TRADER_ATTR}]`).forEach((el) => el.remove());
  traderHandle = null;
  traderState = null;
}

const fmtHold = (s: number) =>
  s >= 86400 ? `${(s / 86400).toFixed(1)}d` : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)}m`;

/** The full trader panel, opened from the Details button as a right-side drawer
 *  (same shadow-root isolation and trusted-event rule as the trading panel). */
function openTraderPanel(handle: string, dataIn: any) {
  document.querySelectorAll(`[${TRADER_ATTR}="panel"]`).forEach((el) => el.remove());
  let data = dataIn;
  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.setAttribute(TRADER_ATTR, "panel");
  host.style.cssText = "all:initial;position:fixed;inset:0 0 0 auto;z-index:2147483000;";
  ["click", "pointerdown", "mousedown", "mouseup", "keydown"].forEach((ev) =>
    host.addEventListener(ev, (e) => e.stopPropagation()));
  const sh = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style"); style.textContent = STYLES; sh.appendChild(style);
  const panel = document.createElement("div"); panel.className = "drawer"; sh.appendChild(panel);
  document.body.appendChild(host);
  makeDrawerDraggable(panel);

  let tab: "positions" | "trades" = "positions";
  let holdPage = 0;
  let source: "fomo" | "pump" = data?.fomo ? "fomo" : "pump";
  const imgCache: Record<string, string | null | undefined> = {};
  const close = () => { host.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  window.addEventListener("keydown", onKey, true);

  const ensureHoldImages = () => {
    if (source !== "fomo") return;
    const holds: any[] = data?.fomo?.holdings || [];
    const imgByAddr: Record<string, string> = {};
    for (const h of holds) if (h.address && h.image) imgByAddr[String(h.address).toLowerCase()] = h.image;
    const start = holdPage * HOLD_PAGE;
    const pageUrls: (string | undefined)[] = tab === "positions"
      ? holds.slice(start, start + HOLD_PAGE).map((h) => h.image)
      : (data?.fomo?.trades || []).slice(start, start + HOLD_PAGE)
          .map((t: any) => imgByAddr[String(t.address || "").toLowerCase()]);
    const urls = [...pageUrls, ...topWins(holds).map((h) => h.image)];
    for (const u of urls) {
      if (!u || imgCache[u] !== undefined) continue;
      imgCache[u] = null;
      send({ type: "STRIX_IMAGE", url: u }).then((r) => {
        imgCache[u] = r?.data || null;
        if (r?.data) draw();
      }).catch(() => { imgCache[u] = null; });
    }
  };

  const draw = () => {
    ensureHoldImages();
    panel.innerHTML = traderHtml(handle, data, tab, holdPage, source, imgCache);
    panel.querySelectorAll<HTMLElement>("[data-tsrc]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        source = el.dataset.tsrc === "pump" ? "pump" : "fomo";
        tab = "positions"; holdPage = 0; draw();
      }));
    panel.querySelectorAll<HTMLElement>("[data-ttab]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        tab = el.dataset.ttab === "trades" ? "trades" : "positions"; holdPage = 0; draw();
      }));
    panel.querySelectorAll<HTMLElement>('[data-act="tpclose"]').forEach((el) =>
      el.addEventListener("click", (ev) => { if (ev.isTrusted) close(); }));
    panel.querySelectorAll<HTMLElement>("[data-hpage]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        const total = (tab === "trades" ? data.fomo?.trades?.length : data.fomo?.holdings?.length) || 0;
        const max = Math.max(1, Math.ceil(total / HOLD_PAGE));
        holdPage += el.dataset.hpage === "next" ? 1 : -1;
        holdPage = Math.max(0, Math.min(max - 1, holdPage));
        draw();
      }));
  };

  // If we were handed shallow data, deepen it in place.
  if (!data?.fomo?.deep) {
    send({ type: "STRIX_TRADER", handle, deep: true }).then((full) => {
      if (full?.fomo) { const had = !!data?.fomo; data = full; if (!had) source = "fomo"; draw(); }
    }).catch(() => {});
  }
  draw();
}

/* ── inline profile overlays: a PnL badge by the name, a top-holdings row, and
   a Details button that opens the full panel. Each is its own closed shadow so
   X's CSS/CSP can't touch it; all carry TRADER_ATTR so a nav clears them. ── */
const INLINE_STYLES = `
  @font-face{font-family:"ImpulseSans";font-weight:600;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-600.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-700.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseMono";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexmono-700.woff2")}") format("woff2")}
  *{font-family:"ImpulseSans",-apple-system,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}
  .pbadge{display:inline-flex;align-items:center;gap:11px;padding:11px 18px 11px 13px;border-radius:18px;cursor:pointer;
    background:#0b0f06;border:1px solid #34431e;transition:background .12s,border-color .12s;
    box-shadow:0 16px 40px -12px rgba(0,0,0,.9), 0 0 0 4px #000, 0 0 30px -8px rgba(182,240,60,.35)}
  .pbadge:hover{background:#121808;border-color:#4c651f}
  .pbadge img{width:34px;height:34px;border-radius:11px;display:block}
  .pbv{display:flex;flex-direction:column;line-height:1}
  .pbv b{font:700 27px "ImpulseMono",ui-monospace,monospace;color:#eef3e4;letter-spacing:-.02em}
  .pbv i{font:700 10px "ImpulseMono",ui-monospace,monospace;font-style:normal;letter-spacing:.14em;
    text-transform:uppercase;color:#8ce04a;margin-top:5px}
  .card{width:100%;margin-top:12px;padding:13px 15px 15px;border-radius:16px;
    background:radial-gradient(135% 130% at 0% 0%, rgba(182,240,60,.09), transparent 55%), #0b0f06;
    border:1px solid #26331a;box-shadow:0 14px 34px -20px rgba(0,0,0,.7)}
  .chead{display:flex;align-items:center;gap:18px}
  .chead .mk{width:32px;height:32px;border-radius:9px;display:block;flex:0 0 auto;
    box-shadow:0 0 0 1px rgba(182,240,60,.28), 0 6px 18px -8px rgba(182,240,60,.5)}
  .stat{display:flex;flex-direction:column;gap:2px;min-width:0}
  .stat .sv{font:700 20px "ImpulseMono",ui-monospace,monospace;color:#eef3e4;line-height:1;
    letter-spacing:-.01em;font-variant-numeric:tabular-nums}
  .stat .sv.up{color:#8ce04a}
  .stat .sv.dn{color:#ff6b6b}
  .stat .sl{font:700 8.5px "ImpulseMono",monospace;letter-spacing:.09em;text-transform:uppercase;color:#7d8a67}
  .spacer{flex:1 1 auto}
  .det{display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:999px;border:0;cursor:pointer;flex:0 0 auto;
    background:#b6f03c;color:#0a1005;font:700 13.5px "ImpulseSans",sans-serif;box-shadow:0 8px 22px -10px rgba(182,240,60,.7);transition:background .12s}
  .det:hover{background:#c9ff52}
  .det img{width:18px;height:18px;border-radius:5px;display:block}
  .det.buy{margin-right:8px;background:transparent;color:#b6f03c;border:1px solid #2a3a1a;box-shadow:none}
  .det.buy:hover{background:#141810}
  .hlbl{margin:15px 0 9px;font:700 9.5px "ImpulseMono",monospace;letter-spacing:.11em;text-transform:uppercase;color:#7d8a67}
  .chips{display:flex;gap:8px;flex-wrap:wrap}
  .chip{display:inline-flex;align-items:center;gap:8px;padding:6px 13px 6px 6px;border-radius:12px;
    background:#11150a;border:1px solid #242e18;color:#eef3e4;transition:border-color .12s,background .12s}
  .chip.link{cursor:pointer}
  .chip.link:hover{border-color:#3d4f22;background:#161c0c}
  .chip .lg{width:26px;height:26px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
    overflow:hidden;background:#20261a;color:#b6f03c;font:800 10px "ImpulseSans",sans-serif}
  .chip .lg img{width:100%;height:100%;object-fit:cover;display:block}
  .chip .sym{font:700 13.5px "ImpulseSans",sans-serif}
  .chip b{font:700 12.5px "ImpulseMono",ui-monospace,monospace;color:#a9b599}
  .folw{width:100%;margin-top:13px;padding:17px 17px 15px;border-radius:21px;
    background:radial-gradient(120% 120% at 100% 0%, rgba(182,240,60,.11), transparent 52%), linear-gradient(180deg,#0e1308,#090c05);
    border:1px solid #2d3d1b;box-shadow:0 24px 54px -28px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.035)}
  .folhdr{display:flex;align-items:center;gap:9px;margin-bottom:14px;
    font:800 11.5px "ImpulseMono",monospace;letter-spacing:.14em;text-transform:uppercase;color:#b2c494}
  .folhdr svg{width:17px;height:17px;display:block;color:#b6f03c}
  .folhdr em{margin-left:auto;font-style:normal;font:700 9.5px "ImpulseMono",monospace;letter-spacing:.09em;color:#5f6e49}
  .follist{display:flex;flex-direction:column;gap:8px}
  .folr{display:flex;align-items:center;gap:14px;padding:10px 13px 10px 11px;border-radius:16px;text-decoration:none;
    background:#10150a;border:1px solid #212c15;transition:border-color .13s,background .13s,transform .13s}
  .folr:hover{border-color:#47611e;background:#171f0d;transform:translateX(3px)}
  .folr.top{background:linear-gradient(90deg, rgba(182,240,60,.14), rgba(182,240,60,.015));border-color:#56721f;
    box-shadow:0 0 0 1px rgba(182,240,60,.14), 0 12px 30px -16px rgba(182,240,60,.45)}
  .folrk{flex:0 0 auto;width:24px;text-align:center;font:800 15px "ImpulseMono",ui-monospace,monospace;color:#5f6e49}
  .folr.top .folrk{color:#b6f03c}
  .folav{width:48px;height:48px;border-radius:50%;object-fit:cover;flex:0 0 auto;background:#20261a;
    display:flex;align-items:center;justify-content:center;color:#b6f03c;font:800 18px "ImpulseSans",sans-serif;
    box-shadow:0 0 0 1px rgba(182,240,60,.16), 0 7px 18px -9px rgba(0,0,0,.6)}
  .folmeta{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:4px}
  .foln{display:flex;align-items:center;gap:5px;font:700 16px "ImpulseSans",sans-serif;color:#f1f6ea;line-height:1.1}
  .foln b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:195px;font-weight:700}
  .foln .bv{flex:0 0 auto;width:15px;height:15px;display:block;color:#4fb0ff}
  .folh{font:700 12.5px "ImpulseMono",ui-monospace,monospace;color:#8a977a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .folnum{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:2px;text-align:right}
  .folnum b{font:800 19px "ImpulseMono",ui-monospace,monospace;color:#8ce04a;letter-spacing:-.02em;line-height:1}
  .folnum i{font-style:normal;font:700 8.5px "ImpulseMono",monospace;letter-spacing:.1em;text-transform:uppercase;color:#5f6e49}
  .folbtn{display:inline-flex;align-items:center;gap:9px;margin-top:12px;padding:12px 19px;border-radius:999px;cursor:pointer;
    background:linear-gradient(180deg,#151d0c,#0e1308);border:1px solid #35461f;color:#c4f45a;font:800 13.5px "ImpulseSans",sans-serif;
    box-shadow:0 11px 28px -15px rgba(182,240,60,.55);transition:background .13s,border-color .13s,transform .13s}
  .folbtn:hover{background:linear-gradient(180deg,#1b240f,#121809);border-color:#56721f;transform:translateY(-1px)}
  .folbtn:disabled{cursor:default;opacity:.8;transform:none}
  .folbtn svg{width:16px;height:16px;display:block}
  .folspin{width:15px;height:15px;border-radius:50%;border:2px solid #2a3a1a;border-top-color:#b6f03c;display:inline-block;animation:folsp .7s linear infinite}
  @keyframes folsp{to{transform:rotate(360deg)}}
  .folnone{font:700 13px "ImpulseSans",sans-serif;color:#7d8a67;padding:4px 2px}
  .folnav{display:flex;align-items:center;gap:11px;margin-top:14px;padding-top:14px;border-top:1px solid #1e2814}
  .folnav button{display:inline-flex;align-items:center;justify-content:center;width:37px;height:37px;border-radius:12px;cursor:pointer;
    background:#121809;border:1px solid #2b3a1a;color:#b6f03c;font-size:15px;transition:background .13s,border-color .13s}
  .folnav button:hover:not(:disabled){background:#18200d;border-color:#56721f}
  .folnav button:disabled{opacity:.3;cursor:default}
  .folcount{font:800 13px "ImpulseMono",ui-monospace,monospace;color:#9aa882}
  .folcount i{font-style:normal;color:#5f6e49}
  .vetbtn{display:inline-flex;align-items:center;gap:9px;margin-top:12px;padding:12px 19px;border-radius:999px;cursor:pointer;
    background:linear-gradient(180deg,#151d0c,#0e1308);border:1px solid #35461f;color:#c4f45a;font:800 13.5px "ImpulseSans",sans-serif;
    box-shadow:0 11px 28px -15px rgba(182,240,60,.55);transition:background .13s,border-color .13s,transform .13s}
  .vetbtn:hover{background:linear-gradient(180deg,#1b240f,#121809);border-color:#56721f;transform:translateY(-1px)}
  .vetbtn:disabled{cursor:default;opacity:.8;transform:none}
  .vetbtn svg{width:16px;height:16px;display:block}
  .vet{width:100%;margin-top:13px;padding:17px 17px 15px;border-radius:21px;
    background:radial-gradient(120% 120% at 0% 0%, rgba(182,240,60,.11), transparent 52%), linear-gradient(180deg,#0e1308,#090c05);
    border:1px solid #2d3d1b;box-shadow:0 24px 54px -28px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.035)}
  .vethead{display:flex;align-items:center;gap:14px;margin-bottom:13px}
  .vethead>img,.vethead .vfb{width:50px;height:50px;border-radius:50%;object-fit:cover;flex:0 0 auto;background:#20261a;
    display:flex;align-items:center;justify-content:center;color:#b6f03c;font:800 19px "ImpulseSans",sans-serif;box-shadow:0 0 0 1px rgba(182,240,60,.16)}
  .vetwho{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:4px}
  .vetn{display:flex;align-items:center;gap:5px;font:800 16.5px "ImpulseSans",sans-serif;color:#f1f6ea;line-height:1.1}
  .vetn .bv{width:15px;height:15px;color:#4fb0ff;flex:0 0 auto}
  .vetn b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px;font-weight:800}
  .veth{font:700 12.5px "ImpulseMono",ui-monospace,monospace;color:#8a977a}
  .vetscore{flex:0 0 auto;width:58px;height:58px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;
    border:3px solid currentColor;background:rgba(0,0,0,.25)}
  .vetscore b{font:800 20px "ImpulseMono",ui-monospace,monospace;line-height:1;color:currentColor}
  .vetscore i{font-style:normal;font:700 7px "ImpulseMono",monospace;letter-spacing:.1em;color:#7d8a67;margin-top:2px}
  .vetverdict{display:inline-flex;align-items:center;gap:6px;margin-bottom:11px;padding:6px 14px;border-radius:999px;
    border:1px solid currentColor;background:rgba(255,255,255,.03);font:800 11px "ImpulseMono",monospace;letter-spacing:.1em;text-transform:uppercase;color:currentColor}
  .vetsigs{display:flex;flex-direction:column}
  .vsig{display:flex;align-items:center;gap:11px;padding:9px 2px;border-bottom:1px solid #161f0d}
  .vsig:last-child{border-bottom:0}
  .vsig .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
  .vsig .vl{font:700 13px "ImpulseSans",sans-serif;color:#a9b599}
  .vsig .vv{margin-left:auto;font:800 12.5px "ImpulseMono",ui-monospace,monospace;text-align:right}
  .dot.good,.vv.good{color:#8ce04a} .dot.good{background:#8ce04a}
  .dot.warn,.vv.warn{color:#f0c23c} .dot.warn{background:#f0c23c}
  .dot.bad,.vv.bad{color:#ff6b6b} .dot.bad{background:#ff6b6b}
  .vetfoot{display:flex;align-items:center;gap:9px;margin-top:12px;padding-top:12px;border-top:1px solid #1e2814}
  .vetfoot .vflbl{font:700 9.5px "ImpulseMono",monospace;letter-spacing:.09em;text-transform:uppercase;color:#7d8a67}
  .vetfoot .vfavs{display:inline-flex}
  .vetfoot .vfavs img,.vetfoot .vfavs span{width:26px;height:26px;border-radius:50%;margin-left:-8px;border:2px solid #0b0f06;object-fit:cover;background:#20261a;
    display:flex;align-items:center;justify-content:center;color:#b6f03c;font:800 10px "ImpulseSans",sans-serif}
  .vetfoot .vfavs :first-child{margin-left:0}
  .vetnote{margin-top:11px;font:700 9.5px "ImpulseMono",monospace;letter-spacing:.04em;color:#5f6e49}
  .vetspin{width:15px;height:15px;border-radius:50%;border:2px solid #2a3a1a;border-top-color:#b6f03c;display:inline-block;animation:folsp .7s linear infinite}
  @media (max-width:560px){ .chead{gap:12px} .stat .sv{font-size:17px} .foln b{max-width:130px} }`;

function makeInlineHost(part: string, tag = "span"): { host: HTMLElement; root: HTMLElement } {
  const host = document.createElement(tag);
  host.setAttribute(HOST_ATTR, "");
  host.setAttribute(TRADER_ATTR, part);
  host.style.cssText = tag === "span" ? "all:initial;display:inline-flex;vertical-align:middle;margin-left:8px" : "all:initial;display:block";
  ["click", "pointerdown", "mousedown", "mouseup", "keydown"].forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));
  const sh = host.attachShadow({ mode: "closed" });
  const st = document.createElement("style"); st.textContent = INLINE_STYLES; sh.appendChild(st);
  const root = document.createElement("div"); sh.appendChild(root);
  return { host, root };
}

/**
 * The Impulse stats card: one cohesive block placed under the profile's
 * bio/location row. Header = PnL + portfolio stats and a Details button; below
 * = the trader's top holdings as logo chips (each opens that token to trade).
 */
function injectStatsCard(data: any, token: BioToken | null) {
  const f = data?.fomo;
  const hasPanel = !!(data && (data.fomo || data.pump));
  const pnl = f?.pnl?.all;
  const port = f?.portfolioUsd;
  const holds = f ? (f.holdings || []).slice().sort((a: any, b: any) => (b.valueUsd || 0) - (a.valueUsd || 0)).slice(0, 5) : [];
  if (pnl == null && port == null && !holds.length && !token && !hasPanel) return;
  const anchor = document.querySelector('[data-testid="UserProfileHeader_Items"]')
    || document.querySelector('[data-testid="UserDescription"]')
    || document.querySelector('[data-testid="UserName"]');
  if (!anchor) return;
  if (document.querySelector(`[${TRADER_ATTR}="card"]`)) return;
  const { host, root } = makeInlineHost("card", "div");

  const stat = (v: string, label: string, cls = "") =>
    `<div class="stat"><div class="sv ${cls}">${v}</div><div class="sl">${label}</div></div>`;
  // PnL is the card's headline (portfolio now lives on the avatar badge); fall
  // back to portfolio here only when there's no PnL figure.
  const stats = pnl != null
    ? stat(`${pnl >= 0 ? "+" : ""}${money(pnl)}`, "Total PnL", pnl >= 0 ? "up" : "dn")
    : (port != null ? stat(money(port), "Portfolio") : "");

  // Cached logo → instant paint (X re-renders the header several times on load).
  const slot = (h: any, i: number) => {
    const cached = h.image ? holdLogoCache[h.image] : null;
    if (cached) return `<span class="lg" data-lg="${i}"><img src="${cached}" alt=""></span>`;
    return `<span class="lg" data-lg="${i}">${esc((String(h.symbol || "?")[0] || "?").toUpperCase())}</span>`;
  };
  const chips = holds.map((h: any, i: number) =>
    `<span class="chip${h.address ? " link" : ""}"${h.address ? ` data-ca="${esc(h.address)}" data-chain="${esc(h.chain || "")}" title="Trade ${esc(h.symbol)}"` : ""}>` +
    `${slot(h, i)}<span class="sym">${esc(h.symbol)}</span><b>${money(h.valueUsd || 0)}</b></span>`).join("");
  const holdsBlock = holds.length ? `<div class="hlbl">Top holdings</div><div class="chips">${chips}</div>` : "";
  const buyBtn = token ? `<button class="det buy" data-buy>${esc(token.label)}</button>` : "";
  const detBtn = hasPanel ? `<button class="det" data-det>${LOGO}Details</button>` : "";

  root.innerHTML = `<div class="card">
      <div class="chead"><img class="mk" src="${chrome.runtime.getURL("icons/mascot.png")}" alt="">` +
        `${stats}<div class="spacer"></div>${buyBtn}${detBtn}</div>${holdsBlock}</div>`;

  (root.querySelector("[data-det]") as HTMLElement | null)?.addEventListener("click", (e) => {
    if (e.isTrusted && traderState) openTraderPanel(traderState.handle, traderState.data);
  });
  if (token) (root.querySelector("[data-buy]") as HTMLElement | null)?.addEventListener("click", (e) => {
    if (e.isTrusted) openDrawer(token.ca, token.viaCashtag, token.chain);
  });
  root.querySelectorAll<HTMLElement>(".chip.link").forEach((el) => el.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    if (el.dataset.ca) openDrawer(el.dataset.ca, false, el.dataset.chain || null);
  }));

  anchor.insertAdjacentElement("afterend", host);
  // Fetch any logo not already cached, then fill its slot and remember it.
  holds.forEach((h: any, i: number) => {
    if (!h.image) return;
    const paint = (d: string) => { const lg = root.querySelector(`[data-lg="${i}"]`); if (lg && !lg.querySelector("img")) lg.innerHTML = `<img src="${d}" alt="">`; };
    if (holdLogoCache[h.image] !== undefined) { const c = holdLogoCache[h.image]; if (c) paint(c); return; }
    holdLogoCache[h.image] = null;
    send({ type: "STRIX_IMAGE", url: h.image }).then((r) => {
      const d = r?.data && String(r.data).startsWith("data:image/") ? String(r.data) : null;
      holdLogoCache[h.image] = d;
      if (d) paint(d);
    }).catch(() => { holdLogoCache[h.image] = null; });
  });
}

/** A small portfolio-value badge overlaid on the bottom of the profile avatar.
 *  The page has many UserAvatar containers (the nav account, every tweet); the
 *  profile header's is the large one, so pick by size, preferring the handle. */
function injectPortfolioBadge(data: any) {
  const port = data?.fomo?.portfolioUsd;
  if (port == null) return;
  const big = (els: Element[]) => els.find((el) => el.getBoundingClientRect().width > 72) as HTMLElement | undefined;
  const handle = traderState?.handle || "";
  const av =
    (handle && big([...document.querySelectorAll(`[data-testid="UserAvatar-Container-${handle}"]`)]))
    || big([...document.querySelectorAll('[data-testid^="UserAvatar-Container-"]')]);
  if (!av) return;
  if (av.querySelector(`[${TRADER_ATTR}="port"]`)) return;
  if (getComputedStyle(av).position === "static") av.style.position = "relative";
  const { host, root } = makeInlineHost("port", "div");
  // To the right of the avatar, vertically centred, with a gap.
  host.style.cssText = "all:initial;position:absolute;left:100%;top:50%;transform:translateY(-50%);margin-left:20px;z-index:5;white-space:nowrap";
  root.innerHTML = `<span class="pbadge" title="Portfolio value — open the Impulse panel">${LOGO_LG}` +
    `<span class="pbv"><b>${money(port)}</b><i>Portfolio</i></span></span>`;
  root.firstElementChild!.addEventListener("click", (e) => { if (e.isTrusted && traderState) openTraderPanel(traderState.handle, traderState.data); });
  av.appendChild(host);
}

/** Ensure the inline overlays are present for the resolved trader (re-inserts if
 *  X re-rendered the header and wiped them). Deduped; runs on the scan tick. */
function paintTraderInline() {
  const h = xProfileHandle(location.href);
  if (!h || !traderState || traderState.handle.toLowerCase() !== h.toLowerCase()) return;
  injectPortfolioBadge(traderState.data);
  injectStatsCard(traderState.data, traderState.token);
}

const BV_ICON = `<svg class="bv" viewBox="0 0 24 24" fill="currentColor"><path d="M22.25 12l-2.44-2.79.34-3.69-3.61-.82-1.89-3.2L12 2.96 8.75 1.5 6.86 4.7l-3.61.81.34 3.7L1.25 12l2.44 2.79-.34 3.7 3.61.82 1.89 3.2L12 21.04l3.25 1.46 1.89-3.2 3.61-.82-.34-3.69L22.25 12zm-13.17 4.19l-3.5-3.5 1.41-1.41 2.09 2.08 5.84-5.84 1.41 1.41-7.25 7.26z"/></svg>`;
const FOLW_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const fmtFollowers = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K"
  : String(n);

function folChip(r: FollowerRow, rank: number): string {
  const initial = esc((String(r.name || r.userName || "?")[0] || "?").toUpperCase());
  const av = r.avatar
    ? `<img class="folav" src="${esc(r.avatar)}" alt="" loading="lazy">`
    : `<span class="folav">${initial}</span>`;
  return `<a class="folr${rank === 1 ? " top" : ""}" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" title="@${esc(r.userName)} · ${r.followers.toLocaleString()} followers">` +
    `<span class="folrk">${rank}</span>${av}` +
    `<span class="folmeta"><span class="foln"><b>${esc(r.name || r.userName)}</b>${r.blue ? BV_ICON : ""}</span>` +
    `<span class="folh">@${esc(r.userName)}</span></span>` +
    `<span class="folnum"><b>${fmtFollowers(r.followers)}</b><i>followers</i></span></a>`;
}

/** On-demand notable-followers overlay: a button under the bio that, when
 *  clicked, fetches (once per handle, cached) and expands into the ranked strip.
 *  On-demand keeps credit spend to profiles a user actually asks about. */
function paintTopFollowers() {
  const h = xProfileHandle(location.href);
  if (!h) return;
  if (document.querySelector(`[${TRADER_ATTR}="folw"]`)) return;   // already present
  const cardHost = document.querySelector(`[${TRADER_ATTR}="card"]`) as HTMLElement | null;
  const anchor = cardHost
    || document.querySelector('[data-testid="UserProfileHeader_Items"]')
    || document.querySelector('[data-testid="UserDescription"]')
    || document.querySelector('[data-testid="UserName"]');
  if (!anchor) return;
  const key = h.toLowerCase();
  const { host, root } = makeInlineHost("folw", "div");
  const FOL_PAGE = 5;
  let folPage = 0;

  // One page of the ranked list, biggest first, with prev/next to page through.
  const renderRows = (rows: FollowerRow[]) => {
    const pages = Math.max(1, Math.ceil(rows.length / FOL_PAGE));
    folPage = Math.max(0, Math.min(folPage, pages - 1));
    const start = folPage * FOL_PAGE;
    const slice = rows.slice(start, start + FOL_PAGE);
    const nav = rows.length > FOL_PAGE
      ? `<div class="folnav"><button class="fprev" ${folPage <= 0 ? "disabled" : ""} title="Bigger">◀</button>` +
        `<button class="fnext" ${folPage >= pages - 1 ? "disabled" : ""} title="Smaller">▶</button>` +
        `<span class="folcount">${start + 1}–${start + slice.length} <i>of ${rows.length}</i></span></div>`
      : "";
    root.innerHTML = `<div class="folw"><div class="folhdr">${FOLW_ICON}<span>Notable followers</span><em>ranked by reach</em></div>` +
      `<div class="follist">${slice.map((r, i) => folChip(r, start + i + 1)).join("")}</div>${nav}</div>`;
    root.querySelector(".fprev")?.addEventListener("click", (e) => { if ((e as MouseEvent).isTrusted && folPage > 0) { folPage--; renderRows(rows); } });
    root.querySelector(".fnext")?.addEventListener("click", (e) => { if ((e as MouseEvent).isTrusted && folPage < pages - 1) { folPage++; renderRows(rows); } });
  };
  const none = () =>
    `<div class="folw"><div class="folhdr">${FOLW_ICON}<span>Notable followers</span></div>` +
    `<div class="folnone">No notable followers found</div></div>`;

  const renderBtn = (loading = false) => {
    root.innerHTML = `<button class="folbtn"${loading ? " disabled" : ""}>` +
      `${loading ? `<span class="folspin"></span>` : FOLW_ICON}` +
      `<span>${loading ? "Finding notable followers…" : "Notable followers"}</span></button>`;
    if (!loading) root.querySelector(".folbtn")!.addEventListener("click", (e) => { if ((e as MouseEvent).isTrusted) load(); });
  };
  const paint = (rows: FollowerRow[] | null) => { folPage = 0; if (rows && rows.length) renderRows(rows); else root.innerHTML = none(); };
  const load = () => {
    const cached = topFollowersCache.get(key);
    if (cached !== undefined) { paint(cached); return; }
    renderBtn(true);
    send({ type: "STRIX_TOPFOLLOWERS", handle: h }).then((r) => {
      if (r == null) { renderBtn(false); return; }   // backend error/unreachable — don't cache, allow retry
      const top: FollowerRow[] = Array.isArray(r.top) ? r.top : [];
      topFollowersCache.set(key, top.length ? top : null);
      if (xProfileHandle(location.href)?.toLowerCase() === key) paint(top.length ? top : null);
    }).catch(() => { renderBtn(false); });
  };

  // Already fetched this handle? Expand straight to the result; else show button.
  const cached = topFollowersCache.get(key);
  if (cached !== undefined) paint(cached);
  else renderBtn(false);

  anchor.insertAdjacentElement("afterend", host);
}

const VET_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`;

/** On-demand account vetting: a button under the bio that, on click, fetches a
 *  legit-check (age, verification, reach, cadence, engagement, notable-follower
 *  caliber) and expands into a scored panel. Cached per handle. */
function paintVet() {
  const h = xProfileHandle(location.href);
  if (!h) return;
  if (document.querySelector(`[${TRADER_ATTR}="vet"]`)) return;      // already present
  const anchor = (document.querySelector(`[${TRADER_ATTR}="folw"]`) as HTMLElement | null)
    || (document.querySelector(`[${TRADER_ATTR}="card"]`) as HTMLElement | null)
    || document.querySelector('[data-testid="UserProfileHeader_Items"]')
    || document.querySelector('[data-testid="UserDescription"]')
    || document.querySelector('[data-testid="UserName"]');
  if (!anchor) return;
  const key = h.toLowerCase();
  const { host, root } = makeInlineHost("vet", "div");

  const tier = (s: number) => s >= 60 ? "#8ce04a" : s >= 40 ? "#f0c23c" : s >= 25 ? "#ff9f45" : "#ff6b6b";
  const panel = (d: any) => {
    const col = tier(Number(d.score) || 0);
    const av = d.avatar
      ? `<img src="${esc(d.avatar)}" alt="">`
      : `<span class="vfb">${esc((String(d.name || d.userName || "?")[0] || "?").toUpperCase())}</span>`;
    const sigs = (d.signals || []).map((s: any) =>
      `<div class="vsig"><span class="dot ${esc(s.level)}"></span><span class="vl">${esc(s.label)}</span><span class="vv ${esc(s.level)}">${esc(s.value)}</span></div>`).join("");
    const tf = (d.topFollowers || []);
    const foot = tf.length
      ? `<div class="vetfoot"><span class="vflbl">Followed by</span><span class="vfavs">` +
        tf.map((n: any) => n.avatar ? `<img src="${esc(n.avatar)}" alt="" title="@${esc(n.userName)} · ${fmtFollowers(n.followers)}">`
          : `<span title="@${esc(n.userName)}">${esc((String(n.name || n.userName || "?")[0] || "?").toUpperCase())}</span>`).join("") +
        `</span></div>`
      : "";
    root.innerHTML = `<div class="vet">` +
      `<div class="vethead">${av}<div class="vetwho"><div class="vetn"><b>${esc(d.name || d.userName)}</b>${d.blue ? BV_ICON : ""}</div>` +
      `<div class="veth">@${esc(d.userName)}</div></div>` +
      `<div class="vetscore" style="color:${col}"><b>${Number(d.score) || 0}</b><i>/100</i></div></div>` +
      `<div class="vetverdict" style="color:${col}">${esc(d.verdict || "")}</div>` +
      `<div class="vetsigs">${sigs}</div>${foot}` +
      `<div class="vetnote">Heuristic signal — not financial advice. DYOR.</div></div>`;
  };
  const none = () => { root.innerHTML = `<div class="vet"><div class="vetnote" style="color:#7d8a67;font-size:12px">Couldn't vet this account.</div></div>`; };
  const renderBtn = (loading = false) => {
    root.innerHTML = `<button class="vetbtn"${loading ? " disabled" : ""}>` +
      `${loading ? `<span class="vetspin"></span>` : VET_ICON}<span>${loading ? "Vetting account…" : "Vet account"}</span></button>`;
    if (!loading) root.querySelector(".vetbtn")!.addEventListener("click", (e) => { if ((e as MouseEvent).isTrusted) load(); });
  };
  const load = () => {
    const c = vetCache.get(key);
    if (c !== undefined) { c ? panel(c) : none(); return; }
    renderBtn(true);
    send({ type: "STRIX_VET", handle: h }).then((r) => {
      if (r == null) { renderBtn(false); return; }     // backend error — allow retry
      vetCache.set(key, r && r.signals ? r : null);
      if (xProfileHandle(location.href)?.toLowerCase() === key) (r && r.signals ? panel(r) : none());
    }).catch(() => { renderBtn(false); });
  };

  const cached = vetCache.get(key);
  if (cached !== undefined) (cached ? panel(cached) : none());
  else renderBtn(false);

  anchor.insertAdjacentElement("afterend", host);
}

/* ── Author overlays: a FOMO PnL + top-3 holdings badge on every tweet whose
   author is a FOMO trader. Backend-only lookups (no FomoScan cost), throttled
   to two at a time and cached per handle (including "not a trader"). ── */
const AUTHOR_ATTR = "data-strix-author";
const authorCache = new Map<string, any>();       // handle -> trader data | null
const authorInFlight = new Set<string>();
const authorQueue: string[] = [];
let authorWorkers = 0;
const AUTHOR_MAX = 2;
const AUTHOR_STYLES = `
  @font-face{font-family:"ImpulseSans";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-700.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseMono";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexmono-700.woff2")}") format("woff2")}
  *{font-family:"ImpulseSans",-apple-system,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}
  .fbadge{display:inline-flex;align-items:center;gap:10px;padding:4px 13px 4px 6px;border-radius:13px;cursor:pointer;
    background:#0c1207;border:1px solid #34431e;transition:background .12s,border-color .12s;
    box-shadow:0 8px 22px -10px rgba(0,0,0,.75), 0 0 22px -10px rgba(182,240,60,.35)}
  .fbadge:hover{background:#121a0b;border-color:#4a621f}
  .fpnl{display:inline-flex;align-items:center;gap:7px;font:700 17px "ImpulseMono",ui-monospace,monospace;color:#8ce04a;letter-spacing:-.02em}
  .fpnl.dn{color:#ff6b6b}
  .fpnl img{width:22px;height:22px;border-radius:7px;display:block}
  .fholds{display:inline-flex;align-items:center}
  .fh{width:27px;height:27px;border-radius:50%;margin-left:-9px;border:2px solid #0c1207;overflow:hidden;flex:0 0 auto;
    display:flex;align-items:center;justify-content:center;background:#20261a;color:#b6f03c;font:800 11px "ImpulseSans",sans-serif}
  .fh:first-child{margin-left:0}
  .fh img{width:100%;height:100%;object-fit:cover;display:block}`;

function makeAuthorHost(handle: string): { host: HTMLElement; root: HTMLElement } {
  const host = document.createElement("span");
  host.setAttribute(HOST_ATTR, "");
  host.setAttribute(AUTHOR_ATTR, handle.toLowerCase());
  host.style.cssText = "all:initial;display:inline-flex;vertical-align:middle;margin-left:8px";
  ["click", "pointerdown", "mousedown", "mouseup", "keydown"].forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));
  const sh = host.attachShadow({ mode: "closed" });
  const st = document.createElement("style"); st.textContent = AUTHOR_STYLES; sh.appendChild(st);
  const root = document.createElement("div"); sh.appendChild(root);
  return { host, root };
}

function pumpAuthorQueue() {
  while (authorWorkers < AUTHOR_MAX && authorQueue.length) {
    const key = authorQueue.shift()!;
    authorInFlight.add(key); authorWorkers++;
    send({ type: "STRIX_TRADER", handle: key, deep: true, backendOnly: true })
      .then((d) => { authorCache.set(key, d && d.fomo ? d : null); })
      .catch(() => authorCache.set(key, null))
      .finally(() => { authorInFlight.delete(key); authorWorkers--; injectCachedBadges(); pumpAuthorQueue(); });
  }
}
function queueAuthor(handle: string) {
  const key = handle.toLowerCase();
  if (authorCache.has(key) || authorInFlight.has(key) || authorQueue.includes(key)) return;
  authorQueue.push(key);
  pumpAuthorQueue();
}

function injectAuthorBadge(un: Element, handle: string, data: any) {
  const f = data?.fomo; if (!f) return;
  const pnl = f.pnl?.all;
  const holds = (f.holdings || []).slice().sort((a: any, b: any) => (b.valueUsd || 0) - (a.valueUsd || 0)).slice(0, 3);
  if (pnl == null && !holds.length) return;
  const key = handle.toLowerCase();
  const existing = un.querySelector(`[${AUTHOR_ATTR}]`);
  if (existing) { if (existing.getAttribute(AUTHOR_ATTR) === key) return; existing.remove(); } // stale on a recycled node
  const { host, root } = makeAuthorHost(key);
  const pnlHtml = pnl != null ? `<span class="fpnl ${pnl < 0 ? "dn" : ""}">${LOGO}${pnl >= 0 ? "+" : ""}${money(pnl)}</span>` : "";
  const slot = (h: any, i: number) => {
    const c = h.image ? holdLogoCache[h.image] : null;
    const inner = c ? `<img src="${c}" alt="">` : esc((String(h.symbol || "?")[0] || "?").toUpperCase());
    return `<span class="fh" data-fh="${i}" title="${esc(h.symbol || "")}">${inner}</span>`;
  };
  const holdsHtml = holds.length ? `<span class="fholds">${holds.map(slot).join("")}</span>` : "";
  root.innerHTML = `<span class="fbadge" title="FOMO trader — open the Impulse panel">${pnlHtml}${holdsHtml}</span>`;
  root.firstElementChild!.addEventListener("click", (e) => { if (e.isTrusted) openTraderPanel(handle, data); });
  un.appendChild(host);
  holds.forEach((h: any, i: number) => {
    if (!h.image) return;
    const paint = (d: string) => { const el = root.querySelector(`[data-fh="${i}"]`); if (el && !el.querySelector("img")) el.innerHTML = `<img src="${d}" alt="">`; };
    if (holdLogoCache[h.image] !== undefined) { const c = holdLogoCache[h.image]; if (c) paint(c); return; }
    holdLogoCache[h.image] = null;
    send({ type: "STRIX_IMAGE", url: h.image }).then((r) => {
      const d = r?.data && String(r.data).startsWith("data:image/") ? String(r.data) : null;
      holdLogoCache[h.image] = d; if (d) paint(d);
    }).catch(() => { holdLogoCache[h.image] = null; });
  });
}

/** The author handle of a tweet, from its permalink (/handle/status/id), or a
 *  profile link in the name block. Empty when it's not a real handle. */
function authorHandleOf(art: Element): string {
  const perma = (art.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null)?.getAttribute("href") || "";
  let handle = perma.match(/^\/([^/]+)\/status\//)?.[1] || "";
  if (!handle) {
    const link = art.querySelector('[data-testid="User-Name"] a[href^="/"]:not([href*="/status"])') as HTMLAnchorElement | null;
    handle = (link?.getAttribute("href") || "").replace(/^\//, "").split("/")[0];
  }
  return (handle && /^[A-Za-z0-9_]{1,15}$/.test(handle) && !X_RESERVED.has(handle.toLowerCase())) ? handle : "";
}

/** Paint badges for tweets whose author is already resolved (no lookups). */
function injectCachedBadges() {
  if (!FOMO_ENABLED) return;
  document.querySelectorAll("article").forEach((art) => {
    const un = art.querySelector('[data-testid="User-Name"]');
    if (!un) return;
    const handle = authorHandleOf(art);
    if (!handle) return;
    const data = authorCache.get(handle.toLowerCase());
    if (data && data.fomo) injectAuthorBadge(un, handle, data);
  });
}

// Look up a tweet's author only when it scrolls into view — so a fast feed
// resolves a few at a time instead of firing every author at once on load.
const tweetIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const art = e.target as Element;
    const handle = authorHandleOf(art);
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (!authorCache.has(key)) queueAuthor(handle);
    else {
      const d = authorCache.get(key);
      const un = art.querySelector('[data-testid="User-Name"]');
      if (d?.fomo && un) injectAuthorBadge(un, handle, d);
    }
  }
}, { rootMargin: "250px 0px" });

/** Observe any new tweets for the author overlay, and paint cached ones. */
function paintTweetAuthors() {
  if (!FOMO_ENABLED) return;
  document.querySelectorAll("article:not([data-strix-io])").forEach((art) => {
    art.setAttribute("data-strix-io", "1");
    tweetIO.observe(art);
  });
  injectCachedBadges();
}

/* ── Cashtag intel: on every tweet that names a $cashtag, an inline trigger
   that shows which big accounts have tweeted that ticker — ranked by following,
   one tweet at a time with prev/next. The X search only fires on click
   (on-demand), and results are cached per symbol. ── */
const CASH_ATTR = "data-strix-cash";
type CashEntry = { name: string; userName: string; avatar: string; followers: number; blue: boolean;
  text: string; likes: number; retweets: number; replies: number; views: number; createdAt: string; url: string };
const cashCache = new Map<string, CashEntry[] | null>();   // SYMBOL -> entries | null (none)
const cashInFlight = new Set<string>();
const CASH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 11h-6"/><path d="M20 8v6"/></svg>`;
const CASH_STYLES = `
  @font-face{font-family:"ImpulseSans";font-weight:600;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-600.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-700.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseMono";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexmono-700.woff2")}") format("woff2")}
  *{font-family:"ImpulseSans",-apple-system,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}
  .ctrig{display:inline-flex;align-items:center;gap:5px;vertical-align:middle;padding:3px 11px 3px 8px;border-radius:999px;cursor:pointer;
    background:linear-gradient(180deg,#121a0b,#0b1106);border:1px solid #3a4b20;color:#c4f45a;font:800 11.5px "ImpulseSans",sans-serif;line-height:1.4;
    box-shadow:0 5px 14px -8px rgba(182,240,60,.5);transition:background .12s,border-color .12s}
  .ctrig:hover{background:linear-gradient(180deg,#19240e,#101708);border-color:#56721f}
  .ctrig svg{width:14px;height:14px;display:block}
  .cspin{width:12px;height:12px;border-radius:50%;border:2px solid #2a3a1a;border-top-color:#b6f03c;display:inline-block;vertical-align:middle;animation:csp .7s linear infinite}
  @keyframes csp{to{transform:rotate(360deg)}}
  .cpager{margin:13px 0 6px;border-radius:21px;overflow:hidden;
    background:radial-gradient(120% 110% at 0% 0%, rgba(182,240,60,.11), transparent 50%), linear-gradient(180deg,#0e1308,#090c05);
    border:1px solid #2d3d1b;box-shadow:0 28px 64px -30px rgba(0,0,0,.92), inset 0 1px 0 rgba(255,255,255,.035)}
  .cpcap{display:flex;align-items:center;gap:9px;padding:13px 16px;border-bottom:1px solid #1d2814;
    font:800 11.5px "ImpulseMono",monospace;letter-spacing:.14em;text-transform:uppercase;color:#b2c494}
  .cpcap svg{width:16px;height:16px;color:#b6f03c}
  .cpcap .sym{color:#c4f45a}
  .cpcap .x{margin-left:auto;cursor:pointer;color:#6b7a52;font-size:20px;line-height:1;background:none;border:0;padding:0 3px}
  .cpcap .x:hover{color:#eef3e4}
  .cpbody{padding:18px 18px 10px}
  .cprow{display:flex;align-items:center;gap:15px}
  .cprow>img,.cpfb{width:58px;height:58px;border-radius:50%;object-fit:cover;flex:0 0 auto;background:#20261a;
    box-shadow:0 0 0 2px rgba(182,240,60,.2), 0 9px 22px -11px rgba(0,0,0,.7)}
  .cpfb{display:flex;align-items:center;justify-content:center;color:#b6f03c;font:800 23px "ImpulseSans",sans-serif}
  .cpwho{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:7px}
  .cpn{display:flex;align-items:center;gap:6px;font:800 18.5px "ImpulseSans",sans-serif;color:#f1f6ea;line-height:1.1}
  .cpn .bv{width:16px;height:16px;color:#4fb0ff;flex:0 0 auto}
  .cpn b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px;font-weight:800}
  .cph{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
  .cphandle{font:700 13px "ImpulseMono",ui-monospace,monospace;color:#8a977a}
  .cpfollow{display:inline-flex;align-items:baseline;gap:5px;padding:4px 11px;border-radius:999px;background:rgba(140,224,74,.13);border:1px solid rgba(140,224,74,.3)}
  .cpfollow b{font:800 14px "ImpulseMono",ui-monospace,monospace;color:#8ce04a}
  .cpfollow i{font-style:normal;font:700 9px "ImpulseMono",monospace;letter-spacing:.08em;text-transform:uppercase;color:#6f8a4a}
  .cpopen{flex:0 0 auto;align-self:center;display:inline-flex;align-items:center;gap:5px;padding:10px 16px;border-radius:999px;text-decoration:none;
    background:#b6f03c;color:#0a1005;font:800 13px "ImpulseSans",sans-serif;box-shadow:0 11px 26px -13px rgba(182,240,60,.75)}
  .cpopen:hover{background:#c9ff52}
  .cptxt{margin:16px 0 14px;padding:13px 16px;border-radius:14px;background:#0a0e05;border:1px solid #1d2814;border-left:3px solid #56721f;
    font:600 16px/1.5 "ImpulseSans",sans-serif;color:#dde7d0;white-space:pre-wrap;word-break:break-word}
  .cpstats{display:flex;gap:9px;flex-wrap:wrap}
  .cpstat{display:inline-flex;align-items:baseline;gap:6px;padding:6px 13px;border-radius:999px;background:#11150a;border:1px solid #212c15;
    font:700 12px "ImpulseMono",ui-monospace,monospace;color:#8a977a}
  .cpstat b{color:#c4d2ad;font-size:13.5px}
  .cpnav{display:flex;align-items:center;gap:11px;padding:13px 16px 15px;border-top:1px solid #1d2814;margin-top:10px}
  .cpnav button{display:inline-flex;align-items:center;justify-content:center;width:39px;height:39px;border-radius:12px;cursor:pointer;
    background:#121809;border:1px solid #2b3a1a;color:#b6f03c;font-size:15px;transition:background .13s,border-color .13s}
  .cpnav button:hover:not(:disabled){background:#18200d;border-color:#56721f}
  .cpnav button:disabled{opacity:.3;cursor:default}
  .cpcount{font:800 13px "ImpulseMono",ui-monospace,monospace;color:#9aa882}
  .cpcount i{font-style:normal;color:#5f6e49}
  .cprank{margin-left:auto;display:inline-flex;align-items:center;padding:5px 12px;border-radius:999px;
    background:rgba(182,240,60,.1);border:1px solid rgba(182,240,60,.26);
    font:800 10px "ImpulseMono",monospace;letter-spacing:.07em;text-transform:uppercase;color:#b6f03c}
  .cpnone{padding:22px;font:700 13.5px "ImpulseSans",sans-serif;color:#7d8a67;text-align:center}`;

function makeCashHost(part: string, tag = "span"): { host: HTMLElement; root: HTMLElement } {
  const host = document.createElement(tag);
  host.setAttribute(HOST_ATTR, "");
  host.setAttribute(CASH_ATTR, part);
  host.style.cssText = tag === "span" ? "all:initial;display:inline-flex;vertical-align:middle;margin-left:4px" : "all:initial;display:block";
  ["click", "pointerdown", "mousedown", "mouseup", "keydown"].forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));
  const sh = host.attachShadow({ mode: "closed" });
  const st = document.createElement("style"); st.textContent = CASH_STYLES; sh.appendChild(st);
  const root = document.createElement("div"); sh.appendChild(root);
  return { host, root };
}

/** The ranked "big names on $SYM" pager, inserted inline under the tweet text.
 *  Clicking the same ticker's trigger again collapses it. */
function openCashPager(art: Element, sym: string, _trigRoot: HTMLElement) {
  const prior = art.querySelector(`[${CASH_ATTR}="pager"]`);
  if (prior) {
    const was = prior.getAttribute("data-sym");
    prior.remove();
    if (was === sym) return;               // same trigger again → toggle closed
  }
  const anchorEl = (art.querySelector('[data-testid="tweetText"]') as HTMLElement) || art;
  const { host, root } = makeCashHost("pager", "div");
  host.setAttribute("data-sym", sym);
  let idx = 0;
  const close = () => host.remove();
  const bindClose = () => root.querySelector(".x")?.addEventListener("click", (ev) => { if ((ev as MouseEvent).isTrusted) close(); });
  const cap = `<div class="cpcap">${CASH_ICON}<span>Big names on <span class="sym">$${esc(sym)}</span></span><button class="x" title="Close">×</button></div>`;

  const draw = (items: CashEntry[]) => {
    const e = items[idx];
    const av = e.avatar ? `<img src="${esc(e.avatar)}" alt="">` : `<span class="cpfb">${esc((String(e.name || e.userName || "?")[0] || "?").toUpperCase())}</span>`;
    const views = e.views ? `<span class="cpstat"><b>${fmtCount(e.views)}</b> views</span>` : "";
    root.innerHTML = `<div class="cpager">${cap}<div class="cpbody">` +
      `<div class="cprow">${av}<div class="cpwho"><div class="cpn"><b>${esc(e.name || e.userName)}</b>${e.blue ? BV_ICON : ""}</div>` +
      `<div class="cph"><span class="cphandle">@${esc(e.userName)}</span><span class="cpfollow"><b>${fmtFollowers(e.followers)}</b><i>followers</i></span></div></div>` +
      `${e.url ? `<a class="cpopen" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ""}</div>` +
      `<div class="cptxt">${esc(e.text) || "<i>(no text)</i>"}</div>` +
      `<div class="cpstats"><span class="cpstat"><b>${fmtCount(e.likes)}</b> likes</span><span class="cpstat"><b>${fmtCount(e.retweets)}</b> RT</span><span class="cpstat"><b>${fmtCount(e.replies)}</b> replies</span>${views}</div>` +
      `</div><div class="cpnav"><button class="prev" ${idx <= 0 ? "disabled" : ""} title="Bigger following">◀</button>` +
      `<button class="next" ${idx >= items.length - 1 ? "disabled" : ""} title="Smaller following">▶</button>` +
      `<span class="cpcount">${idx + 1} <i>/ ${items.length}</i></span><span class="cprank">#${idx + 1} by following</span></div></div>`;
    bindClose();
    root.querySelector(".prev")?.addEventListener("click", (ev) => { if ((ev as MouseEvent).isTrusted && idx > 0) { idx--; draw(items); } });
    root.querySelector(".next")?.addEventListener("click", (ev) => { if ((ev as MouseEvent).isTrusted && idx < items.length - 1) { idx++; draw(items); } });
  };
  const loading = () => { root.innerHTML = `<div class="cpager">${cap}<div class="cpnone"><span class="cspin"></span> searching X…</div></div>`; bindClose(); };
  const none = () => { root.innerHTML = `<div class="cpager">${cap}<div class="cpnone">No notable tweets found for $${esc(sym)}</div></div>`; bindClose(); };
  const show = (items: CashEntry[] | null) => { idx = 0; if (items && items.length) draw(items); else none(); };

  anchorEl.insertAdjacentElement("afterend", host);

  const cached = cashCache.get(sym);
  if (cached !== undefined) { show(cached); return; }
  loading();
  cashInFlight.add(sym);
  send({ type: "STRIX_CASHTAG_TWEETS", symbol: sym }).then((r) => {
    if (r == null) { if (host.isConnected) none(); return; }   // backend error — don't cache, reopening retries
    const items: CashEntry[] = Array.isArray(r.items) ? r.items : [];
    cashCache.set(sym, items.length ? items : null);
    if (host.isConnected) show(items.length ? items : null);
  }).catch(() => { if (host.isConnected) none(); }).finally(() => { cashInFlight.delete(sym); });
}

/** Append a "Big names" trigger after each distinct cashtag link in a tweet.
 *  Idempotent (skips a cashtag whose next sibling is already our trigger), so
 *  it survives X recycling tweet nodes as the feed scrolls. */
function injectCashTriggers(art: Element) {
  const tt = art.querySelector('[data-testid="tweetText"]');
  if (!tt) return;
  const seen = new Set<string>();
  for (const a of [...tt.querySelectorAll("a")]) {
    const txt = (a.textContent || "").trim();
    if (!/^\$[A-Za-z][A-Za-z0-9]{0,14}$/.test(txt)) continue;
    const sym = txt.slice(1).toUpperCase();
    if (seen.has(sym)) continue;                      // one trigger per ticker per tweet
    seen.add(sym);
    const next = a.nextElementSibling as HTMLElement | null;
    if (next && next.getAttribute?.(CASH_ATTR) === `trig:${sym}`) continue;   // already present
    const { host, root } = makeCashHost(`trig:${sym}`, "span");
    root.innerHTML = `<span class="ctrig" title="Big accounts tweeting $${esc(sym)}">${CASH_ICON}<span>Big names</span></span>`;
    root.firstElementChild!.addEventListener("click", (e) => { if ((e as MouseEvent).isTrusted) openCashPager(art, sym, root); });
    a.insertAdjacentElement("afterend", host);
  }
}

/** Run the cashtag triggers across the tweets currently in the DOM. Cheap (no
 *  lookups) and deduped, so it's safe to call on every scan tick. */
function paintCashtags() {
  document.querySelectorAll("article").forEach((art) => injectCashTriggers(art));
}

/** Holdings per page. Eight fills the panel without needing a scroll. */
const HOLD_PAGE = 8;

/**
 * A signed USD figure.
 *
 * fmtCompact already prefixes the dollar sign, so adding another here printed
 * "$$781.46" everywhere money() was used. The sign is still applied outside the
 * symbol rather than inside it, because "-$35.35" is how a loss is written and
 * "$-35.35" is not.
 */
const money = (n: number) => (n < 0 ? "-" : "") + fmtCompact(Math.abs(n));

/** A plain count. fmtCompact is for money and would render 169 as "$169". */
const fmtCount = (n: any) => {
  const v = Number(n);
  if (!isFinite(v)) return "0";
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v);
};

/**
 * A percentage return, at a length that fits the column.
 *
 * These run from -100% to five figures on a launchpad win, and "+1847.8%" needs
 * more room than the row has. Past 100% the decimal is noise — nobody reading a
 * 19x needs the tenth — so it is dropped, and past 1000% the figure switches to
 * multiples, which is how people say it anyway.
 */
const fmtPct = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1000) return `${v < 0 ? "-" : "+"}${(a / 100).toFixed(a >= 10000 ? 0 : 1)}x`;
  if (a >= 100) return `${v < 0 ? "-" : "+"}${a.toFixed(0)}%`;
  return `${v < 0 ? "-" : "+"}${a.toFixed(1)}%`;
};

/**
 * Where to read more about a holding.
 *
 * DexScreener's search resolves an address on any chain, which matters because
 * the balances feed gives an address with no network beside it. Guessing a
 * chain from the address shape would send half of these to a 404.
 */
const dexLink = (addr: string) => `https://dexscreener.com/search?q=${encodeURIComponent(addr)}`;

/** 0x1234…abcd — long enough to recognise, short enough to fit. */
/** 3d, 5h, 12m — short enough to sit at the end of a dense row. */
const fmtAgoShort = (ms: number) => {
  const d = Date.now() - ms;
  if (d < 3_600_000) return `${Math.max(1, Math.floor(d / 60_000))}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
};

const shortAddr = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

/** A round token thumbnail for a holding: the inlined logo, or a lettered
 *  fallback tinted from the symbol so pictureless tokens still read apart. */
function tokThumb(sym: string, image: string | null | undefined, imgCache: Record<string, string | null | undefined>): string {
  const data = image ? imgCache[image] : null;
  if (data && String(data).startsWith("data:image/")) {
    return `<img class="htokimg" src="${data}" alt="">`;
  }
  const s = String(sym || "?").replace(/^\$/, "");
  const initial = esc((s[0] || "?").toUpperCase());
  const hue = ([...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7));
  return `<span class="htokfb" style="background:hsl(${hue} 42% 24%);color:hsl(${hue} 80% 74%)">${initial}</span>`;
}

/** A trader's biggest winning positions (by USD profit), for the top strip. */
function topWins(holdings: any[]): any[] {
  return (holdings || [])
    .filter((h) => Number(h?.pnlUsd) > 0)
    .sort((a, b) => Number(b.pnlUsd) - Number(a.pnlUsd))
    .slice(0, 5);
}

function traderHtml(handle: string, d: any, tab: "positions" | "trades" = "positions", holdPage = 0,
  source: "fomo" | "pump" = "fomo", imgCache: Record<string, string | null | undefined> = {}): string {
  const f = d.fomo, p = d.pump;
  const av = f?.avatar || p?.avatar || null;
  // Only a data: URI the extension built itself is ever written into src. Any
  // other value falls back to the logo rather than reaching the markup.
  const disc = av && String(av).startsWith("data:image/")
    ? `<img src="${av}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`
    : LOGO;

  // How firmly this profile is tied to the handle on screen, strongest first.
  // A confirmed link is the account naming this X handle itself. Failing that,
  // the same handle existing on BOTH platforms is real corroboration — two
  // independent services would have to be wrong the same way — so it ranks
  // above a single-platform name match, and is still never called confirmed.
  const confirmedBy = f?.link === "confirmed" ? "FOMO" : p?.link === "confirmed" ? "pump.fun" : null;
  const badge = confirmedBy
    ? `<div class="tvbadge ok"><b>Linked.</b> ${confirmedBy} lists @${esc(handle)} as this account's X.</div>`
    : f && p
      ? `<div class="tvbadge mid"><b>Match on both.</b> The same handle trades on FOMO and pump.fun, though neither has confirmed @${esc(handle)}.</div>`
      : `<div class="tvbadge"><b>Name match.</b> ${f ? "FOMO" : "pump.fun"} has this handle but has not confirmed @${esc(handle)}.</div>`;

  const src = [
    f ? `<span class="srcchip">${FOMO_MARK_SM}FOMO</span>` : "",
    p ? `<span class="srcchip">${PUMP_MARK_SM}pump.fun</span>` : "",
  ].join("");

  // The three figures worth reading before anything else: what they made over
  // the headline window, how often they are right, and how much they move. The
  // same strip the holders and thesis tabs open with.
  // The strip adapts to the source. FomoScan computes windowed PnL and a win
  // rate, so it leads with those. FOMO has neither — no windowed PnL, no
  // win-rate endpoint — but it does have a live portfolio value and a total
  // PnL, which are the honest headline figures for it. Showing empty "30d" and
  // "win rate" cells for a FOMO profile read as zeros; this shows what exists.
  const wr = f?.winRate;
  const fromFomo = f?.statWindow == null && (f?.portfolioUsd != null || f?.pnl?.all != null);
  let summary = "";
  if (fromFomo) {
    const tot = f?.pnl?.all ?? null;
    summary = `<div class="hsum">
      <div class="hsumcell"><span>Portfolio</span><b>${f?.portfolioUsd != null ? money(f.portfolioUsd) : "—"}</b></div>
      <div class="hsumcell"><span>PnL</span><b class="${tot == null ? "" : tot >= 0 ? "lo" : "hi"}">${
        tot == null ? "—" : (tot >= 0 ? "+" : "") + money(tot)}</b></div>
      <div class="hsumcell"><span>Volume</span><b>${f?.volumeUsd ? money(f.volumeUsd) : "—"}</b></div>
    </div>`;
  } else if (f?.pnl || wr != null || f?.volumeUsd) {
    const p30 = f?.pnl?.["30d"];
    summary = `<div class="hsum">
      <div class="hsumcell"><span>PnL ${esc(f?.statWindow || "30d")}</span><b class="${
        p30 == null ? "" : p30 >= 0 ? "lo" : "hi"}">${p30 == null ? "—" : (p30 >= 0 ? "+" : "") + money(p30)}</b></div>
      <div class="hsumcell"><span>Win rate</span><b>${wr == null ? "—" : `${(wr * 100).toFixed(0)}%`}</b></div>
      <div class="hsumcell"><span>Volume</span><b>${f?.volumeUsd ? money(f.volumeUsd) : "—"}</b></div>
    </div>`;
  }

  // Only the windows that carry a figure. The all-time column was a permanent
  // em-dash once the source changed: FomoScan sweeps 24h, 7d and 30d and has no
  // lifetime window, and an empty cell in a grid of profits reads as a zero.
  const pw = (["24h", "7d", "30d", "all"] as const).filter((w) => f?.pnl?.[w] != null);
  const pnl = f?.pnl && pw.length
    ? `<div class="tclabel"><span>Realised profit</span><span class="r">on-chain sweep</span></div>
       <div class="pgrid">${pw.map((w) => {
          const v = f.pnl![w]!;
          return `<div class="pcell"><span class="plbl">${w === "all" ? "all time" : w}</span>
            <b class="pval ${v >= 0 ? "up" : "dn"}">${(v >= 0 ? "+" : "") + money(v)}</b></div>`;
        }).join("")}</div>`
    : "";

  // The trading stats describe a 30-day window, not a lifetime, so the window
  // is stated once in the section header rather than repeated on nine labels.
  // "Trades 1,024" unqualified next to an account two years old is a different
  // and much smaller claim than it appears.
  const stats = [
    f?.portfolioUsd ? ["Portfolio", money(f.portfolioUsd)] : null,
    f?.holdings?.length ? ["Positions", String(f.holdings.length)] : null,
    f?.tradeCount ? ["Trades", f.tradeCount.toLocaleString()] : null,
    f?.uniqueTokens ? ["Tokens", String(f.uniqueTokens)] : null,
    f?.avgHoldSeconds ? ["Avg hold", fmtHold(f.avgHoldSeconds)] : null,
    f?.accountAgeDays ? ["Wallet age", `${Math.round(f.accountAgeDays)}d`] : null,
    f?.rank && f?.walletsRanked ? ["PnL rank", `#${f.rank}`] : null,
  ].filter(Boolean) as [string, string][];

  const statHtml = stats.length
    ? `<div class="tclabel"><span>Track record</span>${
        f?.statWindow ? `<span class="r">${esc(f.statWindow)} window</span>` : ""}</div>
       <div class="sgrid">${stats.map(([k, v]) =>
        `<div class="scell"><span class="plbl">${esc(k)}</span><b class="sval">${esc(v)}</b></div>`).join("")}</div>`
    : "";

  // ── the two lists ──────────────────────────────────────────────────────
  const all = f?.holdings || [];
  const maxPage = Math.max(1, Math.ceil(all.length / HOLD_PAGE));
  const page = Math.max(0, Math.min(maxPage - 1, holdPage));
  const start = page * HOLD_PAGE;
  // Position value as the row's width, scaled to the largest on screen — the
  // reading the holders table and the thesis feed already ask for.
  const maxVal = all.reduce((m: number, h: any) => Math.max(m, Number(h.valueUsd) || 0), 0);

  const row = (sym: string, addr: string | null, mid: string, right: string, title: string, fill = 0, thumb = "") => {
    const bar = fill > 0 ? `<span class="hfill" style="width:${fill.toFixed(1)}%"></span>` : "";
    const inner = `${bar}${thumb}<span class="hsym">${esc(sym)}</span>${mid}${right}<span class="hgo" aria-hidden="true">↗</span>`;
    // An anchor rather than a click handler: it needs no script, so the host
    // page's CSP cannot stop it opening.
    return addr
      ? `<a class="hrow2 link" href="${dexLink(addr)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${inner}</a>`
      : `<div class="hrow2">${inner}</div>`;
  };

  const posList = all.length
    ? `<div class="hlist">${all.slice(start, start + HOLD_PAGE).map((h: any) => {
        // The percentage is the unrealised return on the position, not a 24h
        // move — the source has no such figure and inventing the timeframe
        // would be the kind of wrong nobody can see.
        const ch = h.returnPct;
        const cls = ch == null ? "" : ch >= 0 ? "up" : "dn";
        const v = Number(h.valueUsd) || 0;
        // The chain goes in the gap between the name and the money, which was
        // dead space. It earns the room: this trader holds the same kind of
        // position on four different networks and the symbol alone never said
        // which one a row was.
        const net = h.chain && CHAIN_LABEL[h.chain]
          ? `<span class="hchainlogo" title="${esc(CHAIN_LABEL[h.chain].name)}">${chainLogo(CHAIN_LABEL[h.chain].logo, 15)}</span>` : "";
        return row(h.symbol, h.address,
          net + `<span class="hval2">${h.valueUsd == null ? "—" : money(h.valueUsd)}</span>`,
          `<span class="hchg ${cls}">${ch == null ? "" : fmtPct(Number(ch))}</span>`,
          `${h.symbol}: ${money(v)} held, ${ch == null ? "return unknown" : Number(ch).toFixed(1) + "% unrealised"}`,
          maxVal > 0 && v > 0 ? Math.max(1.5, Math.min(100, (v / maxVal) * 100)) : 0,
          tokThumb(h.symbol, h.image, imgCache));
      }).join("")}</div>
      ${maxPage > 1 ? `<div class="pager">
        <button data-hpage="prev" ${page === 0 ? "disabled" : ""}>‹ Prev</button>
        <span>${start + 1}–${Math.min(start + HOLD_PAGE, all.length)} of ${all.length}</span>
        <button data-hpage="next" ${page >= maxPage - 1 ? "disabled" : ""}>Next ›</button>
      </div>` : ""}`
    : `<div class="tpempty">No captured positions for this trader yet.</div>`;

  // Trades carry no logo of their own; borrow it from the holdings by address.
  const imgByAddr: Record<string, string> = {};
  for (const h of all) if (h.address && h.image) imgByAddr[String(h.address).toLowerCase()] = h.image;

  const trades = f?.trades || [];
  const tMaxPage = Math.max(1, Math.ceil(trades.length / HOLD_PAGE));
  const tPage = Math.max(0, Math.min(tMaxPage - 1, holdPage));
  const tStart = tPage * HOLD_PAGE;
  const tradeList = (trades.length
    ? `<div class="hlist">${trades.slice(tStart, tStart + HOLD_PAGE).map((t: any) => {
        const open = t.status !== "closed";
        const v = t.pnlUsd;
        const cls = v == null ? "" : v >= 0 ? "up" : "dn";
        const when = t.closedAt || t.createdAt;
        const net = t.chain && CHAIN_LABEL[t.chain]
          ? `<span class="hchainlogo" title="${esc(CHAIN_LABEL[t.chain].name)}">${chainLogo(CHAIN_LABEL[t.chain].logo, 15)}</span>` : "";
        // A FOMO swap carries a direction (buy/sell) and a USD size but no PnL.
        // Show those — a green "buy"/red "sell" tag and the dollar size — rather
        // than a hardcoded "closed" and an empty PnL column.
        const side = t.status === "buy" ? "up" : t.status === "sell" ? "dn" : "";
        const label = t.status === "buy" || t.status === "sell" ? t.status : (open ? "open" : "closed");
        const size = t.amount != null ? money(t.amount) : (v == null ? "—" : (v >= 0 ? "+" : "") + money(v));
        const timg = tokThumb(t.symbol, imgByAddr[String(t.address || "").toLowerCase()], imgCache);
        return row(t.symbol, t.address,
          net + `<span class="tstatus ${side || (open ? "open" : "")}">${label}</span>`,
          `<span class="hchg">${size}</span>` +
          `<span class="twhen2">${when ? fmtAgoShort(Number(when)) : ""}</span>`,
          t.note ? String(t.note).slice(0, 180) : `${t.symbol} · ${label} ${size}`,
          0, timg);
      }).join("")}</div>
      ${tMaxPage > 1 ? `<div class="pager">
        <button data-hpage="prev" ${tPage === 0 ? "disabled" : ""}>‹ Prev</button>
        <span>${tStart + 1}–${Math.min(tStart + HOLD_PAGE, trades.length)} of ${trades.length}${f?.moreTrades ? "+" : ""}</span>
        <button data-hpage="next" ${tPage >= tMaxPage - 1 ? "disabled" : ""}>Next ›</button>
      </div>` : ""}`
    : `<div class="tpempty">Nothing recorded for this trader yet.</div>`);

  // A trailing "+" rather than a made-up total: the feed says only whether
  // more exists, not how much, and printing a number we do not have would be
  // the same overstatement the old lifetime count was there to prevent.
  const more = f?.moreTrades ? "+" : "";
  const holds = `<div class="tclabel">
      <div class="tfseg">
        <button data-ttab="positions" class="${tab === "positions" ? "on" : ""}">Positions ${all.length}</button>
        <button data-ttab="trades" class="${tab === "trades" ? "on" : ""}">History ${trades.length}${more}</button>
      </div>
    </div>
    ${tab === "positions" ? posList : tradeList}
    <div class="gsrc">holdings ranked by value · via FOMO</div>`;

  // Three states, said apart. Still loading is not the same as loaded-and-empty,
  // and neither is the same as the API refusing us on credits — rendering all
  // three as blank figures would make an outage look like a quiet trader.
  const notice = f?.quotaError
    ? `<div class="tvbadge"><b>Stats unavailable.</b> ${esc(f.quotaError)}</div>`
    : f && !f.deep
      ? `<div class="tpempty"><span class="spin"></span> Loading track record…</div>`
      : "";

  // Wallets follow the active source — the panel is showing one platform's
  // profile, so it shows that platform's addresses.
  const w = (source === "pump" ? p?.wallets : f?.wallets) || f?.wallets || p?.wallets || {};
  const wallets = [
    w.evm ? `<div class="wrow"><span class="wtag">EVM</span><span class="waddr">${esc(shortAddr(w.evm))}</span></div>` : "",
    w.solana ? `<div class="wrow"><span class="wtag">SOL</span><span class="waddr">${esc(shortAddr(w.solana))}</span></div>` : "",
  ].join("");

  // Source switch — only when both platforms know the handle. FOMO leads.
  const toggle = f && p
    ? `<div class="tsrcseg">
        <button data-tsrc="fomo" class="${source === "fomo" ? "on" : ""}">${FOMO_MARK_SM}<span>FOMO</span></button>
        <button data-tsrc="pump" class="${source === "pump" ? "on" : ""}">${PUMP_MARK_SM}<span>pump.fun</span></button>
      </div>`
    : "";

  const followers = source === "pump"
    ? (p?.followers != null ? `<div class="tpfol" title="Followers on pump.fun"><b>${fmtCount(p.followers)}</b><span>on pump.fun</span></div>` : "")
    : (f?.followers ? `<div class="tpfol" title="Followers on FOMO, not on X"><b>${fmtCount(f.followers)}</b><span>on FOMO</span></div>` : "");

  const head = `<div class="tphead">
      <div class="tpav">${disc}</div>
      <div class="tpmeta">
        <div class="tpname">${esc((source === "pump" ? p?.handle : f?.displayName || f?.handle) || p?.handle || handle)}
          ${source !== "pump" && f?.verified ? `<span class="tver">✓</span>` : ""}</div>
        <div class="tphandle">@${esc(handle)}</div>
      </div>
      ${followers}
      <button class="xclose" data-act="tpclose" title="Close (Esc)" aria-label="Close">&#10005;</button>
    </div>
    ${toggle}`;

  // pump.fun view: it carries a profile, not a trading record, so this is the
  // identity and reach, plus a jump to their pump.fun page.
  if (source === "pump" && p) {
    const pumpUrl = p.wallets?.solana ? `https://pump.fun/profile/${encodeURIComponent(p.wallets.solana)}` : `https://pump.fun/@${encodeURIComponent(handle)}`;
    const pumpStats = `<div class="hsum">
      <div class="hsumcell"><span>Followers</span><b>${p.followers != null ? fmtCount(p.followers) : "—"}</b></div>
      <div class="hsumcell"><span>Following</span><b>${p.following != null ? fmtCount(p.following) : "—"}</b></div>
      <div class="hsumcell"><span>Link</span><b class="${p.link === "confirmed" ? "lo" : ""}">${p.link === "confirmed" ? "Confirmed" : "Name"}</b></div>
    </div>`;
    return `<div class="tp">
      ${head}
      ${p.bio ? `<div class="tpbio">${esc(p.bio)}</div>` : ""}
      ${pumpStats}
      ${wallets ? `<div class="tpsec wsec">${wallets}</div>` : ""}
      <div class="tpsec" style="border-top:1px solid var(--line)">
        <a class="tpext" href="${pumpUrl}" target="_blank" rel="noopener noreferrer">${PUMP_MARK_SM}<span>View on pump.fun</span><span class="hgo2">↗</span></a>
      </div>
    </div>`;
  }

  // Bio, straight from FOMO's profile (newlines preserved).
  const bioHtml = f?.bio ? `<div class="tpbio">${esc(f.bio)}</div>` : "";

  // Biggest wins: a horizontal strip of the trader's top positions by USD profit.
  const wins = topWins(f?.holdings || []);
  const winStrip = wins.length
    ? `<div class="ttlabel">Biggest wins</div>
       <div class="ttrades">${wins.map((h: any, i: number) => `
         <div class="ttcard">
           <div class="tthd">#${i + 1} Trade</div>
           <div class="ttrow">${tokThumb(h.symbol, h.image, imgCache)}<span class="ttsym">${esc(h.symbol)}</span></div>
           <div class="ttfoot"><span class="ttpnl">+${fmtCompact(h.pnlUsd)}</span>${
             h.returnPct != null ? `<span class="ttpct">▲${fmtPct(Math.abs(Number(h.returnPct))).replace("+", "")}</span>` : ""}</div>
         </div>`).join("")}</div>`
    : "";

  return `<div class="tp">
    ${head}
    ${bioHtml}
    ${notice}${summary}${winStrip}${pnl}${statHtml}${f && !f.deep ? "" : holds}
    ${wallets ? `<div class="tpsec wsec">${wallets}</div>` : ""}
  </div>`;
}

/** Bring the Analyze dock in line with the profile on screen. */
async function syncTraderDock() {
  const handle = xProfileHandle(location.href);
  if (!handle) { if (traderHandle) removeTraderDock(); return; }
  const key = handle.toLowerCase();
  if (traderDismissed.has(key)) return;
  if (traderHandle && traderHandle.toLowerCase() === key) { paintTraderInline(); return; }

  // New profile: clear the old overlays and resolve this one. The deep call is
  // made up front now (the PnL badge and top-holdings row are shown inline, not
  // behind a click), joined with a bio-token check for a possible Buy chip.
  removeTraderDock();
  traderHandle = handle;
  const [data, token] = await Promise.all([
    send({ type: "STRIX_TRADER", handle, deep: true }).catch(() => null),
    findBioToken(handle).catch(() => null),
  ]);
  if (xProfileHandle(location.href) !== handle) return;        // navigated away mid-flight
  const trader = data && (data.fomo || data.pump) ? data : null;
  if (!trader && !token) return;                               // not a trader, no bio token — nothing to show

  traderState = { handle, data: trader, token };
  paintTraderInline();
}

const DOCK_ATTR = "data-strix-dock";
/** Tokens the user dismissed this page-load, so the dock stays gone. */
const dockDismissed = new Set<string>();
let dockCa: string | null = null;

function removeDock() {
  document.querySelectorAll(`[${DOCK_ATTR}]`).forEach((el) => el.remove());
  dockCa = null;
}

/**
 * Floating trading panel for the address in the URL.
 *
 * Same isolation rules as the inline pill: a closed shadow root the host page
 * cannot read, and every control gated on a trusted event so page script
 * cannot drive a trade with a synthetic click.
 */
function mountDock(ca: string, chainHint: string | null) {
  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.setAttribute(DOCK_ATTR, "");
  host.style.cssText = "all:initial;position:fixed;inset:auto 0 0 auto;z-index:2147483000;";
  ["click", "pointerdown", "mousedown", "mouseup", "keydown"].forEach((ev) =>
    host.addEventListener(ev, (e) => e.stopPropagation()));

  const sh = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  sh.appendChild(style);

  const dock = document.createElement("div");
  dock.className = "dock";
  sh.appendChild(dock);
  document.body.appendChild(host);

  const label = "Trade on Impulse";
  const pill = document.createElement("button");
  pill.className = "pill";
  pill.innerHTML = `${LOGO}<span>${label}</span>`;
  dock.appendChild(pill);

  const close = document.createElement("button");
  close.className = "dockx";
  close.textContent = "hide for this token";
  close.setAttribute("aria-label", "Hide the Impulse panel for this token");
  dock.appendChild(close);
  close.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    dockDismissed.add(ca.toLowerCase());
    removeDock();
  });

  // The URL dock is the entry point on Pons, DexScreener, pump.fun and
  // DexTools, and it was the last surface still opening the old bottom-right
  // card — the same panel, the same token, in a different shape and palette
  // from the one a tweet opens. It uses openDrawer now, so every route into
  // the trade panel lands on the same screen.
  pill.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    openDrawer(ca, false, chainHint);
    pill.querySelector("span")!.textContent = drawerCa === ca ? "Hide" : label;
  });
}

/** Bring the dock in line with whatever the URL now points at. */
async function syncDock() {
  const raw = urlToken(location.href);
  if (!raw) { if (dockCa) removeDock(); return; }

  // DexScreener-style URLs name a pool, not a token: resolve it to the real
  // contract first. The URL still holds the pool address, so the "navigated
  // away" checks below compare against that.
  let hit: UrlHit = raw;
  if (raw.pair) {
    const poolKey = raw.ca.toLowerCase();
    const r = await send({ type: "STRIX_PAIRTOKEN", pair: raw.ca, chain: raw.chain });
    const now = urlToken(location.href);
    if (!now || now.ca.toLowerCase() !== poolKey) return; // moved on mid-resolve
    if (!r?.ca) { if (dockCa) removeDock(); return; }      // pool didn't resolve
    hit = { ca: String(r.ca), chain: r.chain || raw.chain };
  }

  const key = hit.ca.toLowerCase();
  if (dockDismissed.has(key)) return;
  if (dockCa && dockCa.toLowerCase() === key) return; // already showing this one

  // Verified before it mounts, exactly like the inline pill: a wallet address
  // or a base58-shaped path word must never get a Buy button.
  if (!(await isToken(hit.ca, hit.chain || undefined))) return;
  // The user may have navigated again while that lookup was in flight — compare
  // against the pool for a pair URL, the token for a direct one.
  const still = urlToken(location.href);
  if (!still || still.ca.toLowerCase() !== raw.ca.toLowerCase()) return;

  removeDock();
  dockCa = hit.ca;
  mountDock(hit.ca, tokenChains.get(key) || hit.chain || null);
}

/**
 * Watch for SPA navigation.
 *
 * Every site this targets is a single-page app: opening a token on Pons or
 * DexScreener swaps the URL through pushState and never reloads. A one-shot
 * read at startup would pin the dock to whichever token you first landed on
 * and be wrong for the rest of the session.
 */
function watchUrl(onChange: () => void) {
  let last = location.href;
  const fire = () => {
    if (location.href === last) return;
    last = location.href;
    onChange();
  };
  for (const m of ["pushState", "replaceState"] as const) {
    const orig = history[m];
    history[m] = function (this: History, ...args: any[]) {
      const r = (orig as any).apply(this, args);
      // location is only updated once the original call returns.
      setTimeout(fire, 0);
      return r;
    } as any;
  }
  window.addEventListener("popstate", fire);
  window.addEventListener("hashchange", fire);
  // Some routers write the URL without either API; a slow poll is the backstop.
  setInterval(fire, 1200);
}

/**
 * The text under an element, with node boundaries preserved.
 *
 * Never use textContent for matching. It concatenates across elements, so a
 * timestamp rendered in its own span arrives glued to what precedes it —
 * "0x…4389ecb0" + "22:27" — and the address pattern's trailing not-a-hex guard
 * then rejects a perfectly good address. That guard is right to exist: it stops
 * a 40-character slice being taken out of a 64-character transaction hash. So
 * the fix is to stop manufacturing adjacency that is not on screen.
 */
function nodeText(el: Element): string {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const v = n.nodeValue;
    if (v && v.trim()) parts.push(v);
  }
  return parts.join(String.fromCharCode(10));
}

function scan() {
  document.querySelectorAll<HTMLElement>(`[data-testid="tweetText"]:not([${MARK}])`).forEach((node) => {
    node.setAttribute(MARK, "1");
    scanNode(node, nodeText(node));
  });
  scanGeneric();
}

/* ── generic pages ────────────────────────────────────────────────────────
   X gets a precise selector because its markup is known. Everywhere else —
   Telegram Web, Discord, a forum, a blog — there is no such handle, so text
   nodes are walked directly and the pill is mounted after the nearest block
   the text sits in. */

// Non-global copies: .test() on a /g/ regex advances lastIndex and so returns
// alternating results on repeated calls. A genuinely nasty source of "works
// every other scroll".
const ADDR_TEST = /0x[a-fA-F0-9]{40}/;
const SOL_TEST = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const TICKER_TEST = /\$[A-Za-z][A-Za-z0-9]{1,9}(?![A-Za-z0-9])/;

// `pre` stays out — that is a real code block, and a hex constant inside one is
// a code sample, not a call. Inline `code` is now allowed, because in every chat
// client a pasted contract address is rendered as monospace to make it
// tap-to-copy: excluding it meant Telegram and Discord, the two places people
// actually share addresses, never showed a buy button. A `code` inside a `pre`
// is still skipped, which keeps documentation sites quiet.
const SKIP_SEL =
  `[${HOST_ATTR}], [${MARK}], script, style, noscript, pre, textarea, input, ` +
  `select, [contenteditable="true"], [aria-hidden="true"]`;

/**
 * Is this text inside a list of links — a sidebar, search results, a nav?
 *
 * Telegram shows every conversation's last message in the chat list, so an
 * address someone sent appears twice: once in the message, once in the sidebar
 * preview. The sidebar copy is navigation, not content, and a buy button there
 * is both wrong and in the way.
 *
 * The test is structural rather than a list of site selectors: the text sits
 * inside a link whose siblings are also links. One anchor is a link preview or
 * a mention. Three side by side is a list of destinations.
 */
function inNavList(el: Element): boolean {
  const a = el.closest("a");
  if (!a) return false;
  // Walk a few levels out looking for the container this link belongs to. The
  // immediate parent alone was too strict — a chat list wraps each row, so the
  // sibling count came back as one and the sidebar kept getting a button.
  let p: Element | null = a.parentElement;
  for (let i = 0; i < 3 && p && p !== document.body; i++, p = p.parentElement) {
    if (p.querySelectorAll("a").length >= 3) return true;
  }
  return false;
}

/** Cap per page: a long thread full of addresses should not mount fifty panels. */
const GENERIC_LIMIT = 12;

/**
 * Panels currently ON SCREEN, not panels ever created.
 *
 * A running total was wrong for exactly the apps this scanner exists for.
 * Telegram and Discord virtualise their message lists — a message that scrolls
 * out is removed from the DOM, taking its panel with it — so a long session
 * burned through the cap and then silently stopped mounting anything, with no
 * way for the user to tell that had happened.
 */
function liveMounts(): number {
  return document.querySelectorAll(`[${HOST_ATTR}]:not([${TRADER_ATTR}]):not([${DOCK_ATTR}])`).length;
}

/**
 * Where to put the pill: the nearest block-level ancestor that can actually
 * show it.
 *
 * "Nearest block" alone is not enough, and Telegram is why. An address inside a
 * link-preview card sits in an `<a class="webpage">` that is `overflow:hidden`
 * with a clamped height — so the pill mounted correctly, measured 420x40, and
 * was clipped into invisibility. Being inside an anchor is worse still: the
 * click would have followed the link instead of opening the panel.
 *
 * So two kinds of ancestor are climbed out of before a block is chosen:
 * anything that clips, and any link. The one exception is a scroll container —
 * a message list clips by design, and escaping it would put the pill outside
 * every message rather than under one.
 */
function blockAncestor(el: Element): Element {
  // Start at the element holding the text and climb only until something can
  // actually display a pill. Searching for "the nearest block ancestor" was
  // the wrong shape: on Telegram every wrapper between the message and the app
  // root clips, so the search walked out to the entire message list and
  // mounted a zero-width pill under a thousand messages.
  //
  // An element qualifies when it is not a link (the click would navigate), does
  // not clip (the pill would be cut away), has real width, and is small enough
  // to be content rather than page furniture.
  let n: Element = el;
  for (let i = 0; i < 8; i++) {
    const cs = getComputedStyle(n);
    const clips =
      cs.overflow !== "visible" || cs.overflowX !== "visible" || cs.overflowY !== "visible";
    const usable =
      n.tagName !== "A" &&
      !clips &&
      n.getBoundingClientRect().width > 0 &&
      n.querySelectorAll("*").length <= 40;
    if (usable) return n;
    const parent = n.parentElement;
    if (!parent || parent === document.body) break;
    n = parent;
  }
  return n;
}

function scanGeneric() {
  const mounted = liveMounts();
  if (mounted >= GENERIC_LIMIT || !document.body) return;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(t) {
      const v = t.nodeValue;
      if (!v || v.length < 4) return NodeFilter.FILTER_REJECT;
      if (!ADDR_TEST.test(v) && !TICKER_TEST.test(v) && !SOL_TEST.test(v)) return NodeFilter.FILTER_REJECT;
      const p = (t as Text).parentElement;
      if (!p || p.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
      if (inNavList(p)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets: { host: Element; text: string }[] = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const parent = (t as Text).parentElement;
    if (!parent) continue;
    const host = blockAncestor(parent);
    // A virtualised list hands back a recycled node with our mark still on it
    // but its panel long gone. Treat that as unscanned rather than skipping it
    // forever.
    if (host.hasAttribute(MARK)) {
      const next = host.nextElementSibling;
      if (next && next.hasAttribute(HOST_ATTR)) continue;
      host.removeAttribute(MARK);
    }
    host.setAttribute(MARK, "1");
    targets.push({ host, text: "" });
    if (targets.length + mounted >= GENERIC_LIMIT) break;
  }

  for (const tgt of targets) tgt.text = nodeText(tgt.host);

  if (DEBUG) {
    dlog(`scanGeneric: ${targets.length} target(s), ${mounted} panel(s) already up`);
    targets.forEach((t, i) =>
      dlog(`  target[${i}] <${t.host.tagName.toLowerCase()}.${(t.host.className || "").toString().split(" ")[0]}>`,
        JSON.stringify(t.text.replace(/\s+/g, " ").trim().slice(0, 70))));
  }

  for (const { host, text } of targets) {
    scanNode(host, text);
  }
}

// ── Timeline ticker scanner ────────────────────────────────────────────────
// A floating button that auto-scrolls the current timeline, collecting every
// cashtag and contract it passes (deduped by tweet id), then shows them ranked
// by how many tweets named each — a fast read of what the feed is talking
// about, without scrolling it by hand, with a Buy on every row.
const SCAN_ATTR = "data-strix-scan";
let scanBusy = false;
const napMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SCAN_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.7-4.7"/></svg>`;
const SCAN_CHEV = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
const QUOTE_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1.2-4A8 8 0 1 1 21 12z"/></svg>`;

// ── Tweet hover card ───────────────────────────────────────────────────────
// Hovering a scanned ticker shows who tweeted it and what they said, in a
// body-level card (own closed shadow, fixed position) so nothing on the page or
// the popover can clip it.
const TWEET_TIP_STYLES = `
  @font-face{font-family:"ImpulseSans";font-weight:400;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-400.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-weight:600;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-600.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-700.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseMono";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexmono-700.woff2")}") format("woff2")}
  *{font-family:"ImpulseSans",-apple-system,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}
  .twc{width:100%;padding:13px 14px;border-radius:15px;background:#0a0d07;border:1px solid #222a18;
    box-shadow:0 22px 54px -16px rgba(0,0,0,.94)}
  .twh{display:flex;align-items:center;gap:7px;margin-bottom:11px;padding-bottom:10px;border-bottom:1px solid #171c11;
    font:700 12.5px "ImpulseSans",sans-serif;color:#eef3e4}
  .twh svg{color:#8a927e}
  .twh .c{color:#b6f03c;font-family:"ImpulseMono",ui-monospace,monospace}
  .twrow{display:flex;flex-direction:column;gap:3px}
  .twrow + .twrow{margin-top:11px;padding-top:11px;border-top:1px solid #12160c}
  .twn{font:700 12.5px "ImpulseSans",sans-serif;color:#b6f03c}
  .twt{font-size:12.5px;line-height:1.5;color:#c7cebb;
    display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .twmore{margin-top:11px;font:700 10px "ImpulseMono",monospace;letter-spacing:.06em;text-transform:uppercase;color:#7d8a67;text-align:center}`;

let _twtip: { el: HTMLElement; root: HTMLElement } | null = null;
function twTipEl() {
  if (_twtip) return _twtip;
  const el = document.createElement("div");
  el.style.cssText = "all:initial;position:fixed;z-index:2147483647;pointer-events:none;display:none;width:330px;";
  const sh = el.attachShadow({ mode: "closed" });
  const st = document.createElement("style"); st.textContent = TWEET_TIP_STYLES; sh.appendChild(st);
  const root = document.createElement("div"); sh.appendChild(root);
  document.body.appendChild(el);
  _twtip = { el, root };
  return _twtip;
}
function tweetCardHtml(label: string, tweets: Mention[]): string {
  const shown = tweets.slice(0, 4);
  const rows = shown.map((m) =>
    `<div class="twrow"><div class="twn">@${esc(m.h || "?")}</div><div class="twt">${esc(m.t || "")}</div></div>`).join("");
  const more = tweets.length > shown.length ? `<div class="twmore">+${tweets.length - shown.length} more</div>` : "";
  return `<div class="twc"><div class="twh">${QUOTE_ICON}<span>Who tweeted <span class="c">${esc(label)}</span></span></div>${rows}${more}</div>`;
}
function showTwTip(rect: DOMRect, html: string) {
  const t = twTipEl();
  t.root.innerHTML = html;
  t.el.style.display = "block";
  const W = 330, gap = 10;
  let left = rect.left + rect.width / 2 - W / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - W - 8));
  t.el.style.left = `${left}px`;
  const h = (t.root.firstElementChild as HTMLElement)?.offsetHeight || 120;
  let top = rect.top - h - gap;
  if (top < 8) top = rect.bottom + gap;   // flip below if no room above
  t.el.style.top = `${top}px`;
}
function hideTwTip() { if (_twtip) _twtip.el.style.display = "none"; }
const SCAN_STYLES = `
  @font-face{font-family:"ImpulseSans";font-weight:600;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-600.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-700.woff2")}") format("woff2")}
  .scanfab{display:inline-flex;align-items:center;gap:8px;padding:10px 15px;border-radius:999px;
    border:1px solid #26331a;background:#0c1207;color:#b6f03c;cursor:pointer;
    font:700 13px "ImpulseSans",-apple-system,sans-serif;box-shadow:0 12px 34px -12px rgba(0,0,0,.85);
    transition:background .12s,transform .12s}
  .scanfab:hover{background:#111a0b;transform:translateY(-1px)}
  .scanfab svg{display:block;flex:0 0 auto}`;

function mountScanButton() {
  if (document.querySelector(`[${SCAN_ATTR}="btn"]`)) return;
  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.setAttribute(SCAN_ATTR, "btn");
  host.style.cssText = "all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483000;";
  ["click", "pointerdown", "mousedown", "mouseup", "keydown"].forEach((ev) =>
    host.addEventListener(ev, (e) => e.stopPropagation()));
  const sh = host.attachShadow({ mode: "closed" });
  const st = document.createElement("style"); st.textContent = SCAN_STYLES; sh.appendChild(st);
  const btn = document.createElement("button");
  btn.className = "scanfab";
  btn.innerHTML = `${SCAN_ICON}<span>Scan tickers</span>`;
  btn.title = "Scan the timeline for cashtags & contracts";
  btn.addEventListener("click", (e) => { if (e.isTrusted) void startTimelineScan(); });
  sh.appendChild(btn);
  document.body.appendChild(host);
}

// Read every tweet currently in the DOM once (X recycles nodes as you scroll,
// so this is called repeatedly and deduped by tweet id). Alongside the counts it
// remembers the FIRST tweet (newest, since we scan top-down) that named each
// ticker/contract, so a row can link back to where it was mentioned.
type Mention = { h: string; t: string; u: string };   // handle, tweet text, url

function collectTweets(
  seen: Set<string>, tickers: Map<string, number>, cas: Map<string, number>,
  tickerUrl: Map<string, string>, caUrl: Map<string, string>,
  tickerTweets: Map<string, Mention[]>, caTweets: Map<string, Mention[]>,
) {
  const push = (m: Map<string, Mention[]>, key: string, men: Mention) => {
    const arr = m.get(key) || [];
    if (arr.length < 12) arr.push(men);
    m.set(key, arr);
  };
  document.querySelectorAll("article").forEach((art) => {
    const href = (art.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null)?.getAttribute("href") || "";
    const m0 = href.match(/^(\/[^/]+\/status\/\d+)/);
    const id = href.match(/\/status\/(\d+)/)?.[1];
    if (!id || seen.has(id)) return;
    seen.add(id);
    const url = location.origin + (m0 ? m0[1] : `/i/status/${id}`);
    const handle = m0 ? (m0[1].split("/")[1] || "") : "";
    const tn = art.querySelector('[data-testid="tweetText"]');
    const text = tn ? nodeText(tn) : "";
    if (!text) return;
    const men: Mention = { h: handle, t: text.replace(/\s+/g, " ").trim().slice(0, 220), u: url };
    // Count each tweet once per distinct ticker / contract it names.
    const tset = new Set<string>();
    for (const m of text.matchAll(TICKER_RE)) if (m[1]) tset.add(m[1].toUpperCase());
    for (const t of tset) { tickers.set(t, (tickers.get(t) || 0) + 1); if (!tickerUrl.has(t)) tickerUrl.set(t, url); push(tickerTweets, t, men); }
    const cset = new Set<string>();
    for (const a of text.match(ADDR_RE) || []) cset.add(a);
    for (const s of text.match(SOL_RE) || []) if (looksLikeMint(s)) cset.add(s);
    for (const c of cset) { cas.set(c, (cas.get(c) || 0) + 1); if (!caUrl.has(c)) caUrl.set(c, url); push(caTweets, c, men); }
  });
}

async function startTimelineScan() {
  if (scanBusy) return;
  scanBusy = true;
  const my = ++_popReq;                          // shares the body-level popover + Escape/close
  document.addEventListener("keydown", popKey, true);
  const seen = new Set<string>();
  const tickers = new Map<string, number>();
  const cas = new Map<string, number>();
  const tickerUrl = new Map<string, string>();
  const caUrl = new Map<string, string>();
  const tickerTweets = new Map<string, Mention[]>();
  const caTweets = new Map<string, Mention[]>();
  const startY = window.scrollY;
  renderScanProgress(my, 0, 0);

  const MAX_TWEETS = 120, MAX_SCROLLS = 50;
  let scrolls = 0, stagnant = 0;
  try {
    while (my === _popReq && seen.size < MAX_TWEETS && scrolls < MAX_SCROLLS) {
      const before = seen.size;
      collectTweets(seen, tickers, cas, tickerUrl, caUrl, tickerTweets, caTweets);
      renderScanProgress(my, seen.size, tickers.size);
      if (seen.size === before) { if (++stagnant >= 5) break; } else stagnant = 0; // hit the end of the loaded feed
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      scrolls++;
      await napMs(450);                            // let the next window of tweets render
    }
    collectTweets(seen, tickers, cas, tickerUrl, caUrl, tickerTweets, caTweets);
  } finally {
    scanBusy = false;
    window.scrollTo(0, startY);                     // put them back where they were
  }
  if (my === _popReq) renderScanResults(my, seen.size, tickers, cas, tickerUrl, caUrl, tickerTweets, caTweets);
}

function renderScanProgress(token: number, scanned: number, found: number) {
  if (token !== _popReq) return;
  const p = popEl();
  p.el.style.display = "block";
  p.root.innerHTML =
    `<div class="pbackdrop"><div class="pcard scanpop"><div class="phead">` +
      `<div class="plogo scanlg">${SCAN_ICON}</div>` +
      `<div class="ptitle"><b>Scanning timeline</b><span>reading your feed</span></div>` +
      `<button class="pclose" title="Stop">${CHART_X}</button></div>` +
      `<div class="pbody"><div class="drawer"><div class="sprog">` +
        `<div class="sprogbar"><span></span></div>` +
        `<div class="sprognums">` +
          `<div class="spn"><b>${scanned}</b><span>tweets read</span></div>` +
          `<div class="spn"><b class="ac">${found}</b><span>tickers found</span></div>` +
        `</div>` +
        `<div class="sprognote">Collecting cashtags, hang tight</div>` +
      `</div></div></div></div></div>`;
  const bd = p.root.querySelector(".pbackdrop") as HTMLElement;
  bd.addEventListener("click", (e) => { if (e.target === bd) closePop(); });
  (p.root.querySelector(".pclose") as HTMLElement).addEventListener("click", (e) => { e.stopPropagation(); closePop(); });
}

function renderScanResults(token: number, scanned: number, tickers: Map<string, number>, cas: Map<string, number>,
  tickerUrl?: Map<string, string>, caUrl?: Map<string, string>,
  tickerTweets?: Map<string, Mention[]>, caTweets?: Map<string, Mention[]>) {
  if (token !== _popReq) return;
  const p = popEl();
  const tk = [...tickers.entries()].sort((a, b) => b[1] - a[1]);
  const ca = [...cas.entries()].sort((a, b) => b[1] - a[1]);
  const maxT = tk.length ? tk[0][1] : 1;
  const maxC = ca.length ? ca[0][1] : 1;

  // The logo + name is a hover zone: hovering shows who tweeted it and what they
  // said (a body-level card), clicking opens the top tweet. The rest of the row
  // buys; the FOMO thesis avatars sit inside the card, under the ticker.
  const open = (url: string | undefined, inner: string) => url
    ? `<a class="sopen" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<span class="sopen">${inner}</span>`;

  const tRow = ([sym, n]: [string, number], i: number) =>
    `<div class="sgroup${i < 3 ? " top" : ""}"><div class="srow link" data-tkr="${esc(sym)}" title="Trade $${esc(sym)}">` +
      `<span class="sfill" style="width:${Math.max(7, (n / maxT) * 100).toFixed(1)}%"></span>` +
      `<span class="srank">${i + 1}</span>` +
      open(tickerUrl?.get(sym), `<span class="slogo">${scanFb(sym)}</span>` +
        `<span class="smeta"><span class="ssym">$${esc(sym)}</span><span class="smc"></span></span>`) +
      `<span class="scount">${n}<i>×</i></span>` +
      `<span class="sbuy">Buy<span class="sgo">↗</span></span></div><div class="rfomo" hidden></div></div>`;
  const cRow = ([addr, n]: [string, number]) =>
    `<div class="sgroup"><div class="srow link" data-ca="${esc(addr)}" title="${esc(addr)}">` +
      `<span class="sfill dim" style="width:${Math.max(7, (n / maxC) * 100).toFixed(1)}%"></span>` +
      open(caUrl?.get(addr), `<span class="slogo">${scanFb(short(addr))}</span>` +
        `<span class="smeta"><span class="ssym mono">${esc(short(addr))}</span><span class="smc"></span></span>`) +
      `<span class="scount">${n}<i>×</i></span>` +
      `<span class="sbuy">Buy<span class="sgo">↗</span></span></div><div class="rfomo" hidden></div></div>`;

  const summary = `<div class="ssum">
    <div class="ssumcell"><b>${scanned}</b><span>Tweets read</span></div>
    <div class="ssumcell"><b class="ac">${tk.length}</b><span>Cashtags</span></div>
    <div class="ssumcell"><b>${ca.length}</b><span>Contracts</span></div>
  </div>`;

  const body = (tk.length || ca.length)
    ? summary +
      (tk.length ? `<div class="scap">Cashtags · most mentioned</div><div class="slist">${tk.map(tRow).join("")}</div>` : "") +
      (ca.length ? `<div class="scap">Contracts</div><div class="slist">${ca.map(cRow).join("")}</div>` : "") +
      `<div class="gsrc">tap any row to resolve & trade</div>`
    : `<div class="sempty"><div class="semoji">🔍</div><b>Nothing to trade here</b>` +
      `<span>No cashtags or contracts in the ${scanned} tweets scanned.</span></div>`;

  p.root.innerHTML =
    `<div class="pbackdrop"><div class="pcard scanpop"><div class="phead">` +
      `<div class="plogo scanlg">${SCAN_ICON}</div>` +
      `<div class="ptitle"><b>Timeline tickers</b><span>${scanned} tweets scanned</span></div>` +
      `<button class="pclose" title="Close">${CHART_X}</button></div>` +
      `<div class="pbody"><div class="drawer">${body}</div></div></div></div>`;
  const bd = p.root.querySelector(".pbackdrop") as HTMLElement;
  bd.addEventListener("click", (e) => { if (e.target === bd) closePop(); });
  (p.root.querySelector(".pclose") as HTMLElement).addEventListener("click", (e) => { e.stopPropagation(); closePop(); });
  // The logo/name zone opens the top tweet on click (keep that off the buy row)
  // and, on hover, shows who tweeted this ticker and what they said.
  p.root.querySelectorAll<HTMLElement>(".sopen").forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); });
    const row = el.closest(".srow") as HTMLElement | null;
    const isTkr = !!row?.dataset.tkr;
    const key = (isTkr ? row?.dataset.tkr : row?.dataset.ca) || "";
    const tweets = (isTkr ? tickerTweets?.get(key) : caTweets?.get(key)) || [];
    if (!tweets.length) return;
    const label = isTkr ? `$${key}` : short(key);
    el.addEventListener("mouseenter", () => showTwTip(el.getBoundingClientRect(), tweetCardHtml(label, tweets)));
    el.addEventListener("mouseleave", hideTwTip);
  });
  // A contract opens straight away; a cashtag opens its resolved token when the
  // enrich pass has found one, otherwise resolves on click.
  p.root.querySelectorAll<HTMLElement>("[data-ca]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (!e.isTrusted) return; e.stopPropagation(); closePop();
      openDrawer(el.dataset.rca || el.dataset.ca!, false, el.dataset.rchain || null);
    }));
  p.root.querySelectorAll<HTMLElement>("[data-tkr]").forEach((el) =>
    el.addEventListener("click", async (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      if (el.classList.contains("resolving")) return;
      if (el.dataset.rca) { closePop(); openDrawer(el.dataset.rca, true, el.dataset.rchain || null); return; }
      if (el.classList.contains("scanna")) return;
      el.classList.add("resolving");
      const r = await send({ type: "STRIX_TICKER", symbol: el.dataset.tkr }).catch(() => null);
      el.classList.remove("resolving");
      if (r?.address) { closePop(); openDrawer(String(r.address), true, r.chain || null); }
      else { el.classList.add("scanna"); el.setAttribute("title", "No tradable token found for this cashtag"); }
    }));

  // Enrich each row with its logo + market cap from DexScreener (throttled).
  void enrichScanRows(p, token);
}

/** A lettered, symbol-tinted fallback avatar until the real logo loads. */
function scanFb(label: string): string {
  const s = String(label || "?").replace(/^\$/, "");
  const hue = [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<span class="sfb" style="background:hsl(${hue} 42% 24%);color:hsl(${hue} 80% 74%)">${esc((s[0] || "?").toUpperCase())}</span>`;
}

/** Fill a scan row's detail drawer: the top 5 FOMO thesis authors on this token
 *  (hover an avatar for their thesis, exactly like the tweet overlay), and a
 *  toggle listing who tweeted it and what they said. */
async function fillScanDetail(row: HTMLElement, detail: HTMLElement, token: number, tweets: Mention[]) {
  if (detail.dataset.loaded || token !== _popReq) return;
  detail.dataset.loaded = "1";

  const whoList = tweets.length
    ? `<div class="wholist" hidden>${tweets.map((m) =>
        `<a class="whoitem" href="${esc(m.u)}" target="_blank" rel="noopener noreferrer">` +
        `<span class="wh">@${esc(m.h || "?")}</span><span class="wt">${esc(m.t || "")}</span><span class="wgo">↗</span></a>`).join("")}</div>`
    : "";
  const whoBtn = tweets.length
    ? `<button class="whobtn" data-who>See who tweeted<span class="whoct">${tweets.length}</span></button>`
    : `<div class="rdnote">No tweet text captured.</div>`;

  detail.innerHTML =
    `<div class="rdsec"><div class="rdlbl">FOMO theses</div>` +
      `<div class="rthesis"><span class="rdnote"><span class="spin"></span> Loading theses…</span></div></div>` +
    `<div class="rdsec">${whoBtn}${whoList}</div>`;

  // Wire the who-tweeted toggle.
  const wb = detail.querySelector("[data-who]") as HTMLElement | null;
  const wl = detail.querySelector(".wholist") as HTMLElement | null;
  wb?.addEventListener("click", (e) => { if (!e.isTrusted) return; e.stopPropagation(); if (wl) { wl.hidden = !wl.hidden; wb.classList.toggle("open", !wl.hidden); } });
  detail.querySelectorAll<HTMLElement>(".whoitem").forEach((a) => a.addEventListener("click", (e) => e.stopPropagation()));

  // Resolve the token (cashtags may not be enriched yet), then load its theses.
  let ca = row.dataset.rca || row.dataset.ca || "";
  let chain = row.dataset.rchain || row.dataset.chain || "";
  if (!ca && row.dataset.tkr) {
    const r = await send({ type: "STRIX_TICKER", symbol: row.dataset.tkr }).catch(() => null);
    if (r?.address) { ca = String(r.address); chain = r.chain || ""; row.dataset.rca = ca; row.dataset.rchain = chain; }
  }
  const strip = detail.querySelector(".rthesis") as HTMLElement | null;
  if (token !== _popReq || !strip) return;
  if (!ca) { strip.innerHTML = `<span class="rdnote">Couldn't resolve a token for this.</span>`; return; }
  const items = await cachedFomoTop(ca.toLowerCase(), ca, chain || null).catch(() => []);
  if (token !== _popReq) return;
  if (items && items.length) {
    strip.innerHTML = "";
    const ts = document.createElement("div"); ts.className = "tstrip";
    for (const t of items.slice(0, 5)) ts.appendChild(buildAvatar(t, "fomo"));
    strip.appendChild(ts);
  } else {
    strip.innerHTML = `<span class="rdnote">No FOMO theses on this token yet.</span>`;
  }
}

/**
 * Enrich each scanned row: resolve it to a token (lenient DexScreener search for
 * cashtags), paint its logo + market cap, then load the top FOMO thesis authors
 * as hover-able avatars beside it. Four workers share the queue so nothing is hit
 * in one burst; everything aborts when the popover closes (`token !== _popReq`).
 */
async function enrichScanRows(p: { root: HTMLElement }, token: number): Promise<void> {
  const rows = [...p.root.querySelectorAll<HTMLElement>(".srow.link")];
  let idx = 0;
  const one = async (row: HTMLElement) => {
    const sym = row.dataset.tkr || null;
    let address = row.dataset.ca || null;
    let chain: string | null = null;
    let mcap: number | null = null;
    let logo: string | null = null;
    try {
      if (sym) {
        const r = await send({ type: "STRIX_DEXTICKER", symbol: sym }).catch(() => null);
        if (token !== _popReq) return;
        const d = r?.data;
        if (!d?.address) { row.classList.add("scanna"); row.setAttribute("title", "No token found for this cashtag"); return; }
        address = String(d.address); chain = d.chain || null; mcap = d.mcap ?? null; logo = d.logo ?? null;
      } else if (address) {
        const t = await send({ type: "STRIX_TOKEN", ca: address, chain: null }).catch(() => null);
        if (token !== _popReq) return;
        if (t?.info) { mcap = Number(t.info.mcap) || null; logo = t.info.logo || null; chain = t.chain || null; }
      }
      if (!address) return;
      row.dataset.rca = address;                        // cache for an instant buy on click
      if (chain) row.dataset.rchain = chain;
      const mcEl = row.querySelector<HTMLElement>(".smc");
      if (mcEl && mcap && mcap > 0) mcEl.innerHTML = `<b>MC</b> ${fmtCompact(mcap)}`;
      if (logo) {
        const img = await send({ type: "STRIX_IMAGE", url: logo }).catch(() => null);
        if (token !== _popReq) return;
        const lg = row.querySelector<HTMLElement>(".slogo");
        if (img?.data && String(img.data).startsWith("data:image/") && lg) lg.innerHTML = `<img src="${img.data}" alt="">`;
      }
      // FOMO thesis authors on this token — the overlay, inline under the row.
      const fomoEl = row.closest(".sgroup")?.querySelector(".rfomo") as HTMLElement | null;
      if (fomoEl && !fomoEl.dataset.done) {
        fomoEl.dataset.done = "1";
        const items = await cachedFomoTop(address.toLowerCase(), address, chain).catch(() => []);
        if (token !== _popReq) return;
        if (items && items.length) {
          const ts = document.createElement("div"); ts.className = "tstrip";
          for (const it of items.slice(0, 5)) ts.appendChild(buildAvatar(it, "fomo"));
          fomoEl.innerHTML = ""; fomoEl.appendChild(ts); fomoEl.hidden = false;
        }
      }
    } catch { /* leave the fallback in place */ }
  };
  const worker = async () => { while (idx < rows.length && token === _popReq) await one(rows[idx++]); };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

/* ── Market Insights: a bottom-right button (opposite Scan tickers) that opens
   a market-pulse overlay — the Trench score, hottest launchpads, and chains —
   from tehcscreener (keyless, daily). Fetched via the background, cached. ── */
const INSIGHTS_ATTR = "data-strix-mkt";
const MKT_BANDS: Record<string, [string, string]> = {
  ded: ["#6b7a52", "Dead"], cold: ["#4fb0ff", "Cold"], active: ["#8ce04a", "Active"],
  hot: ["#f0a23c", "Hot"], euphoric: ["#ff5c8a", "Euphoric"],
};
const MKT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3l2.5-7 5 14 2.5-7H21"/></svg>`;
const usd = (n: number) => {
  n = Number(n) || 0;
  return "$" + (n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n)));
};
const mktCount = (n: number) => {
  n = Number(n) || 0;
  return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(Math.round(n));
};

const MKT_STYLES = `
  @font-face{font-family:"ImpulseSans";font-weight:600;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-600.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseSans";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-700.woff2")}") format("woff2")}
  @font-face{font-family:"ImpulseMono";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexmono-700.woff2")}") format("woff2")}
  *{font-family:"ImpulseSans",-apple-system,"Segoe UI",Roboto,sans-serif;box-sizing:border-box;margin:0}
  .mkbd{position:fixed;inset:0;z-index:2147483040;display:flex;align-items:flex-start;justify-content:center;
    padding:48px 16px;background:rgba(4,6,3,.72);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px)}
  .mkcard{width:100%;max-width:580px;max-height:calc(100vh - 96px);overflow:auto;border-radius:24px;
    background:radial-gradient(130% 90% at 100% 0%, rgba(182,240,60,.1), transparent 46%), linear-gradient(180deg,#0e1308,#080b04);
    border:1px solid #2d3d1b;box-shadow:0 40px 90px -30px rgba(0,0,0,.95), inset 0 1px 0 rgba(255,255,255,.04)}
  .mkcard::-webkit-scrollbar{width:9px} .mkcard::-webkit-scrollbar-thumb{background:#223018;border-radius:9px}
  .mkhead{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:11px;padding:18px 20px;
    background:linear-gradient(180deg,#0f1409,rgba(15,20,9,.86));backdrop-filter:blur(6px);border-bottom:1px solid #1d2814}
  .mkhead .ico{width:38px;height:38px;border-radius:12px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
    background:#141c0b;border:1px solid #35461f;color:#b6f03c}
  .mkhead .ico svg{width:21px;height:21px}
  .mktitle b{display:block;font:800 18px "ImpulseSans",sans-serif;color:#f1f6ea;letter-spacing:-.01em}
  .mktitle span{display:block;font:700 10px "ImpulseMono",monospace;letter-spacing:.09em;text-transform:uppercase;color:#7d8a67;margin-top:3px}
  .mkx{margin-left:auto;cursor:pointer;width:34px;height:34px;border-radius:10px;background:#141c0b;border:1px solid #2b3a1a;color:#9aa882;font-size:19px;line-height:1}
  .mkx:hover{color:#eef3e4;border-color:#4c651f}
  .mkbody{padding:18px 20px 22px}
  .mkload{padding:60px 0;text-align:center;color:#7d8a67;font:700 13px "ImpulseSans",sans-serif}
  .mkspinb{width:26px;height:26px;border-radius:50%;border:3px solid #223018;border-top-color:#b6f03c;margin:0 auto 14px;animation:folsp .8s linear infinite}
  /* trench hero */
  .mktr{--c:#8ce04a;border-radius:18px;padding:18px;background:linear-gradient(180deg, color-mix(in srgb, var(--c) 10%, transparent), transparent), #0a0e05;
    border:1px solid #223018;box-shadow:0 0 40px -18px var(--c)}
  .mktrow{display:flex;align-items:center;gap:18px}
  .mkbig{flex:0 0 auto;display:flex;align-items:baseline;gap:3px;color:var(--c)}
  .mkbig b{font:800 52px "ImpulseMono",ui-monospace,monospace;line-height:.9;letter-spacing:-.03em}
  .mkbig i{font-style:normal;font:800 15px "ImpulseMono",monospace;color:#5f6e49}
  .mkbandw{flex:1 1 auto;min-width:0}
  .mkbandlbl{font:800 15px "ImpulseSans",sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--c)}
  .mkbandsub{font:700 10.5px "ImpulseMono",monospace;letter-spacing:.05em;text-transform:uppercase;color:#7d8a67;margin-top:4px}
  .mkmeter{margin-top:10px;height:9px;border-radius:999px;background:#161f0d;overflow:hidden;border:1px solid #223018}
  .mkmeter span{display:block;height:100%;border-radius:999px;background:var(--c);box-shadow:0 0 12px -2px var(--c)}
  .mkspark{display:block;width:100%;height:42px;margin-top:14px}
  .mkcomp{display:flex;gap:8px;margin-top:13px;flex-wrap:wrap}
  .mkchipc{flex:1 1 0;min-width:0;padding:9px 12px;border-radius:12px;background:#10150a;border:1px solid #212c15}
  .mkchipc b{display:block;font:800 15px "ImpulseMono",ui-monospace,monospace;color:#dbe6cc}
  .mkchipc span{display:block;font:700 9px "ImpulseMono",monospace;letter-spacing:.08em;text-transform:uppercase;color:#7d8a67;margin-top:3px}
  .mkchipc em{font-style:normal;color:#8ce04a}
  /* sections */
  .mksec{margin-top:22px}
  .mksechd{display:flex;align-items:center;gap:10px;margin-bottom:13px}
  .mksechd h3{font:800 12px "ImpulseMono",monospace;letter-spacing:.14em;text-transform:uppercase;color:#b2c494}
  .mkwin{margin-left:auto;display:inline-flex;gap:3px;padding:3px;border-radius:999px;background:#10150a;border:1px solid #212c15}
  .mkwin button{padding:5px 11px;border-radius:999px;border:0;cursor:pointer;background:none;color:#7d8a67;font:800 11px "ImpulseMono",monospace;letter-spacing:.04em}
  .mkwin button.on{background:#b6f03c;color:#0a1005}
  .mkbars{display:flex;flex-direction:column;gap:9px}
  .mkbar{display:flex;align-items:center;gap:12px}
  .mkbn{flex:0 0 150px;display:flex;align-items:center;gap:9px;min-width:0}
  .mkbchip{width:26px;height:26px;border-radius:8px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;color:#0a1005;font:800 12px "ImpulseSans",sans-serif;overflow:hidden}
  .mkbchip img{width:100%;height:100%;object-fit:cover;border-radius:7px;display:block}
  .mkbn .nm{min-width:0;display:flex;flex-direction:column;gap:2px}
  .mkbn .nm b{font:800 13.5px "ImpulseSans",sans-serif;color:#eef3e4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mkbn .nm em{font-style:normal;font:700 9px "ImpulseMono",monospace;letter-spacing:.06em;text-transform:uppercase;color:#6f7d57}
  .mktrack{flex:1 1 auto;height:26px;border-radius:8px;background:#10150a;border:1px solid #1a2410;overflow:hidden;position:relative}
  .mktrack span{position:absolute;inset:0 auto 0 0;border-radius:8px;opacity:.9}
  .mkbv{flex:0 0 auto;text-align:right;display:flex;flex-direction:column;gap:2px}
  .mkbv b{font:800 14px "ImpulseMono",ui-monospace,monospace;color:#dbe6cc}
  .mkbv i{font-style:normal;font:700 9.5px "ImpulseMono",monospace;color:#6f7d57}
  .mkfoot{margin-top:20px;text-align:center;font:700 9.5px "ImpulseMono",monospace;letter-spacing:.05em;color:#55634180}
  .mkerr{padding:40px 0;text-align:center;color:#7d8a67;font:700 13px "ImpulseSans",sans-serif}
  @media (max-width:520px){ .mkbn{flex-basis:108px} .mkbig b{font-size:42px} }`;

const MKT_BTN_STYLES = `
  @font-face{font-family:"ImpulseSans";font-weight:700;font-display:swap;src:url("${chrome.runtime.getURL("fonts/plexsans-700.woff2")}") format("woff2")}
  .mkfab{display:inline-flex;align-items:center;gap:8px;padding:10px 15px;border-radius:999px;cursor:pointer;
    border:1px solid #35461f;background:linear-gradient(180deg,#0f1608,#0a0e05);color:#b6f03c;
    font:700 13px "ImpulseSans",-apple-system,sans-serif;box-shadow:0 12px 34px -12px rgba(0,0,0,.85), 0 0 22px -12px rgba(182,240,60,.5);
    transition:background .12s,transform .12s,border-color .12s}
  .mkfab:hover{background:linear-gradient(180deg,#141d0a,#0d1207);border-color:#56721f;transform:translateY(-1px)}
  .mkfab svg{display:block;width:17px;height:17px;flex:0 0 auto}`;

// Real launchpad/chain logos, proxied to data URIs (x.com CSP blocks a direct
// tehcscreener <img>), cached per URL for the session. null = tried, missing.
const mktLogoCache = new Map<string, string | null>();
function fillMktLogos(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-mklogo]").forEach((el) => {
    const url = el.getAttribute("data-mklogo") || "";
    if (!url) return;
    const cached = mktLogoCache.get(url);
    if (cached) { el.innerHTML = `<img src="${cached}" alt="">`; el.style.background = "#0a0e05"; return; }
    if (cached === null) return;                 // known-missing — keep the colored initial
    send({ type: "STRIX_IMAGE", url }).then((r) => {
      const d = r?.data && String(r.data).startsWith("data:image/") ? String(r.data) : null;
      mktLogoCache.set(url, d);
      if (d && el.isConnected) { el.innerHTML = `<img src="${d}" alt="">`; el.style.background = "#0a0e05"; }
    }).catch(() => mktLogoCache.set(url, null));
  });
}

function mktSpark(vals: number[], color: string): string {
  if (vals.length < 2) return "";
  const w = 540, h = 42, min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - ((v - min) / rng) * (h - 8) - 4).toFixed(1)}`).join(" ");
  return `<svg class="mkspark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" opacity=".92"/></svg>`;
}

function mountInsightsButton() {
  if (document.querySelector(`[${INSIGHTS_ATTR}="btn"]`)) return;
  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.setAttribute(INSIGHTS_ATTR, "btn");
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483000;";
  ["click", "pointerdown", "mousedown", "mouseup", "keydown"].forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));
  const sh = host.attachShadow({ mode: "closed" });
  const st = document.createElement("style"); st.textContent = MKT_BTN_STYLES; sh.appendChild(st);
  const btn = document.createElement("button");
  btn.className = "mkfab";
  btn.innerHTML = `${MKT_ICON}<span>Market insights</span>`;
  btn.title = "Market pulse — trench score, launchpads & chains";
  btn.addEventListener("click", (e) => { if (e.isTrusted) openInsights(); });
  sh.appendChild(btn);
  document.body.appendChild(host);
}

let mktWindow = "7d";
function openInsights() {
  document.querySelectorAll(`[${INSIGHTS_ATTR}="pop"]`).forEach((e) => e.remove());
  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.setAttribute(INSIGHTS_ATTR, "pop");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483040;";
  ["click", "pointerdown", "mousedown", "mouseup", "keydown"].forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));
  const sh = host.attachShadow({ mode: "closed" });
  const st = document.createElement("style"); st.textContent = MKT_STYLES; sh.appendChild(st);
  const root = document.createElement("div"); sh.appendChild(root);
  document.body.appendChild(host);

  const close = () => { host.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  window.addEventListener("keydown", onKey, true);

  const shell = (inner: string) =>
    `<div class="mkbd"><div class="mkcard"><div class="mkhead"><div class="ico">${MKT_ICON}</div>` +
    `<div class="mktitle"><b>Market Insights</b><span>degen market pulse · tehcscreener</span></div>` +
    `<button class="mkx" title="Close">×</button></div><div class="mkbody">${inner}</div></div></div>`;
  const wire = () => {
    const bd = root.querySelector(".mkbd") as HTMLElement;
    bd?.addEventListener("click", (e) => { if (e.target === bd) close(); });
    root.querySelector(".mkx")?.addEventListener("click", (e) => { if ((e as MouseEvent).isTrusted) close(); });
  };

  const barRows = (rows: { name: string; sub: string; val: number; color: string; logo?: string }[]) => {
    const max = Math.max(1, ...rows.map((r) => r.val));
    return `<div class="mkbars">` + rows.map((r) => {
      const pct = Math.max(3, (r.val / max) * 100).toFixed(1);
      const init = (r.name[0] || "?").toUpperCase();
      const chip = `<span class="mkbchip" style="background:${r.color}"${r.logo ? ` data-mklogo="${esc(r.logo)}"` : ""}>${esc(init)}</span>`;
      return `<div class="mkbar"><span class="mkbn">${chip}` +
        `<span class="nm"><b>${esc(r.name)}</b><em>${esc(r.sub)}</em></span></span>` +
        `<span class="mktrack"><span style="width:${pct}%;background:linear-gradient(90deg, color-mix(in srgb, ${r.color} 70%, #0a0e05), ${r.color})"></span></span>` +
        `<span class="mkbv"><b>${usd(r.val)}</b></span></div>`;
    }).join("") + `</div>`;
  };

  const render = (d: any) => {
    const t = d?.trench?.today;
    const band = String(t?.band || "active").toLowerCase();
    const [col, label] = MKT_BANDS[band] || MKT_BANDS.active;
    const score = Number(t?.score) || 0;
    const hist = (d?.trench?.history || []).slice(-60).map((x: any) => Number(x?.score) || 0);
    const comp = t?.components || {};
    const compChip = (c: any, lbl: string) => c
      ? `<div class="mkchipc"><b>${usd(c.value).replace("$", lbl === "Tokens launched" ? "" : "$")}</b><span>${esc(lbl)} · <em>${Math.round(c.percentile)}th pct</em></span></div>`
      : "";
    const trench = `<div class="mktr" style="--c:${col}"><div class="mktrow">` +
      `<div class="mkbig"><b>${score}</b><i>/100</i></div>` +
      `<div class="mkbandw"><div class="mkbandlbl">${esc(label)}</div>` +
      `<div class="mkbandsub">Trench score${t?.day ? ` · ${esc(t.day)}` : ""}</div>` +
      `<div class="mkmeter"><span style="width:${score}%"></span></div></div></div>` +
      mktSpark(hist, col) +
      `<div class="mkcomp">` +
        compChip(comp.pad_volume, "Launchpad volume") +
        (comp.tokens_launched ? `<div class="mkchipc"><b>${mktCount(comp.tokens_launched.value)}</b><span>Tokens launched · <em>${Math.round(comp.tokens_launched.percentile)}th pct</em></span></div>` : "") +
      `</div></div>`;

    const pads = (d?.launchpads?.pads || []).slice(0, 8).map((p: any, i: number) => ({
      name: String(p.display_name || p.pad || "—"),
      sub: `${String(p.chain || "")} · ${mktCount(p.tokens_launched)} launches`,
      val: Number(p.volume_usd) || 0,
      color: ["#b6f03c", "#8ce04a", "#5fd0e0", "#f0a23c", "#ff7ac2", "#9b8cff", "#4fb0ff", "#e0d24f"][i % 8],
      logo: p.logo_path ? `https://tehcscreener.com${p.logo_path}` : "",
    }));
    const chains = (d?.chains?.chains || []).slice()
      .sort((a: any, b: any) => (b?.latest?.dex_volume_usd || 0) - (a?.latest?.dex_volume_usd || 0))
      .slice(0, 8).map((c: any) => ({
        name: String(c.display_name || c.chain || "—"),
        sub: `${mktCount(c?.latest?.active_wallets)} wallets · ${mktCount(c?.latest?.dex_trades)} trades`,
        val: Number(c?.latest?.dex_volume_usd) || 0,
        color: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c.color || "")) ? c.color : "#6947e6",
        logo: c.logo_path ? `https://tehcscreener.com${c.logo_path}` : "",
      }));

    const winBtn = (w: string) => `<button class="${mktWindow === w ? "on" : ""}" data-win="${w}">${w.toUpperCase()}</button>`;
    const padsSec = `<div class="mksec"><div class="mksechd"><h3>Launchpads</h3>` +
      `<div class="mkwin">${winBtn("1d")}${winBtn("7d")}${winBtn("30d")}</div></div>` +
      (pads.length ? barRows(pads) : `<div class="mkerr">No launchpad data.</div>`) + `</div>`;
    const chainsSec = `<div class="mksec"><div class="mksechd"><h3>Chains · DEX volume</h3></div>` +
      (chains.length ? barRows(chains) : `<div class="mkerr">No chain data.</div>`) + `</div>`;

    root.innerHTML = shell(trench + padsSec + chainsSec + `<div class="mkfoot">Data via tehcscreener · updated daily</div>`);
    wire();
    fillMktLogos(root);
    root.querySelectorAll<HTMLElement>(".mkwin button").forEach((b) => b.addEventListener("click", (e) => {
      if (!(e as MouseEvent).isTrusted) return;
      const w = b.dataset.win!; if (w === mktWindow) return;
      mktWindow = w; load();
    }));
  };

  const load = () => {
    root.innerHTML = shell(`<div class="mkload"><div class="mkspinb"></div>Reading the market…</div>`);
    wire();
    send({ type: "STRIX_MARKET", window: mktWindow }).then((d) => {
      if (!d || (!d.trench && !d.launchpads && !d.chains)) { root.innerHTML = shell(`<div class="mkerr">Couldn't load market data. Try again shortly.</div>`); wire(); return; }
      render(d);
    }).catch(() => { root.innerHTML = shell(`<div class="mkerr">Couldn't load market data.</div>`); wire(); });
  };
  load();
}

function boot() {
  dlog("boot on", location.href, "| readyState =", document.readyState);
  scan();
  mountScanButton();
  mountInsightsButton();
  let t: number | undefined;
  new MutationObserver(() => { if (t) clearTimeout(t); t = window.setTimeout(() => { scan(); paintTraderInline(); paintTopFollowers(); paintVet(); paintTweetAuthors(); paintCashtags(); }, 400); }).observe(document.body, { childList: true, subtree: true });

  // The URL dock runs independently of the text scan, so it still appears on a
  // page whose body never spells the address out, and it follows SPA routing.
  void syncDock();
  void syncTraderDock();
  paintTopFollowers();
  paintVet();
  paintTweetAuthors();
  paintCashtags();
  watchUrl(() => {
    void syncDock();
    void syncTraderDock();
    paintTopFollowers();
    paintVet();
    mountScanButton();                  // survives SPA route changes
    mountInsightsButton();
    paintTweetAuthors();
    paintCashtags();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

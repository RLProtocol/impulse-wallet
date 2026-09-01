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

const LOGO = `<img src="${chrome.runtime.getURL("icons/icon48.png")}" width="16" height="16" style="border-radius:4px;display:block" alt=""/>`;
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
const CALLOUTS_ENABLED = true;

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
  if (DEBUG) console.log("%c[impulse]", "background:#c6f24a;color:#000;padding:1px 4px;border-radius:3px", ...a);
};
const PUMP_MARK = `<img src="${chrome.runtime.getURL("icons/pumpfun.png")}" width="17" height="17" style="display:block;border-radius:4px" alt=""/>`;
const PUMP_MARK_SM = `<img src="${chrome.runtime.getURL("icons/pumpfun.png")}" width="15" height="15" style="display:block;border-radius:3px" alt=""/>`;
const LOGO_LG = `<img src="${chrome.runtime.getURL("icons/icon48.png")}" width="34" height="34" style="border-radius:10px;display:block" alt=""/>`;
const BUBBLES = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="9" r="4.5"/><circle cx="17" cy="7" r="2.5"/><circle cx="15.5" cy="16.5" r="3.5"/><path d="M11.5 11.8 13 14"/><path d="M12.3 8.2 14.6 7.6"/></svg>`;

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

  .dock .pill{margin-top:0;order:2;box-shadow:0 10px 30px -10px rgba(0,0,0,.75)}

  .dock .panel{order:1;margin-top:0;margin-bottom:9px;max-height:calc(100vh - 96px);overflow-y:auto;

    box-shadow:0 24px 60px -20px rgba(0,0,0,.85)}

  .dockx{order:3;margin-top:6px;align-self:flex-end;background:none;border:0;cursor:pointer;

    font:600 10.5px ui-monospace,monospace;color:#7d8d75;letter-spacing:.08em;padding:2px 4px}

  .dockx:hover{color:#c6f24a}

  @media (max-width:520px){

    .dock{right:10px;left:10px;bottom:10px;align-items:stretch;max-width:none}

    .dock .pill{align-self:center}

    .dock .panel{max-width:none}

  }

  .pill{display:inline-flex;align-items:center;gap:6px;margin-top:8px;padding:7px 13px;border-radius:999px;

    background:linear-gradient(180deg,#b6f24a,#96d92e);border:1px solid #8fd41f;color:#0b140c;font-weight:800;

    font-size:12px;line-height:1;cursor:pointer;transition:.15s;box-shadow:0 5px 16px -6px rgba(120,190,20,.6)}

  .pill:hover{filter:brightness(1.05);transform:translateY(-1px)}

  .pill svg{opacity:.9}

  .panel{margin-top:9px;width:100%;max-width:436px;border-radius:18px;overflow:hidden;color:#ffffff;

    background:linear-gradient(180deg,#101c13,#0a110c);border:1px solid #223528;

    box-shadow:0 18px 48px -18px rgba(0,0,0,.75), inset 0 1px 0 rgba(255,255,255,.035), 0 0 0 1px rgba(163,230,53,.05);

    animation:rise .22s cubic-bezier(.22,1,.36,1) both}

  @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

  .badge.stk{color:#8fd0ff;background:rgba(93,169,255,.12);border-color:rgba(93,169,255,.32)}

  /* Which network a trade will actually settle on. Always shown: the same

     ticker exists on several chains and the wrong one is unrecoverable. */

  .chainchip{font-size:8.5px;font-weight:900;letter-spacing:.07em;text-transform:uppercase;

    padding:2px 5px;border-radius:5px;color:#0b140c}

  .chainchip.withmark{display:inline-flex;align-items:center;gap:3px;border:1px solid rgba(153,69,255,.5)}

  .stockline{margin:0 14px 12px;background:#111d15;border:1px solid #1e2f24;border-radius:12px;padding:9px 11px;

    font-size:11.5px;color:#dfeeda;text-align:center}

  .stockline b{color:#ffffff}

  .head{display:flex;align-items:center;gap:11px;padding:14px 14px 12px}

  .logo{width:42px;height:42px;border-radius:13px;object-fit:cover;flex:0 0 auto;background:#16241a;

    border:1px solid #2a3f30;display:grid;place-items:center;color:#a3e635}

  .hd{min-width:0;flex:1}

  .symrow{display:flex;align-items:center;gap:6px}

  .sym{font-weight:800;font-size:16px;color:#fff;letter-spacing:-.01em;white-space:nowrap}

  .badge{font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#bff45f;

    background:rgba(163,230,53,.12);border:1px solid rgba(163,230,53,.32);border-radius:6px;padding:2px 5px}

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

  .stat{flex:1;background:#111d15;border:1px solid #1e2f24;border-radius:12px;padding:8px 6px;text-align:center}

  .stat span{display:block;font-size:8.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#c8dcc0;margin-bottom:3px}

  .stat b{font-weight:800;font-size:13px;color:#ffffff}

  .hold{margin:0 14px 11px;background:rgba(163,230,53,.07);border:1px solid rgba(163,230,53,.18);border-radius:12px;

    padding:8px 11px;font-size:12px;color:#dfeeda}

  .hold b{color:#fff}

  .seg{display:flex;gap:5px;margin:0 14px 10px;background:#111d15;border:1px solid #1e2f24;border-radius:12px;padding:4px}

  .seg button{flex:1;border:0;background:transparent;color:#dfeeda;font-weight:800;font-size:13px;padding:8px 0;

    border-radius:9px;cursor:pointer;transition:.15s}

  .seg button.chartbtn{flex:0 0 48px;display:grid;place-items:center;padding:7px 0}

  .seg button.chartbtn:hover{color:#bff45f}

  .tfrow{display:flex;gap:5px;margin:0 14px 10px;align-items:center}

  .tfbtn{flex:1;padding:6px 0;border-radius:9px;background:#111d15;color:#dfeeda;border:1px solid #1e2f24;

    font-weight:700;font-size:11.5px;cursor:pointer;transition:.12s}

  .tfbtn:hover{border-color:#31503a;color:#ffffff}

  .tfbtn.on{background:rgba(163,230,53,.15);border-color:rgba(163,230,53,.5);color:#bff45f}

  .tfchg{flex:0 0 auto;font-size:11.5px;font-weight:800;padding:0 4px}

  .chartbox{margin:0 14px 12px;background:#0d1712;border:1px solid #1e2f24;border-radius:12px;overflow:hidden;min-height:120px}

  .socials{display:flex;gap:12px;margin:-4px 14px 10px;font-size:11px}

  .socials a{color:#dfeeda;text-decoration:none;font-weight:700}

  .socials a:hover{color:#bff45f;text-decoration:underline}

  .secbar{margin:0 14px 11px;display:flex;align-items:center;gap:7px;border-radius:12px;border:1px solid #1e2f24;

    padding:8px 11px;font-size:12px;font-weight:800;cursor:pointer}

  .secbar i{margin-left:auto;font-style:normal;font-weight:600;font-size:10.5px;opacity:.75}

  /* ── FOMO thesis feed ─────────────────────────────────────────────── */

  /* Laid out as a conversation rather than a data table: avatar, name, then the

     position stated at display size because the number IS the argument. A rail

     runs from the avatar down the row to tie the claim to its author. */

  .thesis{position:relative;margin:0 14px;padding:8px 0 9px;border-bottom:1px solid #17241b}

  .thesis:last-of-type{border-bottom:0}

  .trow{display:flex;gap:8px;align-items:flex-start}

  .tavwrap{position:relative;flex:0 0 auto}

  /* Thread rail — anchors the body to the avatar the way a reply does. */

  .tavwrap::after{content:"";position:absolute;left:50%;top:28px;bottom:-9px;width:1px;

    background:linear-gradient(#26382b,rgba(38,56,43,0));transform:translateX(-.5px)}

  .thesis:last-of-type .tavwrap::after{display:none}

  .trank{position:absolute;right:-3px;bottom:-3px;min-width:13px;height:13px;padding:0 3px;

    border-radius:99px;background:#0a120d;border:1px solid #2f4636;color:#a9cf95;

    font:800 8px/12px ui-monospace,monospace;text-align:center}

  .tav{flex:0 0 auto;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;

    overflow:hidden;user-select:none;border:1px solid #26382b}

  .tbody{flex:1 1 auto;min-width:0}



  .thead{display:flex;align-items:center;gap:5px;flex-wrap:wrap}

  .tname{font-weight:800;font-size:10.5px;color:#fff;letter-spacing:-.01em}

  .tbadge{font-size:7.5px;font-weight:800;letter-spacing:.04em;padding:1px 5px;border-radius:5px;

    background:rgba(120,170,255,.14);color:#8fb8ff;border:1px solid rgba(120,170,255,.28)}

  .tdev{font-size:7.5px;font-weight:900;letter-spacing:.05em;padding:1px 5px;border-radius:5px;

    background:rgba(251,191,36,.16);color:#fbbf24;border:1px solid rgba(251,191,36,.32)}

  .twhen{font-size:8.5px;color:#7f9478;margin-left:auto;white-space:nowrap}



  /* The position line. Big, tabular, and the only display-size type in the row. */

  .tpos{display:flex;align-items:center;gap:5px;margin-top:3px;flex-wrap:wrap}

  .tkind{font-size:8.5px;font-weight:700;color:#7f9478;letter-spacing:.02em}

  /* Market cap at call time. Muted against the multiple beside it: the multiple

     is the claim, the cap is the context for it. */

  .tcap{font-size:10.5px;font-weight:700;color:#cfe0c6;font-variant-numeric:tabular-nums}

  .tcap.up{color:#9fbf8f} .tcap.dn{color:#c99}

  .tver{font-size:9px;font-weight:900;color:#59e08a;line-height:1}

  .tx{font-size:9px;font-weight:700;color:#8fb8ff;text-decoration:none}

  .tx:hover{text-decoration:underline}

  .theld{font-size:12.5px;font-weight:800;color:#fff;letter-spacing:-.02em;

    font-variant-numeric:tabular-nums}

  .tdot{width:4px;height:4px;border-radius:99px;background:#59e08a;flex:0 0 auto}

  .tdot.dn{background:#ff7a7a}

  .tpct{font-size:9.5px;font-weight:800;font-variant-numeric:tabular-nums}

  .tpct.up{color:#59e08a} .tpct.dn{color:#ff7a7a}

  .ttook{font-size:8.5px;font-weight:700;color:#9fbf8f}



  .ttext{margin-top:5px;font-size:10.5px;line-height:1.45;color:#eef6ea;

    word-break:break-word;white-space:pre-wrap}

  .ttext a{color:#8fb8ff;text-decoration:none;word-break:break-all}

  .ttext a:hover{text-decoration:underline}



  .tfoot{margin-top:6px;display:flex;align-items:center;gap:11px}

  .tstat{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;color:#7f9478}

  .tstat svg{width:9.5px;height:9.5px;fill:none;stroke:currentColor;stroke-width:2.1}



  .fhead{display:flex;align-items:center;gap:6px;margin:0 14px 2px;padding-bottom:7px;

    border-bottom:1px solid #17241b}

  .fhead img{opacity:.92}

  .fttl{font-size:10px;font-weight:800;color:#ffffff;letter-spacing:-.01em}

  .fsub{margin-left:auto;font-size:8.5px;font-weight:700;color:#7f9478;font-variant-numeric:tabular-nums}



  /* Coming-soon panel. Centred and quiet — it is a promise, not a feature, and

     should not compete with the tabs that actually do something. */

  .soon{padding:22px 18px 20px;text-align:center;display:flex;flex-direction:column;

    align-items:center;gap:0}

  .soonlogo{width:52px;height:52px;border-radius:15px;display:grid;place-items:center;

    background:#111d15;border:1px solid #1e2f24;margin-bottom:12px}

  .soonttl{font-size:15px;font-weight:800;color:#fff;letter-spacing:-.015em}

  .soonpill{margin-top:7px;font-size:8.5px;font-weight:800;letter-spacing:.14em;

    text-transform:uppercase;padding:3px 9px;border-radius:99px;

    background:rgba(163,230,53,.1);border:1px solid rgba(163,230,53,.3);color:#bff45f}

  .soontxt{margin:12px 0 0;font-size:11px;line-height:1.55;color:#c8dcc0;max-width:34ch}

  .soonrow{margin-top:14px;display:flex;flex-wrap:wrap;gap:5px;justify-content:center}

  .soonchip{font-size:9px;font-weight:700;padding:3px 8px;border-radius:7px;

    background:#111d15;border:1px solid #1e2f24;color:#9fbf8f}

  /* ── trader profile panel ─────────────────────────────────────────── */

  /* Given more room than the trade panel on purpose: this is read, not acted

     on, so the numbers get space to be legible rather than compact. */

  .panel.wide{max-width:462px}

  .tp{padding:18px 18px 16px;display:flex;flex-direction:column;gap:16px}



  .tphead{display:flex;align-items:center;gap:13px}

  .tpav{width:52px;height:52px;border-radius:50%;overflow:hidden;flex:0 0 auto;

    background:#111d15;border:1px solid #2a3f30;display:grid;place-items:center}

  .tpmeta{min-width:0;flex:1}

  .tpname{display:flex;align-items:center;gap:6px;font-size:18px;font-weight:800;color:#fff;

    letter-spacing:-.025em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .tphandle{margin-top:1px;font-size:12px;color:#7f9478;font-weight:600}

  .tpsrc{margin-top:7px;display:flex;gap:5px;flex-wrap:wrap}

  .srcchip{display:inline-flex;align-items:center;gap:5px;font-size:9.5px;font-weight:700;

    padding:3px 7px;border-radius:7px;background:#111d15;border:1px solid #1e2f24;color:#a9cf95}

  .tpfol{flex:0 0 auto;text-align:right}

  .tpfol b{display:block;font-size:15px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums;letter-spacing:-.02em}

  .tpfol span{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7f9478}



  /* The link badge is the panel's honesty: it says how sure we are that this

     profile belongs to the handle on screen, and it never overstates. */

  .tvbadge{font-size:10.5px;line-height:1.45;font-weight:600;padding:8px 11px;border-radius:9px;

    background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.22);color:#d9ac52}

  .tvbadge b{display:block;font-size:11px;font-weight:800;color:#e8bd63;margin-bottom:1px}

  .tvbadge.ok{background:rgba(89,224,138,.07);border-color:rgba(89,224,138,.24);color:#8fcfa5}

  .tvbadge.ok b{color:#59e08a}

  /* Corroborated but unconfirmed: its own colour, so it reads as neither a

     verified link nor a bare guess. */

  .tvbadge.mid{background:rgba(120,170,255,.07);border-color:rgba(120,170,255,.22);color:#9dbbe8}

  .tvbadge.mid b{color:#8fb8ff}



  .tpsec{display:flex;flex-direction:column;gap:9px}

  .tplbl{display:flex;align-items:baseline;gap:8px;font-size:9.5px;font-weight:800;

    letter-spacing:.13em;text-transform:uppercase;color:#7f9478}

  .tpcount{margin-left:auto;letter-spacing:0;text-transform:none;font-weight:600;color:#5f7359}

  .tpempty{font-size:11.5px;color:#7f9478;padding:14px;text-align:center;

    background:#111d15;border:1px solid #1e2f24;border-radius:11px}



  .pgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}

  .pcell,.scell{background:#111d15;border:1px solid #1e2f24;border-radius:11px;

    padding:10px 8px;text-align:center}

  .plbl{font-size:9.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#adc7a1}

  .pval{display:block;margin-top:5px;font-size:14px;font-weight:800;color:#fff;

    font-variant-numeric:tabular-nums;letter-spacing:-.02em}

  .pval.up{color:#59e08a} .pval.dn{color:#ff7a7a}

  .sgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}

  .sval{display:block;margin-top:5px;font-size:13px;font-weight:800;color:#fff;

    font-variant-numeric:tabular-nums;letter-spacing:-.02em}



  .ttabs{display:flex;gap:4px;padding:3px;background:#0d1710;border:1px solid #1e2f24;border-radius:11px}

  .ttab{flex:1;display:flex;align-items:baseline;justify-content:center;gap:6px;padding:8px 6px;

    border:0;border-radius:8px;background:none;cursor:pointer;color:#7f9478;

    font:800 11px/1 "Sora",sans-serif;letter-spacing:-.01em;transition:background .12s,color .12s}

  .ttab span{font-weight:700;font-size:9.5px;color:#5f7359;font-variant-numeric:tabular-nums}

  .ttab:hover{color:#c8dcc0}

  .ttab.on{background:#1a2b1f;color:#fff}

  .ttab.on span{color:#9fbf8f}

  .tstatus{font-size:9.5px;font-weight:700;padding:2px 7px;border-radius:6px;

    background:#0d1710;border:1px solid #26382b;color:#7f9478}

  .tstatus.open{border-color:rgba(163,230,53,.28);color:#bff45f}

  .tstatus.up{border-color:rgba(89,224,138,.3);color:#59e08a}

  .tstatus.dn{border-color:rgba(255,122,122,.3);color:#ff7a7a}

  .liveh{display:flex;align-items:center;gap:6px;margin:2px 0 6px;font-size:9.5px;font-weight:800;

    letter-spacing:.12em;text-transform:uppercase;color:#59e08a}

  .livedot{width:5px;height:5px;border-radius:99px;background:#59e08a;

    box-shadow:0 0 7px #59e08a;animation:pulse 1.6s infinite}

  /* Dates the snapshot rather than hiding that it is one. */

  .hlist + .liveh{margin-top:12px}

  .twhen2{width:26px;text-align:right;font-size:9.5px;font-weight:700;color:#5f7359;

    font-variant-numeric:tabular-nums}

  .hlist{display:flex;flex-direction:column;gap:2px}

  .hrow2{display:flex;align-items:center;gap:10px;padding:10px 11px;border-radius:10px;

    background:#111d15;border:1px solid #1e2f24;text-decoration:none}

  .hrow2.link{cursor:pointer;transition:background .12s,border-color .12s}

  .hrow2.link:hover{background:#16241a;border-color:#2f4636}

  .hrow2.link:hover .hgo{opacity:1;transform:translate(1px,-1px)}

  .hsym{flex:1;font-size:13px;font-weight:800;color:#fff;letter-spacing:-.01em;

    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .hval2{font-size:13px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums;letter-spacing:-.02em}

  .hchg{width:56px;text-align:right;font-size:11px;font-weight:700;

    font-variant-numeric:tabular-nums;color:#7f9478}

  .hchg.up{color:#59e08a} .hchg.dn{color:#ff7a7a}

  .hgo{flex:0 0 auto;font-size:11px;color:#7f9478;opacity:.45;transition:opacity .12s,transform .12s}



  .wsec{padding-top:13px;border-top:1px solid #17241b;gap:6px}

  .wrow{display:flex;align-items:center;gap:9px}

  .wtag{font-size:8.5px;font-weight:800;letter-spacing:.1em;color:#7f9478;width:26px}

  .waddr{font:600 11px ui-monospace,SFMono-Regular,monospace;color:#a9cf95;

    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .secbar.ok{color:#bff45f;border-color:rgba(163,230,53,.35);background:rgba(163,230,53,.07)}

  .secbar.warn{color:#fbbf24;border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.07)}

  .secbar.bad{color:#ff7a7a;border-color:rgba(255,122,122,.4);background:rgba(255,122,122,.08)}

  .secbar.na{color:#dfeeda;background:#111d15;font-weight:600;cursor:pointer}

  .secgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0 14px 10px}

  .seccell{display:flex;justify-content:space-between;gap:6px;background:#111d15;border:1px solid #1e2f24;border-radius:10px;padding:7px 10px;font-size:11px}

  .seccell span{color:#c8dcc0}

  .seccell b.ok{color:#59e08a}.seccell b.warn{color:#fbbf24}.seccell b.bad{color:#ff7a7a}.seccell b.na{color:#dfeeda}

  .tabs2{display:flex;gap:5px;margin:0 14px 8px;background:#111d15;border:1px solid #1e2f24;border-radius:10px;padding:3px}

  .tabs2 button{flex:1;border:0;background:transparent;color:#dfeeda;font-weight:800;font-size:11.5px;padding:6px 0;border-radius:8px;cursor:pointer}

  .tabs2 button.on{background:#a3e635;color:#0b140c}

  .chips{display:flex;gap:5px;margin:0 14px 9px}

  .chip2{padding:4px 10px;border-radius:8px;background:#111d15;border:1px solid #1e2f24;color:#dfeeda;font-size:10.5px;font-weight:700;cursor:pointer}

  .chip2.on{background:rgba(163,230,53,.15);border-color:rgba(163,230,53,.5);color:#bff45f}

  .kolline{margin:0 14px 8px;padding:6px 10px;font-size:10.5px;color:#dfeeda;

    background:#111d15;border:1px solid #1e2f24;border-radius:9px;display:flex;gap:10px;align-items:center}

  .kolline b{color:#fbbf24}

  .hrow{display:flex;align-items:center;gap:9px;margin:0 14px 6px;background:#111d15;border:1px solid #1e2f24;

    border-radius:11px;padding:8px 10px;transition:border-color .12s,background .12s}

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

  .hbar{margin-top:5px;height:3px;border-radius:2px;background:#0f1a12;overflow:hidden}

  .hbar i{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,#a3e635,#bff45f)}

  .hrow.pool .hbar i{background:#31503a}

  .htag{flex:0 0 auto;padding:1px 5px;border-radius:5px;border:1px solid #2a3f30;font-size:8px;font-weight:800;

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

  .pager{display:flex;align-items:center;justify-content:center;gap:12px;margin:8px 14px 4px}

  .pager button{border:1px solid #1e2f24;background:#111d15;color:#dfeeda;font-weight:700;font-size:11px;

    padding:5px 12px;border-radius:8px;cursor:pointer;transition:.12s}

  .pager button:hover:not(:disabled){border-color:#31503a;color:#ffffff}

  .pager button:disabled{opacity:.35;cursor:default}

  .pager span{font-size:10.5px;font-weight:700;color:#c8dcc0}

  .bubblebox{margin:0 14px 4px;border-radius:12px;overflow:hidden;border:1px solid #1e2f24;background:#0d1712}

  .bubbleframe{display:block;width:100%;height:420px;border:0}

  .seg button.on-buy{background:#a3e635;color:#0b140c;box-shadow:0 3px 12px -3px rgba(163,230,53,.55)}

  .seg button.on-sell{background:#ff7a7a;color:#160b0b;box-shadow:0 3px 12px -3px rgba(255,122,122,.5)}

  .seg button:disabled{opacity:.35;cursor:default}

  .bar{padding:0 14px 14px}

  .amts{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:9px}

  .amts.pcts{grid-template-columns:repeat(3,1fr)}

  .amt{padding:9px 0;border-radius:10px;background:#111d15;color:#dfeeda;border:1px solid #1e2f24;font-weight:700;

    font-size:12.5px;cursor:pointer;transition:.12s}

  .amt:hover{border-color:#31503a;color:#ffffff}

  .amt.on{background:rgba(163,230,53,.15);border-color:rgba(163,230,53,.5);color:#bff45f}

  .cinrow{position:relative;margin-bottom:9px}

  .cin{width:100%;padding:9px 42px 9px 11px;border-radius:10px;background:#111d15;border:1px solid #1e2f24;

    color:#ffffff;font-weight:700;font-size:13px;font-family:inherit;outline:none;font-variant-numeric:tabular-nums}

  .cin:focus{border-color:rgba(163,230,53,.55)}

  .cin::placeholder{color:#83a077;font-weight:600}

  .cunit{position:absolute;right:11px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:800;color:#c8dcc0}

  .go{width:100%;padding:13px;border:0;border-radius:13px;font-weight:800;font-size:14.5px;cursor:pointer;transition:.15s}

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
    --up:#0ecb81; --down:#f6465d; --accent:#c6f24a;
    position:fixed;top:0;right:0;height:100vh;width:440px;max-width:100vw;
    display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden;
    background:var(--bg);border-left:1px solid var(--line);color:var(--text);
    box-shadow:-24px 0 60px -30px rgba(0,0,0,.9);
    animation:slidein .18s cubic-bezier(.22,1,.36,1) both;
    scrollbar-width:thin;scrollbar-color:#2b3542 transparent}
  .drawer::-webkit-scrollbar{width:8px}
  .drawer::-webkit-scrollbar-thumb{background:#2b3542;border-radius:4px}
  @keyframes slidein{from{transform:translateX(16px);opacity:0}to{transform:none;opacity:1}}
  @media (max-width:520px){ .drawer{width:100vw;border-left:0} }

  /* Numbers are the typography here. Tabular figures so a ticking price does
     not shift the layout under the cursor. */
  .drawer .sym,.drawer .pval,.drawer .stat b,.drawer .amt,.drawer .cin,
  .drawer .qval,.drawer .hold b,.drawer .tfrow button,.drawer .waddr{
    font-variant-numeric:tabular-nums;font-family:"ImpulseMono",ui-monospace,monospace}

  /* ── header ─────────────────────────────────────────────────────────── */
  .drawer .head{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:11px;
    padding:14px 16px 12px;background:var(--bg);border-bottom:1px solid var(--line)}
  .drawer .logo{width:34px;height:34px;border-radius:6px;border:1px solid var(--line);background:var(--surface)}
  .drawer .sym{font-size:15px;font-weight:700;letter-spacing:.01em;color:var(--text)}
  .drawer .name{font-size:11.5px;color:var(--muted);font-weight:500}
  .drawer .badge,.drawer .chainchip{font-size:9px;font-weight:700;letter-spacing:.06em;
    text-transform:uppercase;padding:2px 5px;border-radius:3px;background:var(--surface2);
    color:var(--muted);border:1px solid var(--line)}
  .drawer .xclose{flex:0 0 auto;align-self:flex-start;margin-left:8px;width:24px;height:24px;
    display:grid;place-items:center;border:1px solid var(--line);border-radius:4px;
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
  .drawer .amt{padding:9px 0;border-radius:4px;background:var(--surface);
    border:1px solid var(--line);color:var(--muted);font-size:12px;font-weight:600;
    cursor:pointer;transition:.12s}
  .drawer .amt:hover{border-color:#33404f;color:var(--text)}
  .drawer .amt.on{background:var(--surface2);border-color:var(--accent);color:var(--text)}
  .drawer .cinrow{position:relative}
  .drawer .cin{width:100%;padding:11px 46px 11px 12px;border-radius:4px;background:var(--surface);
    border:1px solid var(--line);color:var(--text);font-size:14px;font-weight:600}
  .drawer .cin:focus{outline:0;border-color:#3a4756}
  .drawer .cunit{position:absolute;right:12px;top:50%;transform:translateY(-50%);
    font-size:11.5px;font-weight:700;color:var(--muted);letter-spacing:.04em}

  /* The two lines that turn a buy button into an order ticket: what you get,
     and what it costs you in impact. Both are already computed for the exit
     proof; not showing them was leaving the work on the floor. */
  .drawer .quote{display:flex;flex-direction:column;gap:6px;padding:10px 12px;
    background:var(--surface);border:1px solid var(--line);border-radius:4px}
  .drawer .qrow{display:flex;align-items:baseline;justify-content:space-between;font-size:11.5px}
  .drawer .qlbl{color:var(--muted);font-weight:600}
  .drawer .qval{color:var(--text);font-weight:600}
  .drawer .qval.warn{color:#e0b252}

  .drawer .go{width:100%;padding:13px;border:0;border-radius:4px;font-size:14px;
    font-weight:700;letter-spacing:.01em;cursor:pointer;transition:.12s}
  .drawer .go.buy{background:var(--up);color:#03150d}
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
    background:var(--surface);border-radius:3px}
  .drawer .note{margin:0 16px 12px;border-radius:4px;font-size:11.5px}
  .drawer .ambig{margin:0;padding:9px 16px;border:0;border-bottom:1px solid var(--line);
    border-radius:0;font-size:10.5px}

  /* ── footer, pinned ─────────────────────────────────────────────────── */
  .drawer .foot{position:sticky;bottom:0;margin-top:auto;padding:11px 16px;
    background:var(--bg);border-top:1px solid var(--line);border-radius:0;
    font-size:11px;color:var(--muted)}
  .drawer .foot a{color:var(--accent);font-weight:600}

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
  .drawer .dirseg button{padding:11px 0;border-radius:4px;border:1px solid var(--line);
    background:var(--surface);color:var(--muted);font-size:13.5px;font-weight:700;
    cursor:pointer;transition:.12s}
  .drawer .dirseg button:hover:not(:disabled){color:var(--text);border-color:#33404f}
  .drawer .dirseg button.on-buy{background:var(--up);border-color:var(--up);color:#03150d}
  .drawer .dirseg button.on-sell{background:var(--down);border-color:var(--down);color:#1a0206}
  .drawer .dirseg button:disabled{opacity:.35;cursor:not-allowed}

  /* A refusal is prose, so it gets a block rather than a value column. */
  .drawer .qblock{margin-top:2px;padding:9px 10px;border-radius:4px;
    background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.25);
    font-size:11px;line-height:1.5;color:#f0a0aa;text-align:left}
  .drawer .qblock b{display:block;margin-bottom:3px;color:var(--down);
    font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}

  /* ── the chart, inline in the order ticket ───────────────────────────── */
  .drawer .chartbox{margin:0;padding:10px 8px 4px;background:var(--bg);
    border-bottom:1px solid var(--line);border-radius:0;border-left:0;border-right:0;border-top:0}
  .drawer .tfrow{display:flex;margin:0;padding:2px 14px 12px;
    border-bottom:1px solid var(--line);background:var(--bg)}
  .drawer .tfseg{display:inline-flex;gap:2px;padding:2px;border-radius:6px;
    background:#0f141a;border:1px solid var(--line)}
  .drawer .tfrow button{min-width:42px;padding:6px 10px;border:0;border-radius:4px;
    background:none;color:var(--muted);cursor:pointer;transition:background .12s,color .12s;
    font:600 11px/1 "ImpulseMono",ui-monospace,monospace;letter-spacing:.02em;
    font-variant-numeric:tabular-nums}
  .drawer .tfrow button:hover{color:var(--text);background:rgba(255,255,255,.05)}
  .drawer .tfrow button.on{background:var(--surface2);color:var(--text);
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

  const LINE = "#4d9fff", AXIS = "#b3bdcc", GRID = "#2a3442";
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

function openDrawer(ca: string, viaCashtag: boolean, chainHint: string | null) {
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

  drawerRoot = host;
  drawerCa = ca;
  runPanel(ca, drawer, viaCashtag, chainHint);

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

  const pill = document.createElement("button");
  pill.className = "pill";
  pill.innerHTML = `${LOGO}<span>${pillLabel}</span>`;
  root.appendChild(pill);

  pill.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    openDrawer(ca, viaCashtag, chainHint);
  });
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

function runPanel(ca: string, panel: HTMLElement, viaCashtag = false, chainHint: string | null = null) {
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
  let view: "trade" | "chart" | "safety" | "holders" | "bubbles" | "fomo" | "callouts" | "ithesis" = "trade";
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
  let holdTab: "holders" | "traders" = "holders";
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

  function ensureHolders(force = false) {
    const k = holdTab + ":" + holdTag;
    if (force) { delete holdCache[k]; delete holdErrs[k]; }
    if (holdCache[k] !== undefined || holdBusy[k]) return;
    holdBusy[k] = true;
    // Holders rank by current balance; traders rank by realized profit so
    // exited wallets surface (otherwise the two lists look identical).
    const orderBy = holdTab === "traders" ? "profit" : "amount_percentage";
    send({ type: "STRIX_GMGN", what: "holders", ca, tab: holdTab, orderBy, tag: holdTag || undefined }).then((r) => {
      holdBusy[k] = false;
      if (r?.noKey) { gmgnKey = false; holdCache[k] = null; }
      else if (r?.error) { holdCache[k] = null; holdErrs[k] = String(r.error); }
      else holdCache[k] = gRows(r?.data);
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
      </div>${ambigHtml}${statsHtml}${vtabs}`;
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
          <button data-htab="traders" class="${holdTab === "traders" ? "on" : ""}">Traders</button>
        </div>
        <div class="tfseg">
          <button data-htag="" class="${holdTag === "" ? "on" : ""}">All</button>
          <button data-htag="renowned" class="${holdTag === "renowned" ? "on" : ""}">KOL</button>
          <button data-htag="smart_degen" class="${holdTag === "smart_degen" ? "on" : ""}">Smart</button>
        </div>
      </div>`;
      let body: string;
      if (holdBusy[k] || rows === undefined) {
        body = `<div class="note"><span class="spin"></span>Loading ${holdTab}…</div>`;
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
        const top10 = rows.slice(0, 10).reduce((n: number, r: any) => n + (gIsPool(r) ? 0 : pctOf(r)), 0);
        const conc = top10 >= 50 ? "hi" : top10 >= 25 ? "mid" : "lo";
        const summary = `<div class="hsum">
          <div class="hsumcell"><span>Top 10 hold</span><b class="${conc}">${top10.toFixed(1)}%</b></div>
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
          pager + `<div class="gsrc">${holdTab === "traders" ? "ranked by realised profit" : "ranked by holdings"} · via GMGN</div>`;
      }
      content.innerHTML = `${headHtml}${tabs}${body}${footHtml}`;
    } else if (view === "ithesis") {
      // Not shipped. Stated as such rather than hidden: the other two tabs read
      // other people's platforms, and it should be obvious this one will be
      // ours — but never that it already is.
      content.innerHTML = `${headHtml}
        <div class="soon">
          <div class="soonlogo">${LOGO_LG}</div>
          <div class="soonttl">Impulse Thesis</div>
          <div class="soonpill">Coming soon</div>
          <p class="soontxt">Write why you bought, attached to the token, visible to anyone
            looking at it. Ranked by three things: the size of the position behind the words,
            the reach of the person writing them, and whether the call was right.</p>
          <div class="soonrow">
            <span class="soonchip">Your own thesis</span>
            <span class="soonchip">Caller track records</span>
            <span class="soonchip">Every chain</span>
          </div>
        </div>
        <div class="bar" style="margin-top:10px"><button class="go locked" data-act="back">← Back to trading</button></div>${footHtml}`;
    } else if (view === "callouts") {
      const fmtAgo = (ms: number) => {
        const d = Date.now() - ms;
        if (d < 60_000) return "just now";
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
        const best = all[0]?.multiple;
        const head = `<div class="fhead">${PUMP_MARK}<span class="fttl">Callouts</span>` +
          `<span class="fsub">${all.length}${best ? ` · best ${Number(best).toFixed(1)}x` : ""}</span></div>`;

        const rows = all.slice(start, start + PAGE).map((c: any, i: number) => {
          const rank = start + i + 1;
          const mult = c.multiple;
          // 1x is break-even, not zero — a call that went nowhere should read
          // neutral rather than green.
          const cls = mult == null ? "" : mult >= 1.05 ? "up" : mult <= 0.95 ? "dn" : "";
          const multi = mult == null ? ""
            : `<span class="theld">${Number(mult).toFixed(mult >= 10 ? 0 : 1)}x</span>`;
          const at = c.calledAtMcap
            ? `<span class="tkind">called at</span><span class="tcap ${cls}">${fmtCompact(c.calledAtMcap)}</span>`
            : "";
          const av = authorAvatar(c.handle || c.id, c.avatar, PUMP_MARK_SM);
          const x = c.xHandle
            ? `<a class="tx" href="https://x.com/${encodeURIComponent(c.xHandle)}" target="_blank" rel="noopener noreferrer">@${esc(c.xHandle)}</a>`
            : "";
          const peak = c.peakAt ? `<span class="tstat">peaked ${fmtAgo(Number(c.peakAt))}</span>` : "";
          return `<div class="thesis"><div class="trow">
            <div class="tavwrap">${av}<span class="trank">${rank}</span></div>
            <div class="tbody">
              <div class="thead">
                <span class="tname">${esc(c.handle || "unknown")}</span>
                ${c.verified ? `<span class="tver" title="Verified on pump.fun">✓</span>` : ""}
                ${x}
                <span class="twhen">${c.createdAt ? fmtAgo(Number(c.createdAt)) : ""}</span>
              </div>
              <div class="tpos">${multi}${at}</div>
              ${c.text ? `<div class="ttext">${linkify(c.text)}</div>` : ""}
              <div class="tfoot">${peak}</div>
            </div></div></div>`;
        }).join("");

        const pager = maxPage > 1
          ? `<div class="pager">
              <button data-cpage="prev" ${coPage === 0 ? "disabled" : ""}>‹ Prev</button>
              <span>${start + 1}–${Math.min(start + PAGE, all.length)} of ${all.length}</span>
              <button data-cpage="next" ${coPage >= maxPage - 1 ? "disabled" : ""}>Next ›</button>
            </div>`
          : "";
        body = head + rows + pager + `<div class="gsrc">via pump.fun</div>`;
      }
      content.innerHTML = `${headHtml}${body}
        <div class="bar" style="margin-top:10px"><button class="go locked" data-act="back">← Back to trading</button></div>${footHtml}`;
    } else if (view === "fomo") {
      const fmtAgo = (ms: number) => {
        const d = Date.now() - ms;
        if (d < 60_000) return "just now";
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
        // The handle is a snapshot from post time and traders rename, so this
        // is labelled as a claim rather than an identity — a stale handle on a
        // large position reads as the project's own account otherwise.
        // Ranked by the size of the position behind the words, not by recency.
        // Conviction is cheap to type and expensive to hold; sorting on holdings
        // is what separates this from a comment section.
        const all = fomoData.items || [];
        const PAGE = 5;
        const maxPage = Math.max(1, Math.ceil(all.length / PAGE));
        if (fomoPage >= maxPage) fomoPage = maxPage - 1;
        const start = fomoPage * PAGE;
        const totalHeld = all.reduce((n: number, t: any) => n + (Number(t.positionUsd) || 0), 0);
        const head = `<div class="fhead">${FOMO_MARK}<span class="fttl">Trader theses</span>` +
          `<span class="fsub">${esc(fomoData.symbol || "")} · ${all.length}` +
          `${totalHeld > 0 ? ` · ${fmtCompact(totalHeld)} held` : ""}</span></div>`;
        const HEART = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.5-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.5-7 9-7 9z"/></svg>`;
        const REPLY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.3A8 8 0 1 1 21 12z"/></svg>`;

        const rows = all.slice(start, start + PAGE).map((t: any, i: number) => {
          const rank = start + i + 1;
          const pct = t.pnlPct;
          const up = pct == null ? true : pct >= 0;
          // The position, stated at display size: it is the reason to read the
          // sentence under it. A trader with no holdings left has closed out, so
          // the row leads with the return instead of a zero.
          // "holds" and "traded" are different claims: one is money still at
          // risk, the other is money that was committed. Saying the wrong one
          // would misrepresent the author.
          const held = t.positionUsd
            ? `<span class="tkind">${t.positionKind === "traded" ? "traded" : "holds"}</span>` +
              `<span class="theld">${fmtCompact(t.positionUsd)}</span>` +
              (pct == null ? "" : `<span class="tdot ${up ? "" : "dn"}"></span>`)
            : "";
          const move = pct == null ? ""
            : `<span class="tpct ${up ? "up" : "dn"}">${up ? "▲" : "▼"} ${Math.abs(Number(pct)).toFixed(2)}%</span>`;
          // Realised profit is a different claim from an open position — they
          // have already taken some off the table.
          const took = t.realizedPnlUsd
            ? `<span class="ttook">took ${fmtCompact(t.realizedPnlUsd)}</span>` : "";
          const av = authorAvatar(t.authorId || t.authorHandle || "?", t.avatar);
          const foot = [
            `<span class="tstat">${HEART}${t.likeCount || 0}</span>`,
            t.replyCount ? `<span class="tstat">${REPLY}${t.replyCount}</span>` : "",
          ].join("");
          return `<div class="thesis"><div class="trow">
            <div class="tavwrap">${av}<span class="trank">${rank}</span></div>
            <div class="tbody">
              <div class="thead">
                <span class="tname">${esc(t.authorName || t.authorHandle || "unknown")}</span>
                <span class="tbadge">Thesis</span>
                ${t.authorIsDev ? `<span class="tdev">DEV</span>` : ""}
                <span class="twhen">${t.createdAt ? fmtAgo(Number(t.createdAt)) : ""}</span>
              </div>
              <div class="tpos">${held}${move}${took}</div>
              <div class="ttext">${linkify(t.thesis || "")}</div>
              <div class="tfoot">${foot}</div>
            </div></div></div>`;
        }).join("");

        const pager = maxPage > 1
          ? `<div class="pager">
              <button data-fpage="prev" ${fomoPage === 0 ? "disabled" : ""}>‹ Prev</button>
              <span>${start + 1}–${Math.min(start + PAGE, all.length)} of ${all.length}</span>
              <button data-fpage="next" ${fomoPage >= maxPage - 1 ? "disabled" : ""}>Next ›</button>
            </div>`
          : "";
        body = head + rows + pager + `<div class="gsrc">via FOMO</div>`;
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
    bind('[data-act="ithesis"]', () => { view = "ithesis"; render(); });
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

  async function doBuy() {
    phase = "busy"; message = "Confirming…"; render();
    const r = await send({ type: "STRIX_BUY", ca, amountEth: amount, chain });
    if (r?.error === "locked") { status = { unlocked: false }; phase = "ready"; render(); return; }
    if (r?.error) { phase = "error"; message = r.error; render(); return; }
    hash = r.hash; phase = "done"; render();
    status = await send({ type: "STRIX_STATUS", chain }); refreshHolding();
  }
  async function doSell() {
    phase = "busy"; message = "Confirming…"; render();
    const r = await send({ type: "STRIX_SELL", ca, pct, chain });
    if (r?.error === "locked") { status = { unlocked: false }; phase = "ready"; render(); return; }
    if (r?.error) { phase = "error"; message = r.error; render(); return; }
    hash = r.hash; phase = "done"; render();
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
  // Raw addresses: verified first, so wallets never get a Buy button.
  const addrs = Array.from(new Set(text.match(ADDR_RE) || []));
  if (DEBUG) dlog("scanNode: addresses =", addrs);
  addrs.slice(0, 2).forEach((ca) => { void mountIfToken(ca, node); });

  // Solana mints. Same rule — verified before mounting, so a base58-shaped
  // word or somebody's wallet address never becomes a Buy button.
  if (!addrs.length) {
    const mints = Array.from(new Set(text.match(SOL_RE) || [])).filter(looksLikeMint);
    mints.slice(0, 2).forEach((mint) => { void mountIfToken(mint, node, undefined, "solana"); });
  }

  // Cashtags: our supported stocks resolve instantly; everything else is
  // looked up on Robinhood Chain via DexScreener.
  const tickers = new Set<string>();
  for (const m of text.matchAll(TICKER_RE)) tickers.add(m[1].toUpperCase());

  const stocks: string[] = [];
  const others: string[] = [];
  for (const sym of tickers) {
    if (STOCK_TICKERS[sym]) stocks.push(sym);
    else if (sym.length >= 2 && !TICKER_SKIP.has(sym)) others.push(sym);
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

type UrlHit = { ca: string; chain: string | null };

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

const TRADER_ATTR = "data-strix-trader";
const traderDismissed = new Set<string>();
let traderHandle: string | null = null;

function removeTraderDock() {
  document.querySelectorAll(`[${TRADER_ATTR}]`).forEach((el) => el.remove());
  traderHandle = null;
}

const fmtHold = (s: number) =>
  s >= 86400 ? `${(s / 86400).toFixed(1)}d` : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)}m`;

/** Analyze dock: the same shadow-root isolation and trusted-event rule as the
 *  trading panel, so the page can neither read it nor drive it. */
function mountTraderDock(handle: string, data: any) {
  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.setAttribute(TRADER_ATTR, "");
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

  const label = "Analyze trader";
  const pill = document.createElement("button");
  pill.className = "pill";
  pill.innerHTML = `${LOGO}<span>${label}</span>`;
  dock.appendChild(pill);

  const close = document.createElement("button");
  close.className = "dockx";
  close.textContent = "hide for this profile";
  close.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    traderDismissed.add(handle.toLowerCase());
    removeTraderDock();
  });
  dock.appendChild(close);

  let panel: HTMLElement | null = null;
  // Which list is showing, and where in it. Held here rather than in the markup
  // so paging survives a re-render.
  let tab: "positions" | "trades" = "positions";
  let holdPage = 0;

  const draw = () => {
    if (!panel) return;
    panel.innerHTML = traderHtml(handle, data, tab, holdPage);
    // Rebound every draw: innerHTML replaces the nodes these were attached to.
    panel.querySelectorAll<HTMLElement>("[data-ttab]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        tab = el.dataset.ttab === "trades" ? "trades" : "positions";
        draw();
      }));
    panel.querySelectorAll<HTMLElement>("[data-hpage]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        const total = data.fomo?.holdings?.length || 0;
        const max = Math.max(1, Math.ceil(total / HOLD_PAGE));
        holdPage += el.dataset.hpage === "next" ? 1 : -1;
        holdPage = Math.max(0, Math.min(max - 1, holdPage));
        draw();
      }));
  };

  pill.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    if (panel) { panel.remove(); panel = null; pill.querySelector("span")!.textContent = label; return; }
    panel = document.createElement("div");
    panel.className = "panel wide";
    dock.appendChild(panel);
    pill.querySelector("span")!.textContent = "Hide";
    draw();
  });
}

/** Holdings per page. Eight fills the panel without needing a scroll. */
const HOLD_PAGE = 8;

const money = (n: number) => (n < 0 ? "-" : "") + "$" + fmtCompact(Math.abs(n));

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

function traderHtml(handle: string, d: any, tab: "positions" | "trades" = "positions", holdPage = 0): string {
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
    ? `<div class="tvbadge ok"><b>Linked</b> ${confirmedBy} lists @${esc(handle)} as this account's X</div>`
    : f && p
      ? `<div class="tvbadge mid"><b>Match on both</b> the same handle trades on FOMO and pump.fun, though neither has confirmed @${esc(handle)}</div>`
      : `<div class="tvbadge"><b>Name match</b> ${f ? "FOMO" : "pump.fun"} has this handle, but has not confirmed @${esc(handle)}</div>`;

  const src = [
    f ? `<span class="srcchip">${FOMO_MARK_SM}FOMO</span>` : "",
    p ? `<span class="srcchip">${PUMP_MARK_SM}pump.fun</span>` : "",
  ].join("");

  const pnl = f?.pnl
    ? `<div class="tpsec">
        <div class="tplbl">Realised profit</div>
        <div class="pgrid">${(["24h", "7d", "30d", "all"] as const).map((w) => {
          const v = f.pnl[w];
          const cls = v == null ? "" : v >= 0 ? "up" : "dn";
          return `<div class="pcell"><span class="plbl">${w === "all" ? "all time" : w}</span>
            <b class="pval ${cls}">${v == null ? "—" : (v >= 0 ? "+" : "") + money(v)}</b></div>`;
        }).join("")}</div></div>`
    : "";

  const stats = [
    f?.portfolioUsd ? ["Portfolio", money(f.portfolioUsd)] : null,
    f?.holdings?.length ? ["Positions", String(f.holdings.length)] : null,
    f?.tradeCount ? ["Trades", f.tradeCount.toLocaleString()] : null,
    f?.volumeUsd ? ["Volume", money(f.volumeUsd)] : null,
    f?.avgHoldSeconds ? ["Avg hold", fmtHold(f.avgHoldSeconds)] : null,
    f?.accountAgeDays ? ["Account age", `${Math.round(f.accountAgeDays)}d`] : null,
  ].filter(Boolean) as [string, string][];

  const statHtml = stats.length
    ? `<div class="tpsec"><div class="sgrid">${stats.map(([k, v]) =>
        `<div class="scell"><span class="plbl">${k}</span><b class="sval">${esc(v)}</b></div>`).join("")}</div></div>`
    : "";

  // ── the two lists ──────────────────────────────────────────────────────
  const all = f?.holdings || [];
  const maxPage = Math.max(1, Math.ceil(all.length / HOLD_PAGE));
  const page = Math.max(0, Math.min(maxPage - 1, holdPage));
  const start = page * HOLD_PAGE;

  const row = (sym: string, addr: string | null, mid: string, right: string, title: string) => {
    const inner = `<span class="hsym">${esc(sym)}</span>${mid}${right}<span class="hgo" aria-hidden="true">↗</span>`;
    // An anchor rather than a click handler: it needs no script, so the host
    // page's CSP cannot stop it opening.
    return addr
      ? `<a class="hrow2 link" href="${dexLink(addr)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${inner}</a>`
      : `<div class="hrow2">${inner}</div>`;
  };

  const posList = all.length
    ? `<div class="hlist">${all.slice(start, start + HOLD_PAGE).map((h: any) => {
        const ch = h.change24h;
        const cls = ch == null ? "" : ch >= 0 ? "up" : "dn";
        return row(h.symbol, h.address,
          `<span class="hval2">${h.valueUsd == null ? "—" : money(h.valueUsd)}</span>`,
          `<span class="hchg ${cls}">${ch == null ? "" : (ch >= 0 ? "+" : "") + Number(ch).toFixed(1) + "%"}</span>`,
          `${h.symbol} on DexScreener`);
      }).join("")}</div>
      ${maxPage > 1 ? `<div class="pager">
        <button data-hpage="prev" ${page === 0 ? "disabled" : ""}>‹ Prev</button>
        <span>${start + 1}–${Math.min(start + HOLD_PAGE, all.length)} of ${all.length}</span>
        <button data-hpage="next" ${page >= maxPage - 1 ? "disabled" : ""}>Next ›</button>
      </div>` : ""}`
    : `<div class="tpempty">No captured positions for this trader yet.</div>`;

  // Live events first, then the snapshot. They are separated and dated because
  // /trades is captured on a schedule — measured days behind traders who had
  // dealt within the hour — and silently mixing the two would present stale
  // rows as current ones.
  const live = f?.live || [];
  const liveList = live.length
    ? `<div class="liveh"><span class="livedot"></span>Live now</div>
       <div class="hlist">${live.map((e: any) => {
        const kind = e.type === "buy" ? "up" : e.type === "sell" ? "dn" : "";
        return row(e.token || e.type, e.address,
          `<span class="tstatus ${kind}">${esc(e.type)}</span>`,
          `<span class="hchg">${e.usdValue ? money(e.usdValue) : ""}</span>` +
          `<span class="twhen2">${e.ts ? fmtAgoShort(Number(e.ts)) : ""}</span>`,
          `${e.text || e.token || ""}`);
       }).join("")}</div>`
    : "";

  const trades = f?.trades || [];
  const tradeList = liveList + (trades.length
    ? `<div class="hlist">${trades.map((t: any) => {
        const open = t.status !== "closed";
        const v = t.pnlUsd;
        const cls = v == null ? "" : v >= 0 ? "up" : "dn";
        const when = t.closedAt || t.createdAt;
        return row(t.symbol, t.address,
          `<span class="tstatus ${open ? "open" : ""}">${open ? "open" : "closed"}</span>`,
          `<span class="hchg ${cls}">${v == null ? "—" : (v >= 0 ? "+" : "") + money(v)}</span>` +
          `<span class="twhen2">${when ? fmtAgoShort(Number(when)) : ""}</span>`,
          `${t.symbol} on DexScreener`);
      }).join("")}</div>`
    : (liveList ? "" : `<div class="tpempty">No captured trades for this trader yet.</div>`));

  // The recent list is 20 rows against lifetime counts in the thousands, so the
  // tab says how many there really are rather than implying this is all of them.
  const lifetime = (f?.activeCount ?? 0) + (f?.closedCount ?? 0);
  const holds = `<div class="tpsec">
    <div class="ttabs">
      <button class="ttab ${tab === "positions" ? "on" : ""}" data-ttab="positions">
        Positions <span>${all.length}</span></button>
      <button class="ttab ${tab === "trades" ? "on" : ""}" data-ttab="trades">
        Recent trades <span>${trades.length}${lifetime ? ` of ${fmtCompact(lifetime)}` : ""}</span></button>
    </div>
    ${tab === "positions" ? posList : tradeList}
  </div>`;

  const w = f?.wallets || p?.wallets || {};
  const wallets = [
    w.evm ? `<div class="wrow"><span class="wtag">EVM</span><span class="waddr">${esc(shortAddr(w.evm))}</span></div>` : "",
    w.solana ? `<div class="wrow"><span class="wtag">SOL</span><span class="waddr">${esc(shortAddr(w.solana))}</span></div>` : "",
  ].join("");

  return `<div class="tp">
    <div class="tphead">
      <div class="tpav">${disc}</div>
      <div class="tpmeta">
        <div class="tpname">${esc(f?.displayName || f?.handle || p?.handle || handle)}
          ${f?.verified ? `<span class="tver">✓</span>` : ""}</div>
        <div class="tphandle">@${esc(handle)}</div>
        <div class="tpsrc">${src}</div>
      </div>
      ${f?.followers ? `<div class="tpfol"><b>${fmtCompact(f.followers)}</b><span>followers</span></div>` : ""}
    </div>
    ${badge}
    ${pnl}${statHtml}${holds}
    ${wallets ? `<div class="tpsec wsec">${wallets}</div>` : ""}
  </div>`;
}

/** Bring the Analyze dock in line with the profile on screen. */
async function syncTraderDock() {
  const handle = xProfileHandle(location.href);
  if (!handle) { if (traderHandle) removeTraderDock(); return; }
  const key = handle.toLowerCase();
  if (traderDismissed.has(key)) return;
  if (traderHandle && traderHandle.toLowerCase() === key) return;

  const data = await send({ type: "STRIX_TRADER", handle }).catch(() => null);
  // No trading profile means no button. Most people on X are not traders, and
  // an Analyze button that opens an empty panel is worse than no button.
  if (!data || (!data.fomo && !data.pump)) return;
  if (xProfileHandle(location.href) !== handle) return; // navigated away mid-flight

  removeTraderDock();
  traderHandle = handle;
  mountTraderDock(handle, data);
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

  let panel: HTMLElement | null = null;
  pill.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    if (panel) { panel.remove(); panel = null; pill.querySelector("span")!.textContent = label; return; }
    panel = document.createElement("div");
    panel.className = "panel";
    dock.appendChild(panel);
    pill.querySelector("span")!.textContent = "Hide";
    runPanel(ca, panel, false, chainHint);
  });
}

/** Bring the dock in line with whatever the URL now points at. */
async function syncDock() {
  const hit = urlToken(location.href);
  if (!hit) { if (dockCa) removeDock(); return; }
  const key = hit.ca.toLowerCase();
  if (dockDismissed.has(key)) return;
  if (dockCa && dockCa.toLowerCase() === key) return; // already showing this one

  // Verified before it mounts, exactly like the inline pill: a wallet address
  // or a base58-shaped path word must never get a Buy button.
  if (!(await isToken(hit.ca, hit.chain || undefined))) return;
  // The user may have navigated again while that lookup was in flight.
  const still = urlToken(location.href);
  if (!still || still.ca.toLowerCase() !== key) return;

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

function boot() {
  dlog("boot on", location.href, "| readyState =", document.readyState);
  scan();
  let t: number | undefined;
  new MutationObserver(() => { if (t) clearTimeout(t); t = window.setTimeout(scan, 400); }).observe(document.body, { childList: true, subtree: true });

  // The URL dock runs independently of the text scan, so it still appears on a
  // page whose body never spells the address out, and it follows SPA routing.
  void syncDock();
  void syncTraderDock();
  watchUrl(() => {
    void syncDock();
    void syncTraderDock();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

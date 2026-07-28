// HoodX Wallet - X (Twitter) inline trading terminal.
// Detects Robinhood Chain token addresses in tweets and mounts a live buy/sell
// panel in an isolated Shadow DOM (so x.com's CSS and CSP can't touch it).
// All reads, images, and the trade itself are delegated to the extension's
// background service worker - the private key never enters this page.

const ADDR_RE = /(?<![0-9a-fA-Fx])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/g;
// Cashtag tickers ($AAPL, $TSLA…) — only our supported tokenized stocks.
const TICKER_RE = /(?<![A-Za-z0-9$])\$([A-Za-z]{1,6})(?![A-Za-z0-9])/g;
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
const esc = (s: string) => (s || "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] || c));

const OWL = `<img src="${chrome.runtime.getURL("icons/icon48.png")}" width="16" height="16" style="border-radius:4px;display:block" alt=""/>`;
const CANDLES = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4v3"/><rect x="7" y="7" width="4" height="9" rx="1"/><path d="M9 16v3"/><path d="M17 2v4"/><rect x="15" y="6" width="4" height="7" rx="1"/><path d="M17 13v4"/></svg>`;

const SHIELD = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>`;
const PEOPLE = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
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

function holderRowHtml(r: any, rank: number): string {
  const addr = String(gPick(r, ["wallet_address", "address", "account_address"]) || "");
  const pool = gIsPool(r);
  const tags = pool ? [] : gTags(r);
  const name = pool
    ? `${String(r.exchange || "DEX").replace(/_/g, " ")} pool`
    : gPick(r, ["name", "twitter_username", "twitter_name"]);
  const supply = Number(gPick(r, ["amount_percentage"]));
  const supplyStr = isFinite(supply) && supply > 0 ? `${(supply <= 1 ? supply * 100 : supply).toFixed(2)}%` : "";
  const sold = Number(gPick(r, ["sell_amount_percentage"]));
  const soldStr = !pool && isFinite(sold) && sold > 0
    ? `sold ${Math.min(100, (sold <= 1 ? sold * 100 : sold)).toFixed(0)}%`
    : "";
  const profit = pool ? NaN : Number(gPick(r, ["profit", "realized_profit"]));
  const pnlStr = isFinite(profit) && profit !== 0
    ? `<span class="p ${profit >= 0 ? "up2" : "dn2"}">${profit >= 0 ? "+" : "-"}${fmtUsd(Math.abs(profit)).replace("$", "$")}</span>`
    : "";
  const tagHtml = (pool ? `<span class="htag mut">Pool</span>` : "") +
    tags.filter((t) => G_TAG[t]).slice(0, 3).map((t) => `<span class="htag ${G_TAG[t].cls}">${G_TAG[t].label}</span>`).join("");
  const label = name ? esc(String(name)) : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  return `<div class="hrow">
    <span class="hrank">${rank}</span>
    <div class="hmain">
      <a class="haddr" href="https://robinhoodchain.blockscout.com/address/${esc(addr)}" target="_blank" rel="noreferrer" title="${esc(addr)}">${label}</a>${tagHtml}
      <div class="hsub">${[supplyStr ? supplyStr + " supply" : "", soldStr].filter(Boolean).join(" · ")}</div>
    </div>
    <div class="hval">${pnlStr}</div>
  </div>`;
}

// ── in-house candlestick chart (SVG, HoodX-styled — no third-party embed) ───
type Candle = [number, number, number, number, number, number]; // ts,o,h,l,c,v

const fmtAxis = (v: number) => {
  if (!isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (v / 1e3).toFixed(2) + "K";
  if (a >= 1) return "$" + v.toFixed(2);
  if (a >= 0.01) return "$" + v.toFixed(4);
  const d = Math.min(12, Math.ceil(-Math.log10(a)) + 2);
  return "$" + v.toFixed(d).replace(/0+$/, "");
};

function chartSvg(cs: Candle[], tf: string): string {
  const W = 408, H = 250, L = 8, R = 58, T = 12, B = 20;
  const pw = W - L - R, ph = H - T - B;
  let lo = Infinity, hi = -Infinity;
  for (const c of cs) { if (c[3] < lo) lo = c[3]; if (c[2] > hi) hi = c[2]; }
  if (!isFinite(lo) || !isFinite(hi) || hi <= 0) return "";
  const pad = (hi - lo) * 0.06 || hi * 0.02;
  lo -= pad; hi += pad;
  const y = (p: number) => T + ph - ((p - lo) / (hi - lo)) * ph;
  const n = cs.length;
  const step = pw / n;
  const bw = Math.max(1.5, Math.min(9, step * 0.62));
  let out = "";

  // horizontal grid + price axis
  for (let i = 0; i <= 3; i++) {
    const p = lo + ((hi - lo) * i) / 3;
    const yy = y(p).toFixed(1);
    out += `<line x1="${L}" y1="${yy}" x2="${L + pw}" y2="${yy}" stroke="#1e2f24" stroke-dasharray="3 4"/>`;
    out += `<text x="${L + pw + 6}" y="${Number(yy) + 3}" fill="#9cb490" font-size="9" font-family="Sora,system-ui,sans-serif">${fmtAxis(p)}</text>`;
  }

  // time axis (3 labels)
  const fmtT = (ts: number) => {
    const d = new Date(ts * 1000);
    return tf === "15m" || tf === "1H"
      ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  for (const fr of [0.08, 0.5, 0.92]) {
    const idx = Math.min(n - 1, Math.floor(fr * n));
    const xx = (L + idx * step + step / 2).toFixed(1);
    out += `<text x="${xx}" y="${H - 6}" fill="#9cb490" font-size="9" text-anchor="middle" font-family="Sora,system-ui,sans-serif">${fmtT(cs[idx][0])}</text>`;
  }

  // candles
  for (let i = 0; i < n; i++) {
    const [, o, h, l, c] = cs[i];
    const x = L + i * step + step / 2;
    const col = c >= o ? "#59e08a" : "#ff7a7a";
    const yO = y(o), yC = y(c);
    const bodyY = Math.min(yO, yC), bodyH = Math.max(1, Math.abs(yO - yC));
    out += `<line x1="${x.toFixed(1)}" y1="${y(h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y(l).toFixed(1)}" stroke="${col}"/>`;
    out += `<rect x="${(x - bw / 2).toFixed(1)}" y="${bodyY.toFixed(1)}" width="${bw.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${col}" rx="0.5"/>`;
  }

  // last-price marker
  const last = cs[n - 1][4];
  const yl = y(last);
  out += `<line x1="${L}" y1="${yl.toFixed(1)}" x2="${L + pw}" y2="${yl.toFixed(1)}" stroke="#bff45f" stroke-dasharray="2 3" opacity="0.85"/>`;
  out += `<rect x="${L + pw + 1}" y="${(yl - 8).toFixed(1)}" width="${R - 4}" height="15" rx="4" fill="rgba(163,230,53,.15)" stroke="rgba(163,230,53,.4)"/>`;
  out += `<text x="${L + pw + 1 + (R - 4) / 2}" y="${(yl + 3.5).toFixed(1)}" fill="#bff45f" font-size="9" font-weight="700" text-anchor="middle" font-family="Sora,system-ui,sans-serif">${fmtAxis(last)}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">${out}</svg>`;
}

const STYLES = `
  :host{ all:initial; }
  *{ box-sizing:border-box; font-family:"Sora","Inter",-apple-system,"Segoe UI",Arial,sans-serif; }
  .pill{display:inline-flex;align-items:center;gap:6px;margin-top:8px;padding:7px 13px;border-radius:999px;
    background:linear-gradient(180deg,#b6f24a,#96d92e);border:1px solid #8fd41f;color:#0b140c;font-weight:800;
    font-size:12px;line-height:1;cursor:pointer;transition:.15s;box-shadow:0 5px 16px -6px rgba(120,190,20,.6)}
  .pill:hover{filter:brightness(1.05);transform:translateY(-1px)}
  .pill svg{opacity:.9}
  .panel{margin-top:9px;width:100%;max-width:436px;border-radius:18px;overflow:hidden;color:#eafbe1;
    background:linear-gradient(180deg,#101c13,#0a110c);border:1px solid #223528;
    box-shadow:0 18px 48px -18px rgba(0,0,0,.75), inset 0 1px 0 rgba(255,255,255,.035), 0 0 0 1px rgba(163,230,53,.05);
    animation:rise .22s cubic-bezier(.22,1,.36,1) both}
  @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .badge.stk{color:#8fd0ff;background:rgba(93,169,255,.12);border-color:rgba(93,169,255,.32)}
  .stockline{margin:0 14px 12px;background:#111d15;border:1px solid #1e2f24;border-radius:12px;padding:9px 11px;
    font-size:11.5px;color:#bdd3b2;text-align:center}
  .stockline b{color:#eafbe1}
  .head{display:flex;align-items:center;gap:11px;padding:14px 14px 12px}
  .logo{width:42px;height:42px;border-radius:13px;object-fit:cover;flex:0 0 auto;background:#16241a;
    border:1px solid #2a3f30;display:grid;place-items:center;color:#a3e635}
  .hd{min-width:0;flex:1}
  .symrow{display:flex;align-items:center;gap:6px}
  .sym{font-weight:800;font-size:16px;color:#fff;letter-spacing:-.01em;white-space:nowrap}
  .badge{font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#bff45f;
    background:rgba(163,230,53,.12);border:1px solid rgba(163,230,53,.32);border-radius:6px;padding:2px 5px}
  .name{font-size:11.5px;color:#bdd3b2;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .carow{margin-top:3px;font-size:9.5px;color:#9cb490;font-family:ui-monospace,monospace;cursor:pointer;width:fit-content}
  .carow:hover{color:#bff45f}
  .carow b{color:#bff45f;font-weight:700}
  .price{text-align:right;flex:0 0 auto}
  .pval{font-weight:800;font-size:16px;color:#fff;display:flex;align-items:center;gap:6px;justify-content:flex-end}
  .live{width:6px;height:6px;border-radius:999px;background:#59e08a;box-shadow:0 0 8px #59e08a;animation:pulse 1.6s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
  .chg{font-weight:800;font-size:12px;margin-top:3px}
  .up{color:#59e08a} .dn{color:#ff7a7a}
  .stats{display:flex;gap:7px;padding:0 14px 12px}
  .stat{flex:1;background:#111d15;border:1px solid #1e2f24;border-radius:12px;padding:8px 6px;text-align:center}
  .stat span{display:block;font-size:8.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#9cb490;margin-bottom:3px}
  .stat b{font-weight:800;font-size:13px;color:#f2fbec}
  .hold{margin:0 14px 11px;background:rgba(163,230,53,.07);border:1px solid rgba(163,230,53,.18);border-radius:12px;
    padding:8px 11px;font-size:12px;color:#bdd3b2}
  .hold b{color:#fff}
  .seg{display:flex;gap:5px;margin:0 14px 10px;background:#111d15;border:1px solid #1e2f24;border-radius:12px;padding:4px}
  .seg button{flex:1;border:0;background:transparent;color:#aec6a3;font-weight:800;font-size:13px;padding:8px 0;
    border-radius:9px;cursor:pointer;transition:.15s}
  .seg button.chartbtn{flex:0 0 48px;display:grid;place-items:center;padding:7px 0}
  .seg button.chartbtn:hover{color:#bff45f}
  .tfrow{display:flex;gap:5px;margin:0 14px 10px;align-items:center}
  .tfbtn{flex:1;padding:6px 0;border-radius:9px;background:#111d15;color:#c3d4ba;border:1px solid #1e2f24;
    font-weight:700;font-size:11.5px;cursor:pointer;transition:.12s}
  .tfbtn:hover{border-color:#31503a;color:#eafbe1}
  .tfbtn.on{background:rgba(163,230,53,.15);border-color:rgba(163,230,53,.5);color:#bff45f}
  .tfchg{flex:0 0 auto;font-size:11.5px;font-weight:800;padding:0 4px}
  .chartbox{margin:0 14px 12px;background:#0d1712;border:1px solid #1e2f24;border-radius:12px;overflow:hidden;min-height:120px}
  .socials{display:flex;gap:12px;margin:-4px 14px 10px;font-size:11px}
  .socials a{color:#aec6a3;text-decoration:none;font-weight:700}
  .socials a:hover{color:#bff45f;text-decoration:underline}
  .secbar{margin:0 14px 11px;display:flex;align-items:center;gap:7px;border-radius:12px;border:1px solid #1e2f24;
    padding:8px 11px;font-size:12px;font-weight:800;cursor:pointer}
  .secbar i{margin-left:auto;font-style:normal;font-weight:600;font-size:10.5px;opacity:.75}
  .secbar.ok{color:#bff45f;border-color:rgba(163,230,53,.35);background:rgba(163,230,53,.07)}
  .secbar.warn{color:#fbbf24;border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.07)}
  .secbar.bad{color:#ff7a7a;border-color:rgba(255,122,122,.4);background:rgba(255,122,122,.08)}
  .secbar.na{color:#aec6a3;background:#111d15;font-weight:600;cursor:pointer}
  .secgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0 14px 10px}
  .seccell{display:flex;justify-content:space-between;gap:6px;background:#111d15;border:1px solid #1e2f24;border-radius:10px;padding:7px 10px;font-size:11px}
  .seccell span{color:#9cb490}
  .seccell b.ok{color:#59e08a}.seccell b.warn{color:#fbbf24}.seccell b.bad{color:#ff7a7a}.seccell b.na{color:#aec6a3}
  .tabs2{display:flex;gap:5px;margin:0 14px 8px;background:#111d15;border:1px solid #1e2f24;border-radius:10px;padding:3px}
  .tabs2 button{flex:1;border:0;background:transparent;color:#aec6a3;font-weight:800;font-size:11.5px;padding:6px 0;border-radius:8px;cursor:pointer}
  .tabs2 button.on{background:#a3e635;color:#0b140c}
  .chips{display:flex;gap:5px;margin:0 14px 9px}
  .chip2{padding:4px 10px;border-radius:8px;background:#111d15;border:1px solid #1e2f24;color:#aec6a3;font-size:10.5px;font-weight:700;cursor:pointer}
  .chip2.on{background:rgba(163,230,53,.15);border-color:rgba(163,230,53,.5);color:#bff45f}
  .kolline{margin:0 14px 8px;font-size:10.5px;color:#aec6a3}
  .kolline b{color:#fbbf24}
  .hrow{display:flex;align-items:center;gap:8px;margin:0 14px 6px;background:#111d15;border:1px solid #1e2f24;border-radius:10px;padding:7px 10px}
  .hrank{width:18px;flex:0 0 auto;text-align:center;color:#9cb490;font-size:10px;font-weight:800}
  .hmain{flex:1;min-width:0}
  .haddr{color:#eafbe1;font-size:11.5px;font-weight:700;text-decoration:none}
  .haddr:hover{color:#bff45f;text-decoration:underline}
  .htag{display:inline-block;margin-left:4px;padding:1px 4px;border-radius:4px;border:1px solid #2a3f30;font-size:8px;font-weight:800;text-transform:uppercase;vertical-align:1px;color:#aec6a3;background:#16241a}
  .htag.kol{color:#fbbf24;border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.1)}
  .htag.smart{color:#bff45f;border-color:rgba(163,230,53,.4);background:rgba(163,230,53,.1)}
  .htag.bad{color:#ff7a7a;border-color:rgba(255,122,122,.4);background:rgba(255,122,122,.1)}
  .hsub{color:#9cb490;font-size:10px;margin-top:1px}
  .hval{flex:0 0 auto;text-align:right;font-size:10.5px}
  .hval .p{font-weight:800}
  .up2{color:#59e08a}.dn2{color:#ff7a7a}
  .gsrc{margin:2px 14px 10px;text-align:right;font-size:8.5px;color:#83a077}
  .pager{display:flex;align-items:center;justify-content:center;gap:12px;margin:8px 14px 4px}
  .pager button{border:1px solid #1e2f24;background:#111d15;color:#c3d4ba;font-weight:700;font-size:11px;
    padding:5px 12px;border-radius:8px;cursor:pointer;transition:.12s}
  .pager button:hover:not(:disabled){border-color:#31503a;color:#eafbe1}
  .pager button:disabled{opacity:.35;cursor:default}
  .pager span{font-size:10.5px;font-weight:700;color:#9cb490}
  .bubblebox{margin:0 14px 4px;border-radius:12px;overflow:hidden;border:1px solid #1e2f24;background:#0d1712}
  .bubbleframe{display:block;width:100%;height:420px;border:0}
  .seg button.on-buy{background:#a3e635;color:#0b140c;box-shadow:0 3px 12px -3px rgba(163,230,53,.55)}
  .seg button.on-sell{background:#ff7a7a;color:#160b0b;box-shadow:0 3px 12px -3px rgba(255,122,122,.5)}
  .seg button:disabled{opacity:.35;cursor:default}
  .bar{padding:0 14px 14px}
  .amts{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:9px}
  .amts.pcts{grid-template-columns:repeat(3,1fr)}
  .amt{padding:9px 0;border-radius:10px;background:#111d15;color:#c3d4ba;border:1px solid #1e2f24;font-weight:700;
    font-size:12.5px;cursor:pointer;transition:.12s}
  .amt:hover{border-color:#31503a;color:#eafbe1}
  .amt.on{background:rgba(163,230,53,.15);border-color:rgba(163,230,53,.5);color:#bff45f}
  .cinrow{position:relative;margin-bottom:9px}
  .cin{width:100%;padding:9px 42px 9px 11px;border-radius:10px;background:#111d15;border:1px solid #1e2f24;
    color:#eafbe1;font-weight:700;font-size:13px;font-family:inherit;outline:none;font-variant-numeric:tabular-nums}
  .cin:focus{border-color:rgba(163,230,53,.55)}
  .cin::placeholder{color:#83a077;font-weight:600}
  .cunit{position:absolute;right:11px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:800;color:#9cb490}
  .go{width:100%;padding:13px;border:0;border-radius:13px;font-weight:800;font-size:14.5px;cursor:pointer;transition:.15s}
  .go.buy{background:linear-gradient(180deg,#b6f24a,#96d92e);color:#0b140c;box-shadow:0 10px 24px -10px rgba(163,230,53,.65)}
  .go.sell{background:linear-gradient(180deg,#ff8a8a,#f76b6b);color:#160b0b;box-shadow:0 10px 24px -10px rgba(255,122,122,.55)}
  .go:hover{filter:brightness(1.06)}
  .go:active,.amt:active,.seg button:active{transform:scale(.98)}
  .go:disabled{opacity:.5;cursor:default;box-shadow:none;filter:none}
  .go.locked{background:#16241a;color:#eafbe1;border:1px solid #2a3f30;box-shadow:none}
  .note{padding:12px 14px;font-size:12.5px;color:#bdd3b2;text-align:center;line-height:1.45}
  .ok{color:#bff45f} .err{color:#ff7a7a} .u{text-decoration:underline}
  .foot{display:flex;justify-content:space-between;align-items:center;padding:9px 14px;border-top:1px solid #172319;
    font-weight:700;font-size:11px;color:#9cb490;background:rgba(0,0,0,.18)}
  .foot a{color:#bff45f;text-decoration:none;cursor:pointer}
  .foot a:hover{text-decoration:underline}
  .spin{display:inline-block;width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;
    border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:6px}
  @keyframes sp{to{transform:rotate(360deg)}}
`;

function mountHost(ca: string, afterEl: Element, pillLabel = "Trade on HoodX") {
  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.style.cssText = "all:initial;display:block;"; // CSSOM set = CSP-safe
  // Stop X from hijacking clicks (it navigates on tweet click).
  ["click", "pointerdown", "mousedown", "mouseup", "keydown"].forEach((ev) =>
    host.addEventListener(ev, (e) => e.stopPropagation()));

  const sh = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  sh.appendChild(style);
  const root = document.createElement("div");
  sh.appendChild(root);
  afterEl.insertAdjacentElement("afterend", host);

  const pill = document.createElement("button");
  pill.className = "pill";
  pill.innerHTML = `${OWL}<span>${pillLabel}</span>`;
  root.appendChild(pill);

  let panel: HTMLElement | null = null;
  pill.addEventListener("click", () => {
    if (panel) { panel.remove(); panel = null; pill.querySelector("span")!.textContent = pillLabel; return; }
    panel = document.createElement("div");
    panel.className = "panel"; // gives the container its own dark background
    root.appendChild(panel);
    pill.querySelector("span")!.textContent = "Hide";
    runPanel(ca, panel);
  });
}

function runPanel(ca: string, panel: HTMLElement) {
  let info: any = null, status: any = null, holding: any = null, logoData: string | null = null;
  let dir: "buy" | "sell" = "buy", amount = "0.05", pct = 100;
  let phase: "loading" | "ready" | "notfound" | "busy" | "done" | "error" = "loading";
  let message = "", hash = "";
  let timer: any = null;
  let editing = false;
  let pairAddr: string | null = null;
  let caCopied = false;
  let view: "trade" | "chart" | "safety" | "holders" | "bubbles" = "trade";
  let tf = "1H";
  let chartLoading = false;
  // Per-timeframe candle cache: undefined = not fetched, null = no data.
  const candles: Record<string, Candle[] | null | undefined> = {};

  // GMGN state (loaded via background proxy; noKey → features hidden).
  let gmgnKey = true; // assume until told otherwise
  let sec: any = undefined; // undefined = loading, null = unavailable
  let ginfo: any = null;
  let holdTab: "holders" | "traders" = "holders";
  let holdTag = ""; // "" | "renowned" | "smart_degen"
  let holdPage = 0;
  const holdCache: Record<string, any[] | null | undefined> = {};
  const holdBusy: Record<string, boolean> = {};
  const holdErrs: Record<string, string> = {};

  const content = document.createElement("div");
  panel.appendChild(content);

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
    send({ type: "STRIX_CANDLES", pool: pairAddr, ca, tf }).then((r) => {
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
    const chgHtml = isFinite(chg) ? `<div class="chg ${chg >= 0 ? "up" : "dn"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</div>` : "";
    const logo = logoData ? `<img class="logo" src="${logoData}"/>` : `<div class="logo">${OWL}</div>`;
    const locked = !status?.unlocked;
    const statsHtml = isStk
      ? `<div class="stockline">Tokenized <b>${esc(info?.name || "")}</b> stock · trades via USDG, settles in ETH</div>`
      : `<div class="stats">
          <div class="stat"><span>Mcap</span><b>${fmtCompact(info?.mcap)}</b></div>
          <div class="stat"><span>Liq</span><b>${fmtCompact(info?.liquidityUsd)}</b></div>
          <div class="stat"><span>Vol 24h</span><b>${fmtCompact(info?.volume24h)}</b></div>
        </div>`;

    const seg = `<div class="seg">
      <button data-dir="buy" class="${dir === "buy" ? "on-buy" : ""}">Buy</button>
      <button data-dir="sell" class="${dir === "sell" ? "on-sell" : ""}" ${h <= 0 ? "disabled" : ""}>Sell</button>
      ${pairAddr ? `<button data-act="chart" class="chartbtn" title="Chart">${CANDLES}</button>` : ""}
      ${gmgnKey ? `<button data-act="holders" class="chartbtn" title="Top holders & traders">${PEOPLE}</button>` : ""}
      <button data-act="bubbles" class="chartbtn" title="Bubble map">${BUBBLES}</button>
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
      action = `<div class="note ok">Done ✓ <a class="ok u" href="https://robinhoodchain.blockscout.com/tx/${hash}" target="_blank">view tx</a></div>
        <div class="bar"><button class="go buy" data-act="again">Trade again</button></div>`;
    } else if (locked) {
      action = `<div class="bar"><button class="go locked" data-act="unlock">Unlock HoodX to trade</button></div>`;
    } else if (dir === "buy") {
      const amts = BUY_AMOUNTS.map((a) => `<button class="amt ${a === amount ? "on" : ""}" data-amt="${a}">${a}</button>`).join("");
      const lbl = phase === "busy" ? `<span class="spin"></span>${esc(message || "Buying…")}` : `Buy ${amount || "0"} ETH`;
      action = `<div class="bar"><div class="amts">${amts}</div>` +
        `<div class="cinrow"><input class="cin" data-cbuy inputmode="decimal" value="${esc(amount)}" placeholder="Custom amount"/><span class="cunit">ETH</span></div>` +
        `<button class="go buy" data-act="buy" ${phase === "busy" || !(Number(amount) > 0) ? "disabled" : ""}>${lbl}</button>${phase === "error" ? `<div class="note err">${esc(message)}</div>` : ""}</div>`;
    } else {
      const pcts = SELL_PCTS.map((p) => `<button class="amt ${p === pct ? "on" : ""}" data-pct="${p}">${p}%</button>`).join("");
      const lbl = phase === "busy" ? `<span class="spin"></span>${esc(message || "Selling…")}` : `Sell ${pct}% ${esc(info?.symbol || "")}`;
      action = `<div class="bar"><div class="amts pcts">${pcts}</div>` +
        `<div class="cinrow"><input class="cin" data-csell inputmode="numeric" value="${pct}" placeholder="Custom percent"/><span class="cunit">%</span></div>` +
        `<button class="go sell" data-act="sell" ${phase === "busy" || h <= 0 || pct <= 0 ? "disabled" : ""}>${lbl}</button>${phase === "error" ? `<div class="note err">${esc(message)}</div>` : ""}</div>`;
    }

    const headHtml = `
      <div class="head">${logo}
        <div class="hd">
          <div class="symrow"><span class="sym">${esc(info?.symbol || "TOKEN")}</span><span class="badge${isStk ? " stk" : ""}">${isStk ? "STOCK" : esc(info?.venue || "?")}</span></div>
          <div class="name">${esc(info?.name || short(ca))}</div>
          <div class="carow" data-act="copyca" title="Copy contract address">${short(ca)} ${caCopied ? `<b>copied ✓</b>` : "⧉"}</div>
        </div>
        <div class="price"><div class="pval"><span class="live"></span>${fmtUsd(info?.priceUsd)}</div>${chgHtml}</div>
      </div>`;
    const footHtml = `<div class="foot"><span>${status?.unlocked ? `${esc(status.label || "Wallet")} · ${Number(status.eth).toFixed(4)} ETH` : "HoodX · locked"}</span><a data-act="open">Open wallet ↗</a></div>`;

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
      const tabs = `<div class="tabs2">
        <button data-htab="holders" class="${holdTab === "holders" ? "on" : ""}">Holders</button>
        <button data-htab="traders" class="${holdTab === "traders" ? "on" : ""}">Traders</button>
      </div>
      <div class="chips">
        <button class="chip2 ${holdTag === "" ? "on" : ""}" data-htag="">All</button>
        <button class="chip2 ${holdTag === "renowned" ? "on" : ""}" data-htag="renowned">KOLs</button>
        <button class="chip2 ${holdTag === "smart_degen" ? "on" : ""}" data-htag="smart_degen">Smart $</button>
      </div>`;
      let body: string;
      if (holdBusy[k] || rows === undefined) {
        body = `<div class="note"><span class="spin"></span>Loading ${holdTab}…</div>`;
      } else if (!rows || !rows.length) {
        const why = holdErrs[k]
          ? `Couldn't load: ${esc(holdErrs[k])}`
          : holdTag
            ? "None found in the top 100."
            : "No holder data for this token yet.";
        body = `<div class="note">${why}<br/><br/><button class="amt" data-act="hretry" style="padding:7px 18px">Retry</button></div>`;
      } else {
        const kols = rows.filter((r) => { const t = gTags(r); return t.includes("kol") || t.includes("renowned"); }).length;
        const smart = rows.filter((r) => gTags(r).includes("smart_degen")).length;
        const kolline = !holdTag && (kols || smart)
          ? `<div class="kolline">Top ${rows.length}: <b>${kols} KOL${kols === 1 ? "" : "s"}</b> · <span style="color:#bff45f">${smart} smart money</span></div>`
          : "";
        const PAGE = 5;
        const maxPage = Math.max(1, Math.ceil(rows.length / PAGE));
        if (holdPage >= maxPage) holdPage = maxPage - 1;
        const slice = rows.slice(holdPage * PAGE, holdPage * PAGE + PAGE);
        const pager = maxPage > 1
          ? `<div class="pager">
              <button data-hpage="prev" ${holdPage === 0 ? "disabled" : ""}>‹ Prev</button>
              <span>${holdPage + 1} / ${maxPage}</span>
              <button data-hpage="next" ${holdPage >= maxPage - 1 ? "disabled" : ""}>Next ›</button>
            </div>`
          : "";
        body = kolline + slice.map((r, i) => holderRowHtml(r, holdPage * PAGE + i + 1)).join("") + pager +
          `<div class="gsrc">${rows.length} wallets · ${holdTab === "traders" ? "by profit" : "by holdings"}</div>`;
      }
      content.innerHTML = `${headHtml}${tabs}${body}
        <div class="bar" style="margin-top:10px"><button class="go locked" data-act="back">← Back to trading</button></div>${footHtml}`;
    } else if (view === "bubbles") {
      // Holder bubble map (Bubblemaps) via our CSP-exempt extension page.
      const src = chrome.runtime.getURL(`bubble.html?ca=${encodeURIComponent(ca)}`);
      content.innerHTML = `${headHtml}
        <div class="bubblebox"><iframe class="bubbleframe" src="${src}" allow="clipboard-write"></iframe></div>
        <div class="gsrc">holder bubble map</div>
        <div class="bar"><button class="go locked" data-act="back">← Back to trading</button></div>${footHtml}`;
    } else {
      content.innerHTML = `${headHtml}${statsHtml}${socialsHtml}${secbar}${holdHtml}${seg}${action}${footHtml}`;
    }

    const bind = (sel: string, fn: (el: HTMLElement) => void) => content.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
    bind("[data-dir]", (el) => { dir = el.dataset.dir as any; if (phase === "error") phase = "ready"; render(); });
    bind("[data-amt]", (el) => { amount = el.dataset.amt!; if (phase === "error") phase = "ready"; render(); });
    bind("[data-pct]", (el) => { pct = Number(el.dataset.pct); if (phase === "error") phase = "ready"; render(); });
    bind('[data-act="buy"]', doBuy);
    bind('[data-act="sell"]', doSell);
    bind('[data-act="chart"]', openChart);
    bind("[data-tf]", (el) => { tf = el.dataset.tf!; ensureCandles(); render(); });
    bind('[data-act="back"]', () => { view = "trade"; render(); });
    bind('[data-act="safety"]', () => { view = "safety"; render(); });
    bind('[data-act="holders"]', () => { view = "holders"; ensureHolders(); render(); });
    bind('[data-act="bubbles"]', () => { view = "bubbles"; render(); });
    bind("[data-htab]", (el) => { holdTab = el.dataset.htab as any; holdPage = 0; ensureHolders(); render(); });
    bind("[data-htag]", (el) => { holdTag = el.dataset.htag || ""; holdPage = 0; ensureHolders(); render(); });
    bind("[data-hpage]", (el) => { holdPage += el.dataset.hpage === "next" ? 1 : -1; if (holdPage < 0) holdPage = 0; render(); });
    bind('[data-act="hretry"]', () => { ensureHolders(true); render(); });
    bind('[data-act="again"]', () => { phase = "ready"; hash = ""; refreshHolding(); render(); });
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
      send({ type: "STRIX_TOKEN", ca }),
      send({ type: "STRIX_STATUS" }),
      send({ type: "STRIX_PAIR", ca }),
    ]);
    status = s;
    pairAddr = pr?.pair || null;
    if (!t?.info) { phase = "notfound"; render(); return; }
    info = t.info;
    phase = "ready";
    render();
    // GMGN extras (non-blocking): safety verdict + socials.
    send({ type: "STRIX_GMGN", what: "security", ca }).then((r) => {
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
    holding = await send({ type: "STRIX_HOLDING", ca });
    render();
  }
  async function tick() {
    if (!panel.isConnected) { clearInterval(timer); return; }
    const [t, s] = await Promise.all([send({ type: "STRIX_TOKEN", ca }), send({ type: "STRIX_STATUS" })]);
    if (t?.info) info = t.info;
    status = s;
    // Skip re-render in the bubbles view — it would reload the vendor iframe.
    if (phase !== "busy" && !editing && view !== "bubbles") render();
  }

  async function doBuy() {
    phase = "busy"; message = "Confirming…"; render();
    const r = await send({ type: "STRIX_BUY", ca, amountEth: amount });
    if (r?.error === "locked") { status = { unlocked: false }; phase = "ready"; render(); return; }
    if (r?.error) { phase = "error"; message = r.error; render(); return; }
    hash = r.hash; phase = "done"; render();
    status = await send({ type: "STRIX_STATUS" }); refreshHolding();
  }
  async function doSell() {
    phase = "busy"; message = "Confirming…"; render();
    const r = await send({ type: "STRIX_SELL", ca, pct });
    if (r?.error === "locked") { status = { unlocked: false }; phase = "ready"; render(); return; }
    if (r?.error) { phase = "error"; message = r.error; render(); return; }
    hash = r.hash; phase = "done"; render();
    status = await send({ type: "STRIX_STATUS" }); refreshHolding();
  }

  render();
  load();
}

async function resolveAndMount(sym: string, node: Element) {
  // Non-stock cashtag: ask the background to find a Robinhood Chain token with
  // that exact symbol (deepest liquidity). Mount only if one actually exists.
  const r = await send({ type: "STRIX_TICKER", symbol: sym });
  if (r?.address && node.isConnected) mountHost(r.address, node, `Buy $${sym}`);
}

function scan() {
  document.querySelectorAll<HTMLElement>(`[data-testid="tweetText"]:not([${MARK}])`).forEach((node) => {
    node.setAttribute(MARK, "1");
    const text = node.textContent || "";

    // Raw contract addresses.
    const addrs = Array.from(new Set(text.match(ADDR_RE) || []));
    addrs.slice(0, 2).forEach((ca) => mountHost(ca, node));

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
    stocks.slice(0, 2).forEach((sym) => mountHost(STOCK_TICKERS[sym], node, `Buy $${sym}`));
    others.slice(0, 2).forEach((sym) => resolveAndMount(sym, node));
  });
}

function boot() {
  scan();
  let t: number | undefined;
  new MutationObserver(() => { if (t) clearTimeout(t); t = window.setTimeout(scan, 400); }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

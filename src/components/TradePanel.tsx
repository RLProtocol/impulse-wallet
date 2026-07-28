import type { Address } from "viem";
import { useWallet } from "../state";
import { Spinner, IconExt, useAsync } from "./ui";
import { TokenLogo } from "./TokenLogo";
import SwapWidget from "./SwapWidget";
import SafetyPanel from "./SafetyPanel";
import { api } from "../lib/dex";
import type { TokenInfo } from "../lib/api";
import { gmgn, hasGmgnKey, pick } from "../lib/gmgn";
import { runTxBundle } from "../lib/trade";
import { tokenBalance } from "../lib/wallet";
import { addToken } from "../lib/tokens";
import { formatUnitsNum, fmtUsd, fmtCompact, fmtPct, fmtNum } from "../lib/format";

export default function TradePanel({ ca }: { ca: Address }) {
  const { address, toast, refresh, go } = useWallet();
  const info = useAsync<TokenInfo>(() => api.tokenInfo(ca), [ca]);
  const bal = useAsync(() => tokenBalance(ca, address!), [ca, address]);
  // GMGN token info — used for socials (website / X / telegram) if available.
  const gInfo = useAsync(async () => ((await hasGmgnKey()) ? gmgn.info(ca).catch(() => null) : null), [ca]);
  const socials = extractSocials(gInfo.data);

  const t = info.data;
  const decimals = t?.decimals ?? 18;
  const balance = bal.data != null ? formatUnitsNum(bal.data, decimals) : 0;

  if (info.loading) return <div className="flex justify-center p-8"><Spinner className="h-6 w-6 text-lime" /></div>;
  if (info.error || !t)
    return (
      <div className="card p-4 text-center text-[13px] text-muted">
        Couldn't load this token. Check the address, or it may not be tradable on Robinhood Chain yet.
      </div>
    );

  async function doBuy(amountEth: string, slippage: number, onStep: (s: string) => void) {
    onStep("Building trade…");
    const bundle = await api.buildBuy({ ca, amountEth, address: address!, slippage });
    const h = await runTxBundle(bundle.txs, onStep);
    await addToken(ca, "trade", { symbol: t!.symbol, name: t!.name, decimals: t!.decimals });
    toast("ok", `Bought ${t!.symbol}`);
    await Promise.all([refresh(), bal.refetch()]);
    return h;
  }
  async function doSell(pct: number, slippage: number, onStep: (s: string) => void) {
    onStep("Building trade…");
    const bundle = await api.buildSell({ ca, pct, address: address!, slippage });
    const h = await runTxBundle(bundle.txs, onStep);
    toast("ok", `Sold ${pct}% ${t!.symbol}`);
    await Promise.all([refresh(), bal.refetch()]);
    return h;
  }

  return (
    <div className="space-y-4">
      {/* Stats header */}
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <TokenLogo kind="token" symbol={t.symbol} address={t.address} src={t.logo} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-display text-lg font-bold text-white">{t.symbol}</span>
              <span className="chip px-1.5 py-0 text-[9px] uppercase">{t.venue}</span>
              {socials.map((s) => (
                <a key={s.label} href={s.url} target="_blank" rel="noreferrer" title={s.label}
                  className="text-[10px] font-semibold text-muted hover:text-lime">
                  {s.label}
                </a>
              ))}
            </div>
            <div className="truncate text-[12px] text-muted">{t.name}</div>
          </div>
          <div className="text-right">
            <div className="text-[15px] font-semibold text-white">{fmtUsd(t.priceUsd)}</div>
            <div className={`text-[12px] ${(t.priceChange24h || 0) >= 0 ? "text-up" : "text-down"}`}>{fmtPct(t.priceChange24h)}</div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <Stat label="Mcap" value={t.mcap != null ? "$" + fmtCompact(t.mcap) : "-"} />
          <Stat label="Liquidity" value={t.liquidityUsd != null ? "$" + fmtCompact(t.liquidityUsd) : "-"} />
          <Stat label="Vol 24h" value={t.volume24h != null ? "$" + fmtCompact(t.volume24h) : "-"} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button onClick={() => go({ name: "chart", kind: "token", address: t.address, symbol: t.symbol })} className="rounded-lg border border-border bg-surface2 py-2 text-[12px] font-semibold text-lime hover:border-lime/40">
            View chart
          </button>
          <button onClick={() => go({ name: "holders", ca: t.address, symbol: t.symbol })} className="rounded-lg border border-border bg-surface2 py-2 text-[12px] font-semibold text-lime hover:border-lime/40">
            Holders & traders
          </button>
        </div>
        {balance > 0 && (
          <div className="mt-3 rounded-lg bg-surface2 px-3 py-2 text-[12px] text-muted">
            Holding <span className="font-semibold text-white">{fmtNum(balance)} {t.symbol}</span>
            {t.priceUsd != null && <> · {fmtUsd(balance * t.priceUsd)}</>}
          </div>
        )}
      </div>

      <SafetyPanel ca={ca} />

      <SwapWidget
        token={{ kind: "token", symbol: t.symbol, name: t.name, address: t.address, decimals, priceUsd: t.priceUsd, logo: t.logo }}
        balanceRaw={bal.data ?? 0n}
        onBuy={doBuy}
        onSell={doSell}
      />
    </div>
  );
}

// GMGN /v1/token/info socials come in slightly different shapes; normalize to
// [{label, url}] and drop anything that isn't a usable link.
function extractSocials(d: any): { label: string; url: string }[] {
  if (!d) return [];
  const link = pick(d, ["link", "links", "social_links", "socials"]) || d;
  const out: { label: string; url: string }[] = [];
  const website = pick(link, ["website", "official_website", "homepage"]);
  if (website) out.push({ label: "Web", url: String(website) });
  const tw = pick(link, ["twitter_username", "twitter", "x"]);
  if (tw) out.push({ label: "𝕏", url: String(tw).startsWith("http") ? String(tw) : `https://x.com/${String(tw).replace(/^@/, "")}` });
  const tg = pick(link, ["telegram", "tg"]);
  if (tg) out.push({ label: "TG", url: String(tg).startsWith("http") ? String(tg) : `https://t.me/${String(tg).replace(/^@/, "")}` });
  const dc = pick(link, ["discord"]);
  if (dc && String(dc).startsWith("http")) out.push({ label: "DC", url: String(dc) });
  return out.filter((s) => /^https?:\/\//.test(s.url)).slice(0, 4);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface2 py-2">
      <div className="text-[9px] uppercase tracking-wider text-muted">{label}</div>
      <div className="text-[12px] font-semibold text-white">{value}</div>
    </div>
  );
}

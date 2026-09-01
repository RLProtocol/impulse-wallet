import type { Address } from "viem";
import { useWallet } from "../state";
import { CHAINS, type ChainKey } from "../lib/chains";
import * as sol from "../lib/solana";
import { getUnlockedSol } from "../lib/keystore";
import { resolveTokenChain } from "../lib/dexcore";
import { Spinner, IconExt, useAsync } from "./ui";
import { TokenLogo } from "./TokenLogo";
import SwapWidget from "./SwapWidget";
import SafetyPanel from "./SafetyPanel";
import { api } from "../lib/dex";
import type { TokenInfo } from "../lib/api";
import { gmgn, hasGmgnKey, pick } from "../lib/gmgn";
import { runTxBundle } from "../lib/trade";
import { nativeBalance, tokenBalance } from "../lib/wallet";
import { addToken, untrackIfEmpty } from "../lib/tokens";
import { formatUnitsNum, fmtUsd, fmtCompact, fmtPct, fmtNum } from "../lib/format";

export default function TradePanel({ ca, chain: chainProp }: { ca: Address | string; chain?: ChainKey }) {
  const { address, toast, refresh, go, chain: activeChain } = useWallet();
  // A pasted contract may live on a chain other than the one selected, so the
  // token's own chain wins. Resolved once, then used for reads and for signing.
  const resolved = useAsync(
    async () => (chainProp ? chainProp : (await resolveTokenChain(String(ca)))?.cfg.key ?? activeChain),
    [ca, chainProp, activeChain],
  );
  const chain: ChainKey = (resolved.data as ChainKey) || activeChain;
  const svm = CHAINS[chain].vm === "svm";
  const info = useAsync<TokenInfo>(() => api.tokenInfo(ca, chain), [ca, chain]);
  // Native balance on the token's own chain — what a buy actually spends.
  const nativeBal = useAsync(async () => {
    if (svm) {
      const kp = await getUnlockedSol();
      return kp ? sol.solBalance(kp.address).catch(() => 0n) : 0n;
    }
    return address ? nativeBalance(address as Address, chain).catch(() => 0n) : 0n;
  }, [address, chain, svm]);

  const bal = useAsync(
    async () => (svm
      ? (await sol.splBalance((await getUnlockedSol())?.address || "", String(ca)).catch(() => ({ raw: 0n }))).raw
      : tokenBalance(ca as Address, address!, chain)),
    [ca, address, chain, svm],
  );
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
        Couldn't load this token. Check the address, or it may not be tradable on any supported chain yet.
      </div>
    );

  async function doBuy(amountEth: string, slippage: number, onStep: (s: string) => void) {
    onStep("Building trade…");
    let h: string;
    if (svm) {
      const kp = await getUnlockedSol();
      if (!kp) throw new Error("This account has no Solana key. Import a recovery phrase to use Solana.");
      onStep("Routing…");
      const r = await sol.solBuy(kp, String(ca), Number(amountEth), slippage);
      onStep(`Confirming (${r.via})…`);
      await sol.confirmTx(r.signature);
      h = r.signature;
    } else {
      const bundle = await api.buildBuy({ ca: ca as Address, amountEth, address: address!, slippage, chain });
      h = await runTxBundle(bundle.txs, onStep, chain);
    }
    await addToken(ca as Address, "trade", { symbol: t!.symbol, name: t!.name, decimals: t!.decimals }, chain);
    toast("ok", `Bought ${t!.symbol}`);
    await Promise.all([refresh(), bal.refetch()]);
    return h;
  }
  async function doSell(pct: number, slippage: number, onStep: (s: string) => void) {
    onStep("Building trade…");
    let h: string;
    if (svm) {
      const kp = await getUnlockedSol();
      if (!kp) throw new Error("This account has no Solana key. Import a recovery phrase to use Solana.");
      onStep("Routing…");
      const r = await sol.solSell(kp, String(ca), pct, slippage);
      onStep(`Confirming (${r.via})…`);
      await sol.confirmTx(r.signature);
      h = r.signature;
    } else {
      const bundle = await api.buildSell({ ca: ca as Address, pct, address: address!, slippage, chain });
      h = await runTxBundle(bundle.txs, onStep, chain);
    }
    if (pct >= 100) {
      const left = svm
        ? (await sol.splBalance((await getUnlockedSol())?.address || "", String(ca)).catch(() => ({ raw: 1n }))).raw
        : await tokenBalance(ca as Address, address!, chain).catch(() => 1n);
      await untrackIfEmpty(ca as Address, chain, left).catch(() => false);
    }
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
        chain={chain}
        nativeRaw={nativeBal.data ?? 0n}
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

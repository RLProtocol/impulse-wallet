import { useMemo, useState } from "react";
import { formatEther } from "viem";
import { useWallet } from "../state";
import { Spinner, IconExt, IconSwap, IconChevronDown } from "./ui";
import { TokenLogo, EthMark, type LogoKind } from "./TokenLogo";
import { fmtNum, fmtUsd, formatUnitsNum } from "../lib/format";
import { CHAINS, type ChainKey } from "../lib/chains";

export type SwapToken = {
  kind: LogoKind;
  symbol: string;
  name: string;
  address?: string;
  decimals: number;
  priceUsd: number | null;
  logo?: string | null;
};

const BUY_PRESETS = ["0.01", "0.05", "0.1", "0.5"];
const SELL_PCTS = [25, 50, 100];

export default function SwapWidget({
  token,
  balanceRaw,
  chain: chainProp,
  nativeRaw,
  onBuy,
  onSell,
  defaultSlippage = 10,
  slippageOptions = [5, 10, 20, 30],
}: {
  token: SwapToken;
  balanceRaw: bigint;
  /** Chain the trade will actually settle on. Defaults to the picker, but a
   *  pasted or overlay-opened token can live somewhere else entirely. */
  chain?: ChainKey;
  /** Native balance on that chain, in its own base units. */
  nativeRaw?: bigint;
  onBuy: (amountEth: string, slippage: number, onStep: (s: string) => void) => Promise<string>;
  onSell: (pct: number, slippage: number, onStep: (s: string) => void) => Promise<string>;
  defaultSlippage?: number;
  slippageOptions?: number[];
}) {
  const { ethBalance, ethUsd, solBalance, chain: activeChain, toast } = useWallet();
  // The token's chain wins over the picker: opening a Base token while the
  // picker says Robinhood used to show the Robinhood ETH balance and enable a
  // Buy for funds that do not exist on Base.
  const chain = chainProp ?? activeChain;
  const cfg = CHAINS[chain];
  const svm = cfg.vm === "svm";
  const [dir, setDir] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("0.05"); // ETH for buy
  const [pct, setPct] = useState(100); // % for sell
  const [slippage, setSlippage] = useState(defaultSlippage);
  const [showSlip, setShowSlip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [hash, setHash] = useState<string>();

  const held = formatUnitsNum(balanceRaw, token.decimals);
  // Native balance for the chain in view. SOL is 9 decimals, so formatEther
  // would under-report it by a factor of a billion.
  const nativeFallback = svm ? solBalance : ethBalance;
  const raw = nativeRaw ?? (chainProp && chainProp !== activeChain ? 0n : nativeFallback);
  const ethBal = svm ? Number(raw) / 1e9 : Number(formatEther(raw));

  // Estimated receive amount (price-based, like a quote preview).
  const est = useMemo(() => {
    const p = token.priceUsd || 0;
    if (dir === "buy") {
      const eth = Number(amount) || 0;
      const usd = ethUsd ? eth * ethUsd : 0;
      return p > 0 ? usd / p : 0; // tokens out
    }
    const tokens = (held * pct) / 100;
    const usd = tokens * p;
    return ethUsd ? usd / ethUsd : 0; // ETH out
  }, [dir, amount, pct, held, token.priceUsd, ethUsd]);

  const payUsd = dir === "buy"
    ? (ethUsd ? (Number(amount) || 0) * ethUsd : null)
    : ((held * pct) / 100) * (token.priceUsd || 0);
  const recvUsd = dir === "buy"
    ? est * (token.priceUsd || 0)
    : (ethUsd ? est * ethUsd : null);

  const canGo = dir === "buy" ? Number(amount) > 0 && Number(amount) <= ethBal + 1e-9 : held > 0;

  async function go() {
    setBusy(true); setHash(undefined);
    try {
      const h = dir === "buy" ? await onBuy(amount, slippage, setStep) : await onSell(pct, slippage, setStep);
      setHash(h);
    } catch (e: any) {
      toast("err", e?.message || "Swap failed");
    } finally { setBusy(false); setStep(""); }
  }

  // The pay-with asset follows the chain: SOL on Solana, ETH everywhere else.
  // Hardcoding it made a Solana trade read "sell for ETH".
  const eth = { kind: "native" as LogoKind, symbol: cfg.nativeSymbol, address: undefined, logo: undefined };
  const tok = { kind: token.kind, symbol: token.symbol, address: token.address, logo: token.logo };
  const payToken = dir === "buy" ? eth : tok;
  const recvToken = dir === "buy" ? tok : eth;

  const rate = token.priceUsd && ethUsd
    ? `1 ${token.symbol} = ${fmtNum(token.priceUsd / ethUsd, 8)} ${cfg.nativeSymbol}`
    : null;

  return (
    <div>
      {/* Pay card */}
      <div className="rounded-2xl border border-border bg-surface2 p-4">
        <div className="mb-2 flex items-center justify-between text-[11px] text-muted">
          <span>You pay</span>
          <span>
            Balance {dir === "buy" ? fmtNum(ethBal) : fmtNum(held)}
            {dir === "buy" && (
              <button className="ml-1.5 font-semibold text-lime" onClick={() => setAmount(String(Math.max(0, ethBal - 0.0005)))}>MAX</button>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {dir === "buy" ? (
            <input
              className="min-w-0 flex-1 bg-transparent text-3xl font-semibold text-white outline-none placeholder:text-muted/40"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
            />
          ) : (
            <div className="min-w-0 flex-1 text-3xl font-semibold text-white">{fmtNum((held * pct) / 100)}</div>
          )}
          <TokenPill kind={payToken.kind} symbol={payToken.symbol} address={payToken.address} src={payToken.logo} />
        </div>
        <div className="mt-1 text-[12px] text-muted">{fmtUsd(payUsd)}</div>

        {dir === "buy" ? (
          <div className="mt-3 grid grid-cols-4 gap-2">
            {BUY_PRESETS.map((p) => (
              <button key={p} onClick={() => setAmount(p)} className={`rounded-lg py-1.5 text-[12px] ${amount === p ? "bg-lime/20 text-lime" : "bg-surface text-muted hover:text-white"}`}>{p}</button>
            ))}
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {SELL_PCTS.map((p) => (
              <button key={p} onClick={() => setPct(p)} className={`rounded-lg py-1.5 text-[12px] ${pct === p ? "bg-lime/20 text-lime" : "bg-surface text-muted hover:text-white"}`}>{p}%</button>
            ))}
          </div>
        )}
      </div>

      {/* Swap direction toggle */}
      <div className="relative z-10 -my-3 flex justify-center">
        <button
          onClick={() => setDir((d) => (d === "buy" ? "sell" : "buy"))}
          className="grid h-9 w-9 place-items-center rounded-xl border-4 border-bg bg-surface2 text-lime transition hover:bg-surface"
          title={dir === "buy" ? "Switch to sell" : "Switch to buy"}
        >
          <IconSwap className="h-4 w-4" />
        </button>
      </div>

      {/* Receive card */}
      <div className="rounded-2xl border border-border bg-surface2 p-4">
        <div className="mb-2 text-[11px] text-muted">You receive (estimated)</div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-3xl font-semibold text-white">{fmtNum(est)}</div>
          <TokenPill kind={recvToken.kind} symbol={recvToken.symbol} address={recvToken.address} src={recvToken.logo} />
        </div>
        <div className="mt-1 text-[12px] text-muted">{fmtUsd(recvUsd)}</div>
      </div>

      {/* Details */}
      <div className="mt-3 space-y-1.5 px-1 text-[12px]">
        {rate && (
          <div className="flex items-center justify-between text-muted">
            <span>Rate</span>
            <span className="text-white/80">{rate}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <button onClick={() => setShowSlip((s) => !s)} className="flex items-center gap-1 text-muted hover:text-white">
            Slippage <IconChevronDown className={`h-3.5 w-3.5 transition ${showSlip ? "rotate-180" : ""}`} />
          </button>
          <span className="text-white/80">{slippage}%</span>
        </div>
        {showSlip && (
          <div className="flex justify-end gap-1.5 pt-0.5">
            {slippageOptions.map((s) => (
              <button key={s} onClick={() => setSlippage(s)} className={`rounded-md px-2 py-0.5 text-[11px] ${slippage === s ? "bg-lime/20 text-lime" : "bg-surface2 text-muted"}`}>{s}%</button>
            ))}
          </div>
        )}
      </div>

      {/* Action */}
      <button
        className={`mt-4 w-full py-4 text-[15px] ${dir === "buy" ? "btn-primary" : "btn-danger"}`}
        disabled={busy || !canGo}
        onClick={go}
      >
        {busy
          ? <><Spinner /> {step || "Confirming…"}</>
          : dir === "buy"
            ? `Buy ${token.symbol}`
            : held > 0 ? `Sell ${token.symbol}` : `No ${token.symbol} to sell`}
      </button>

      {hash && (
        <a href={`${cfg.explorer}/${svm ? "tx" : "tx"}/${hash}`} target="_blank" rel="noreferrer" className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-lime hover:underline">
          View transaction <IconExt className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}

function TokenPill({ kind, symbol, address, src }: { kind: LogoKind; symbol: string; address?: string; src?: string | null }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1.5">
      {kind === "native" ? <EthMark size={22} /> : <TokenLogo kind={kind} symbol={symbol} address={address} src={src} size={22} />}
      <span className="pr-0.5 text-[14px] font-semibold text-white">{symbol}</span>
    </div>
  );
}

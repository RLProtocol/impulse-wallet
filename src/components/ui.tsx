import React, { useEffect, useState } from "react";
import logo from "../assets/logo.png";
import { useWallet } from "../state";
import { CHAIN_LIST, type ChainKey } from "../lib/chains";

export function Logo({ className = "h-7 w-7" }: { className?: string }) {
  return <img src={logo} alt="Impulse" className={`logo-glow ${className}`} />;
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Network picker.
 *
 * A segmented row rather than a dropdown: there are three chains and which one
 * you are on decides where a Send actually goes, so it should be readable at a
 * glance instead of hidden behind a tap.
 */
/** Official Solana mark. Inline so it needs no asset round-trip and stays
 *  crisp at the 10px the picker renders it at. */
export function SolanaMark({ className = "h-2.5 w-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 398 312" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="solg" x1="360" y1="-37" x2="141" y2="384" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00FFA3" />
          <stop offset="1" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <g fill="url(#solg)">
        <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
        <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
        <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z" />
      </g>
    </svg>
  );
}

export function ChainPicker({ className = "" }: { className?: string }) {
  const { chain, setChain, refresh } = useWallet();
  return (
    <div className={`flex gap-1 rounded-xl border border-line bg-surface2 p-1 ${className}`}>
      {CHAIN_LIST.map((c) => {
        const on = c.key === chain;
        return (
          <button
            key={c.key}
            onClick={async () => { if (!on) { await setChain(c.key as ChainKey); await refresh(); } }}
            className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-bold transition ${
              on ? "text-ink" : "text-muted hover:text-white"
            }`}
            style={on ? { background: c.tint } : undefined}
            title={c.name}
          >
            {c.short}
          </button>
        );
      })}
    </div>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <Logo className="h-6 w-6" />
      <span className="font-display text-[15px] font-bold tracking-wide text-white">
        IMPULSE <span className="text-lime">WALLET</span>
      </span>
    </div>
  );
}

// MetaMask-quality icon set from lucide, aliased to stable local names.
import {
  Wallet as IconHome,
  ArrowLeftRight as IconChart,
  TrendingUp as IconStock,
  Settings as IconGear,
  ArrowUp as IconSend,
  ArrowDown as IconReceive,
  Plus as IconPlus,
  ChevronLeft as IconBack,
  Copy as IconCopy,
  ExternalLink as IconExt,
  Eye as IconEye,
  ArrowDownUp as IconSwap,
  ChevronDown as IconChevronDown,
  Search as IconSearch,
  ShieldCheck as IconShield,
  CandlestickChart as IconCandle,
  Trophy as IconTrophy,
} from "lucide-react";

export {
  IconHome, IconChart, IconStock, IconGear, IconSend, IconReceive, IconPlus,
  IconBack, IconCopy, IconExt, IconEye, IconSwap, IconChevronDown, IconSearch, IconShield,
  IconCandle, IconTrophy,
};

export function Copyable({ text, children }: { text: string; children?: React.ReactNode }) {
  const { toast } = useWallet();
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        toast("ok", "Copied");
      }}
      className="inline-flex items-center gap-1.5 text-muted hover:text-lime transition"
    >
      {children}
      <IconCopy className="h-3.5 w-3.5" />
    </button>
  );
}

export function Toasts() {
  const { toasts } = useWallet();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto max-w-full rounded-xl px-3.5 py-2.5 text-[13px] font-medium shadow-lg backdrop-blur ${
            t.kind === "ok"
              ? "bg-lime/15 border border-lime/40 text-lime"
              : t.kind === "err"
                ? "bg-danger/15 border border-danger/40 text-danger"
                : "bg-surface2 border border-border text-white"
          }`}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

export function ScreenHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const { back } = useWallet();
  return (
    <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-bg/95 px-3 py-3 backdrop-blur">
      <button onClick={back} className="rounded-lg p-1.5 text-muted hover:bg-surface2 hover:text-white">
        <IconBack />
      </button>
      <h2 className="font-display flex-1 text-[15px] font-bold tracking-wide text-white">{title}</h2>
      {right}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <div className="label mb-1.5">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-muted">{hint}</div>}
    </label>
  );
}

// Small hook: run an async fn on mount + expose loading/data/error + refetch.
export function useAsync<T>(fn: () => Promise<T>, deps: React.DependencyList = []) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const run = React.useCallback(() => {
    setLoading(true);
    setError(undefined);
    fn()
      .then((d) => setData(d))
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  // Drop the old result the moment the inputs change, so a chain switch shows
  // a spinner rather than the previous chain's balances until the new read
  // lands. Deliberately not inside run(): a manual refetch (after a trade)
  // should update in place, not blank the screen.
  const first = React.useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setData(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { data, loading, error, refetch: run, setData };
}

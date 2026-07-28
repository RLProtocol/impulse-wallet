import React, { useEffect, useState } from "react";
import owl from "../assets/owl.png";
import { useWallet } from "../state";

export function Owl({ className = "h-7 w-7" }: { className?: string }) {
  return <img src={owl} alt="HoodX" className={`owl-glow ${className}`} />;
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <Owl className="h-6 w-6" />
      <span className="font-display text-[15px] font-bold tracking-wide text-white">
        HOODX <span className="text-lime">WALLET</span>
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
} from "lucide-react";

export {
  IconHome, IconChart, IconStock, IconGear, IconSend, IconReceive, IconPlus,
  IconBack, IconCopy, IconExt, IconEye, IconSwap, IconChevronDown, IconSearch, IconShield,
  IconCandle,
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
  useEffect(run, [run]);
  return { data, loading, error, refetch: run, setData };
}

import { useWallet } from "../state";
import { Spinner, useAsync, IconShield } from "./ui";
import { gmgn, hasGmgnKey, pick, asBool, asPct } from "../lib/gmgn";

// Token safety card: honeypot / taxes / verified / renounced / concentration /
// rug risk with a one-line verdict.

type Check = { label: string; value: string; level: "ok" | "warn" | "bad" | "na" };

function buildChecks(d: any): { checks: Check[]; verdict: "ok" | "warn" | "bad" } {
  const honeypot = asBool(pick(d, ["is_honeypot", "honeypot"]));
  const buyTax = asPct(pick(d, ["buy_tax", "buyTax"]));
  const sellTax = asPct(pick(d, ["sell_tax", "sellTax"]));
  const verified = asBool(pick(d, ["open_source", "is_open_source", "verified", "is_verified"]));
  const renounced = asBool(pick(d, ["owner_renounced", "renounced", "renounced_ownership", "is_renounced"]));
  const locked = asBool(pick(d, ["lock_summary.is_locked", "is_locked", "locked", "lp_locked", "liquidity_locked"]));
  const lockPct = asPct(pick(d, ["lock_summary.lock_percent", "lock_percent"]));
  const top10 = asPct(pick(d, ["top_10_holder_rate", "top10_holder_rate", "top_10_rate"]));
  const rug = Number(pick(d, ["rug_ratio", "rugRatio"]));
  const hasRug = isFinite(rug) && pick(d, ["rug_ratio", "rugRatio"]) != null;

  const fmtTax = (t?: number) => (t == null ? "?" : `${t.toFixed(t < 10 ? 1 : 0)}%`);
  const checks: Check[] = [
    // Honeypot row only shown when it actually IS one — hidden otherwise.
    ...(honeypot === true ? [{ label: "Honeypot", value: "YES — can't sell", level: "bad" } as Check] : []),
    { label: "Buy tax", value: fmtTax(buyTax), level: buyTax == null ? "na" : buyTax > 10 ? "bad" : buyTax > 3 ? "warn" : "ok" },
    { label: "Sell tax", value: fmtTax(sellTax), level: sellTax == null ? "na" : sellTax > 10 ? "bad" : sellTax > 3 ? "warn" : "ok" },
    { label: "Contract verified", value: verified == null ? "Unknown" : verified ? "Yes" : "No", level: verified == null ? "na" : verified ? "ok" : "warn" },
    { label: "Ownership renounced", value: renounced == null ? "Unknown" : renounced ? "Yes" : "No", level: renounced == null ? "na" : renounced ? "ok" : "warn" },
    ...(locked != null ? [{ label: "Liquidity locked", value: locked ? (lockPct != null ? `Yes (${lockPct.toFixed(0)}%)` : "Yes") : "No", level: locked ? "ok" : "warn" } as Check] : []),
    ...(top10 != null ? [{ label: "Top 10 holders", value: `${top10.toFixed(1)}%`, level: top10 > 50 ? "bad" : top10 > 30 ? "warn" : "ok" } as Check] : []),
    ...(hasRug ? [{ label: "Rug risk score", value: `${(rug <= 1 ? rug * 100 : rug).toFixed(0)}%`, level: rug > 0.3 ? "bad" : rug > 0.1 ? "warn" : "ok" } as Check] : []),
  ];

  const verdict = checks.some((c) => c.level === "bad") ? "bad" : checks.some((c) => c.level === "warn") ? "warn" : "ok";
  return { checks, verdict };
}

const VERDICT_TEXT = {
  ok: "No red flags found",
  warn: "Caution — review the flags below",
  bad: "High risk — trade carefully",
} as const;

export default function SafetyPanel({ ca }: { ca: string }) {
  const { go } = useWallet();
  const keyQ = useAsync(() => hasGmgnKey(), []);
  const q = useAsync(async () => ((await hasGmgnKey()) ? gmgn.security(ca) : null), [ca]);

  if (keyQ.data === false) return null;
  if (q.loading) {
    return (
      <div className="card flex items-center gap-2.5 p-3">
        <Spinner className="h-4 w-4 text-lime" />
        <span className="text-[12px] text-muted">Running safety checks…</span>
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div className="card p-3 text-[12px] text-muted">
        Safety data unavailable{q.error ? ` — ${q.error}` : ""}.
      </div>
    );
  }

  const { checks, verdict } = buildChecks(q.data);
  const vColor = verdict === "ok" ? "text-lime" : verdict === "warn" ? "text-yellow-400" : "text-danger";
  const vBorder = verdict === "ok" ? "border-lime/30" : verdict === "warn" ? "border-yellow-400/30" : "border-danger/40";

  return (
    <div className={`card p-4 ${vBorder}`}>
      <div className="flex items-center gap-2">
        <IconShield className={`h-4 w-4 ${vColor}`} />
        <span className="text-[13px] font-semibold text-white">Safety</span>
        <span className={`ml-auto text-[11px] font-semibold ${vColor}`}>{VERDICT_TEXT[verdict]}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {checks.map((c) => (
          <div key={c.label} className="flex items-center justify-between rounded-lg bg-surface2 px-2.5 py-1.5">
            <span className="text-[10px] text-muted">{c.label}</span>
            <span
              className={`text-[11px] font-semibold ${
                c.level === "ok" ? "text-lime" : c.level === "warn" ? "text-yellow-400" : c.level === "bad" ? "text-danger" : "text-muted"
              }`}
            >
              {c.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

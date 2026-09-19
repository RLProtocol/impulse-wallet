import { useEffect, useState } from "react";
import { useWallet } from "../state";
import { IconTrophy } from "../components/ui";
import mascot from "../assets/mascot.png";

type Row = {
  wallet: string; username: string; dp: string | null;
  pnl: number; realized: number; unrealized: number;
  invested: number; volume: number; trades: number; tokens: number;
};

const WINDOWS = [
  { k: "24h", label: "24H" },
  { k: "7d", label: "7D" },
  { k: "30d", label: "30D" },
  { k: "all", label: "All" },
];

// Compact USD, signed.
function usd(n: number): string {
  const a = Math.abs(n);
  const body = a >= 1000
    ? "$" + new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(a)
    : "$" + a.toFixed(2);
  return (n < 0 ? "-" : "") + body;
}

// Gold / silver / bronze for the top three, muted for the rest.
const MEDAL = ["#FFC542", "#C7CFDA", "#E08E5A"];

// The Impulse mascot is the default avatar; a real photo overrides it.
function Avatar({ row, top }: { row: Row; top: boolean }) {
  const dp = !!row.dp;
  return (
    <div
      className={`grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full border-2 ${dp ? "" : "bg-surface2"} ${top ? "" : "border-border"}`}
      style={top ? { borderColor: "hsl(79 86% 59% / 0.55)" } : undefined}
    >
      <img src={row.dp || mascot} alt="" className={dp ? "h-full w-full object-cover" : "h-8 w-8 object-contain"} />
    </div>
  );
}

const EXPLORERS: Record<string, string> = {
  robinhood: "https://robinhoodchain.blockscout.com",
  eth: "https://etherscan.io",
  base: "https://basescan.org",
  bnb: "https://bscscan.com",
};

export default function Leaderboard() {
  const { chain } = useWallet();
  const [win, setWin] = useState("24h");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    setRows(null);
    setErr("");
    chrome.runtime.sendMessage({ type: "STRIX_ILEADERBOARD", window: win }, (r: any) => {
      if (!alive) return;
      if (chrome.runtime.lastError) { setErr("Couldn't reach the leaderboard."); return; }
      if (r && "v" in r) setRows(r.v.entries || []);
      else setErr(r?.error || "Couldn't load the leaderboard.");
    });
    return () => { alive = false; };
  }, [win]);

  const openExplorer = (addr: string) => {
    const base = EXPLORERS[chain] || EXPLORERS.robinhood;
    window.open(`${base}/address/${addr}`, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-border bg-bg/95 px-4 py-3.5 backdrop-blur">
        <div className="grid h-8 w-8 place-items-center rounded-xl bg-lime/12 text-lime">
          <IconTrophy className="h-[18px] w-[18px]" />
        </div>
        <div>
          <div className="text-[16px] font-bold leading-none tracking-tight">Leaderboard</div>
          <div className="mt-1 text-[11px] text-muted">Top traders on Impulse · by profit</div>
        </div>
      </header>

      {/* Window selector */}
      <div className="px-4 pt-3.5">
        <div className="flex gap-1 rounded-2xl border border-border bg-surface p-1">
          {WINDOWS.map((w) => (
            <button
              key={w.k}
              onClick={() => setWin(w.k)}
              className={`flex-1 rounded-xl py-2 text-[12.5px] font-semibold transition ${
                win === w.k ? "bg-lime text-lime-on shadow-glow" : "text-muted hover:text-white"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2.5 p-4 pt-3.5">
        {rows === null && !err && (
          <div className="py-24 text-center text-[13px] text-muted">Loading the board…</div>
        )}
        {err && <div className="py-24 text-center text-[13px] text-danger">{err}</div>}
        {rows && !rows.length && !err && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <img src={mascot} alt="" className="h-16 w-16 opacity-70" />
            <div className="text-[13.5px] leading-relaxed text-muted">
              No ranked traders yet.<br />Trade through Impulse to climb the board.
            </div>
          </div>
        )}

        {rows?.map((row, i) => {
          const up = row.pnl >= 0;
          const top = i < 3;
          return (
            <div
              key={row.wallet}
              className={`flex items-center gap-3 rounded-2xl border p-3 transition ${
                top ? "border-lime/25 bg-lime/[0.05]" : "border-border bg-surface hover:border-white/15"
              }`}
            >
              {/* Rank */}
              <div className="w-7 shrink-0 text-center">
                {top ? (
                  <div
                    className="mx-auto grid h-6 w-6 place-items-center rounded-full text-[12px] font-black"
                    style={{ color: MEDAL[i], border: `1.5px solid ${MEDAL[i]}66`, background: `${MEDAL[i]}14` }}
                  >
                    {i + 1}
                  </div>
                ) : (
                  <span className="font-mono text-[13px] font-bold text-dim">{i + 1}</span>
                )}
              </div>

              {/* Identity → explorer */}
              <button onClick={() => openExplorer(row.wallet)} className="shrink-0" title="View wallet on explorer">
                <Avatar row={row} top={top} />
              </button>
              <button onClick={() => openExplorer(row.wallet)} className="min-w-0 flex-1 text-left" title="View wallet on explorer">
                <div className="truncate text-[14.5px] font-semibold hover:text-lime">{row.username}</div>
                <div className="mt-0.5 text-[11px] text-muted">
                  {row.trades} trade{row.trades === 1 ? "" : "s"} <span className="text-dim">·</span> {row.tokens} token{row.tokens === 1 ? "" : "s"}
                </div>
              </button>

              {/* Profit */}
              <div className="shrink-0 text-right">
                <div className={`font-mono text-[15.5px] font-bold leading-none ${up ? "text-up" : "text-down"}`}>
                  {up ? "+" : ""}{usd(row.pnl)}
                </div>
                <div className="mt-1 font-mono text-[10px] text-dim">{usd(row.invested)} in</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

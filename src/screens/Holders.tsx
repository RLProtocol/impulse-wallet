import { useState } from "react";
import { ScreenHeader, Spinner, useAsync, IconExt } from "../components/ui";
import { gmgn, hasGmgnKey, rowsOf, walletAddrOf, tagsOf, pick, isPoolRow, TAG_LABEL, type HolderSort, type WalletTag } from "../lib/gmgn";
import { addrUrl } from "../lib/chain";
import { shortAddr, fmtUsd, fmtPct } from "../lib/format";
import { useWallet } from "../state";

// Top holders / traders (GMGN, top 100) with per-wallet PnL, sortable, and
// KOL / smart-money tag filters + badges.

const SORTS: { key: HolderSort; label: string }[] = [
  { key: "amount_percentage", label: "Supply %" },
  { key: "profit", label: "Profit" },
  { key: "unrealized_profit", label: "Unrealized" },
];
const FILTERS: { key: WalletTag | undefined; label: string }[] = [
  { key: undefined, label: "All" },
  { key: "renowned", label: "KOLs" },
  { key: "smart_degen", label: "Smart $" },
  { key: "dev", label: "Dev" },
];
const TAG_STYLE: Record<string, string> = {
  kol: "border-yellow-400/40 bg-yellow-400/10 text-yellow-400",
  renowned: "border-yellow-400/40 bg-yellow-400/10 text-yellow-400",
  smart_degen: "border-lime/40 bg-lime/10 text-lime",
  whale: "border-sky-400/40 bg-sky-400/10 text-sky-400",
  dev: "border-danger/40 bg-danger/10 text-danger",
  creator: "border-danger/40 bg-danger/10 text-danger",
  rat_trader: "border-danger/40 bg-danger/10 text-danger",
  wash_trader: "border-danger/40 bg-danger/10 text-danger",
  sniper: "border-sky-400/40 bg-sky-400/10 text-sky-400",
};

export default function Holders({ ca, symbol }: { ca: string; symbol?: string }) {
  const { go } = useWallet();
  const [tab, setTab] = useState<"holders" | "traders">("holders");
  const [sort, setSort] = useState<HolderSort>("amount_percentage");
  const [tag, setTag] = useState<WalletTag | undefined>(undefined);
  const [page, setPage] = useState(0);
  const PAGE = 5;

  // Holders rank by current balance; traders make sense ranked by profit
  // (includes wallets that already exited) — switch the default per tab.
  const pickTab = (t: "holders" | "traders") => {
    setTab(t);
    setSort(t === "traders" ? "profit" : "amount_percentage");
    setPage(0);
  };

  const keyQ = useAsync(() => hasGmgnKey(), []);
  const q = useAsync(async () => {
    if (!(await hasGmgnKey())) return null;
    const d = tab === "holders" ? await gmgn.topHolders(ca, sort, tag) : await gmgn.topTraders(ca, sort, tag);
    return rowsOf(d);
  }, [ca, tab, sort, tag]);

  const rows = q.data || [];
  const kols = rows.filter((r: any) => { const t = tagsOf(r); return t.includes("kol") || t.includes("renowned"); }).length;
  const smart = rows.filter((r: any) => tagsOf(r).includes("smart_degen")).length;

  return (
    <div>
      <ScreenHeader title={`${symbol || "Token"} · Top ${tab}`} />
      <div className="space-y-3 p-4">
        {keyQ.data === false ? (
          <div className="card p-4 text-center text-[13px] text-muted">
            Holder data is unavailable right now.
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="flex gap-2">
              {(["holders", "traders"] as const).map((t) => (
                <button
                  key={t}
                  className={`flex-1 rounded-lg px-3 py-2 text-[13px] font-semibold capitalize ${tab === t ? "bg-lime text-black" : "bg-surface2 text-muted"}`}
                  onClick={() => pickTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* Filters + sort */}
            <div className="flex items-center gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.label}
                  className={`rounded-md px-2 py-1 text-[11px] ${tag === f.key ? "bg-lime/20 text-lime" : "bg-surface2 text-muted hover:text-white"}`}
                  onClick={() => { setTag(f.key); setPage(0); }}
                >
                  {f.label}
                </button>
              ))}
              <select
                className="ml-auto rounded-md border border-border bg-surface2 px-1.5 py-1 text-[11px] text-muted outline-none"
                value={sort}
                onChange={(e) => { setSort(e.target.value as HolderSort); setPage(0); }}
              >
                {SORTS.map((s) => <option key={s.key} value={s.key}>↓ {s.label}</option>)}
              </select>
            </div>

            {!q.loading && !tag && rows.length > 0 && (kols > 0 || smart > 0) && (
              <div className="rounded-lg border border-yellow-400/25 bg-yellow-400/5 px-3 py-2 text-[11px] text-muted">
                In top {rows.length}: <span className="font-semibold text-yellow-400">{kols} KOL{kols === 1 ? "" : "s"}</span>
                {" · "}
                <span className="font-semibold text-lime">{smart} smart money</span>
              </div>
            )}

            {q.loading && (
              <div className="flex justify-center p-8"><Spinner className="h-6 w-6 text-lime" /></div>
            )}
            {q.error && (
              <div className="card p-4 text-center text-[12px] text-muted">Couldn't load — {q.error}</div>
            )}
            {!q.loading && !q.error && rows.length === 0 && (
              <div className="card p-4 text-center text-[13px] text-muted">
                {tag
                  ? `No ${FILTERS.find((f) => f.key === tag)?.label} wallets found here.`
                  : "No holder data for this token yet (tokenized stocks aren't indexed)."}
                <button className="mt-2 block w-full text-[12px] text-lime hover:underline" onClick={q.refetch}>Retry</button>
              </div>
            )}

            <div className="space-y-1.5">
              {rows.slice(page * PAGE, page * PAGE + PAGE).map((r: any, i: number) => (
                <WalletRow key={walletAddrOf(r) || i} row={r} rank={page * PAGE + i + 1} />
              ))}
            </div>
            {rows.length > PAGE && (
              <div className="flex items-center justify-center gap-4 pt-1">
                <button
                  className="rounded-lg border border-border bg-surface2 px-3 py-1.5 text-[12px] font-semibold text-muted hover:text-white disabled:opacity-35"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  ‹ Prev
                </button>
                <span className="text-[11px] font-semibold text-muted">
                  {page + 1} / {Math.ceil(rows.length / PAGE)}
                </span>
                <button
                  className="rounded-lg border border-border bg-surface2 px-3 py-1.5 text-[12px] font-semibold text-muted hover:text-white disabled:opacity-35"
                  disabled={page >= Math.ceil(rows.length / PAGE) - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next ›
                </button>
              </div>
            )}
            {rows.length > 0 && (
              <div className="text-right text-[9px] text-muted/70">
                {rows.length} wallets · {tab === "traders" ? "traders incl. exited" : "current holders"}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function WalletRow({ row, rank }: { row: any; rank: number }) {
  const addr = walletAddrOf(row);
  const pool = isPoolRow(row);
  const tags = pool ? [] : tagsOf(row);
  const name = pool ? `${String(row.exchange || "DEX").replace(/_/g, " ")} pool` : pick(row, ["name", "twitter_username", "twitter_name", "nickname"]);
  const supplyPct = Number(pick(row, ["amount_percentage", "amount_percent"]));
  const valueUsd = Number(pick(row, ["usd_value", "value_usd", "amount_usd"]));
  // Pool/contract rows report meaningless transfer-based "profit" — hide it.
  const profit = pool ? NaN : Number(pick(row, ["profit", "realized_profit", "total_profit"]));
  const unrealized = pool ? NaN : Number(pick(row, ["unrealized_profit", "unrealized_pnl"]));
  const sold = pool ? NaN : Number(pick(row, ["sell_amount_percentage"]));

  const pnl = (label: string, v: number) =>
    isFinite(v) && v !== 0 ? (
      <span className={v >= 0 ? "text-up" : "text-down"}>
        {label} {v >= 0 ? "+" : "-"}{fmtUsd(Math.abs(v)).replace("$", "$")}
      </span>
    ) : null;

  return (
    <div className="card flex items-center gap-2.5 p-2.5">
      <span className="w-6 shrink-0 text-center text-[11px] font-semibold text-muted">{rank}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <a
            href={addrUrl(addr)} target="_blank" rel="noreferrer"
            className="truncate font-mono text-[12px] text-white hover:text-lime"
            title={addr}
          >
            {name ? String(name) : shortAddr(addr, 5)}
          </a>
          {pool && (
            <span className="shrink-0 rounded border border-border bg-surface2 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-muted">
              Pool
            </span>
          )}
          {tags.filter((t) => TAG_LABEL[t]).slice(0, 3).map((t) => (
            <span key={t} className={`shrink-0 rounded border px-1 py-px text-[8px] font-bold uppercase tracking-wide ${TAG_STYLE[t] || "border-border bg-surface2 text-muted"}`}>
              {TAG_LABEL[t]}
            </span>
          ))}
          <a href={addrUrl(addr)} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-muted hover:text-lime">
            <IconExt className="h-3 w-3" />
          </a>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted">
          {isFinite(supplyPct) && supplyPct > 0 && <span>{fmtPct(supplyPct <= 1 ? supplyPct * 100 : supplyPct).replace("+", "")} supply</span>}
          {isFinite(valueUsd) && valueUsd > 0 && <span>{fmtUsd(valueUsd)}</span>}
          {isFinite(sold) && sold > 0 && <span>sold {Math.min(100, sold <= 1 ? sold * 100 : sold).toFixed(0)}%</span>}
          {pnl("PnL", profit)}
          {pnl("Unreal.", unrealized)}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { ScreenHeader, Spinner } from "../components/ui";
import type { Trending, TrendingToken } from "../lib/impulse";
import mascot from "../assets/mascot.png";

function bg<T = any>(msg: any): Promise<{ v?: T; error?: string }> {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage(msg, (r: any) =>
        res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (r || { error: "no response" })));
    } catch (e: any) { res({ error: String(e) }); }
  });
}

function compact(n?: number | null): string {
  if (!n) return "0";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
const RANK = ["#FFC542", "#C7CFDA", "#E08E5A"]; // gold / silver / bronze

const DEX = (t: TrendingToken) => `https://dexscreener.com/${t.chain || "robinhood"}/${t.ca}`;

function TokenRow({ t, rank, metric, count }: { t: TrendingToken; rank: number; metric: string; count: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <a href={DEX(t)} target="_blank" rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3 transition hover:border-lime/40">
      <span className="w-4 text-center font-mono text-[13px] font-bold" style={{ color: RANK[rank] || "#9AA391" }}>{rank + 1}</span>
      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full border border-border bg-surface2">
        <img src={!broken && t.image ? t.image : mascot} alt="" onError={() => setBroken(true)}
          className={t.image && !broken ? "h-full w-full object-cover" : "h-7 w-7 object-contain absolute inset-0 m-auto"} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-bold text-white">${t.symbol || "?"}</span>
        </div>
        <div className="text-[11px] text-white/55">MC {t.mcap ? "$" + compact(t.mcap) : "—"}</div>
      </div>
      <div className="text-right">
        <div className="font-mono text-[16px] font-bold leading-none text-lime">{compact(count)}</div>
        <div className="mt-0.5 text-[9.5px] font-medium uppercase tracking-wide text-white/45">{metric}</div>
      </div>
    </a>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex-1 rounded-xl border border-border bg-surface2 px-3 py-2.5 text-center">
      <div className={`text-[20px] font-bold leading-none ${accent ? "text-lime" : "text-white"}`}>{value}</div>
      <div className="mt-1 text-[9.5px] font-medium uppercase tracking-wide text-white/50">{label}</div>
    </div>
  );
}

export default function Popularity() {
  const [data, setData] = useState<Trending | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = () => {
    setLoading(true); setErr("");
    bg<Trending>({ type: "STRIX_ITRENDING" }).then((r) => {
      if (r.error || !r.v) setErr("Couldn't load trending right now.");
      else setData(r.v);
      setLoading(false);
    });
  };
  useEffect(load, []);

  return (
    <div>
      <ScreenHeader title="Popularity" right={
        <button onClick={load} className="text-[11.5px] font-medium text-lime hover:brightness-110">Refresh</button>
      } />

      <div className="space-y-5 p-4">
        {/* hero: what the crowd is looking at */}
        <div className="relative overflow-hidden rounded-2xl border border-lime/30 bg-surface p-4">
          <div className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-lime/20 blur-3xl" aria-hidden />
          <div className="relative">
            <div className="flex items-center gap-2">
              <img src={mascot} alt="" className="h-7 w-7 object-contain" />
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-lime/80">Trending on Impulse</div>
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-[34px] font-bold leading-none text-white">{data ? compact(data.totalSeen) : "—"}</span>
              <span className="text-[13px] font-semibold text-white/60">tokens seen</span>
            </div>
            <div className="mt-3 flex gap-2">
              <Stat label="Opened" value={data ? compact(data.totalOpened) : "—"} accent />
              <Stat label="Tokens tracked" value={data ? compact(data.totalTokens) : "—"} />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><Spinner className="h-6 w-6" /></div>
        ) : err ? (
          <div className="rounded-2xl border border-border bg-surface2 py-8 text-center text-[12.5px] text-white/60">{err}</div>
        ) : (
          <>
            <section>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[12px] font-bold uppercase tracking-wide text-white">Most seen</span>
                <span className="text-[10.5px] text-white/45">appeared in the overlay</span>
              </div>
              <div className="space-y-2">
                {(data?.topSeen || []).map((t, i) => <TokenRow key={t.ca} t={t} rank={i} metric="seen" count={t.seen} />)}
                {(!data?.topSeen || data.topSeen.length === 0) && <Empty />}
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[12px] font-bold uppercase tracking-wide text-white">Most opened</span>
                <span className="text-[10.5px] text-white/45">traders dug in</span>
              </div>
              <div className="space-y-2">
                {(data?.topOpened || []).map((t, i) => <TokenRow key={t.ca} t={t} rank={i} metric="opened" count={t.opened} />)}
                {(!data?.topOpened || data.topOpened.length === 0) && <Empty />}
              </div>
            </section>
          </>
        )}

        <p className="px-1 text-[10.5px] leading-relaxed text-white/45">
          Popularity is aggregated across everyone using Impulse. "Seen" counts a token appearing in the overlay;
          "opened" counts its panel being opened, which is the stronger signal of real interest.
        </p>
      </div>
    </div>
  );
}

function Empty() {
  return <div className="rounded-2xl border border-dashed border-border py-6 text-center text-[12px] text-white/50">No data yet.</div>;
}

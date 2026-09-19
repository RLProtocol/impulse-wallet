import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../state";
import { ScreenHeader, Field, Spinner, Copyable } from "../components/ui";
import type { CopyJob, CopyWallet, CopyHolding, CopyEvent } from "../lib/copyd";
import mascot from "../assets/mascot.png";

function bg<T = any>(msg: any): Promise<{ v?: T; error?: string }> {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage(msg, (r: any) =>
        res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (r || { error: "no response" })));
    } catch (e: any) { res({ error: String(e) }); }
  });
}

const CONF_LABEL: Record<string, string> = { high: "High confidence", medium: "Medium confidence", none: "Not resolvable" };
const STATUS: Record<string, { label: string; dot: string; text: string }> = {
  active: { label: "Active", dot: "bg-lime", text: "text-lime" },
  paused: { label: "Paused", dot: "bg-white/40", text: "text-white/60" },
  stopped: { label: "Stopped", dot: "bg-white/30", text: "text-white/50" },
  low_balance: { label: "Needs funding", dot: "bg-gold", text: "text-gold" },
};
const EVENT_LABEL: Record<string, string> = {
  buy: "Bought", sell: "Sold (mirrored)", manual_sell: "Sold", withdraw: "Withdrew",
  mcap_skip: "Skipped, over mcap", cap_daily_skip: "Skipped, daily cap",
  cap_token_skip: "Skipped, token cap", cap_total_reached: "Stopped, total cap",
  low_balance: "Paused, low balance",
};
function usd(n?: number | null): string { return !n ? "$0" : "$" + new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n); }
function eth(n?: number | null): string { return (n == null ? 0 : n).toFixed(4); }
function ago(t: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
  if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`;
}

/* small inline icons */
const I = {
  down: "M12 4v13M6 11l6 6 6-6",       // withdraw
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z",
  export: "M14 3h7v7M21 3l-9 9M20 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5",
};
function Ico({ d, className = "h-3.5 w-3.5" }: { d: string; className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>{d.split("M").filter(Boolean).map((p, i) => <path key={i} d={"M" + p} />)}</svg>;
}

/* ── the one reusable copy wallet (hero card) ──────────────────────────────── */
function WalletCard({ owner, wallet, reload, toast }: {
  owner: string; wallet: CopyWallet; reload: () => void; toast: (k: any, m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pk, setPk] = useState("");
  const [ks, setKs] = useState("");

  async function sell(token?: string, all = false) {
    setBusy(true);
    const r = await bg({ type: "STRIX_COPY_SELL", owner, body: all ? { all: true } : { token, pct: 100 } });
    setBusy(false);
    if (r.error) { toast("err", r.error); return; }
    toast("ok", all ? "Sold everything to ETH" : "Sold to ETH"); reload();
  }
  async function withdraw() {
    setBusy(true);
    const r = await bg<{ ok: boolean; tx: string }>({ type: "STRIX_COPY_WITHDRAW", owner });
    setBusy(false);
    if (r.error || !r.v?.ok) { toast("err", r.error || String(r.v?.tx || "Withdraw failed")); return; }
    toast("ok", "ETH sent to your main wallet"); reload();
  }
  async function reveal() {
    const r = await bg<{ pk: string }>({ type: "STRIX_COPY_REVEAL", owner });
    if (r.error || !r.v?.pk) { toast("err", r.error || "Reveal failed"); return; }
    setPk(r.v.pk);
  }
  async function doExport() {
    const pw = window.prompt("Set a password to encrypt the exported wallet (at least 8 characters):");
    if (!pw) return;
    if (pw.length < 8) { toast("err", "Password must be at least 8 characters"); return; }
    const r = await bg<{ keystore: any }>({ type: "STRIX_COPY_EXPORT", owner, password: pw });
    if (r.error || !r.v?.keystore) { toast("err", r.error || "Export failed"); return; }
    setKs(JSON.stringify(r.v.keystore)); toast("ok", "Wallet exported");
  }

  const funded = !!wallet.balanceEth;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-lime/30 bg-surface p-4">
      <div className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full bg-lime/20 blur-3xl" aria-hidden />
      <div className="relative">
        <div className="flex items-start justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-lime/80">Copytrade wallet</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-[26px] font-bold leading-none text-white">{eth(wallet.balanceEth)}</span>
              <span className="text-[13px] font-semibold text-white/60">ETH</span>
            </div>
          </div>
          <img src={mascot} alt="" className="h-10 w-10 object-contain opacity-90" />
        </div>

        <div className="mt-3 rounded-xl border border-border bg-surface2 px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wide text-white/50">Deposit address (Robinhood chain)</div>
          <Copyable text={wallet.address || ""}>
            <span className="font-mono text-[11.5px] text-white">{wallet.address}</span>
          </Copyable>
        </div>
        {!funded && (
          <div className="mt-2 text-[11.5px] text-gold">Deposit ETH to the address above to start copying.</div>
        )}

        {wallet.holdings && wallet.holdings.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-white/60">Holdings</span>
              <button disabled={busy} onClick={() => sell(undefined, true)}
                className="rounded-lg bg-lime/15 px-2.5 py-1 text-[11px] font-bold text-lime hover:bg-lime/25">Sell all to ETH</button>
            </div>
            <div className="space-y-1.5">
              {wallet.holdings.map((h: CopyHolding) => (
                <div key={h.token} className="flex items-center justify-between rounded-xl bg-surface2 px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-bold text-white">{h.symbol}</span>
                    <span className="font-mono text-[11px] text-white/60">{usd(h.usd)}</span>
                  </div>
                  <button disabled={busy} onClick={() => sell(h.token)}
                    className="rounded-lg bg-lime/15 px-3 py-1 text-[11px] font-bold text-lime hover:bg-lime/25">Sell</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2">
          <button disabled={busy || !funded} onClick={withdraw}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-border bg-surface2 py-2 text-[11.5px] font-semibold text-white hover:border-lime/40 disabled:opacity-40">
            <Ico d={I.down} /> Withdraw
          </button>
          <button onClick={reveal}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-border bg-surface2 py-2 text-[11.5px] font-semibold text-white hover:border-lime/40">
            <Ico d={I.eye} /> Key
          </button>
          <button onClick={doExport}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-border bg-surface2 py-2 text-[11.5px] font-semibold text-white hover:border-lime/40">
            <Ico d={I.export} /> Export
          </button>
        </div>

        {pk && (
          <div className="mt-2 rounded-xl border border-gold/40 bg-gold/[0.08] p-2.5">
            <div className="mb-1 text-[11px] font-bold text-gold">Private key. Never share it; anyone with it controls this wallet.</div>
            <Copyable text={pk}><span className="block break-all font-mono text-[10px] text-white">{pk}</span></Copyable>
          </div>
        )}
        {ks && (
          <div className="mt-2 rounded-xl border border-border bg-surface2 p-2.5">
            <div className="mb-1 text-[11px] text-white/70">Encrypted keystore. Import into any wallet using your password.</div>
            <Copyable text={ks}><span className="block max-h-16 overflow-y-auto break-all font-mono text-[9.5px] text-white/60">{ks.slice(0, 240)}</span></Copyable>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── one follow ────────────────────────────────────────────────────────────── */
function JobCard({ job, reload, toast }: { job: CopyJob; reload: () => void; toast: (k: any, m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [copySells, setCopySells] = useState(job.copySells);
  const st = STATUS[job.status] || STATUS.stopped;

  async function toggleMode(next: boolean) {
    setCopySells(next);
    const r = await bg({ type: "STRIX_COPY_MODE", id: job.id, copySells: next });
    if (r.error) { setCopySells(!next); toast("err", r.error); return; }
    toast("ok", next ? "Now mirroring sells too" : "Buys only");
  }
  async function remove() {
    const r = await bg({ type: "STRIX_COPY_STOP", id: job.id });
    if (r.error) { toast("err", r.error); return; }
    toast("ok", "Stopped copying"); reload();
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-3.5">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-left">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${st.dot}`} />
          <span className="text-[14px] font-bold text-white">@{job.handle}</span>
          <span className={`text-[11px] font-semibold ${st.text}`}>{st.label}</span>
        </div>
        <span className="font-mono text-[11.5px] text-white/70">{job.amountEth} ETH {open ? "▾" : "▸"}</span>
      </button>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-white/60">
        <span>Up to mcap <b className="text-white">{job.maxMcapUsd ? usd(job.maxMcapUsd) : "any"}</b></span>
        <span>Copied <b className="text-white">{usd(job.spent?.total)}</b></span>
        <span>{job.copySells ? "Buys + sells" : "Buys only"}</span>
      </div>

      {open && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <label className="flex cursor-pointer items-center justify-between rounded-xl bg-surface2 px-3 py-2.5">
            <span className="text-[12.5px] text-white">Also mirror their sells</span>
            <input type="checkbox" checked={copySells} onChange={(e) => toggleMode(e.target.checked)} className="h-4 w-4 accent-lime" />
          </label>

          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/60">History</div>
            {(!job.events || job.events.length === 0) ? (
              <div className="text-[12px] text-white/50">No copies yet.</div>
            ) : (
              <div className="space-y-1.5">
                {[...job.events].reverse().map((e: CopyEvent, i) => (
                  <div key={i} className="flex items-center justify-between text-[11.5px]">
                    <span className={e.ok === false ? "text-down" : "text-white/75"}>
                      {EVENT_LABEL[e.kind] || e.kind}{e.token ? ` ${e.token.slice(0, 6)}` : ""}
                    </span>
                    <span className="font-mono text-white/45">{e.usd ? usd(e.usd) + " · " : ""}{ago(e.t)} ago</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button onClick={remove} className="w-full rounded-xl border border-down/40 py-2 text-[12px] font-bold text-down hover:bg-down/10">
            Stop copying @{job.handle}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Copytrade({ handle: initial }: { handle?: string }) {
  const { address, toast } = useWallet();

  const [wallet, setWallet] = useState<CopyWallet | null>(null);
  const [jobs, setJobs] = useState<CopyJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [firstPk, setFirstPk] = useState<{ address: string; pk: string } | null>(null);

  const [handle, setHandle] = useState(initial || "");
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<{ resolved: boolean; confidence: string } | null>(null);
  const [amount, setAmount] = useState("0.01");
  const [maxMcap, setMaxMcap] = useState("");
  const [mirrorSells, setMirrorSells] = useState(false);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    if (!address) { setLoading(false); return; }
    const [w, j] = await Promise.all([
      bg<CopyWallet>({ type: "STRIX_COPY_WALLET", owner: address }),
      bg<CopyJob[]>({ type: "STRIX_COPY_LIST", owner: address }),
    ]);
    setWallet(w.v || { exists: false });
    setJobs(j.v || []);
    setLoading(false);
  }, [address]);

  useEffect(() => { reload(); }, [reload]);

  const doResolve = useCallback(async (h: string) => {
    const clean = h.replace(/^@/, "").trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(clean)) { setResolved(null); return; }
    setResolving(true); setResolved(null);
    const r = await bg<{ resolved: boolean; confidence: string }>({ type: "STRIX_COPY_RESOLVE", handle: clean });
    setResolving(false);
    if (r.error) { toast("err", "Could not resolve. The FOMO session may be down."); return; }
    setResolved({ resolved: !!r.v?.resolved, confidence: r.v?.confidence || "none" });
  }, [toast]);

  useEffect(() => { if (initial) doResolve(initial); }, [initial, doResolve]);

  async function create() {
    if (!address) { toast("err", "No wallet address."); return; }
    const amt = Number(amount);
    if (!(amt > 0)) { toast("err", "Enter an amount per copy."); return; }
    const mcap = maxMcap ? Number(maxMcap.replace(/[, _$]/g, "")) : 0;
    setCreating(true);
    const r = await bg<CopyJob & { wallet: CopyWallet }>({
      type: "STRIX_COPY_CREATE",
      body: { owner: address, handle: handle.replace(/^@/, "").trim(), amountEth: amt, maxMcapUsd: mcap, copySells: mirrorSells },
    });
    setCreating(false);
    if (r.error || !r.v) { toast("err", r.error || "Could not start copying."); return; }
    toast("ok", `Copying @${r.v.handle}`);
    if (r.v.wallet?.isNew && r.v.wallet.pk && r.v.wallet.address) setFirstPk({ address: r.v.wallet.address, pk: r.v.wallet.pk });
    setResolved(null); setHandle(""); setAmount("0.01"); setMaxMcap(""); setMirrorSells(false);
    reload();
  }

  const canFollow = resolved?.resolved;

  return (
    <div>
      <ScreenHeader title="Copytrade" />
      <div className="space-y-4 p-4">

        {firstPk && (
          <div className="rounded-2xl border border-gold/50 bg-gold/[0.09] p-4">
            <div className="text-[14px] font-bold text-gold">Save your copytrade wallet</div>
            <div className="mt-1 text-[12px] leading-relaxed text-white/80">
              This is a dedicated wallet just for copytrading. Deposit the ETH you want to copy with to the address below, and back up the private key somewhere safe. You can reveal it again anytime from the wallet card.
            </div>
            <div className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-white/55">Deposit address</div>
            <Copyable text={firstPk.address}><span className="font-mono text-[12px] text-white">{firstPk.address}</span></Copyable>
            <div className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-white/55">Private key</div>
            <Copyable text={firstPk.pk}><span className="block break-all font-mono text-[10.5px] text-white">{firstPk.pk}</span></Copyable>
            <button onClick={() => setFirstPk(null)} className="btn-primary mt-3 w-full">I have saved it</button>
          </div>
        )}

        {!loading && wallet?.exists && address && (
          <WalletCard owner={address} wallet={wallet} reload={reload} toast={toast} />
        )}

        <div className="rounded-2xl border border-border bg-surface p-4">
          <div className="mb-3 flex items-center gap-2.5">
            <img src={mascot} alt="" className="h-8 w-8 object-contain" />
            <div>
              <div className="text-[15px] font-bold text-white">Copy a FOMO trader</div>
              <div className="text-[11.5px] text-white/60">Paste a handle and Impulse mirrors their buys, 24/7.</div>
            </div>
          </div>

          <Field label="Trader handle">
            <div className="relative">
              <input className="input pr-24" placeholder="@handle" value={handle}
                onChange={(e) => { setHandle(e.target.value); setResolved(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") doResolve(handle); }}
                autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <button onClick={() => doResolve(handle)} disabled={resolving || !handle.trim()}
                className="btn-primary absolute right-1.5 top-1/2 -translate-y-1/2 px-3.5 py-1.5 text-[12px]">
                {resolving ? <Spinner className="h-3.5 w-3.5" /> : "Resolve"}
              </button>
            </div>
          </Field>

          {resolved && (
            <div className={`mt-3 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[12.5px] font-semibold ${
              canFollow ? "border-lime/40 bg-lime/[0.09] text-lime" : "border-border bg-surface2 text-white/70"}`}>
              {canFollow ? (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m4 12.5 5.2 5L20 7" /></svg>
                  <span>Trader resolved. {CONF_LABEL[resolved.confidence]}.</span>
                </>
              ) : (<span>No copyable wallet found for this trader yet.</span>)}
            </div>
          )}

          {canFollow && (
            <div className="mt-4 space-y-3">
              <Field label="Amount per copy (ETH)" hint="Spent on each buy the trader makes.">
                <input className="input font-mono" inputMode="decimal" value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.01" />
              </Field>
              <Field label="Copy up to market cap (USD)" hint="Only copy tokens at or below this market cap. Leave blank for no limit.">
                <input className="input font-mono" inputMode="numeric" value={maxMcap}
                  onChange={(e) => setMaxMcap(e.target.value)} placeholder="500000 (blank for any)" />
              </Field>
              <label className="flex cursor-pointer items-center justify-between rounded-xl bg-surface2 px-3 py-2.5">
                <span className="text-[12.5px] text-white">Also mirror their sells <span className="text-white/50">(off means buys only)</span></span>
                <input type="checkbox" checked={mirrorSells} onChange={(e) => setMirrorSells(e.target.checked)} className="h-4 w-4 accent-lime" />
              </label>
              <button onClick={create} disabled={creating} className="btn-primary w-full">
                {creating ? <Spinner className="h-4 w-4" /> : "Start copying"}
              </button>
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-semibold uppercase tracking-wide text-white/70">Following</span>
            <button onClick={reload} className="text-[11.5px] font-medium text-lime hover:brightness-110">Refresh</button>
          </div>
          {loading ? (
            <div className="flex justify-center py-8"><Spinner className="h-5 w-5" /></div>
          ) : jobs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border py-8 text-center text-[12.5px] text-white/55">
              Not copying anyone yet. Resolve a trader above to start.
            </div>
          ) : (
            <div className="space-y-2">{jobs.map((j) => <JobCard key={j.id} job={j} reload={reload} toast={toast} />)}</div>
          )}
        </div>

        <p className="px-1 text-[11px] leading-relaxed text-white/45">
          Every copy runs from one dedicated wallet you fund and fully control. Sell its tokens, withdraw to your
          main wallet, or export it whenever you want. Your main wallet keys never leave this device.
        </p>
      </div>
    </div>
  );
}

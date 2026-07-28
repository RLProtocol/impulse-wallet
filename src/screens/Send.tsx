import { useMemo, useState } from "react";
import { isAddress, type Address } from "viem";
import { useWallet } from "../state";
import { ScreenHeader, Field, Spinner, useAsync, IconExt } from "../components/ui";
import { loadPortfolio, type Row } from "../lib/portfolio";
import { sendNative, sendToken, waitReceipt } from "../lib/wallet";
import { parseUnitsSafe, fmtNum, fmtUsd } from "../lib/format";
import { txUrl } from "../lib/chain";

export default function Send() {
  const { address, go, toast, refresh } = useWallet();
  const { data } = useAsync(() => loadPortfolio(address!), [address]);
  const rows = useMemo(() => (data?.rows || []).filter((r) => r.balanceRaw > 0n), [data]);

  const [selIdx, setSelIdx] = useState(0);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState<string>();

  const sel: Row | undefined = rows[selIdx];
  const toValid = isAddress(to.trim());
  const amtRaw = sel ? parseUnitsSafe(amount, sel.decimals) : 0n;
  const amtValid = sel ? amtRaw > 0n && amtRaw <= sel.balanceRaw : false;

  async function submit() {
    if (!sel || !toValid || !amtValid) return;
    setBusy(true);
    setHash(undefined);
    try {
      let h: `0x${string}`;
      if (sel.kind === "native") {
        h = await sendNative(to.trim() as Address, amount);
      } else {
        h = await sendToken(sel.address!, to.trim() as Address, amtRaw);
      }
      setHash(h);
      toast("info", "Transaction sent");
      await waitReceipt(h);
      toast("ok", `Sent ${amount} ${sel.symbol}`);
      await refresh();
      setAmount("");
    } catch (e: any) {
      toast("err", humanErr(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ScreenHeader title="Send" />
      <div className="space-y-4 p-4">
        {rows.length === 0 ? (
          <div className="card p-4 text-center text-[13px] text-muted">Nothing to send yet.</div>
        ) : (
          <>
            <Field label="Asset">
              <select
                className="input appearance-none"
                value={selIdx}
                onChange={(e) => setSelIdx(Number(e.target.value))}
              >
                {rows.map((r, i) => (
                  <option key={i} value={i}>
                    {r.symbol} - {fmtNum(r.balance)} available
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Recipient address">
              <input
                className="input font-mono text-[12px]"
                placeholder="0x…"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>

            <Field label="Amount">
              <div className="relative">
                <input
                  className="input pr-16"
                  placeholder="0.0"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-lime/15 px-2 py-1 text-[11px] font-semibold text-lime"
                  onClick={() => sel && setAmount(String(sel.balance))}
                >
                  MAX
                </button>
              </div>
              {sel && (
                <div className="mt-1 text-[11px] text-muted">
                  ≈ {fmtUsd(sel.priceUsd != null ? Number(amount || 0) * sel.priceUsd : null)} ·{" "}
                  Balance {fmtNum(sel.balance)} {sel.symbol}
                </div>
              )}
            </Field>

            <button className="btn-primary w-full" disabled={!toValid || !amtValid || busy} onClick={submit}>
              {busy ? <Spinner /> : `Send ${sel?.symbol || ""}`}
            </button>

            {hash && (
              <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-1.5 text-[12px] text-lime hover:underline">
                View on explorer <IconExt className="h-3.5 w-3.5" />
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function humanErr(e: any): string {
  const m = (e?.shortMessage || e?.message || String(e)).toString();
  if (/insufficient funds/i.test(m)) return "Insufficient ETH for gas.";
  if (/user rejected|denied/i.test(m)) return "Transaction rejected.";
  if (/reverted/i.test(m)) return "Transaction reverted.";
  return m.length > 120 ? m.slice(0, 120) + "…" : m;
}

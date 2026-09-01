import { useMemo, useState } from "react";
import { isAddress, type Address } from "viem";
import { useWallet } from "../state";
import { ScreenHeader, Field, Spinner, useAsync, IconExt } from "../components/ui";
import { loadPortfolio, loadSolPortfolio, type Row } from "../lib/portfolio";
import { sendNative, sendToken, waitReceipt } from "../lib/wallet";
import { parseUnitsSafe, fmtNum, fmtUsd } from "../lib/format";
import { CHAINS } from "../lib/chains";
import * as sol from "../lib/solana";
import { getUnlockedSol } from "../lib/keystore";

/** Stable identity for a holding — index is useless while rows load async. */
const keyOf = (r: Row) => `${r.kind}:${r.address?.toLowerCase() || "native"}`;

export default function Send({ kind, address: assetAddr }: { kind?: "native" | "token" | "stock"; address?: string } = {}) {
  const { address, go, toast, refresh, chain, solAddress } = useWallet();
  const svm = CHAINS[chain].vm === "svm";
  const { data } = useAsync(
    () => (svm ? (solAddress ? loadSolPortfolio(solAddress) : Promise.resolve({ rows: [], totalUsd: 0 })) : loadPortfolio(address!, chain)),
    [address, solAddress, chain],
  );
  const rows = useMemo(() => (data?.rows || []).filter((r) => r.balanceRaw > 0n), [data]);

  // Asset the caller opened Send for. Tapping "Send shares" on an AAPL page
  // and landing on ETH is how someone sends the wrong asset.
  const wanted = kind ? `${kind}:${assetAddr?.toLowerCase() || "native"}` : null;
  const [picked, setPicked] = useState<string | null>(null);

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState<string>();

  // Resolved every render rather than seeded once: rows arrive after first
  // paint, and a dropdown change has to win over the incoming asset.
  // Falls back to the first holding when the target has no balance to send.
  const sel: Row | undefined = rows.find((r) => keyOf(r) === (picked ?? wanted)) ?? rows[0];
  const toValid = svm ? sol.isSolAddress(to.trim()) : isAddress(to.trim());
  const amtRaw = sel ? parseUnitsSafe(amount, sel.decimals) : 0n;
  const amtValid = sel ? amtRaw > 0n && amtRaw <= sel.balanceRaw : false;

  async function submit() {
    if (!sel || !toValid || !amtValid) return;
    setBusy(true);
    setHash(undefined);
    try {
      let h: string;
      if (svm) {
        // Solana signs with its own keypair; the EVM wallet client has no part
        // in it and its chainId would be meaningless here.
        const kp = await getUnlockedSol();
        if (!kp) throw new Error("This account has no Solana key. Import a recovery phrase to use Solana.");
        h = await sol.solTransfer(
          kp, to.trim(), amtRaw,
          sel.kind === "native" ? undefined : (sel.address as unknown as string),
          sel.decimals,
        );
        setHash(h);
        toast("info", "Transaction sent");
        await sol.confirmTx(h);
      } else if (sel.kind === "native") {
        h = await sendNative(to.trim() as Address, amount, chain);
        setHash(h);
        toast("info", "Transaction sent");
        await waitReceipt(h as `0x${string}`, chain);
      } else {
        h = await sendToken(sel.address!, to.trim() as Address, amtRaw, chain);
        setHash(h);
        toast("info", "Transaction sent");
        await waitReceipt(h as `0x${string}`, chain);
      }
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
      <ScreenHeader title={`Send on ${CHAINS[chain].name}`} />
      <div className="space-y-4 p-4">
        {rows.length === 0 ? (
          <div className="card p-4 text-center text-[13px] text-muted">
            {svm && !solAddress
              ? "This account has no Solana key. Solana needs a wallet created from a recovery phrase."
              : `Nothing to send on ${CHAINS[chain].name} yet.`}
          </div>
        ) : (
          <>
            <Field label="Asset">
              <select
                className="input appearance-none"
                value={sel ? keyOf(sel) : ""}
                onChange={(e) => setPicked(e.target.value)}
              >
                {rows.map((r) => (
                  <option key={keyOf(r)} value={keyOf(r)}>
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
              <a href={`${CHAINS[chain].explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-1.5 text-[12px] text-lime hover:underline">
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

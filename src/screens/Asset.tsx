import type { Address } from "viem";
import { formatEther } from "viem";
import { useWallet } from "../state";
import { ScreenHeader, useAsync, IconSend, IconReceive, IconExt } from "../components/ui";
import TradePanel from "../components/TradePanel";
import StockPanel from "../components/StockPanel";
import UsdgPanel from "../components/UsdgPanel";
import { nativeBalance } from "../lib/wallet";
import { removeToken } from "../lib/tokens";
import { STOCK_BY_ADDR, USDG } from "../lib/chain";
import { CHAINS } from "../lib/chains";
import * as sol from "../lib/solana";
import { fmtNum, fmtUsd } from "../lib/format";
import { ethToUsd } from "../state";

export default function Asset({ kind, address }: { kind: "native" | "token" | "stock"; address?: string }) {
  const { address: wallet, go, ethUsd, toast, back, refresh, chain, solAddress } = useWallet();

  const cfg = CHAINS[chain];
  const svm = cfg.vm === "svm";
  // The native asset is not always ETH — on Solana it is SOL, and the header,
  // balance card and actions all have to follow the chain rather than assume
  // Robinhood. Getting this wrong showed a SOL holding as "ETH" on Robinhood.
  const nativeSym = cfg.nativeSymbol;
  const title =
    kind === "native" ? nativeSym : kind === "stock" ? STOCK_BY_ADDR[(address || "").toLowerCase()]?.symbol || "Stock" : "Token";

  const nativeBal = useAsync(async () => {
    if (kind !== "native") return 0n;
    if (svm) return solAddress ? sol.solBalance(solAddress) : 0n;
    return nativeBalance(wallet!, chain);
  }, [kind, wallet, chain, solAddress, svm]);

  return (
    <div>
      <ScreenHeader
        title={title}
        right={
          address ? (
            <a href={`${CHAINS[chain].explorer}/address/${address}`} target="_blank" rel="noreferrer" className="rounded-lg p-1.5 text-muted hover:text-lime">
              <IconExt />
            </a>
          ) : undefined
        }
      />
      <div className="space-y-4 p-4">
        {kind === "native" && (
          <>
            <div className="card p-5 text-center">
              <div className="label">{nativeSym} balance</div>
              <div className="font-display mt-1 text-3xl font-bold text-white">
                {/* SOL is 9 decimals, not 18 — formatEther would show a
                    balance a billion times too small. */}
                {fmtNum(svm
                  ? Number(nativeBal.data ?? 0n) / 1e9
                  : Number(formatEther(nativeBal.data ?? 0n)))}
              </div>
              <div className="text-[13px] text-muted">
                {svm ? "" : fmtUsd(ethToUsd(nativeBal.data ?? 0n, ethUsd))}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button className="btn-primary" onClick={() => go({ name: "send", kind: "native" })}><IconSend className="h-4 w-4" /> Send {nativeSym}</button>
                <button className="btn-ghost" onClick={() => go({ name: "receive" })}><IconReceive className="h-4 w-4" /> Receive</button>
              </div>
              {/* USDG and the ETH chart are Robinhood-only surfaces. */}
              {chain === "robinhood" && (
                <>
                  <button className="btn-ghost mt-2 w-full" onClick={() => go({ name: "asset", kind: "token", address: USDG })}>Swap ETH ⇄ USDG</button>
                  <button className="btn-ghost mt-2 w-full" onClick={() => go({ name: "chart", kind: "native", symbol: "ETH" })}>View ETH chart</button>
                </>
              )}
            </div>
            <p className="text-center text-[12px] text-muted">
              {nativeSym} pays gas and settles trades on {cfg.name}.
            </p>
          </>
        )}

        {kind === "token" && address && address.toLowerCase() === USDG.toLowerCase() && (
          <>
            <UsdgPanel />
            <button className="btn-ghost w-full" onClick={() => go({ name: "send", kind: "token", address })}><IconSend className="h-4 w-4" /> Send USDG</button>
          </>
        )}

        {kind === "token" && address && address.toLowerCase() !== USDG.toLowerCase() && (
          <>
            <TradePanel ca={address as Address} />
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-ghost" onClick={() => go({ name: "send", kind: "token", address })}><IconSend className="h-4 w-4" /> Send</button>
              <button
                className="btn-ghost text-danger"
                onClick={async () => {
                  await removeToken(address as Address, chain);
                  toast("info", "Removed from wallet");
                  await refresh();
                  back();
                }}
              >
                Hide token
              </button>
            </div>
          </>
        )}

        {kind === "stock" && address && (
          <>
            <StockPanel address={address as Address} />
            <button className="btn-ghost w-full" onClick={() => go({ name: "send", kind: "stock", address })}><IconSend className="h-4 w-4" /> Send shares</button>
          </>
        )}
      </div>
    </div>
  );
}

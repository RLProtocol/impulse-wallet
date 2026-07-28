import type { Address } from "viem";
import { formatEther } from "viem";
import { useWallet } from "../state";
import { ScreenHeader, useAsync, IconSend, IconReceive, IconExt } from "../components/ui";
import TradePanel from "../components/TradePanel";
import StockPanel from "../components/StockPanel";
import UsdgPanel from "../components/UsdgPanel";
import { nativeBalance } from "../lib/wallet";
import { removeToken } from "../lib/tokens";
import { STOCK_BY_ADDR, addrUrl, USDG } from "../lib/chain";
import { fmtNum, fmtUsd } from "../lib/format";
import { ethToUsd } from "../state";

export default function Asset({ kind, address }: { kind: "native" | "token" | "stock"; address?: string }) {
  const { address: wallet, go, ethUsd, toast, back, refresh } = useWallet();

  const title =
    kind === "native" ? "ETH" : kind === "stock" ? STOCK_BY_ADDR[(address || "").toLowerCase()]?.symbol || "Stock" : "Token";

  const nativeBal = useAsync(async () => (kind === "native" ? nativeBalance(wallet!) : 0n), [kind, wallet]);

  return (
    <div>
      <ScreenHeader
        title={title}
        right={
          address ? (
            <a href={addrUrl(address)} target="_blank" rel="noreferrer" className="rounded-lg p-1.5 text-muted hover:text-lime">
              <IconExt />
            </a>
          ) : undefined
        }
      />
      <div className="space-y-4 p-4">
        {kind === "native" && (
          <>
            <div className="card p-5 text-center">
              <div className="label">ETH balance</div>
              <div className="font-display mt-1 text-3xl font-bold text-white">
                {fmtNum(Number(formatEther(nativeBal.data ?? 0n)))}
              </div>
              <div className="text-[13px] text-muted">{fmtUsd(ethToUsd(nativeBal.data ?? 0n, ethUsd))}</div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button className="btn-primary" onClick={() => go({ name: "send" })}><IconSend className="h-4 w-4" /> Send</button>
                <button className="btn-ghost" onClick={() => go({ name: "receive" })}><IconReceive className="h-4 w-4" /> Receive</button>
              </div>
              <button className="btn-ghost mt-2 w-full" onClick={() => go({ name: "asset", kind: "token", address: USDG })}>Swap ETH ⇄ USDG</button>
              <button className="btn-ghost mt-2 w-full" onClick={() => go({ name: "chart", kind: "native", symbol: "ETH" })}>View ETH chart</button>
            </div>
            <p className="text-center text-[12px] text-muted">
              ETH is the gas + settlement currency on Robinhood Chain.
            </p>
          </>
        )}

        {kind === "token" && address && address.toLowerCase() === USDG.toLowerCase() && (
          <>
            <UsdgPanel />
            <button className="btn-ghost w-full" onClick={() => go({ name: "send" })}><IconSend className="h-4 w-4" /> Send USDG</button>
          </>
        )}

        {kind === "token" && address && address.toLowerCase() !== USDG.toLowerCase() && (
          <>
            <TradePanel ca={address as Address} />
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-ghost" onClick={() => go({ name: "send" })}><IconSend className="h-4 w-4" /> Send</button>
              <button
                className="btn-ghost text-danger"
                onClick={async () => {
                  await removeToken(address as Address);
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
            <button className="btn-ghost w-full" onClick={() => go({ name: "send" })}><IconSend className="h-4 w-4" /> Send shares</button>
          </>
        )}
      </div>
    </div>
  );
}

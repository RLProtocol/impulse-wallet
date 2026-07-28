import type { Address } from "viem";
import { useWallet } from "../state";
import { Spinner, useAsync } from "./ui";
import { TokenLogo } from "./TokenLogo";
import SwapWidget from "./SwapWidget";
import { api } from "../lib/dex";
import { runTxBundle } from "../lib/trade";
import { tokenBalance } from "../lib/wallet";
import { formatUnitsNum, fmtUsd, fmtNum } from "../lib/format";
import { STOCK_BY_ADDR } from "../lib/chain";

export default function StockPanel({ address: stockAddr }: { address: Address }) {
  const { address, toast, refresh, go } = useWallet();
  const meta = STOCK_BY_ADDR[stockAddr.toLowerCase()];

  const priceQ = useAsync(async () => {
    const { stocks } = await api.stocks();
    return stocks.find((s) => s.address.toLowerCase() === stockAddr.toLowerCase())?.priceUsd ?? null;
  }, [stockAddr]);
  const balQ = useAsync(() => tokenBalance(stockAddr, address!), [stockAddr, address]);

  const priceUsd = priceQ.data ?? null;
  const shares = balQ.data != null ? formatUnitsNum(balQ.data, 18) : 0;

  async function doBuy(amountEth: string, slippage: number, onStep: (s: string) => void) {
    onStep("Building order…");
    const bundle = await api.buildStockBuy({ stock: stockAddr, amountEth, address: address!, slippage });
    const h = await runTxBundle(bundle.txs, onStep);
    toast("ok", `Bought ${meta?.symbol || "stock"}`);
    await Promise.all([refresh(), balQ.refetch()]);
    return h;
  }
  async function doSell(pct: number, slippage: number, onStep: (s: string) => void) {
    onStep("Building order…");
    const bundle = await api.buildStockSell({ stock: stockAddr, pct, address: address!, slippage });
    const h = await runTxBundle(bundle.txs, onStep);
    toast("ok", `Sold ${pct}% ${meta?.symbol || "stock"}`);
    await Promise.all([refresh(), balQ.refetch()]);
    return h;
  }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <TokenLogo kind="stock" symbol={meta?.symbol || "?"} address={stockAddr} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-display text-lg font-bold text-white">{meta?.symbol}</span>
              <span className="chip px-1.5 py-0 text-[9px] uppercase">stock</span>
            </div>
            <div className="truncate text-[12px] text-muted">{meta?.name}</div>
          </div>
          <div className="text-right">
            <div className="text-[15px] font-semibold text-white">{priceQ.loading ? <Spinner className="h-4 w-4" /> : fmtUsd(priceUsd)}</div>
            <div className="text-[11px] text-muted">per share</div>
          </div>
        </div>
        {shares > 0 && (
          <div className="mt-3 rounded-lg bg-surface2 px-3 py-2 text-[12px] text-muted">
            Holding <span className="font-semibold text-white">{fmtNum(shares)} shares</span>
            {priceUsd != null && <> · {fmtUsd(shares * priceUsd)}</>}
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button onClick={() => go({ name: "chart", kind: "stock", address: stockAddr, symbol: meta?.symbol })} className="rounded-lg border border-border bg-surface2 py-2 text-[12px] font-semibold text-lime hover:border-lime/40">
            View chart
          </button>
          <button onClick={() => go({ name: "holders", ca: stockAddr, symbol: meta?.symbol })} className="rounded-lg border border-border bg-surface2 py-2 text-[12px] font-semibold text-lime hover:border-lime/40">
            Holders & traders
          </button>
        </div>
      </div>

      <SwapWidget
        token={{ kind: "stock", symbol: meta?.symbol || "STOCK", name: meta?.name || "Stock", address: stockAddr, decimals: 18, priceUsd }}
        balanceRaw={balQ.data ?? 0n}
        onBuy={doBuy}
        onSell={doSell}
      />
    </div>
  );
}

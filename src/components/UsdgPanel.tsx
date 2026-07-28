import { useWallet } from "../state";
import { useAsync } from "./ui";
import { TokenLogo } from "./TokenLogo";
import SwapWidget from "./SwapWidget";
import { api } from "../lib/dex";
import { runTxBundle } from "../lib/trade";
import { tokenBalance } from "../lib/wallet";
import { publicClient, USDG, ERC20_ABI } from "../lib/chain";
import { formatUnitsNum, fmtNum } from "../lib/format";

export default function UsdgPanel() {
  const { address, toast, refresh } = useWallet();

  const decQ = useAsync(async () => {
    try { return Number(await publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: "decimals" })); }
    catch { return 6; }
  }, []);
  const balQ = useAsync(() => tokenBalance(USDG, address!), [address]);
  const decimals = decQ.data ?? 6;
  const bal = balQ.data != null ? formatUnitsNum(balQ.data, decimals) : 0;

  async function doBuy(amountEth: string, slippage: number, onStep: (s: string) => void) {
    onStep("Building swap…");
    const bundle = await api.buildUsdgBuy({ amountEth, address: address!, slippage });
    const h = await runTxBundle(bundle.txs, onStep);
    toast("ok", "Swapped ETH to USDG");
    await Promise.all([refresh(), balQ.refetch()]);
    return h;
  }
  async function doSell(pct: number, slippage: number, onStep: (s: string) => void) {
    onStep("Building swap…");
    const bundle = await api.buildUsdgSell({ pct, address: address!, slippage });
    const h = await runTxBundle(bundle.txs, onStep);
    toast("ok", "Swapped USDG to ETH");
    await Promise.all([refresh(), balQ.refetch()]);
    return h;
  }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <TokenLogo kind="token" symbol="USDG" address={USDG} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-display text-lg font-bold text-white">USDG</span>
              <span className="chip px-1.5 py-0 text-[9px] uppercase">stablecoin</span>
            </div>
            <div className="truncate text-[12px] text-muted">Global Dollar · swap with ETH</div>
          </div>
          <div className="text-right">
            <div className="text-[15px] font-semibold text-white">$1.00</div>
            <div className="text-[11px] text-muted">per USDG</div>
          </div>
        </div>
        {bal > 0 && (
          <div className="mt-3 rounded-lg bg-surface2 px-3 py-2 text-[12px] text-muted">
            Holding <span className="font-semibold text-white">{fmtNum(bal)} USDG</span>
          </div>
        )}
      </div>

      <SwapWidget
        token={{ kind: "token", symbol: "USDG", name: "Global Dollar", address: USDG, decimals, priceUsd: 1 }}
        balanceRaw={balQ.data ?? 0n}
        onBuy={doBuy}
        onSell={doSell}
        defaultSlippage={1}
        slippageOptions={[0.5, 1, 2, 5]}
      />
    </div>
  );
}

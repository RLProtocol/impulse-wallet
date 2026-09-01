import { useWallet } from "../state";
import {
  Wordmark, Spinner, Copyable, useAsync, ChainPicker,
  IconSend, IconReceive, IconPlus, IconGear, IconChevronDown, IconCandle,
} from "../components/ui";
import { TokenLogo } from "../components/TokenLogo";
import { AccountAvatar } from "./Accounts";
import { loadPortfolio, loadSolPortfolio, type Row } from "../lib/portfolio";
import { CHAINS } from "../lib/chains";
import { shortAddr, fmtUsd, fmtNum } from "../lib/format";

export default function Home() {
  const { address, go, lock, accounts, activeId, chain, solAddress, activeAddress } = useWallet();
  const active = accounts.find((a) => a.id === activeId);
  const svm = CHAINS[chain].vm === "svm";
  // Keyed on chain as well as address: switching network must re-read, not
  // leave the previous chain's holdings on screen. Solana has its own loader —
  // base58 address, token accounts instead of per-token balanceOf, no stocks.
  const { data, loading, refetch } = useAsync(
    () => (svm ? (solAddress ? loadSolPortfolio(solAddress) : Promise.resolve({ rows: [], totalUsd: 0 })) : loadPortfolio(address!, chain)),
    [address, solAddress, chain],
  );

  return (
    <div>
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-4">
        <Wordmark />
        <button onClick={() => go({ name: "settings" })} className="rounded-lg p-1.5 text-muted hover:bg-surface2 hover:text-white">
          <IconGear />
        </button>
      </div>

      {/* Network */}
      <div className="px-4 pt-3">
        <ChainPicker />
      </div>

      {/* Balance card */}
      <div className="px-4 pt-4">
        <div className="card bg-gradient-to-b from-surface to-surface2 p-5">
          <button onClick={() => go({ name: "accounts" })} className="mb-3 flex w-full items-center gap-2 rounded-xl bg-surface2/70 px-2.5 py-1.5 text-left transition hover:bg-surface2">
            {active && <AccountAvatar address={active.address} size={22} />}
            <span className="truncate text-[12px] font-semibold text-white">{active?.label || "Account"}</span>
            <IconChevronDown className="ml-auto h-4 w-4 text-muted" />
          </button>
          <div className="text-[11px] uppercase tracking-wider text-muted">Total balance</div>
          <div className="mt-1 flex items-end gap-2">
            <div className="font-display text-3xl font-bold text-white">
              {loading && !data ? <Spinner className="h-6 w-6 text-lime" /> : fmtUsd(data?.totalUsd)}
            </div>
          </div>
          <div className="mt-2">
            <Copyable text={activeAddress || ""}>
              <span className="font-mono text-[12px]">{shortAddr(activeAddress, 6)}</span>
            </Copyable>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <Action label="Send" onClick={() => go({ name: "send" })}><IconSend /></Action>
            <Action label="Receive" onClick={() => go({ name: "receive" })}><IconReceive /></Action>
            <Action label="Buy" onClick={() => go({ name: "trade" })}><IconPlus /></Action>
          </div>
        </div>
      </div>

      {/* Assets */}
      <div className="mt-5 px-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="label">Assets</div>
          <button className="text-[12px] text-lime hover:underline" onClick={() => go({ name: "addToken" })}>
            + Add token
          </button>
        </div>
        <div className="space-y-1.5">
          {data?.rows.map((r) => (
            <AssetRow
              key={r.kind + (r.address || "native")}
              row={r}
              chain={CHAINS[chain].dexscreener}
              onClick={() => go({ name: "asset", kind: r.kind, address: r.address })}
              onChart={() => go({ name: "chart", kind: r.kind, address: r.address, symbol: r.symbol })}
            />
          ))}
          {!loading && data && data.rows.filter((r) => r.balance > 0).length === 0 && (
            <div className="card p-4 text-center text-[13px] text-muted">
              No balance yet. Tap <span className="text-lime">Receive</span> to fund your wallet with ETH on Robinhood Chain.
            </div>
          )}
        </div>
        <button className="mt-3 w-full text-center text-[12px] text-muted hover:text-white" onClick={refetch}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <button className="mx-auto mt-3 block text-[12px] text-muted hover:text-danger" onClick={lock}>
          Lock wallet
        </button>
      </div>
    </div>
  );
}

function Action({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1.5 rounded-xl bg-lime/10 py-3 text-lime transition hover:bg-lime/20">
      {children}
      <span className="text-[11px] font-semibold">{label}</span>
    </button>
  );
}

function AssetRow({ row, chain, onClick, onChart }: { row: Row; chain: string; onClick: () => void; onChart: () => void }) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
      className="card flex w-full cursor-pointer items-center gap-3 p-3 text-left transition hover:border-lime/40"
    >
      <TokenLogo kind={row.kind} symbol={row.symbol} address={row.address} chain={chain} size={38} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-semibold text-white">{row.symbol}</span>
          {row.kind === "stock" && <span className="chip px-1.5 py-0 text-[9px]">stock</span>}
        </div>
        <div className="truncate text-[11px] text-muted">{row.name}</div>
      </div>
      <div className="text-right">
        <div className="text-[13px] font-semibold text-white">{fmtNum(row.balance)}</div>
        <div className="text-[11px] text-muted">{fmtUsd(row.valueUsd)}</div>
      </div>
      <button
        title={`${row.symbol} chart`}
        onClick={(e) => { e.stopPropagation(); onChart(); }}
        className="shrink-0 rounded-lg border border-border bg-surface2 p-2 text-muted transition hover:border-lime/40 hover:text-lime"
      >
        <IconCandle className="h-4 w-4" />
      </button>
    </div>
  );
}

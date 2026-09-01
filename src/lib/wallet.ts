import {
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicClient, ERC20_ABI } from "./chain";
import { CHAINS, cfgFor, clientFor, viemChainFor, type ChainKey } from "./chains";
import { getUnlockedPk } from "./keystore";

async function requireAccount() {
  const pk = await getUnlockedPk();
  if (!pk) throw new Error("Wallet is locked.");
  return privateKeyToAccount(pk as Hex);
}

/**
 * Wallet client for one chain.
 *
 * Chain-bound on purpose: viem stamps chainId into the signed transaction, so
 * a bundle built for Base and signed with the Robinhood client would be
 * rejected at best and replayable at worst. Callers that hold a TxBundle must
 * pass the chain it was built for.
 */
export async function walletClient(chain: ChainKey = "robinhood") {
  const account = await requireAccount();
  const cfg = CHAINS[chain];
  return createWalletClient({ account, chain: viemChainFor(chain), transport: http(cfg.rpc) });
}

// ── Reads ────────────────────────────────────────────────────────────────
export async function nativeBalance(address: Address, chain: ChainKey = "robinhood"): Promise<bigint> {
  return clientFor(chain).getBalance({ address });
}

export async function tokenBalance(token: Address, address: Address, chain: ChainKey = "robinhood"): Promise<bigint> {
  return clientFor(chain).readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  }) as Promise<bigint>;
}

export async function tokenMeta(token: Address, chain: ChainKey = "robinhood"): Promise<{ symbol: string; name: string; decimals: number }> {
  const c = clientFor(chain);
  const [symbol, name, decimals] = await Promise.all([
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "TOKEN"),
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "name" }).catch(() => "Token"),
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
  ]);
  return { symbol: String(symbol), name: String(name), decimals: Number(decimals) };
}

// ── Writes ───────────────────────────────────────────────────────────────
export async function sendNative(to: Address, amountEth: string, chain: ChainKey = "robinhood"): Promise<Hex> {
  const wc = await walletClient(chain);
  return wc.sendTransaction({ to, value: parseEther(amountEth) });
}

export async function sendToken(token: Address, to: Address, amountRaw: bigint, chain: ChainKey = "robinhood"): Promise<Hex> {
  const wc = await walletClient(chain);
  return wc.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amountRaw],
  });
}

// Generic: sign + broadcast an unsigned tx built by the backend trade engine.
export type UnsignedTx = {
  to: Address;
  data?: Hex;
  value?: string; // decimal wei string
  /** Fallback gas limit, used only when estimation reverts. Decimal string. */
  gas?: string;
  /** Clamp applied to the estimate. Defaults to the V2/V3 band. */
  gasMin?: string;
  gasMax?: string;
  /**
   * Recompute this transaction immediately before it is sent.
   *
   * Some quotes cannot be taken at build time because they depend on a state
   * change an earlier transaction in the bundle makes. Selling a bonding-curve
   * token is the case that forced this: the curve prices a sell by simulating
   * its own sell(), which pulls the tokens via transferFrom and therefore
   * reverts until the approval has confirmed. Quoting before the approval
   * lands yields no price, and a swap with no price floor accepts any output.
   * So the sell is rebuilt after its approval, with a real quote behind it.
   */
  rebuild?: () => Promise<UnsignedTx>;
};

/**
 * Gas limit for one swap, mirroring robinhoodcode.py.
 *
 * The bot estimates per-transaction and applies a 1.5x buffer because tax
 * tokens do real work inside transfer() and V4 hooks run arbitrary code — a
 * fixed limit either runs out on those or, when set high enough to survive
 * them, blocks buys that should fit. Reserving 900k against the balance makes
 * "buy with most of my ETH" fail the funds check while the swap itself needs
 * a fraction of that.
 *
 * Estimation is safe here: runTxBundle waits for each approval receipt before
 * building the next send, so allowance is already on-chain by the swap.
 *
 * A failed estimate is not fatal — same as the bot, fall back to the fixed
 * limit rather than blocking a trade on a flaky eth_call.
 */
async function gasFor(tx: UnsignedTx, account: Address, chain: ChainKey): Promise<bigint | undefined> {
  // Only swaps carry a fallback. Approvals don't, and are left to viem's own
  // estimation exactly as before — a bare approve must not pick up a swap-sized
  // floor, which would over-reserve against the balance for no reason.
  if (!tx.gas) return undefined;
  const fallback = BigInt(tx.gas);
  const lo = BigInt(tx.gasMin ?? "200000");
  const hi = BigInt(tx.gasMax ?? "1000000");
  try {
    const est = await clientFor(chain).estimateGas({
      account,
      to: tx.to,
      data: tx.data,
      value: tx.value ? BigInt(tx.value) : undefined,
    });
    const buffered = (est * 3n) / 2n;
    return buffered < lo ? lo : buffered > hi ? hi : buffered;
  } catch {
    return fallback;
  }
}

export async function signAndSend(tx: UnsignedTx, chain: ChainKey = "robinhood"): Promise<Hex> {
  const wc = await walletClient(chain);
  const account = wc.account!;
  return wc.sendTransaction({
    account,
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : undefined,
    gas: await gasFor(tx, account.address, chain),
  });
}

export async function waitReceipt(hash: Hex, chain: ChainKey = "robinhood") {
  return clientFor(chain).waitForTransactionReceipt({ hash, timeout: 90_000 });
}

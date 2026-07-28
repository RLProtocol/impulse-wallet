import {
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicClient, robinhoodChain, RH_RPC, ERC20_ABI } from "./chain";
import { getUnlockedPk } from "./keystore";

async function requireAccount() {
  const pk = await getUnlockedPk();
  if (!pk) throw new Error("Wallet is locked.");
  return privateKeyToAccount(pk as Hex);
}

export async function walletClient() {
  const account = await requireAccount();
  return createWalletClient({ account, chain: robinhoodChain, transport: http(RH_RPC) });
}

// ── Reads ────────────────────────────────────────────────────────────────
export async function nativeBalance(address: Address): Promise<bigint> {
  return publicClient.getBalance({ address });
}

export async function tokenBalance(token: Address, address: Address): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  }) as Promise<bigint>;
}

export async function tokenMeta(token: Address): Promise<{ symbol: string; name: string; decimals: number }> {
  const [symbol, name, decimals] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "TOKEN"),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "name" }).catch(() => "Token"),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
  ]);
  return { symbol: String(symbol), name: String(name), decimals: Number(decimals) };
}

// ── Writes ───────────────────────────────────────────────────────────────
export async function sendNative(to: Address, amountEth: string): Promise<Hex> {
  const wc = await walletClient();
  return wc.sendTransaction({ to, value: parseEther(amountEth) });
}

export async function sendToken(token: Address, to: Address, amountRaw: bigint): Promise<Hex> {
  const wc = await walletClient();
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
  gas?: string; // decimal gas string
};

export async function signAndSend(tx: UnsignedTx): Promise<Hex> {
  const wc = await walletClient();
  const account = wc.account!;
  return wc.sendTransaction({
    account,
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : undefined,
    gas: tx.gas ? BigInt(tx.gas) : undefined,
  });
}

export async function waitReceipt(hash: Hex) {
  return publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
}

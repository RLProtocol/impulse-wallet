import type { Hex } from "viem";
import { signAndSend, waitReceipt, type UnsignedTx } from "./wallet";
import { DEFAULT_CHAIN, type ChainKey } from "./chains";

export type StepCb = (msg: string) => void;

// Execute a bundle of unsigned txs (e.g. [approve, swap]) in order, waiting for
// each to confirm before sending the next. Returns the final tx hash.
export async function runTxBundle(txs: UnsignedTx[], onStep?: StepCb, chain: ChainKey = DEFAULT_CHAIN): Promise<Hex> {
  if (!txs.length) throw new Error("Nothing to execute.");
  let last: Hex | undefined;
  for (let i = 0; i < txs.length; i++) {
    const isSwap = i === txs.length - 1;
    onStep?.(txs.length > 1 && !isSwap ? `Approving… (${i + 1}/${txs.length})` : "Confirming trade…");
    // A tx may need re-pricing now that the previous one has landed — see
    // UnsignedTx.rebuild.
    const tx = txs[i].rebuild ? await txs[i].rebuild!() : txs[i];
    const h = await signAndSend(tx, chain);
    last = h;
    await waitReceipt(h, chain);
  }
  return last!;
}

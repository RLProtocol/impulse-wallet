import type { Hex } from "viem";
import { signAndSend, waitReceipt, type UnsignedTx } from "./wallet";

export type StepCb = (msg: string) => void;

// Execute a bundle of unsigned txs (e.g. [approve, swap]) in order, waiting for
// each to confirm before sending the next. Returns the final tx hash.
export async function runTxBundle(txs: UnsignedTx[], onStep?: StepCb): Promise<Hex> {
  if (!txs.length) throw new Error("Nothing to execute.");
  let last: Hex | undefined;
  for (let i = 0; i < txs.length; i++) {
    const isSwap = i === txs.length - 1;
    onStep?.(txs.length > 1 && !isSwap ? `Approving… (${i + 1}/${txs.length})` : "Confirming trade…");
    const h = await signAndSend(txs[i]);
    last = h;
    await waitReceipt(h);
  }
  return last!;
}

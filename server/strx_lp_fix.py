"""
Fix + seed the STRX/ETH liquidity pool on Robinhood Chain.

The pair was accidentally initialized with dust at a broken price. This script
overwhelms that dust by minting real liquidity directly on the pair (bypassing
the router's ratio check), setting the price to your target.

It does, from the OWNER wallet (0xF7Ac92...):
  1. setFee(0,0,0,0)      -> turn off the transfer tax
  2. toggleSwap(false)    -> turn off auto swap-back
  3. WETH.deposit(3 ETH)  -> wrap your 3 ETH
  4. transfer 1,447,500 STRX  -> to the pair
  5. transfer 3 WETH          -> to the pair
  6. pair.mint(owner)     -> mint LP; reserves become ~3 ETH + 1,447,500 STRX

HOW TO RUN (key never leaves your machine, never pasted in chat):
  Windows PowerShell:
     $env:OWNER_PRIVATE_KEY="0xYOUR_F7Ac92_PRIVATE_KEY"
     python strx_lp_fix.py
  It prints each step + the final price/FDV. Afterwards, restore your tax:
     setFee(2,2,0,0) and toggleSwap(true) on the STRX contract (or re-run with
     your values) — the script leaves fee at 0 so YOU choose the final tax.

Requires: pip install web3
"""
import os
from web3 import Web3
from eth_account import Account

RPC   = "https://rpc.mainnet.chain.robinhood.com"
CHAIN = 4663
STRX  = Web3.to_checksum_address("0x64B020e4B40A576cE731Ee8fDF95D104e237DB3f")   # 9 decimals
WETH  = Web3.to_checksum_address("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73")   # 18 decimals
PAIR  = Web3.to_checksum_address("0x6cc96F36F56D163840467F2c69c984740d4A0DEc")

STRX_HUMAN = 1_447_500                 # STRX to add
ETH_WEI    = 3 * 10**18                # 3 ETH to add
STRX_RAW   = STRX_HUMAN * 10**9        # 9 decimals

STRX_ABI = [
    {"name":"setFee","type":"function","stateMutability":"nonpayable","inputs":[{"type":"uint256"},{"type":"uint256"},{"type":"uint256"},{"type":"uint256"}],"outputs":[]},
    {"name":"toggleSwap","type":"function","stateMutability":"nonpayable","inputs":[{"type":"bool"}],"outputs":[]},
    {"name":"transfer","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address"},{"type":"uint256"}],"outputs":[{"type":"bool"}]},
    {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
]
WETH_ABI = [
    {"name":"deposit","type":"function","stateMutability":"payable","inputs":[],"outputs":[]},
    {"name":"transfer","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address"},{"type":"uint256"}],"outputs":[{"type":"bool"}]},
    {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
]
PAIR_ABI = [
    {"name":"mint","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
    {"name":"getReserves","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"uint112"},{"type":"uint112"},{"type":"uint32"}]},
    {"name":"token0","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
    {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
]

def main():
    key = os.environ.get("OWNER_PRIVATE_KEY", "").strip()
    if not key:
        print("Set OWNER_PRIVATE_KEY env to the 0xF7Ac92 wallet key and re-run.")
        return
    if not key.startswith("0x"):
        key = "0x" + key
    w3  = Web3(Web3.HTTPProvider(RPC))
    acc = Account.from_key(key)
    me  = acc.address
    print("owner:", me)
    if me.lower() != "0xf7ac92dd29600b4468163ed3be03a1a8153a63ec":
        print("WARNING: this key is not the token owner 0xF7Ac92. setFee/toggleSwap will fail.")

    strx = w3.eth.contract(address=STRX, abi=STRX_ABI)
    weth = w3.eth.contract(address=WETH, abi=WETH_ABI)
    pair = w3.eth.contract(address=PAIR, abi=PAIR_ABI)

    eth_bal  = w3.eth.get_balance(me)
    strx_bal = strx.functions.balanceOf(me).call()
    print(f"balances: {eth_bal/1e18:.4f} ETH, {strx_bal/1e9:,.2f} STRX")
    if eth_bal < ETH_WEI + 10**16:
        print("Not enough ETH (need 3 + gas)."); return
    if strx_bal < STRX_RAW:
        print("Not enough STRX."); return

    def send(fn, value=0, gas=400_000, label=""):
        tx = fn.build_transaction({
            "from": me, "value": value, "gas": gas,
            "nonce": w3.eth.get_transaction_count(me, "pending"),
            "chainId": CHAIN, "gasPrice": w3.eth.gas_price,
        })
        signed = w3.eth.account.sign_transaction(tx, key)
        h = w3.eth.send_raw_transaction(signed.raw_transaction)
        rc = w3.eth.wait_for_transaction_receipt(h, timeout=120)
        ok = rc["status"] == 1
        print(f"  [{'OK' if ok else 'FAIL'}] {label}  {h.hex()}")
        if not ok:
            raise SystemExit(f"step failed: {label}")
        return rc

    print("\n1) setFee(0,0,0,0)")
    send(strx.functions.setFee(0, 0, 0, 0), label="setFee 0")
    print("2) toggleSwap(false)")
    send(strx.functions.toggleSwap(False), label="toggleSwap off")

    print(f"3) wrap {ETH_WEI/1e18} ETH -> WETH")
    send(weth.functions.deposit(), value=ETH_WEI, gas=120_000, label="WETH deposit")

    print(f"4) transfer {STRX_HUMAN:,} STRX -> pair")
    before = strx.functions.balanceOf(PAIR).call()
    send(strx.functions.transfer(PAIR, STRX_RAW), gas=200_000, label="STRX -> pair")
    got = strx.functions.balanceOf(PAIR).call() - before
    print(f"   pair received {got/1e9:,.2f} STRX (want {STRX_HUMAN:,})")
    if got < STRX_RAW * 0.99:
        print("   ! STRX was taxed on the way in — setFee(0) did not fully apply. Aborting before mint.")
        return

    print(f"5) transfer {ETH_WEI/1e18} WETH -> pair")
    send(weth.functions.transfer(PAIR, ETH_WEI), gas=120_000, label="WETH -> pair")

    print("6) pair.mint(owner)")
    send(pair.functions.mint(me), gas=400_000, label="mint")

    r0, r1, _ = pair.functions.getReserves().call()
    t0 = pair.functions.token0().call()
    strx_is0 = t0.lower() == STRX.lower()
    strx_res = (r0 if strx_is0 else r1) / 1e9
    eth_res  = (r1 if strx_is0 else r0) / 1e18
    price_eth = eth_res / strx_res if strx_res else 0
    print(f"\nFINAL POOL: {strx_res:,.0f} STRX + {eth_res:.4f} ETH")
    print(f"price: {price_eth:.10f} ETH/STRX")
    print(f"(at ~$1930/ETH -> ${price_eth*1930:.6f}/STRX, FDV(10M) ~= ${price_eth*1930*10_000_000:,.0f})")
    print("\nDONE. Now restore your tax on the STRX contract from the owner wallet:")
    print("   setFee(2,2,0,0)  and  toggleSwap(true)   (use YOUR intended values)")

if __name__ == "__main__":
    main()

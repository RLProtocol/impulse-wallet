"""
Remove ALL of the owner's liquidity from a pair (get your ETH + tokens back).

Approves the LP token to the router and calls
removeLiquidityETHSupportingFeeOnTransferTokens for the owner's full LP balance.

RUN (PowerShell):
   $env:OWNER_PRIVATE_KEY="0xYOUR_KEY"
   $env:INFO_FILE="test_new.json"
   python remove_lp.py
"""
import os, json
import _env  # loads .env into os.environ
from web3 import Web3
from eth_account import Account

RPC    = "https://rpc.mainnet.chain.robinhood.com"
CHAIN  = 4663
ROUTER = Web3.to_checksum_address("0x89e5DB8B5aA49aA85AC63f691524311AEB649eba")
INFO   = os.environ.get("INFO_FILE", "test_new.json")

ROUTER_ABI = [{"name":"removeLiquidityETHSupportingFeeOnTransferTokens","type":"function","stateMutability":"nonpayable",
    "inputs":[{"type":"address"},{"type":"uint256"},{"type":"uint256"},{"type":"uint256"},{"type":"address"},{"type":"uint256"}],
    "outputs":[{"type":"uint256"}]}]
PAIR_ABI = [
 {"name":"approve","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address"},{"type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"name":"allowance","type":"function","stateMutability":"view","inputs":[{"type":"address"},{"type":"address"}],"outputs":[{"type":"uint256"}]},
 {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
]
ERC20_ABI = [{"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]}]

def main():
    key = os.environ.get("OWNER_PRIVATE_KEY","").strip()
    if not key: print("Set OWNER_PRIVATE_KEY and re-run."); return
    if not key.startswith("0x"): key = "0x"+key
    info = json.load(open(INFO))
    token = Web3.to_checksum_address(info["token"]); pair = Web3.to_checksum_address(info["pair"])
    w3 = Web3(Web3.HTTPProvider(RPC)); acc = Account.from_key(key); me = acc.address
    router = w3.eth.contract(address=ROUTER, abi=ROUTER_ABI)
    p = w3.eth.contract(address=pair, abi=PAIR_ABI)
    tok = w3.eth.contract(address=token, abi=ERC20_ABI)

    liq = p.functions.balanceOf(me).call()
    print("owner LP balance:", liq)
    if liq == 0: print("nothing to remove."); return
    eth0 = w3.eth.get_balance(me); t0 = tok.functions.balanceOf(me).call()

    def send(fn, gas=500_000, label=""):
        tx = fn.build_transaction({"from":me,"gas":gas,
            "nonce":w3.eth.get_transaction_count(me,"pending"),
            "chainId":CHAIN,"gasPrice":w3.eth.gas_price})
        s = w3.eth.account.sign_transaction(tx,key)
        h = w3.eth.send_raw_transaction(s.raw_transaction)
        rc = w3.eth.wait_for_transaction_receipt(h, timeout=180)
        print(f"  [{'OK' if rc['status']==1 else 'FAIL'}] {label} {h.hex()}")
        if rc["status"]!=1: raise SystemExit("failed: "+label)

    if p.functions.allowance(me, ROUTER).call() < liq:
        print("approve LP token -> router")
        send(p.functions.approve(ROUTER, (1<<256)-1), gas=120_000, label="approve LP")

    print("removeLiquidityETHSupportingFeeOnTransferTokens (all)")
    send(router.functions.removeLiquidityETHSupportingFeeOnTransferTokens(token, liq, 0, 0, me, 9999999999), label="removeLiquidity")

    eth1 = w3.eth.get_balance(me); t1 = tok.functions.balanceOf(me).call()
    print(f"\nrecovered ~{(eth1-eth0)/1e18:.6f} ETH (net of gas) and {(t1-t0)/1e9:,.4f} tokens")
    print("LP left:", p.functions.balanceOf(me).call(), "(the ~1000 wei MINIMUM_LIQUIDITY stays locked forever - normal)")

if __name__ == "__main__":
    main()

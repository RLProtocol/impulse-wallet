"""
STEP 3 (TEST) - Prove the new token actually trades: does a small BUY then a
full SELL through the V2 router (fee-on-transfer variants) and prints what
came back, so you can confirm buy/sell + the tax both work on-chain.

Uses INFO_FILE (default test_new.json) and BUY_ETH (default 0.002).

RUN (PowerShell):
   $env:OWNER_PRIVATE_KEY="0xYOUR_KEY"
   $env:INFO_FILE="test_new.json"; $env:BUY_ETH="0.002"
   python test_trade.py
"""
import os, json
from web3 import Web3
from eth_account import Account

RPC    = "https://rpc.mainnet.chain.robinhood.com"
CHAIN  = 4663
ROUTER = Web3.to_checksum_address("0x89e5DB8B5aA49aA85AC63f691524311AEB649eba")
WETH   = Web3.to_checksum_address("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73")
INFO   = os.environ.get("INFO_FILE", "test_new.json")
BUY_ETH= int(float(os.environ.get("BUY_ETH", "0.002")) * 10**18)

ROUTER_ABI = [
 {"name":"swapExactETHForTokensSupportingFeeOnTransferTokens","type":"function","stateMutability":"payable","inputs":[{"type":"uint256"},{"type":"address[]"},{"type":"address"},{"type":"uint256"}],"outputs":[]},
 {"name":"swapExactTokensForETHSupportingFeeOnTransferTokens","type":"function","stateMutability":"nonpayable","inputs":[{"type":"uint256"},{"type":"uint256"},{"type":"address[]"},{"type":"address"},{"type":"uint256"}],"outputs":[]},
]
ERC20_ABI = [
 {"name":"approve","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address"},{"type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"name":"allowance","type":"function","stateMutability":"view","inputs":[{"type":"address"},{"type":"address"}],"outputs":[{"type":"uint256"}]},
 {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
]

def main():
    key = os.environ.get("OWNER_PRIVATE_KEY","").strip()
    if not key: print("Set OWNER_PRIVATE_KEY and re-run."); return
    if not key.startswith("0x"): key = "0x"+key
    token = Web3.to_checksum_address(json.load(open(INFO))["token"])
    w3 = Web3(Web3.HTTPProvider(RPC)); acc = Account.from_key(key); me = acc.address
    router = w3.eth.contract(address=ROUTER, abi=ROUTER_ABI)
    erc = w3.eth.contract(address=token, abi=ERC20_ABI)

    def send(fn, value=0, gas=400_000, label=""):
        tx = fn.build_transaction({"from":me,"value":value,"gas":gas,
            "nonce":w3.eth.get_transaction_count(me,"pending"),
            "chainId":CHAIN,"gasPrice":w3.eth.gas_price})
        s = w3.eth.account.sign_transaction(tx,key)
        h = w3.eth.send_raw_transaction(s.raw_transaction)
        rc = w3.eth.wait_for_transaction_receipt(h, timeout=180)
        print(f"  [{'OK' if rc['status']==1 else 'FAIL'}] {label} {h.hex()}")
        if rc["status"]!=1: raise SystemExit("failed: "+label)

    # NOTE: owner is fee-excluded, so to actually see the tax you'd trade from a
    # non-owner wallet. This still proves the pool swaps in both directions.
    print("BUY test with", BUY_ETH/1e18, "ETH")
    b0 = erc.functions.balanceOf(me).call()
    send(router.functions.swapExactETHForTokensSupportingFeeOnTransferTokens(
        0, [WETH, token], me, 9999999999), value=BUY_ETH, label="buy")
    got = erc.functions.balanceOf(me).call() - b0
    print(f"  received {got/1e9:,.4f} TEST")

    print("SELL all of it back")
    if erc.functions.allowance(me, ROUTER).call() < got:
        send(erc.functions.approve(ROUTER, (1<<256)-1), gas=120_000, label="approve")
    e0 = w3.eth.get_balance(me)
    send(router.functions.swapExactTokensForETHSupportingFeeOnTransferTokens(
        got, 0, [token, WETH], me, 9999999999), label="sell")
    e1 = w3.eth.get_balance(me)
    print(f"  ETH back (net of gas): ~{(e1-e0)/1e18:.6f}")
    print("\nBoth directions swapped -> the pool trades. Test complete.")

if __name__ == "__main__":
    main()

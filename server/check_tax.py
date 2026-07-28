"""
Verify the buy/sell tax on the test token by trading from a NON-OWNER wallet
and measuring what actually arrives vs the tax-free pool quote.

You need a second wallet (NOT the owner 0xF7Ac92) with a little ETH on
Robinhood Chain - e.g. make a fresh account in HoodX and send it ~0.02 ETH.

RUN (PowerShell):
   $env:INFO_FILE="test_new.json"
   $env:BUYER_KEY="0xSECOND_WALLET_KEY"      # NOT the owner wallet
   $env:BUY_ETH="0.003"
   python check_tax.py
"""
import os, json
import _env  # loads .env into os.environ
from web3 import Web3
from eth_account import Account

RPC    = "https://rpc.mainnet.chain.robinhood.com"
CHAIN  = 4663
ROUTER = Web3.to_checksum_address("0x89e5DB8B5aA49aA85AC63f691524311AEB649eba")
WETH   = Web3.to_checksum_address("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73")
INFO   = os.environ.get("INFO_FILE", "test_new.json")
BUY_ETH= int(float(os.environ.get("BUY_ETH", "0.003")) * 10**18)

ROUTER_ABI = [
 {"name":"getAmountsOut","type":"function","stateMutability":"view","inputs":[{"type":"uint256"},{"type":"address[]"}],"outputs":[{"type":"uint256[]"}]},
 {"name":"swapExactETHForTokensSupportingFeeOnTransferTokens","type":"function","stateMutability":"payable","inputs":[{"type":"uint256"},{"type":"address[]"},{"type":"address"},{"type":"uint256"}],"outputs":[]},
 {"name":"swapExactTokensForETHSupportingFeeOnTransferTokens","type":"function","stateMutability":"nonpayable","inputs":[{"type":"uint256"},{"type":"uint256"},{"type":"address[]"},{"type":"address"},{"type":"uint256"}],"outputs":[]},
]
ERC20_ABI = [
 {"name":"approve","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address"},{"type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"name":"allowance","type":"function","stateMutability":"view","inputs":[{"type":"address"},{"type":"address"}],"outputs":[{"type":"uint256"}]},
 {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
]

def main():
    key = os.environ.get("BUYER_KEY","").strip()
    if not key: print("Set BUYER_KEY to a NON-owner wallet (with a little ETH)."); return
    if not key.startswith("0x"): key = "0x"+key
    token = Web3.to_checksum_address(json.load(open(INFO))["token"])
    w3 = Web3(Web3.HTTPProvider(RPC)); acc = Account.from_key(key); me = acc.address
    if me.lower() == "0xf7ac92dd29600b4468163ed3be03a1a8153a63ec":
        print("That's the OWNER wallet - it's fee-excluded, taxes won't show. Use a different wallet."); return
    router = w3.eth.contract(address=ROUTER, abi=ROUTER_ABI)
    erc = w3.eth.contract(address=token, abi=ERC20_ABI)
    print("buyer:", me, "| ETH:", w3.eth.get_balance(me)/1e18)

    def send(fn, value=0, gas=400_000, label=""):
        tx = fn.build_transaction({"from":me,"value":value,"gas":gas,
            "nonce":w3.eth.get_transaction_count(me,"pending"),
            "chainId":CHAIN,"gasPrice":w3.eth.gas_price})
        s = w3.eth.account.sign_transaction(tx,key)
        h = w3.eth.send_raw_transaction(s.raw_transaction)
        rc = w3.eth.wait_for_transaction_receipt(h, timeout=180)
        print(f"  [{'OK' if rc['status']==1 else 'FAIL'}] {label} {h.hex()}")
        if rc["status"]!=1: raise SystemExit("failed: "+label)

    # BUY: expected (tax-free AMM out) vs actual received
    exp_buy = router.functions.getAmountsOut(BUY_ETH, [WETH, token]).call()[-1]
    b0 = erc.functions.balanceOf(me).call()
    print(f"\nBUY {BUY_ETH/1e18} ETH -> pool quote {exp_buy/1e9:,.4f} TEST (tax-free)")
    send(router.functions.swapExactETHForTokensSupportingFeeOnTransferTokens(0,[WETH,token],me,9999999999), value=BUY_ETH, label="buy")
    got = erc.functions.balanceOf(me).call() - b0
    buy_tax = (1 - got/exp_buy)*100 if exp_buy else 0
    print(f"  actually received {got/1e9:,.4f} TEST  =>  BUY TAX ~= {buy_tax:.2f}%")

    # SELL all: expected ETH vs actual ETH
    if erc.functions.allowance(me, ROUTER).call() < got:
        send(erc.functions.approve(ROUTER,(1<<256)-1), gas=120_000, label="approve")
    exp_sell = router.functions.getAmountsOut(got, [token, WETH]).call()[-1]
    e0 = w3.eth.get_balance(me)
    print(f"\nSELL {got/1e9:,.4f} TEST -> pool quote {exp_sell/1e18:.6f} ETH (tax-free)")
    send(router.functions.swapExactTokensForETHSupportingFeeOnTransferTokens(got,0,[token,WETH],me,9999999999), label="sell")
    e1 = w3.eth.get_balance(me)
    net = e1 - e0
    # net includes gas; sell tax reduces token amount reaching the pool. Show measured.
    print(f"  ETH back (net of gas): ~{net/1e18:.6f}  (quote was {exp_sell/1e18:.6f})")
    print("\nIf BUY TAX shows ~2%, the tax is working. (Sell tax similarly cuts the ETH out;")
    print("gas makes the net imprecise, but the buy-tax number is the clean signal.)")

if __name__ == "__main__":
    main()

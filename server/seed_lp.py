"""
STEP 2 - Seed the LP for the NEW STRX at $40k FDV (3 ETH + 1,447,500 STRX).

Fresh pair + owner is fee-excluded, so the standard router addLiquidityETH
works first try (no dust, no tax, no toggling).

RUN (PowerShell):
   $env:OWNER_PRIVATE_KEY="0xYOUR_PRIVATE_KEY"
   python seed_lp.py
"""
import os, json
import _env  # loads .env into os.environ
from web3 import Web3
from eth_account import Account

RPC    = "https://rpc.mainnet.chain.robinhood.com"
CHAIN  = 4663
ROUTER = Web3.to_checksum_address("0x89e5DB8B5aA49aA85AC63f691524311AEB649eba")

INFO_FILE  = os.environ.get("INFO_FILE", "strx_new.json")
STRX_HUMAN = int(os.environ.get("LP_STRX", "1447500"))
ETH_WEI    = int(float(os.environ.get("LP_ETH", "3")) * 10**18)
STRX_RAW   = STRX_HUMAN * 10**9          # 9 decimals

ROUTER_ABI = [{"name":"addLiquidityETH","type":"function","stateMutability":"payable",
    "inputs":[{"type":"address"},{"type":"uint256"},{"type":"uint256"},{"type":"uint256"},{"type":"address"},{"type":"uint256"}],
    "outputs":[{"type":"uint256"},{"type":"uint256"},{"type":"uint256"}]}]
ERC20_ABI = [
    {"name":"approve","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address"},{"type":"uint256"}],"outputs":[{"type":"bool"}]},
    {"name":"allowance","type":"function","stateMutability":"view","inputs":[{"type":"address"},{"type":"address"}],"outputs":[{"type":"uint256"}]},
    {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
]
PAIR_ABI = [
    {"name":"getReserves","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"uint112"},{"type":"uint112"},{"type":"uint32"}]},
    {"name":"token0","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
]

def main():
    key = os.environ.get("OWNER_PRIVATE_KEY", "").strip()
    if not key: print("Set OWNER_PRIVATE_KEY (in .env) and re-run."); return
    if not key.startswith("0x"): key = "0x" + key
    w3  = Web3(Web3.HTTPProvider(RPC))
    ta = os.environ.get("TOKEN_ADDR", "").strip()
    if ta:
        token = Web3.to_checksum_address(ta)
        pair = w3.eth.contract(address=token, abi=[{"name":"uniswapV2Pair","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]}]).functions.uniswapV2Pair().call()
        pair = Web3.to_checksum_address(pair)
    else:
        info = json.load(open(INFO_FILE))
        token = Web3.to_checksum_address(info["token"])
        pair  = Web3.to_checksum_address(info["pair"])
    acc = Account.from_key(key); me = acc.address
    strx   = w3.eth.contract(address=token, abi=ERC20_ABI)
    router = w3.eth.contract(address=ROUTER, abi=ROUTER_ABI)
    print("owner:", me, "| token:", token)
    print("balances:", w3.eth.get_balance(me)/1e18, "ETH,", strx.functions.balanceOf(me).call()/1e9, "STRX")

    def send(fn, value=0, gas=600_000, label=""):
        tx = fn.build_transaction({"from": me, "value": value, "gas": gas,
            "nonce": w3.eth.get_transaction_count(me, "pending"),
            "chainId": CHAIN, "gasPrice": w3.eth.gas_price})
        s = w3.eth.account.sign_transaction(tx, key)
        h = w3.eth.send_raw_transaction(s.raw_transaction)
        rc = w3.eth.wait_for_transaction_receipt(h, timeout=180)
        print(f"  [{'OK' if rc['status']==1 else 'FAIL'}] {label} {h.hex()}")
        if rc["status"] != 1: raise SystemExit("failed: "+label)

    if strx.functions.allowance(me, ROUTER).call() < STRX_RAW:
        print("approve router (max)")
        send(strx.functions.approve(ROUTER, (1<<256)-1), gas=120_000, label="approve")

    print(f"addLiquidityETH: {STRX_HUMAN:,} STRX + {ETH_WEI/1e18} ETH")
    send(router.functions.addLiquidityETH(token, STRX_RAW, 0, 0, me, 9999999999),
         value=ETH_WEI, gas=600_000, label="addLiquidityETH")

    p = w3.eth.contract(address=pair, abi=PAIR_ABI)
    r0, r1, _ = p.functions.getReserves().call(); t0 = p.functions.token0().call()
    strx_is0 = t0.lower() == token.lower()
    sres = (r0 if strx_is0 else r1)/1e9; eres = (r1 if strx_is0 else r0)/1e18
    price = eres/sres if sres else 0
    print(f"\nPOOL: {sres:,.0f} STRX + {eres:.4f} ETH | price {price:.10f} ETH/STRX")
    print(f"~${price*1930:.6f}/STRX  FDV(10M) ~= ${price*1930*10_000_000:,.0f}")
    print("\nDONE. Next: python airdrop.py")

if __name__ == "__main__":
    main()

"""
Bridge a Remix (or any) deploy into the LP/airdrop scripts.

After you deploy in Remix, paste its contract address here and this writes the
{token, pair} json the other scripts read (it reads the pair straight off the
token via uniswapV2Pair()).

RUN (PowerShell):
   $env:TOKEN_ADDR="0xYOUR_DEPLOYED_CA"
   $env:OUT_FILE="test_new.json"      # or strx_new.json for the real one
   python save_deployed.py
"""
import os, json
from web3 import Web3

RPC = "https://rpc.mainnet.chain.robinhood.com"
ABI = [
 {"name":"uniswapV2Pair","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
 {"name":"totalSupply","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
 {"name":"symbol","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]},
 {"name":"decimals","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"uint8"}]},
]

def main():
    ta = os.environ.get("TOKEN_ADDR", "").strip()
    if not ta:
        print("Set TOKEN_ADDR to your deployed contract address."); return
    token = Web3.to_checksum_address(ta)
    out = os.environ.get("OUT_FILE", "test_new.json")
    w3 = Web3(Web3.HTTPProvider(RPC))
    c = w3.eth.contract(address=token, abi=ABI)
    pair = c.functions.uniswapV2Pair().call()
    sym  = c.functions.symbol().call()
    dec  = c.functions.decimals().call()
    supply = c.functions.totalSupply().call()
    json.dump({"token": token, "pair": pair}, open(out, "w"), indent=1)
    print(f"symbol={sym} decimals={dec} supply={supply/10**dec:,.0f}")
    print(f"token: {token}")
    print(f"pair : {pair}")
    print(f"saved {out}. Next: python seed_lp.py")

if __name__ == "__main__":
    main()

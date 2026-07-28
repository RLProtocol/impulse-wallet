"""
STEP 1 - Deploy the NEW Strix (STRX) token on Robinhood Chain.

Byte-for-byte the same contract as your current STRX (9 decimals, 10M supply,
2% buy tax, owner fee-excluded), just a fresh deploy -> fresh Uniswap V2 pair
(the constructor auto-creates it). Prints the new CA + pair address.

RUN (PowerShell):
   cd "C:\\Users\\Aayus\\OneDrive\\Desktop\\strix-wallet\\server"
   pip install web3 py-solc-x
   $env:OWNER_PRIVATE_KEY="0xYOUR_PRIVATE_KEY"
   python deploy_strx.py

After it prints NEW_TOKEN + NEW_PAIR, run  seed_lp.py  then  airdrop.py.
"""
import os, json
from web3 import Web3
from eth_account import Account
import solcx

RPC   = "https://rpc.mainnet.chain.robinhood.com"
CHAIN = 4663
SRC   = os.environ.get("SRC_FILE", "strx_source.sol")
OUT   = os.environ.get("OUT_FILE", "strx_new.json")
SOLC  = "0.8.34"

def compile_contract():
    try:
        solcx.set_solc_version(SOLC)
    except Exception:
        print(f"installing solc {SOLC} ...")
        solcx.install_solc(SOLC)
        solcx.set_solc_version(SOLC)
    source = open(SRC, "r", encoding="utf-8").read()
    # match verified settings: optimization OFF, default evm
    compiled = solcx.compile_source(
        source, output_values=["abi", "bin"],
        solc_version=SOLC, optimize=False,
    )
    key = next(k for k in compiled if k.endswith(":Strix"))
    return compiled[key]["abi"], compiled[key]["bin"]

def main():
    key = os.environ.get("OWNER_PRIVATE_KEY", "").strip()
    if not key:
        print("Set OWNER_PRIVATE_KEY and re-run."); return
    if not key.startswith("0x"): key = "0x" + key
    w3  = Web3(Web3.HTTPProvider(RPC))
    acc = Account.from_key(key); me = acc.address
    print("deployer:", me)
    print("ETH balance:", w3.eth.get_balance(me)/1e18)

    abi, bytecode = compile_contract()
    print("compiled OK, bytecode len:", len(bytecode))

    Strix = w3.eth.contract(abi=abi, bytecode=bytecode)
    tx = Strix.constructor().build_transaction({
        "from": me, "nonce": w3.eth.get_transaction_count(me, "pending"),
        "chainId": CHAIN, "gasPrice": w3.eth.gas_price, "value": 0,
    })
    # constructor creates the pair -> needs headroom
    try:
        est = w3.eth.estimate_gas(tx); tx["gas"] = int(est * 3 // 2)
    except Exception as e:
        print("estimate failed, using 6M:", e); tx["gas"] = 6_000_000
    print("gas:", tx["gas"])

    signed = w3.eth.account.sign_transaction(tx, key)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    print("deploy tx:", h.hex(), "\nwaiting...")
    rc = w3.eth.wait_for_transaction_receipt(h, timeout=180)
    if rc["status"] != 1:
        print("DEPLOY FAILED"); return
    token = rc["contractAddress"]
    print("\n=== NEW_TOKEN (CA):", token)

    c = w3.eth.contract(address=token, abi=abi)
    pair = c.functions.uniswapV2Pair().call()
    supply = c.functions.totalSupply().call()
    bal = c.functions.balanceOf(me).call()
    print("=== NEW_PAIR      :", pair)
    print("total supply:", supply/1e9, "STRX  | owner holds:", bal/1e9, "STRX")

    json.dump({"token": token, "pair": pair, "abi": abi},
              open(OUT, "w"), indent=1)
    print(f"\nsaved {OUT} (token+pair+abi). Next: python seed_lp.py")

if __name__ == "__main__":
    main()

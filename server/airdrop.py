"""
Airdrop the NEW STRX 1:1 to old holders.

Sends each old holder the same amount they hold in the old STRX. Transfers are
from the owner (fee-excluded) so they are UNTAXED. Always excludes the owner
0xF7Ac92, both pairs, burn, marketing, and any address in blacklist.txt.
Handles a decimals change automatically (old STRX is 9 decimals). Resumable:
records every send in airdrop_progress.json and skips done wallets on re-run.

RUN (PowerShell) - right after you deploy the new token:
   cd "C:\\Users\\Aayus\\OneDrive\\Desktop\\strix-wallet\\server"
   $env:OWNER_PRIVATE_KEY="0xYOUR_KEY"
   $env:TOKEN_ADDR="0xNEW_TOKEN_CA"       # the CA you just deployed
   python airdrop.py                      # DRY RUN: prints the full list, sends nothing
   python airdrop.py --send               # actually sends
"""
import os, json, sys
import _env  # loads .env into os.environ
from web3 import Web3
from eth_account import Account

RPC   = "https://rpc.mainnet.chain.robinhood.com"
CHAIN = 4663
OLD_DECIMALS = 9
OWNER_HARD = "0xf7ac92dd29600b4468163ed3be03a1a8153a63ec"   # never airdrop to ourselves
OLD_PAIR   = "0x6cc96f36f56d163840467f2c69c984740d4a0dec"
MARKETING  = "0x1dd3cc01b65d7cf43251884d812a10285bce9b75"
ALWAYS_EXCLUDE = {
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    OWNER_HARD, OLD_PAIR, MARKETING,
}
ABI = [
 {"name":"transfer","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address"},{"type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
 {"name":"decimals","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"uint8"}]},
 {"name":"uniswapV2Pair","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
]

def load_blacklist():
    bl = set()
    if os.path.exists("blacklist.txt"):
        for line in open("blacklist.txt"):
            a = line.strip().split("#")[0].strip().lower()
            if a.startswith("0x") and len(a) == 42:
                bl.add(a)
    return bl

def resolve_token(w3):
    ta = os.environ.get("TOKEN_ADDR", "").strip()
    if ta:
        return Web3.to_checksum_address(ta)
    if os.path.exists(os.environ.get("INFO_FILE", "strx_new.json")):
        return Web3.to_checksum_address(json.load(open(os.environ.get("INFO_FILE", "strx_new.json")))["token"])
    print("Set TOKEN_ADDR to the new token CA (or provide strx_new.json)."); sys.exit(1)

def main():
    send_mode = "--send" in sys.argv
    key = os.environ.get("OWNER_PRIVATE_KEY", "").strip()
    if send_mode and not key: print("Set OWNER_PRIVATE_KEY to send."); return
    if key and not key.startswith("0x"): key = "0x" + key
    w3  = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 30}))
    me  = Account.from_key(key).address if key else Web3.to_checksum_address(OWNER_HARD)
    token = resolve_token(w3)
    c = w3.eth.contract(address=token, abi=ABI)
    new_dec = c.functions.decimals().call()
    try: new_pair = c.functions.uniswapV2Pair().call().lower()
    except Exception: new_pair = ""
    holders = json.load(open("strx_holders.json"))     # {addr_lower: raw_balance @ 9 decimals}

    exclude = set(ALWAYS_EXCLUDE) | load_blacklist() | {me.lower()}
    if new_pair: exclude.add(new_pair)

    scale = 10 ** (new_dec - OLD_DECIMALS)             # 9->9 =1 ; 9->18 =1e9
    recipients = []
    for a, v in holders.items():
        if a in exclude or v <= 0: continue
        recipients.append((a, v * scale))              # amount in NEW token units
    recipients.sort(key=lambda x: -x[1])
    total = sum(v for _, v in recipients)

    progress = json.load(open("airdrop_progress.json")) if os.path.exists("airdrop_progress.json") else {}

    print(f"token: {token}  (decimals={new_dec})")
    print(f"owner: {me}  balance: {c.functions.balanceOf(me).call()/10**new_dec:,.2f}")
    print(f"recipients: {len(recipients)}  |  total to send: {total/10**new_dec:,.2f}")
    print(f"excluded: owner+pairs+burn+marketing + {len(load_blacklist())} blacklisted")
    done = sum(1 for a,_ in recipients if progress.get(a,{}).get('status')=='ok')
    print(f"already sent (resume): {done}\n")

    if not send_mode:
        for a, v in recipients:
            mark = " [SENT]" if progress.get(a,{}).get('status')=='ok' else ""
            print(f"  {a}  {v/10**new_dec:>14,.2f}{mark}")
        print(f"\nDRY RUN - {len(recipients)} wallets, {total/10**new_dec:,.2f} tokens. To send: python airdrop.py --send")
        return

    if c.functions.balanceOf(me).call() < total:
        print("! owner balance < total to send. Aborting."); return

    def gasprice():
        # 2x current to stay safely above a rising base fee (gas here is ~0.1 gwei)
        try:    base = w3.eth.get_block("pending")["baseFeePerGas"]
        except Exception: base = w3.eth.gas_price
        return int(max(base, w3.eth.gas_price) * 2)

    sent_now = 0
    for i, (a, v) in enumerate(recipients, 1):
        to = Web3.to_checksum_address(a)
        # ON-CHAIN skip: if they already hold their airdrop, never re-send
        if c.functions.balanceOf(to).call() >= v:
            progress[a] = {"status": "ok", "amt": v, "note": "confirmed on-chain"}
            continue
        try:
            tx = c.functions.transfer(to, v).build_transaction({
                "from": me, "nonce": w3.eth.get_transaction_count(me, "pending"),
                "chainId": CHAIN, "gasPrice": gasprice(), "gas": 120_000})
            s = w3.eth.account.sign_transaction(tx, key)
            h = w3.eth.send_raw_transaction(s.raw_transaction)
            rc = w3.eth.wait_for_transaction_receipt(h, timeout=180)
            ok = rc["status"] == 1
            progress[a] = {"status": "ok" if ok else "fail", "tx": h.hex(), "amt": v}
            sent_now += ok
            print(f"  [{i}/{len(recipients)}] {'OK' if ok else 'FAIL'} {a} {v/10**new_dec:,.2f} {h.hex()}")
        except Exception as e:
            progress[a] = {"status": "error", "err": str(e)[:120]}
            print(f"  [{i}/{len(recipients)}] ERROR {a}: {str(e)[:120]}")
        json.dump(progress, open("airdrop_progress.json", "w"), indent=1)
    print(f"\n(sent {sent_now} new this run)")

    ok = sum(1 for p in progress.values() if p.get("status") == "ok")
    print(f"\nDONE. {ok}/{len(recipients)} sent. Re-run to retry any failures.")

if __name__ == "__main__":
    main()

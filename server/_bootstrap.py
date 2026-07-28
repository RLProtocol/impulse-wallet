"""Stub the heavy modules robinhoodcode.py imports at the top (Telegram,
Telethon, Postgres, Solana) but that the wallet backend never calls. This lets
us import the REAL robinhoodcode trading engine with only the web3 stack
installed (web3 / eth-abi / eth-account / requests / python-dotenv).

Import this module BEFORE importing robinhoodcode.
"""
import sys
import types


class _Dummy:
    """Permissive placeholder: callable, subscriptable, attribute-chainable."""

    def __init__(self, *a, **k):
        pass

    def __call__(self, *a, **k):
        return _Dummy()

    def __getattr__(self, _name):
        return _Dummy()

    def __getitem__(self, _k):
        return _Dummy()


class _StubModule(types.ModuleType):
    __path__: list = []  # mark as a package so submodule imports resolve

    def __getattr__(self, _name):
        return _Dummy()


def _stub(*dotted_names: str) -> None:
    for name in dotted_names:
        if name in sys.modules:
            continue
        mod = _StubModule(name)
        sys.modules[name] = mod
        # attach as attribute on the parent package (so `from a.b import c` works)
        if "." in name:
            parent, child = name.rsplit(".", 1)
            if parent in sys.modules:
                setattr(sys.modules[parent], child, mod)


_stub(
    # Telegram
    "telegram", "telegram.ext",
    # Telethon
    "telethon", "telethon.sessions", "telethon.tl", "telethon.tl.functions",
    "telethon.tl.functions.channels", "telethon.tl.functions.messages",
    "telethon.errors", "telethon.utils",
    # Postgres
    "psycopg2", "psycopg2.extras", "psycopg2.pool",
    # Solana
    "solana", "solana.rpc", "solana.rpc.api",
    "solders", "solders.keypair", "solders.pubkey", "solders.system_program",
    "solders.transaction", "solders.commitment_config",
    "solders.rpc", "solders.rpc.requests", "solders.rpc.config",
    # misc
    "base58",
)

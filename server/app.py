"""Strix Wallet trade API — builds unsigned transactions + serves prices.

Run locally:  uvicorn app:app --port 8787 --reload
The wallet extension points at this base URL (Settings → Strix Trade API).
"""
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import trade_engine as te

app = FastAPI(title="Strix Wallet API", version="0.1.0")

# The extension calls from a chrome-extension:// origin. No credentials → * is fine.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _fail(msg: str, code: int = 400):
    return JSONResponse(status_code=code, content={"error": str(msg)[:300]})


@app.get("/health")
def health():
    return {"ok": True, "chain": 4663}


@app.get("/native-price")
def native_price():
    try:
        return {"usd": te.native_price()}
    except Exception as e:
        return _fail(e, 502)


@app.get("/token")
def token(ca: str = Query(...)):
    try:
        return te.token_info(ca)
    except Exception as e:
        return _fail(e)


@app.get("/stocks")
def stocks():
    try:
        return {"stocks": te.stock_list()}
    except Exception as e:
        return _fail(e, 502)


class QuoteBuy(BaseModel):
    ca: str
    amountEth: str


@app.post("/quote/buy")
def quote_buy(b: QuoteBuy):
    try:
        return te.quote_buy(b.ca, b.amountEth)
    except Exception as e:
        return _fail(e)


class BuyReq(BaseModel):
    ca: str
    amountEth: str
    address: str
    slippage: float | None = None


@app.post("/tx/buy")
def tx_buy(b: BuyReq):
    try:
        return te.build_buy(b.ca, b.amountEth, b.address, b.slippage)
    except Exception as e:
        return _fail(e)


class SellReq(BaseModel):
    ca: str
    pct: int
    address: str
    slippage: float | None = None


@app.post("/tx/sell")
def tx_sell(b: SellReq):
    try:
        return te.build_sell(b.ca, b.pct, b.address, b.slippage)
    except Exception as e:
        return _fail(e)


class StockBuyReq(BaseModel):
    stock: str
    amountEth: str
    address: str
    slippage: float | None = None


@app.post("/tx/stock/buy")
def tx_stock_buy(b: StockBuyReq):
    try:
        return te.build_stock_buy(b.stock, b.amountEth, b.address, b.slippage)
    except Exception as e:
        return _fail(e)


class StockSellReq(BaseModel):
    stock: str
    pct: int
    address: str
    slippage: float | None = None


@app.post("/tx/stock/sell")
def tx_stock_sell(b: StockSellReq):
    try:
        return te.build_stock_sell(b.stock, b.pct, b.address, b.slippage)
    except Exception as e:
        return _fail(e)

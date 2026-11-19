#!/usr/bin/env python3
"""Tokenized Equities MCP server (v1, read-only).

Four data legs:
  1. Stonk            - on-chain tokenized-stock catalog (public API, no key)
  2. Backpack         - 24/7 equity perp price discovery (public API, no key)
  3. Financial Datasets - underlying stock data (X-API-Key from env only)
  4. Solana RPC       - on-chain truth via the fleet's existing RPC helpers

Plus Jupiter's public quote API for the on-chain executable token price.

Python 3 stdlib only. MCP Streamable HTTP: POST /mcp, GET /health,
GET / serves a small portal page. Binds $HOST:$PORT (default
127.0.0.1:8787; set HOST=0.0.0.0 on Render). No signing, no keys held,
read-only.
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY_PATH = os.path.join(HERE, "registry.json")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))

STONK_BASE = "https://stonkfun.xyz/api/public/v1"  # apex host (www 301s here)
BACKPACK_BASE = "https://api.backpack.exchange"
FD_BASE = "https://api.financialdatasets.ai"
JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

RPC_PRIMARY = os.path.expanduser("~/workspace/solana-rpc/mainnet_rpc.py")
RPC_FALLBACK = os.path.expanduser("~/workspace/solana-rpc/helius_mainnet_rpc.py")

UA = {"User-Agent": "equities-mcp/0.1"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _range_total(url: str, hdrs: dict, timeout: int):
    """Total body size via a 1-byte Range probe (Content-Range header)."""
    from http.client import IncompleteRead

    h = dict(hdrs)
    h["Range"] = "bytes=0-0"
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            cr = resp.headers.get("Content-Range") or ""
            resp.read()
    except IncompleteRead:
        return None
    if "/" in cr:
        try:
            return int(cr.rsplit("/", 1)[1])
        except ValueError:
            return None
    return None


def _fetch_identity_ranged(url: str, hdrs: dict, timeout: int) -> bytes:
    """Fetch the full identity-encoded body, reassembling with Range
    requests when the egress proxy truncates the stream mid-body."""
    from http.client import IncompleteRead

    h = dict(hdrs)
    h["Accept-Encoding"] = "identity"
    raw = b""
    total = None
    try:
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            clen = resp.headers.get("Content-Length")
            total = int(clen) if clen else None
            try:
                raw = resp.read()
            except IncompleteRead as inc:
                raw = inc.partial or b""
                if total is None and inc.expected:
                    total = len(raw) + inc.expected
    except IncompleteRead as inc:
        raw = inc.partial or b""
    if total is None:
        total = _range_total(url, h, timeout)
    if total is None:
        return raw  # best effort; JSON parse upstream will judge
    stalls = 0
    while len(raw) < total and stalls < 8:
        end = min(total - 1, len(raw) + 24575)
        h2 = dict(h)
        h2["Range"] = f"bytes={len(raw)}-{end}"
        before = len(raw)
        try:
            req = urllib.request.Request(url, headers=h2)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                try:
                    raw += resp.read()
                except IncompleteRead as inc:
                    raw += inc.partial or b""
        except IncompleteRead as inc:
            raw += inc.partial or b""
        except Exception:  # noqa: BLE001
            pass
        if len(raw) == before:
            stalls += 1
            time.sleep(0.5)
    return raw


def http_get_json(url: str, headers: dict | None = None, timeout: int = 25):
    """GET JSON, resilient to this VM's flaky egress: gzip first (smaller
    payloads survive far more often); if the body still truncates, fall
    back to an identity fetch reassembled via HTTP Range requests."""
    import gzip as _gzip

    hdrs = dict(UA)
    if headers:
        hdrs.update(headers)
    last_err = None
    for attempt in range(3):
        try:
            h = dict(hdrs)
            h["Accept-Encoding"] = "gzip"
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = _gzip.decompress(raw)
                return json.loads(raw.decode())
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(0.5 * (attempt + 1))
    try:
        raw = _fetch_identity_ranged(url, hdrs, timeout)
        return json.loads(raw.decode())
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"GET failed: {last_err}; ranged fallback: {e}")


def _rpc_direct(method: str, params: list):
    """Direct JSON-RPC over HTTPS — used on hosts without the fleet helper
    scripts (e.g. Render). Endpoint: $SOLANA_RPC_URL if set (never printed;
    it may carry a key), else the public mainnet endpoint."""
    url = os.environ.get("SOLANA_RPC_URL", "").strip() or "https://api.mainnet-beta.solana.com"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                       "params": params}).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={**UA, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = json.loads(resp.read().decode())
    if "error" in out:
        raise RuntimeError(str(out["error"])[:200])
    return out.get("result")


def rpc(method: str, params: list):
    """Solana JSON-RPC via the fleet helpers (primary QuikNode, fallback Helius).

    Endpoint URLs live inside the helper scripts and are never printed here.
    On hosts where the helpers do not exist (Render), falls back to a direct
    JSON-RPC call so the on-chain leg still works.
    """
    payload = json.dumps(params)
    errors = []
    for script in (RPC_PRIMARY, RPC_FALLBACK):
        if not os.path.exists(script):
            continue
        try:
            out = subprocess.run(
                [sys.executable, script, "--method", method, "--params", payload],
                capture_output=True, text=True, timeout=45,
            )
            if out.returncode != 0:
                errors.append((out.stderr or "rpc helper failed").strip()[:200])
                continue
            body = json.loads(out.stdout)
            if "error" in body:
                errors.append(str(body["error"])[:200])
                continue
            return body.get("result")
        except Exception as e:  # noqa: BLE001
            errors.append(str(e)[:200])
    try:
        return _rpc_direct(method, params)
    except Exception as e:  # noqa: BLE001
        errors.append("direct: " + str(e)[:200])
    raise RuntimeError("solana_rpc_unavailable: " + "; ".join(errors))


# --------------------------------------------------------------------------
# Financial Datasets leg (key from env only; absent -> structured error)
# --------------------------------------------------------------------------

class NotConfigured(Exception):
    code = "financial_datasets_not_configured"


def fd_get(path: str, params: dict):
    key = os.environ.get("FINANCIAL_DATASETS_API_KEY", "").strip()
    if not key:
        raise NotConfigured(
            "Financial Datasets leg is not configured: FINANCIAL_DATASETS_API_KEY "
            "is not set in this service's environment."
        )
    qs = urllib.parse.urlencode(params)
    url = f"{FD_BASE}{path}?{qs}" if qs else f"{FD_BASE}{path}"
    return http_get_json(url, headers={"X-API-Key": key})


def fd_snapshot(ticker: str):
    body = fd_get("/prices/snapshot/", {"ticker": ticker})
    if isinstance(body, dict):
        return body.get("snapshot") or body
    return body


# --------------------------------------------------------------------------
# Stonk + Backpack legs and the registry build
# --------------------------------------------------------------------------

def stonk_pairs() -> list:
    body = http_get_json(f"{STONK_BASE}/pairs?launchable=true")
    return (body.get("data") or {}).get("pairs") or []


def backpack_equity_perps() -> dict:
    """ticker -> backpack symbol for *.US_USDC_PERP markets."""
    markets = http_get_json(f"{BACKPACK_BASE}/api/v1/markets")
    out = {}
    for m in markets:
        sym = m.get("symbol", "")
        if sym.endswith(".US_USDC_PERP"):
            out[sym.split(".")[0]] = sym
    return out


def backpack_mark(symbol: str):
    t = http_get_json(f"{BACKPACK_BASE}/api/v1/ticker?symbol={urllib.parse.quote(symbol)}")
    for field in ("markPrice", "lastPrice", "indexPrice"):
        v = t.get(field)
        if v not in (None, "", "0"):
            try:
                return float(v), field
            except (TypeError, ValueError):
                continue
    return None, None


def _stonk_ticker_candidates(pair: dict) -> list:
    """Map a Stonk pair entry to candidate underlying tickers.

    xstock entries carry the ticker with a trailing 'x' (NVDAX -> NVDA);
    Backpack Securities ('Sunrise') entries carry the plain ticker (NVDA).
    """
    sym = (pair.get("symbol") or "").upper()
    cat = (pair.get("category") or "").lower()
    cands = []
    if cat == "xstock" and sym.endswith("X") and len(sym) > 2:
        cands.append(sym[:-1])
    cands.append(sym)
    return cands


# Issuer preference when several on-chain versions of one ticker exist.
_CATEGORY_RANK = {"xstock": 0, "backpack": 1}


def verify_mint(mint: str):
    """RPC-verify a mint. Returns parsed mint info or None."""
    info = rpc("getAccountInfo", [mint, {"encoding": "jsonParsed"}])
    if not info or not info.get("value"):
        return None
    parsed = (((info["value"].get("data") or {}).get("parsed") or {}).get("info") or {})
    if "decimals" not in parsed:
        return None
    return {
        "decimals": parsed.get("decimals"),
        "supply_raw": parsed.get("supply"),
        "mint_authority": parsed.get("mintAuthority"),
        "freeze_authority": parsed.get("freezeAuthority"),
        "owner_program": info["value"].get("owner"),
    }


def build_registry() -> dict:
    perps = backpack_equity_perps()
    pairs = stonk_pairs()

    # ticker -> candidate Stonk entries (best issuer first)
    by_ticker: dict[str, list] = {}
    for pair in pairs:
        if pair.get("symbolAmbiguous"):
            continue
        for cand in _stonk_ticker_candidates(pair):
            if cand in perps:
                by_ticker.setdefault(cand, []).append(pair)
                break
    for entries in by_ticker.values():
        entries.sort(key=lambda p: _CATEGORY_RANK.get((p.get("category") or "").lower(), 9))

    registry = {}
    for ticker in sorted(by_ticker):
        verified = []
        for pair in by_ticker[ticker][:3]:
            mint = pair.get("mint")
            if not mint:
                continue
            try:
                v = verify_mint(mint)
            except Exception:  # noqa: BLE001 - unverifiable mints never enter
                v = None
            if v is None:
                continue
            verified.append({
                "solana_mint": mint,
                "stonk_symbol": pair.get("symbol"),
                "issuer": pair.get("categoryLabel") or pair.get("category"),
                "name": pair.get("name"),
                "decimals": v["decimals"],
                "token_program": v["owner_program"],
            })
        if not verified:
            continue
        primary = verified[0]
        registry[ticker] = {
            "ticker": ticker,
            "fd_ticker": ticker,
            "backpack_symbol": perps[ticker],
            "solana_mint": primary["solana_mint"],
            "decimals": primary["decimals"],
            "issuer": primary["issuer"],
            "stonk_symbol": primary["stonk_symbol"],
            "name": primary["name"],
            "token_program": primary["token_program"],
            "also_onchain": verified[1:],
            "verified_at": now_iso(),
        }

    doc = {"generated_at": now_iso(), "tickers": registry}
    _write_registry(doc)
    return doc


def _write_registry(doc: dict) -> None:
    tmp = REGISTRY_PATH + ".tmp"
    for attempt in range(3):
        try:
            with open(tmp, "w") as f:
                json.dump(doc, f, indent=1)
            os.replace(tmp, REGISTRY_PATH)
            return
        except OSError:
            if attempt == 2:
                raise
            time.sleep(1.0)


_registry_cache: dict | None = None


def load_registry(refresh: bool = False) -> dict:
    global _registry_cache
    if not refresh and _registry_cache is not None:
        return _registry_cache
    if not refresh and os.path.exists(REGISTRY_PATH):
        try:
            with open(REGISTRY_PATH) as f:
                _registry_cache = json.load(f)
            return _registry_cache
        except (OSError, json.JSONDecodeError):
            pass
    _registry_cache = build_registry()
    return _registry_cache


def registry_age_seconds(doc: dict):
    try:
        gen = datetime.fromisoformat(doc["generated_at"])
        return max(0, int((datetime.now(timezone.utc) - gen).total_seconds()))
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------
# Jupiter on-chain executable price
# --------------------------------------------------------------------------

def jupiter_price_usd(mint: str, decimals: int):
    """Executable price of 1 token in USDC via a Jupiter quote (token -> USDC)."""
    amount = 10 ** decimals  # exactly 1.0 token
    qs = urllib.parse.urlencode({
        "inputMint": mint, "outputMint": USDC_MINT,
        "amount": amount, "slippageBps": 50,
    })
    body = http_get_json(f"{JUP_QUOTE}?{qs}", timeout=20)
    out = body.get("outAmount")
    if out is None:
        return None
    return int(out) / 1e6


def bps(a, b):
    if a is None or b is None or b == 0:
        return None
    return round((a - b) / b * 10000, 1)


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------

def _entry(doc: dict, ticker: str):
    tickers = doc.get("tickers") or {}
    t = (ticker or "").upper()
    if t not in tickers:
        raise ValueError(f"unknown ticker '{ticker}'; registry has: {', '.join(sorted(tickers))}")
    return tickers[t]


def tool_equities_list(args: dict) -> dict:
    doc = load_registry(refresh=bool(args.get("refresh")))
    return {
        "source": "registry (Stonk pairs x Backpack equity perps, RPC-verified)",
        "as_of": now_iso(),
        "registry_generated_at": doc.get("generated_at"),
        "staleness_seconds": registry_age_seconds(doc),
        "count": len(doc.get("tickers") or {}),
        "tickers": doc.get("tickers") or {},
    }


def tool_equities_quote(args: dict) -> dict:
    doc = load_registry()
    e = _entry(doc, args.get("ticker", ""))
    as_of = now_iso()
    legs: dict = {}
    underlying = None

    # Leg 1: Financial Datasets underlying snapshot
    try:
        snap = fd_snapshot(e["fd_ticker"])
        price = snap.get("price") if isinstance(snap, dict) else None
        underlying = float(price) if price is not None else None
        legs["underlying"] = {
            "source": "financialdatasets.ai /prices/snapshot/",
            "as_of": as_of,
            "price_usd": underlying,
            "day_change_percent": snap.get("day_change_percent") if isinstance(snap, dict) else None,
        }
    except NotConfigured as exc:
        legs["underlying"] = {"source": "financialdatasets.ai", "as_of": as_of,
                              "price_usd": None, "error": NotConfigured.code, "note": str(exc)}
    except Exception as exc:  # noqa: BLE001
        legs["underlying"] = {"source": "financialdatasets.ai", "as_of": as_of,
                              "price_usd": None, "error": "leg_failed", "note": str(exc)[:200]}

    # Leg 2: Backpack perp mark
    perp = None
    try:
        perp, field = backpack_mark(e["backpack_symbol"])
        legs["backpack_perp"] = {"source": f"backpack.exchange ticker ({field})",
                                 "as_of": as_of, "symbol": e["backpack_symbol"],
                                 "mark_price_usd": perp}
    except Exception as exc:  # noqa: BLE001
        legs["backpack_perp"] = {"source": "backpack.exchange", "as_of": as_of,
                                 "symbol": e["backpack_symbol"], "mark_price_usd": None,
                                 "error": "leg_failed", "note": str(exc)[:200]}

    # Leg 3: on-chain executable price via Jupiter
    onchain = None
    try:
        onchain = jupiter_price_usd(e["solana_mint"], e["decimals"])
        legs["onchain_token"] = {"source": "jupiter lite-api quote (token->USDC)",
                                 "as_of": as_of, "mint": e["solana_mint"],
                                 "price_usd": onchain}
    except Exception as exc:  # noqa: BLE001
        legs["onchain_token"] = {"source": "jupiter lite-api quote", "as_of": as_of,
                                 "mint": e["solana_mint"], "price_usd": None,
                                 "error": "leg_failed", "note": str(exc)[:200]}

    return {
        "source": "equities_quote (three-way)",
        "as_of": as_of,
        "ticker": e["ticker"],
        "mint": e["solana_mint"],
        "issuer": e["issuer"],
        "legs": legs,
        "premium_discount_bps": {
            "onchain_vs_underlying": bps(onchain, underlying),
            "perp_vs_underlying": bps(perp, underlying),
            "onchain_vs_perp": bps(onchain, perp),
        },
        "note": "bps legs are null when a leg is unavailable (e.g. FD not configured).",
    }


def tool_equities_token_info(args: dict) -> dict:
    doc = load_registry()
    mint = args.get("mint")
    entry = None
    if not mint and args.get("ticker"):
        entry = _entry(doc, args["ticker"])
        mint = entry["solana_mint"]
    if not mint:
        raise ValueError("provide 'mint' or a registry 'ticker'")
    as_of = now_iso()
    v = verify_mint(mint)
    if v is None:
        raise ValueError(f"mint {mint} not found / not a token mint on mainnet")
    supply = rpc("getTokenSupply", [mint])
    largest = rpc("getTokenLargestAccounts", [mint])
    holders = []
    for h in (largest or {}).get("value", [])[:10]:
        holders.append({"address": h.get("address"), "ui_amount": h.get("uiAmount")})
    dec = v["decimals"]
    supply_ui = None
    try:
        supply_ui = int(v["supply_raw"]) / (10 ** dec)
    except (TypeError, ValueError):
        pass
    return {
        "source": "solana rpc (getAccountInfo/getTokenSupply/getTokenLargestAccounts)",
        "as_of": as_of,
        "mint": mint,
        "ticker": entry["ticker"] if entry else None,
        "decimals": dec,
        "supply_ui": supply_ui,
        "supply_raw": v["supply_raw"],
        "mint_authority": v["mint_authority"],
        "freeze_authority": v["freeze_authority"],
        "token_program": v["owner_program"],
        "top_holders": holders,
    }


def tool_equities_fundamentals(args: dict) -> dict:
    ticker = (args.get("ticker") or "").upper()
    if not ticker:
        raise ValueError("provide 'ticker'")
    as_of = now_iso()
    try:
        out = {"source": "financialdatasets.ai", "as_of": as_of, "ticker": ticker}
        metrics = fd_get("/financial-metrics/", {"ticker": ticker, "limit": 1})
        out["financial_metrics"] = metrics.get("financial_metrics") if isinstance(metrics, dict) else metrics
        facts = fd_get("/company/facts/", {"ticker": ticker})
        out["company_facts"] = facts.get("company_facts") if isinstance(facts, dict) else facts
        earn = fd_get("/earnings/", {"ticker": ticker, "limit": 4})
        out["earnings"] = earn.get("earnings") if isinstance(earn, dict) else earn
        news = fd_get("/news/", {"ticker": ticker, "limit": 5})
        out["news"] = news.get("news") if isinstance(news, dict) else news
        return out
    except NotConfigured as exc:
        return {"source": "financialdatasets.ai", "as_of": as_of, "ticker": ticker,
                "error": NotConfigured.code, "note": str(exc)}


def tool_equities_candles(args: dict) -> dict:
    doc = load_registry()
    e = _entry(doc, args.get("ticker", ""))
    source = (args.get("source") or "backpack").lower()
    interval = args.get("interval") or "1h"
    as_of = now_iso()
    if source == "backpack":
        end = int(time.time())
        start = end - 24 * 3600
        qs = urllib.parse.urlencode({"symbol": e["backpack_symbol"], "interval": interval,
                                     "startTime": start, "endTime": end})
        rows = http_get_json(f"{BACKPACK_BASE}/api/v1/klines?{qs}")
        candles = [{"t": r.get("start"), "o": r.get("open"), "h": r.get("high"),
                    "l": r.get("low"), "c": r.get("close"), "v": r.get("volume")} for r in rows]
        return {"source": "backpack.exchange klines", "as_of": as_of, "ticker": e["ticker"],
                "interval": interval, "candles": candles}
    if source == "fd":
        try:
            end_d = datetime.now(timezone.utc).date()
            start_d = end_d - timedelta(days=30)
            body = fd_get("/prices/", {"ticker": e["fd_ticker"], "interval": "day",
                                       "interval_multiplier": 1,
                                       "start_date": str(start_d), "end_date": str(end_d)})
            rows = body.get("prices") if isinstance(body, dict) else body
            return {"source": "financialdatasets.ai /prices/", "as_of": as_of,
                    "ticker": e["ticker"], "interval": "day", "candles": rows}
        except NotConfigured as exc:
            return {"source": "financialdatasets.ai", "as_of": as_of, "ticker": e["ticker"],
                    "error": NotConfigured.code, "note": str(exc)}
    raise ValueError("source must be 'fd' or 'backpack'")


def tool_equities_wallet(args: dict) -> dict:
    address = args.get("address")
    if not address:
        raise ValueError("provide 'address'")
    doc = load_registry()
    by_mint = {e["solana_mint"]: e for e in (doc.get("tickers") or {}).values()}
    as_of = now_iso()
    positions = []
    for program in (TOKEN_PROGRAM, TOKEN2022_PROGRAM):
        res = rpc("getTokenAccountsByOwner", [
            address, {"programId": program}, {"encoding": "jsonParsed"},
        ])
        for acct in (res or {}).get("value", []):
            info = ((((acct.get("account") or {}).get("data") or {}).get("parsed") or {}).get("info") or {})
            mint = info.get("mint")
            if mint not in by_mint:
                continue
            e = by_mint[mint]
            amt = ((info.get("tokenAmount") or {}).get("uiAmount")) or 0
            if not amt:
                continue
            onchain_px = None
            try:
                onchain_px = jupiter_price_usd(mint, e["decimals"])
            except Exception:  # noqa: BLE001
                pass
            underlying_px = None
            try:
                snap = fd_snapshot(e["fd_ticker"])
                if isinstance(snap, dict) and snap.get("price") is not None:
                    underlying_px = float(snap["price"])
            except Exception:  # noqa: BLE001 - FD may be unconfigured; degrade
                underlying_px = None
            positions.append({
                "ticker": e["ticker"], "mint": mint, "amount": amt,
                "onchain_price_usd": onchain_px,
                "value_onchain_usd": (amt * onchain_px) if onchain_px is not None else None,
                "underlying_price_usd": underlying_px,
                "value_underlying_usd": (amt * underlying_px) if underlying_px is not None else None,
            })
    return {"source": "solana rpc getTokenAccountsByOwner + jupiter/fd pricing",
            "as_of": as_of, "address": address, "positions": positions,
            "total_value_onchain_usd": sum(p["value_onchain_usd"] or 0 for p in positions)}


def tool_equities_market_status(args: dict) -> dict:
    et = datetime.now(ZoneInfo("America/New_York"))
    open_now = False
    if et.weekday() < 5:
        mins = et.hour * 60 + et.minute
        open_now = 9 * 60 + 30 <= mins < 16 * 60
    doc = _registry_cache
    reg_age = registry_age_seconds(doc) if doc else None
    return {
        "source": "computed (America/New_York) + leg notes",
        "as_of": now_iso(),
        "us_market_open": open_now,
        "et_now": et.isoformat(),
        "session": "09:30-16:00 ET, Mon-Fri (holidays not modelled)",
        "legs": {
            "backpack_perps": "24/7",
            "onchain_tokens": "24/7 (Solana)",
            "financial_datasets": "underlying trades US market hours; snapshot may be stale when closed",
            "registry_staleness_seconds": reg_age,
        },
    }


TOOLS = {
    "equities_list": {
        "description": "Registry of tokenized equities on Solana: ticker -> Financial Datasets ticker, Backpack perp symbol, RPC-verified Solana mint, decimals, issuer. Built by intersecting Backpack equity perps with the Stonk tokenized-stock catalog. Pass refresh=true to rebuild.",
        "inputSchema": {"type": "object", "properties": {"refresh": {"type": "boolean"}}},
        "fn": tool_equities_list,
    },
    "equities_quote": {
        "description": "Three-way quote for a tokenized equity: Financial Datasets underlying snapshot vs Backpack perp mark vs on-chain executable price (Jupiter), with premium/discount in bps. Legs degrade to null + note, never crash.",
        "inputSchema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]},
        "fn": tool_equities_quote,
    },
    "equities_token_info": {
        "description": "On-chain mint truth via Solana RPC: supply, mint/freeze authorities, top holders. Accepts a registry ticker or a raw mint.",
        "inputSchema": {"type": "object", "properties": {"ticker": {"type": "string"}, "mint": {"type": "string"}}},
        "fn": tool_equities_token_info,
    },
    "equities_fundamentals": {
        "description": "Financial Datasets fundamentals for a ticker: financial metrics, company facts, earnings, news. Returns financial_datasets_not_configured when the key is not set.",
        "inputSchema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]},
        "fn": tool_equities_fundamentals,
    },
    "equities_candles": {
        "description": "Candles for a ticker from Backpack (24h of klines, any Backpack interval) or Financial Datasets (daily, 30d). Source-labelled.",
        "inputSchema": {"type": "object", "properties": {
            "ticker": {"type": "string"},
            "source": {"type": "string", "enum": ["fd", "backpack"]},
            "interval": {"type": "string"}}, "required": ["ticker"]},
        "fn": tool_equities_candles,
    },
    "equities_wallet": {
        "description": "A Solana wallet's holdings of registry tokenized equities, valued at the on-chain price and (when available) the underlying price.",
        "inputSchema": {"type": "object", "properties": {"address": {"type": "string"}}, "required": ["address"]},
        "fn": tool_equities_wallet,
    },
    "equities_market_status": {
        "description": "US market open/closed (America/New_York 09:30-16:00, Mon-Fri) plus per-leg staleness notes.",
        "inputSchema": {"type": "object", "properties": {}},
        "fn": tool_equities_market_status,
    },
}


# --------------------------------------------------------------------------
# Minimal MCP (JSON-RPC) layer + HTTP server
# --------------------------------------------------------------------------

def mcp_handle(msg: dict):
    """Returns a response dict, or None for notifications."""
    method = msg.get("method", "")
    mid = msg.get("id")
    if method.startswith("notifications/") or mid is None:
        return None
    if method == "initialize":
        result = {
            "protocolVersion": (msg.get("params") or {}).get("protocolVersion", "2025-03-26"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "equities-mcp", "version": "0.1.0"},
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [{"name": n, "description": t["description"],
                             "inputSchema": t["inputSchema"],
                             "annotations": {"readOnlyHint": True,
                                             "destructiveHint": False,
                                             "idempotentHint": True}}
                            for n, t in TOOLS.items()]}
    elif method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name", "")
        args = params.get("arguments") or {}
        if name not in TOOLS:
            return {"jsonrpc": "2.0", "id": mid,
                    "error": {"code": -32602, "message": f"unknown tool {name}"}}
        try:
            out = TOOLS[name]["fn"](args)
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": json.dumps(out, indent=1)}],
                "structuredContent": out, "isError": False}}
        except Exception as exc:  # noqa: BLE001 - tool errors are data, not crashes
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": json.dumps(
                    {"error": "tool_error", "tool": name, "note": str(exc)[:400]})}],
                "isError": True}}
    else:
        return {"jsonrpc": "2.0", "id": mid,
                "error": {"code": -32601, "message": f"method not found: {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def _registry_count():
    """Ticker count from the cached registry file only — never triggers a
    build inside a page render."""
    try:
        with open(REGISTRY_PATH) as f:
            doc = json.load(f)
        return len(doc.get("tickers") or {}), doc.get("generated_at")
    except Exception:  # noqa: BLE001
        return None, None


def portal_html() -> bytes:
    """Landing page in the fleet MCP portal style (dark, Solana gradient)."""
    import html as _html

    count, generated = _registry_count()
    count_txt = str(count) if count is not None else "—"
    gen_txt = _html.escape(generated) if generated else "not built yet"
    rows = []
    for name, t in TOOLS.items():
        desc = _html.escape(t["description"].split(". ")[0].rstrip(".") + ".")
        rows.append(f'<div class="tool"><code>{_html.escape(name)}</code>'
                    f'<span>{desc}</span></div>')
    tools_html = "\n      ".join(rows)
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0e14">
<title>Equities MCP · Tokenized Equities on Solana</title>
<meta name="description" content="Equities MCP: read-only MCP server for tokenized equities on Solana — registry of on-chain stock tokens, three-way quotes (underlying vs perp vs on-chain), mint truth, fundamentals, candles and wallet holdings.">
<style>
  * {{ box-sizing: border-box; }}
  body {{ margin:0; background:#0b0e14; color:#e6edf3; font:16px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }}
  .wrap {{ max-width: 880px; margin: 0 auto; padding: 28px 20px 48px; }}
  .brand {{ display:flex; align-items:center; gap:10px; font-weight:700; font-size:18px; }}
  .logo {{ width:30px; height:30px; border-radius:8px; display:grid; place-items:center; color:#0b0e14; font-weight:800; background:linear-gradient(135deg,#9945FF,#14F195); }}
  .brand small {{ color:#8b98a5; font-weight:500; }}
  h1 {{ font-size:38px; line-height:1.15; margin:34px 0 10px; }}
  .grad {{ background:linear-gradient(90deg,#9945FF,#14F195); -webkit-background-clip:text; background-clip:text; color:transparent; }}
  .lead {{ color:#aeb9c4; font-size:18px; margin:0 0 8px; }}
  .status {{ display:inline-flex; align-items:center; gap:8px; margin:14px 0 4px; padding:6px 12px; border:1px solid #22304a; border-radius:999px; font-size:14px; color:#aeb9c4; }}
  .dot {{ width:9px; height:9px; border-radius:50%; background:#8b98a5; }}
  .dot.ok {{ background:#14F195; }} .dot.bad {{ background:#ff5c5c; }}
  .panel {{ background:#101623; border:1px solid #1e2a3f; border-radius:14px; padding:18px 20px; margin-top:18px; }}
  .panel h3 {{ margin:0 0 12px; font-size:16px; }}
  .tool {{ display:flex; gap:14px; padding:9px 0; border-top:1px solid #1a2436; align-items:baseline; }}
  .tool:first-of-type {{ border-top:none; }}
  .tool code {{ color:#14F195; font-size:14px; white-space:nowrap; min-width:190px; }}
  .tool span {{ color:#aeb9c4; font-size:14px; }}
  code {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }}
  pre.code {{ background:#0b0e14; border:1px solid #1e2a3f; border-radius:10px; padding:14px; overflow:auto; font-size:13px; color:#c9d4e0; }}
  .mono {{ color:#14F195; word-break:break-all; }}
  .muted {{ color:#8b98a5; font-size:14px; }}
  .foot {{ margin-top:28px; color:#8b98a5; font-size:13px; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }}
  @media (max-width:640px) {{ .tool {{ flex-direction:column; gap:2px; }} .tool code {{ min-width:0; }} }}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="logo">E</span>Equities MCP <small>· $CLAWD</small></div>
  <h1>Tokenized equities <span class="grad">on Solana</span></h1>
  <p class="lead">A read-only MCP server for the on-chain stock market: which tokenized
  equities exist on Solana, what each token trades at versus the underlying stock and
  the 24/7 perp, and the on-chain truth for every mint. Registry currently tracks
  <b>{count_txt} tickers</b> (built {gen_txt}), every mint verified via Solana RPC
  before it enters.</p>
  <div class="status"><span class="dot" id="dot"></span><span id="statusText">Checking…</span></div>

  <div class="panel"><h3>Tools — read-only, <code>equities_</code> namespace</h3>
      {tools_html}
  </div>

  <div class="panel"><h3>Connect an MCP client</h3>
    <p class="muted">One Streamable HTTP endpoint. The MCP endpoint is
    <code class="mono" id="endpoint">/mcp</code> (POST, JSON-RPC).</p>
    <pre class="code" id="connectCode">Loading…</pre>
    <p class="muted">Or with curl:
    <code>curl -X POST &lt;this-origin&gt;/mcp -H 'Content-Type: application/json' -d '{{"jsonrpc":"2.0","id":1,"method":"tools/list"}}'</code></p>
  </div>

  <div class="panel"><h3>Safety model</h3>
    <p class="muted" style="margin:0">Read-only by design. This server holds no keys,
    signs nothing, and has no swap or trade tools. Data legs: Stonk (on-chain catalog),
    Backpack (24/7 equity perps), Financial Datasets (underlying), Solana RPC
    (on-chain truth), Jupiter (executable on-chain price). A failed leg degrades to
    null + a note — never a fabricated number.</p>
  </div>

  <div class="foot"><span>Equities MCP · tokenized equities on Solana · read-only</span><span>Not financial advice.</span></div>
</div>
<script>
  var origin = window.location.origin;
  document.getElementById('endpoint').textContent = origin + '/mcp';
  document.getElementById('connectCode').textContent =
    JSON.stringify({{mcpServers: {{'equities-mcp': {{url: origin + '/mcp'}}}}}}, null, 2);
  fetch('/health').then(function(r) {{ return r.json(); }}).then(function(j) {{
    document.getElementById('dot').className = 'dot ok';
    document.getElementById('statusText').textContent = 'Live · ' + j.service + ' · ' + j.as_of;
  }}).catch(function() {{
    document.getElementById('dot').className = 'dot bad';
    document.getElementById('statusText').textContent = 'Health check failed';
  }});
</script>
</body>
</html>"""
    return page.encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # keep stdout clean
        pass

    def _send(self, code: int, body: bytes, ctype: str = "application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send(200, json.dumps({"ok": True, "service": "equities-mcp",
                                        "as_of": now_iso()}).encode())
        elif path in ("/", "/index.html"):
            self._send(200, portal_html(), "text/html; charset=utf-8")
        else:
            self._send(404, b'{"error":"not_found"}')

    def do_POST(self):
        if self.path != "/mcp":
            self._send(404, b'{"error":"not_found"}')
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            msg = json.loads(raw.decode() or "{}")
        except Exception:  # noqa: BLE001
            self._send(400, b'{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}')
            return
        if isinstance(msg, list):  # JSON-RPC batch
            replies = [r for r in (mcp_handle(m) for m in msg) if r is not None]
            self._send(200, json.dumps(replies).encode())
            return
        resp = mcp_handle(msg)
        if resp is None:
            self._send(202, b"")
        else:
            self._send(200, json.dumps(resp).encode())


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"equities-mcp listening on {HOST}:{PORT} (POST /mcp, GET /health, GET / portal)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

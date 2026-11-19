# equities-mcp — Tokenized Equities MCP (v1, read-only)

An MCP server for tokenized equities on Solana: which tokenized stocks
exist on-chain, what the token trades at vs the underlying stock vs the
24/7 perp, and on-chain mint truth — all read-only. No swap/trade tools,
no signing, no keys held by the server.

Implemented in **Python 3 stdlib only** (`server.py`, `http.server`-based,
minimal JSON-RPC MCP layer) so it runs anywhere with zero installs.

## The four legs

| Leg | Source | Auth | Used for |
|---|---|---|---|
| Stonk | `stonkfun.xyz/api/public/v1` (`/pairs?launchable=true` is the tokenized-stock catalog; `/tokens`, `/stats` also available) | none | which tokenized stocks exist on Solana, their mints |
| Backpack | `api.backpack.exchange` public REST | none (public market data only; authenticated trading is NOT enabled) | 24/7 equity perp marks + klines (`AAPL.US_USDC_PERP`, …) |
| Financial Datasets | `api.financialdatasets.ai` | `X-API-Key` from env `FINANCIAL_DATASETS_API_KEY` | underlying snapshot, financial metrics, company facts, earnings, news |
| Solana RPC | fleet helpers `~/workspace/solana-rpc/mainnet_rpc.py` (QuikNode), fallback `helius_mainnet_rpc.py`, via subprocess | endpoint URLs live in the helpers, never printed | mint/freeze authority, supply, largest accounts, wallet token accounts |

Plus Jupiter's public quote API (`lite-api.jup.ag`, keyless) for the
on-chain executable token price in `equities_quote`; it degrades to
null + note if unavailable.

Every tool response carries `source`, `as_of`, and `staleness_seconds`
where meaningful. A failed leg degrades to null + a note — never a crash.

## Tools (all `equities_`, all read-only)

- `equities_list {refresh?}` — the registry: ticker → `{fd_ticker,
  backpack_symbol, solana_mint, decimals, issuer, also_onchain[]}`.
  Built by intersecting Backpack equity-perp tickers (`*.US_USDC_PERP`)
  with the Stonk catalog (xStock symbols carry a trailing `x`:
  `NVDAX → NVDA`; Backpack Securities "Sunrise" entries carry the plain
  ticker). **Every mint is verified via RPC (getAccountInfo jsonParsed)
  before it enters the registry**; entries Stonk flags
  `symbolAmbiguous` are skipped. Cached to `registry.json` with a
  `generated_at` timestamp; pass `refresh: true` to rebuild.
- `equities_quote {ticker}` — the centerpiece: three-way comparison of
  FD underlying snapshot, Backpack perp mark, and on-chain token price
  (Jupiter token→USDC), reporting premium/discount in bps
  (onchain_vs_underlying, perp_vs_underlying, onchain_vs_perp).
- `equities_token_info {mint|ticker}` — supply, mint/freeze authorities,
  top holders, via RPC.
- `equities_fundamentals {ticker}` — FD metrics / facts / earnings /
  news. Without the FD key this returns a structured
  `financial_datasets_not_configured` error (not a crash).
- `equities_candles {ticker, source: fd|backpack, interval}` —
  source-labelled candles (Backpack: 24h window; FD: daily, 30d).
- `equities_wallet {address}` — the wallet's registry-token holdings,
  each valued at the on-chain price and (when FD is configured) the
  underlying price.
- `equities_market_status` — US market open/closed computed from
  America/New_York (09:30–16:00 ET, Mon–Fri; holidays not modelled) plus
  per-leg staleness notes.

## Run locally

```bash
cd ~/workspace/equities-mcp
python3 server.py            # binds 127.0.0.1:$PORT (default 8787)
curl localhost:8787/health
python3 smoke.py             # starts a throwaway server on :8791 and
                             # exercises initialize/tools/list/list/quote
```

The registry builds lazily on the first `equities_list` call if
`registry.json` is absent (takes ~1–2 min: one RPC verification per
candidate mint, plus retries against this VM's flaky egress — large
responses are reassembled via HTTP Range requests when truncated).

## Deploy notes

- The server binds `$HOST:$PORT` (defaults `127.0.0.1:8787`). On Render
  set `HOST=0.0.0.0`; Render injects `PORT` itself. `GET /` serves a
  portal page in the fleet MCP style; `GET /health` and `POST /mcp`
  are the machine surfaces.
- On hosts without the fleet RPC helper scripts, the Solana leg falls
  back to direct JSON-RPC: `$SOLANA_RPC_URL` if set (never printed),
  else the public mainnet endpoint.
- **Financial Datasets key:** set `FINANCIAL_DATASETS_API_KEY` as the
  service secret at deploy time. The key lives in the Railway
  `hedge-fund` project's production env (`hedge-fund-backend` service);
  the deploy step pulls it in-process from there and sets it directly
  into this service's secrets. It is never printed, never committed,
  and never stored in this repo. Without it the server still runs —
  FD-backed legs return `financial_datasets_not_configured`.
- The Solana RPC helpers must exist on the host at
  `~/workspace/solana-rpc/` (they read their endpoint files from
  `~/.config/solana-rpc/`, 0600).
- `registry.json` is a cache, safe to delete; it regenerates on demand.

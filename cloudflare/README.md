# equities-mcp — Cloudflare Worker port

A JavaScript (ES module) port of `../server.py` running as a Cloudflare
Worker, deployed while the Render workspace is out of build minutes. Same
surfaces and tool logic: `GET /` portal page, `GET /health`, `POST /mcp`
with the same 7 read-only `equities_*` tools. The registry is embedded in
`worker.js` (the current `../registry.json`, 17 tickers);
`equities_list {refresh: true}` rebuilds it in-memory and falls back to the
embedded copy on any error.

**Live:** https://equities-mcp.mynameisjeffspicoli.workers.dev
(portal at `/`, MCP endpoint at `/mcp`). The Render deployment
(https://equities-mcp-ac7p.onrender.com) remains the fallback — it is
untouched by this port.

## Deploy

```bash
python3 deploy.py
```

`deploy.py` uploads `worker.js` to Cloudflare account 1 as the script
`equities-mcp`, enables its workers.dev subdomain, and reads the bindings
back. **Always deploy through `deploy.py`** — see below.

## Secrets (runtime-read, never committed)

The worker needs two `secret_text` bindings, both read by `deploy.py`
in-process at deploy time and passed straight into the upload's bindings:

- `FINANCIAL_DATASETS_API_KEY` — pulled from the Railway `hedge-fund`
  project's production env (`hedge-fund-backend` service) via the Railway
  connector's GraphQL passthrough. If the pull fails, the deploy proceeds
  without it and the FD legs degrade to
  `financial_datasets_not_configured`.
- `SOLANA_RPC_URL` — read from `~/.config/solana-rpc/helius_url` (0600,
  the keyed Helius mainnet endpoint). A keyed RPC is required: the public
  mainnet endpoint is known to 403 from Workers.

Neither value is ever printed, logged, written to a file, or committed.

⚠️ **Re-deploys must go through `deploy.py`.** The secrets live only in
the upload's bindings — a bare re-upload of `worker.js` that omits them
would wipe both secrets from the live worker.

## Local test

```bash
SOLANA_RPC_URL=$(cat ~/.config/solana-rpc/helius_url) node test.mjs
```

Imports `worker.js` in Node and calls its `fetch` handler with a mock env:
health, portal, initialize/tools/list, all tools, error paths, and a full
`buildRegistry` run (Stonk × Backpack, RPC-verified — run it here, not
first live on the Worker, to stay clear of Worker CPU limits).

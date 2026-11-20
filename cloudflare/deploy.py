#!/usr/bin/env python3
"""Deploy the Equities MCP Cloudflare Worker (script name: equities-mcp)
to Cloudflare account 1 and enable its workers.dev subdomain.

IMPORTANT — secret bindings: the worker's secrets (FINANCIAL_DATASETS_API_KEY
and SOLANA_RPC_URL) are bound as secret_text bindings in the SAME multipart
upload as the code. A later bare re-upload that omits them would WIPE the
secrets. Always deploy through this script, never with a bare wrangler/API
upload that doesn't carry the bindings.

Secrets are read at deploy runtime, in this process only, and passed straight
into the bindings JSON. They are never printed, logged, written to a file, or
placed on a command line:
  1. FINANCIAL_DATASETS_API_KEY — pulled via the Railway connector's GraphQL
     passthrough from the hedge-fund project's production env
     (hedge-fund-backend service), where it already lives.
  2. SOLANA_RPC_URL — read from ~/.config/solana-rpc/helius_url (0600),
     the keyed Helius mainnet endpoint file.

If the Railway pull fails, the deploy proceeds WITHOUT the FD secret (the
worker degrades FD legs to financial_datasets_not_configured) and says so.

Cloudflare auth uses the custom.cloudflare surrogate credential; no token
is ever printed. No DNS records, zone routes, or custom domains are touched
— workers.dev only. The Render deployment remains the fallback.
"""
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = "https://api.cloudflare.com/client/v4"
ACCT = "7640372571bf2d69ed5d58a6a6d8929e"
SCRIPT = "equities-mcp"
HERE = os.path.dirname(os.path.abspath(__file__))

RAILWAY_PROJECT = "db925f27-ca0f-49d1-9647-bfa4a68b009f"
RAILWAY_SERVICE = "ab18fc89-d124-4f96-898d-168f99cc2d87"  # hedge-fund-backend
RAILWAY_ENV = "501b019e-e845-442b-822c-85e396584110"  # production
HELIUS_URL_FILE = os.path.expanduser("~/.config/solana-rpc/helius_url")


def api(method, path, body=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    headers = {"Accept": "application/json"}
    if data:
        headers["Content-Type"] = ctype
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    opener = urllib.request.build_opener()
    try:
        with opener.open(req, timeout=90) as resp:
            return read_json_response(resp)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"HTTP {exc.code} on {method} {path}: {exc.read().decode('utf-8', 'replace')[:500]}")


def pull_fd_key():
    """Return the Financial Datasets key from the Railway hedge-fund
    production env, in-process, or None on any failure. Never printed."""
    try:
        sys.path.insert(0, os.path.expanduser("~/workspace/custom-connectors/custom.railway/bin"))
        import railway

        query = (
            "query($proj: String!, $env: String!, $svc: String!) "
            "{ variables(projectId: $proj, environmentId: $env, serviceId: $svc) }"
        )
        status, payload = railway.gql(
            query,
            {"proj": RAILWAY_PROJECT, "env": RAILWAY_ENV, "svc": RAILWAY_SERVICE},
        )
        if status != 200:
            return None
        variables = (payload.get("data") or {}).get("variables") or {}
        key = variables.get("FINANCIAL_DATASETS_API_KEY")
        if isinstance(key, str) and key.strip():
            return key.strip()
        return None
    except Exception:  # noqa: BLE001 - any failure -> deploy without the secret
        return None


def main():
    worker_js = open(os.path.join(HERE, "worker.js")).read()
    print("worker.js:", len(worker_js), "bytes")

    bindings = []

    fd_key = pull_fd_key()
    if fd_key:
        bindings.append({"name": "FINANCIAL_DATASETS_API_KEY", "type": "secret_text", "text": fd_key})
        print("secret bound: FINANCIAL_DATASETS_API_KEY (from Railway hedge-fund env, in-process)")
    else:
        print("WARNING: Railway FD-key pull FAILED — deploying WITHOUT the "
              "FINANCIAL_DATASETS_API_KEY secret; FD legs will return "
              "financial_datasets_not_configured until a re-deploy with the key.")

    rpc_url = open(HELIUS_URL_FILE).read().strip()
    if not rpc_url:
        raise SystemExit("SOLANA_RPC_URL source file is empty; aborting")
    bindings.append({"name": "SOLANA_RPC_URL", "type": "secret_text", "text": rpc_url})
    print("secret bound: SOLANA_RPC_URL (from ~/.config/solana-rpc/helius_url, in-process)")

    metadata = {
        "main_module": "worker.js",
        "compatibility_date": "2025-01-01",
        "bindings": bindings,
    }
    boundary = "----equitiesmcp" + uuid.uuid4().hex
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(metadata)}\r\n")
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"worker.js\"; filename=\"worker.js\"\r\nContent-Type: application/javascript+module\r\n\r\n{worker_js}\r\n")
    parts.append(f"--{boundary}--\r\n")
    body = "".join(parts).encode()
    up = api("PUT", f"/accounts/{ACCT}/workers/scripts/{SCRIPT}", raw=body,
             ctype=f"multipart/form-data; boundary={boundary}")
    result = up.get("result") or {}
    print("worker uploaded: success =", up.get("success"), "| id:", result.get("id"),
          "| etag:", result.get("etag"), "| modified_on:", result.get("modified_on"))

    sub = api("POST", f"/accounts/{ACCT}/workers/scripts/{SCRIPT}/subdomain", {"enabled": True})
    print("workers.dev subdomain enabled:", sub.get("success"), json.dumps(sub.get("result")))

    st = api("GET", f"/accounts/{ACCT}/workers/scripts/{SCRIPT}/settings")
    names = [(b.get("name"), b.get("type")) for b in (st.get("result") or {}).get("bindings", [])]
    print("bindings read back (name, type):", names)
    print("URL: https://equities-mcp.mynameisjeffspicoli.workers.dev")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Smoke test for equities-mcp.

Starts the server on a test port, then calls:
  initialize, tools/list, equities_list, equities_quote (AAPL if mapped,
  else the first registry ticker), equities_market_status.
Prints the raw results as evidence. Stdlib only.

Usage: python3 smoke.py [port]
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
BASE = f"http://127.0.0.1:{PORT}"


def post(payload, timeout=600):
    req = urllib.request.Request(
        BASE + "/mcp",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def call_tool(name, args):
    resp = post({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                 "params": {"name": name, "arguments": args}})
    result = resp.get("result") or {}
    text = (result.get("content") or [{}])[0].get("text", "{}")
    return json.loads(text), result.get("isError", False)


def main():
    env = dict(os.environ, PORT=str(PORT))
    env.pop("FINANCIAL_DATASETS_API_KEY", None)  # FD leg must show not_configured
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "server.py")],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        for _ in range(50):
            try:
                with urllib.request.urlopen(BASE + "/health", timeout=3) as r:
                    print("HEALTH:", r.read().decode())
                break
            except Exception:
                time.sleep(0.4)
        else:
            print("FAIL: server did not come up")
            return 1

        init = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": {"protocolVersion": "2025-03-26"}})
        print("INIT serverInfo:", (init.get("result") or {}).get("serverInfo"))

        lst = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tools = [t["name"] for t in (lst.get("result") or {}).get("tools", [])]
        print(f"TOOLS ({len(tools)}):", tools)
        assert len(tools) == 7, "expected 7 tools"

        reg, err = call_tool("equities_list", {})
        assert not err, f"equities_list errored: {reg}"
        tickers = sorted((reg.get("tickers") or {}).keys())
        print(f"REGISTRY count={reg.get('count')} generated_at={reg.get('registry_generated_at')}")
        for t in tickers:
            e = reg["tickers"][t]
            m = e["solana_mint"]
            print(f"  {t:6s} mint={m[:6]}..{m[-4:]} issuer={e['issuer']} "
                  f"decimals={e['decimals']} backpack={e['backpack_symbol']} "
                  f"alts={len(e.get('also_onchain') or [])}")

        target = "AAPL" if "AAPL" in tickers else (tickers[0] if tickers else None)
        if target:
            q, err = call_tool("equities_quote", {"ticker": target})
            print(f"QUOTE {target} (isError={err}):")
            print(json.dumps(q, indent=1))
        else:
            print("QUOTE: registry empty, nothing to quote")

        st, _ = call_tool("equities_market_status", {})
        print("MARKET STATUS:", json.dumps(st))
        print("SMOKE DONE")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())

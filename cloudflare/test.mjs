// Local Node test harness for the Cloudflare Worker port.
//
// Usage:
//   SOLANA_RPC_URL=$(cat ~/.config/solana-rpc/helius_url) node test.mjs
//   (optionally also FINANCIAL_DATASETS_API_KEY=... to exercise the FD leg)
//
// The env values are read by the shell into this process only; this harness
// never prints them. Without SOLANA_RPC_URL the RPC-dependent checks run
// against the public endpoint and may fail (known 403s) — they are reported
// as warnings, not failures, in that case. buildRegistry is exercised here
// in Node (never first-run live on the Worker; CPU limits).

import worker, { buildRegistry, EMBEDDED_REGISTRY } from "./worker.js";

const env = {
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || "",
  FINANCIAL_DATASETS_API_KEY: process.env.FINANCIAL_DATASETS_API_KEY || "",
};
const hasRpc = Boolean(env.SOLANA_RPC_URL);
const hasFd = Boolean(env.FINANCIAL_DATASETS_API_KEY);
console.log(`env: SOLANA_RPC_URL ${hasRpc ? "set" : "UNSET (public fallback)"}; FD key ${hasFd ? "set" : "UNSET (not_configured path)"}`);

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}
function warn(name, detail = "") {
  console.log(`WARN  ${name}${detail ? " — " + detail : ""}`);
}

async function req(method, path, body) {
  const r = new Request(`http://local${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return worker.fetch(r, env);
}

async function callTool(name, args, id = 99) {
  const resp = await req("POST", "/mcp", {
    jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
  });
  const j = await resp.json();
  const result = j.result || {};
  const text = (result.content || [{}])[0].text || "{}";
  return { parsed: JSON.parse(text), isError: result.isError, raw: j, structured: result.structuredContent };
}

// /health
{
  const resp = await req("GET", "/health");
  const j = await resp.json();
  check("GET /health", resp.status === 200 && j.ok === true && j.service === "equities-mcp", JSON.stringify(j));
}

// portal
{
  const resp = await req("GET", "/");
  const html = await resp.text();
  check("GET / portal", resp.status === 200 && html.includes("Tokenized equities") && html.includes("17 tickers"),
    `status=${resp.status} bytes=${html.length}`);
}

// initialize + ping + tools/list
{
  const resp = await req("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  const j = await resp.json();
  check("initialize", j.result?.serverInfo?.name === "equities-mcp", JSON.stringify(j.result?.serverInfo));

  const resp2 = await req("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (await resp2.json()).result?.tools || [];
  const names = tools.map((t) => t.name);
  check("tools/list = 7 equities_*", tools.length === 7 && names.every((n) => n.startsWith("equities_")), names.join(","));
  check("tools/list annotations", tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false && t.annotations?.idempotentHint === true));
}

// notification -> 202, batch
{
  const resp = await req("POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
  check("notification -> 202", resp.status === 202, `status=${resp.status}`);
  const respB = await req("POST", "/mcp", [
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]);
  const arr = await respB.json();
  check("batch", Array.isArray(arr) && arr.length === 1 && arr[0].id === 1, JSON.stringify(arr).slice(0, 120));
}

// equities_list (embedded)
{
  const { parsed, isError } = await callTool("equities_list", {});
  check("equities_list count=17", !isError && parsed.count === 17, `count=${parsed.count} generated_at=${parsed.registry_generated_at} staleness=${parsed.staleness_seconds}`);
}

// equities_market_status
{
  const { parsed, isError } = await callTool("equities_market_status", {});
  check("equities_market_status", !isError && typeof parsed.us_market_open === "boolean" && String(parsed.et_now).includes("America/New_York"),
    `et_now=${parsed.et_now} open=${parsed.us_market_open}`);
}

// equities_quote AAPL
{
  const { parsed, isError } = await callTool("equities_quote", { ticker: "AAPL" });
  const legs = parsed.legs || {};
  console.log("QUOTE AAPL:", JSON.stringify(parsed.premium_discount_bps || {}),
    "underlying=", legs.underlying?.price_usd, "perp=", legs.backpack_perp?.mark_price_usd,
    "onchain=", legs.onchain_token?.price_usd,
    hasFd ? "" : `(FD leg error=${legs.underlying?.error})`);
  check("equities_quote not error", !isError);
  check("quote backpack leg priced", typeof legs.backpack_perp?.mark_price_usd === "number");
  check("quote onchain leg priced", typeof legs.onchain_token?.price_usd === "number");
  check("quote onchain_vs_perp non-null", parsed.premium_discount_bps?.onchain_vs_perp !== null && parsed.premium_discount_bps?.onchain_vs_perp !== undefined);
  if (hasFd) {
    check("quote FD leg priced", typeof legs.underlying?.price_usd === "number");
    check("quote onchain_vs_underlying non-null", parsed.premium_discount_bps?.onchain_vs_underlying !== null);
  } else {
    check("quote FD leg degrades to not_configured", legs.underlying?.error === "financial_datasets_not_configured", `error=${legs.underlying?.error}`);
  }
}

// equities_token_info AAPL (RPC-dependent)
{
  const { parsed, isError } = await callTool("equities_token_info", { ticker: "AAPL" });
  if (isError && !hasRpc) warn("equities_token_info (no keyed RPC)", parsed.note || "");
  else check("equities_token_info AAPL", !isError && parsed.decimals === 6 && Array.isArray(parsed.top_holders),
    `decimals=${parsed.decimals} supply_ui=${parsed.supply_ui} holders=${(parsed.top_holders || []).length}`);
}

// equities_candles backpack
{
  const { parsed, isError } = await callTool("equities_candles", { ticker: "AAPL", source: "backpack" });
  check("equities_candles backpack", !isError && Array.isArray(parsed.candles) && parsed.candles.length > 0,
    `candles=${(parsed.candles || []).length}`);
}

// equities_fundamentals without FD key -> structured not_configured (not isError)
if (!hasFd) {
  const { parsed, isError } = await callTool("equities_fundamentals", { ticker: "AAPL" });
  check("equities_fundamentals not_configured", !isError && parsed.error === "financial_datasets_not_configured", `error=${parsed.error}`);
}

// unknown tool / unknown ticker
{
  const resp = await req("POST", "/mcp", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope", arguments: {} } });
  const j = await resp.json();
  check("unknown tool -> -32602", j.error?.code === -32602);
  const { isError } = await callTool("equities_quote", { ticker: "ZZZZ" });
  check("unknown ticker -> isError", isError === true);
}

// buildRegistry in Node (Stonk x Backpack, RPC-verify)
{
  const t0 = Date.now();
  try {
    const doc = await buildRegistry(env);
    const tickers = Object.keys(doc.tickers || {});
    console.log(`buildRegistry: ${tickers.length} tickers in ${Math.round((Date.now() - t0) / 1000)}s: ${tickers.join(",")}`);
    const embedded = Object.keys(EMBEDDED_REGISTRY.tickers);
    const missing = embedded.filter((t) => !tickers.includes(t));
    const extra = tickers.filter((t) => !embedded.includes(t));
    if (missing.length || extra.length) warn("buildRegistry set differs from embedded", `missing=${missing.join(",") || "-"} extra=${extra.join(",") || "-"}`);
    if (hasRpc) check("buildRegistry >= 15 tickers incl AAPL/NVDA", tickers.length >= 15 && tickers.includes("AAPL") && tickers.includes("NVDA"));
    else warn("buildRegistry count (no keyed RPC)", `${tickers.length}`);
  } catch (e) {
    if (hasRpc) check("buildRegistry completes", false, String(e.message || e).slice(0, 200));
    else warn("buildRegistry failed without keyed RPC", String(e.message || e).slice(0, 200));
  }
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

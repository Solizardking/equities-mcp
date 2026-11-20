// Tokenized Equities MCP server (v1, read-only) — Cloudflare Worker port
// of ../server.py (Python stdlib). Same surfaces: GET / portal page,
// GET /health, POST /mcp (MCP Streamable HTTP, JSON-RPC).
//
// Four data legs:
//   1. Stonk            - on-chain tokenized-stock catalog (public API, no key)
//   2. Backpack         - 24/7 equity perp price discovery (public API, no key)
//   3. Financial Datasets - underlying stock data (X-API-Key from env only)
//   4. Solana RPC       - direct JSON-RPC over HTTPS ($SOLANA_RPC_URL)
// Plus Jupiter's public quote API for the on-chain executable token price.
//
// Read-only: no signing, no keys held beyond the two read secrets bound at
// deploy time (FINANCIAL_DATASETS_API_KEY, SOLANA_RPC_URL). A failed leg
// degrades to null + a note — never a crash, never a fabricated number.

const STONK_BASE = "https://stonkfun.xyz/api/public/v1"; // apex host (www 301s here)
const BACKPACK_BASE = "https://api.backpack.exchange";
const FD_BASE = "https://api.financialdatasets.ai";
const JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const UA = { "User-Agent": "equities-mcp/0.1" };

// Embedded registry: the current registry.json (17 tickers, RPC-verified
// 2026-11-19). Served by default; equities_list {refresh:true} rebuilds it
// in-memory via buildRegistry() and falls back to this on any error.
const EMBEDDED_REGISTRY = {"generated_at": "2026-11-19T19:02:04.330818+00:00", "tickers": {"AAPL": {"ticker": "AAPL", "fd_ticker": "AAPL", "backpack_symbol": "AAPL.US_USDC_PERP", "solana_mint": "AAPLEDt8RpzPgXyhvFzkMBofvFSQw9gpeMCoUdPdLnB8", "decimals": 6, "issuer": "Sunrise", "stonk_symbol": "AAPL", "name": "Apple", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [], "verified_at": "2026-11-19T19:00:42.115983+00:00"}, "AMD": {"ticker": "AMD", "fd_ticker": "AMD", "backpack_symbol": "AMD.US_USDC_PERP", "solana_mint": "AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES", "decimals": 6, "issuer": "Sunrise", "stonk_symbol": "AMD", "name": "Advanced Micro Devices", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [], "verified_at": "2026-11-19T19:00:45.912720+00:00"}, "AMZN": {"ticker": "AMZN", "fd_ticker": "AMZN", "backpack_symbol": "AMZN.US_USDC_PERP", "solana_mint": "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", "decimals": 8, "issuer": "xStock", "stonk_symbol": "AMZNX", "name": "AMAZON", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [{"solana_mint": "AMZNw7cwU9L9c7ewZXxTws2PwQYxBGm2Rxg3FLDBJz9B", "stonk_symbol": "AMZN", "issuer": "Sunrise", "name": "Amazon", "decimals": 6, "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"}], "verified_at": "2026-11-19T19:00:52.318389+00:00"}, "CRCL": {"ticker": "CRCL", "fd_ticker": "CRCL", "backpack_symbol": "CRCL.US_USDC_PERP", "solana_mint": "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1", "decimals": 8, "issuer": "xStock", "stonk_symbol": "CRCLX", "name": "CIRCLE", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [], "verified_at": "2026-11-19T19:00:55.048335+00:00"}, "DRAM": {"ticker": "DRAM", "fd_ticker": "DRAM", "backpack_symbol": "DRAM.US_USDC_PERP", "solana_mint": "DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw", "decimals": 6, "issuer": "Sunrise", "stonk_symbol": "DRAM", "name": "DRAM", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [], "verified_at": "2026-11-19T19:00:59.416971+00:00"}, "GOOGL": {"ticker": "GOOGL", "fd_ticker": "GOOGL", "backpack_symbol": "GOOGL.US_USDC_PERP", "solana_mint": "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", "decimals": 8, "issuer": "xStock", "stonk_symbol": "GOOGLX", "name": "GOOGLE", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [{"solana_mint": "GooGLMvZtJZXHdNZy95RUrAMCCKxV6ghK3qE5ddBgVm5", "stonk_symbol": "GOOGL", "issuer": "Sunrise", "name": "Alphabet", "decimals": 6, "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"}], "verified_at": "2026-11-19T19:01:05.443970+00:00"}, "HOOD": {"ticker": "HOOD", "fd_ticker": "HOOD", "backpack_symbol": "HOOD.US_USDC_PERP", "solana_mint": "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg", "decimals": 8, "issuer": "xStock", "stonk_symbol": "HOODX", "name": "HOOD", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [], "verified_at": "2026-11-19T19:01:09.934404+00:00"}, "INTC": {"ticker": "INTC", "fd_ticker": "INTC", "backpack_symbol": "INTC.US_USDC_PERP", "solana_mint": "XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM", "decimals": 8, "issuer": "xStock", "stonk_symbol": "INTCX", "name": "INTC", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [], "verified_at": "2026-11-19T19:01:14.002118+00:00"}, "META": {"ticker": "META", "fd_ticker": "META", "backpack_symbol": "META.US_USDC_PERP", "solana_mint": "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", "decimals": 8, "issuer": "xStock", "stonk_symbol": "METAX", "name": "META", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [], "verified_at": "2026-11-19T19:01:17.150026+00:00"}, "MSFT": {"ticker": "MSFT", "fd_ticker": "MSFT", "backpack_symbol": "MSFT.US_USDC_PERP", "solana_mint": "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", "decimals": 8, "issuer": "xStock", "stonk_symbol": "MSFTX", "name": "MSFT", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [{"solana_mint": "MSFThX899B1DddH5jkyMpdArWXzP85VXLYDrbGGcRJM", "stonk_symbol": "MSFT", "issuer": "Sunrise", "name": "Microsoft", "decimals": 6, "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"}], "verified_at": "2026-11-19T19:01:24.123834+00:00"}, "MU": {"ticker": "MU", "fd_ticker": "MU", "backpack_symbol": "MU.US_USDC_PERP", "solana_mint": "MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1", "decimals": 6, "issuer": "Sunrise", "stonk_symbol": "MU", "name": "Micron", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [], "verified_at": "2026-11-19T19:01:27.484344+00:00"}, "NVDA": {"ticker": "NVDA", "fd_ticker": "NVDA", "backpack_symbol": "NVDA.US_USDC_PERP", "solana_mint": "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", "decimals": 8, "issuer": "xStock", "stonk_symbol": "NVDAX", "name": "NVIDIA", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [{"solana_mint": "NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv", "stonk_symbol": "NVDA", "issuer": "Sunrise", "name": "Nvidia", "decimals": 6, "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"}], "verified_at": "2026-11-19T19:01:35.072570+00:00"}, "QQQ": {"ticker": "QQQ", "fd_ticker": "QQQ", "backpack_symbol": "QQQ.US_USDC_PERP", "solana_mint": "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", "decimals": 8, "issuer": "xStock", "stonk_symbol": "QQQX", "name": "QQQ", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [{"solana_mint": "QQQvDYxG7g11Rr4rnaJqDddmP9ocH74YhE3mDaG37R9", "stonk_symbol": "QQQ", "issuer": "Sunrise", "name": "QQQ", "decimals": 6, "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"}], "verified_at": "2026-11-19T19:01:41.230969+00:00"}, "SKHY": {"ticker": "SKHY", "fd_ticker": "SKHY", "backpack_symbol": "SKHY.US_USDC_PERP", "solana_mint": "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3", "decimals": 6, "issuer": "Sunrise", "stonk_symbol": "SKHY", "name": "SKHYNIX", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [], "verified_at": "2026-11-19T19:01:44.277508+00:00"}, "SPCX": {"ticker": "SPCX", "fd_ticker": "SPCX", "backpack_symbol": "SPCX.US_USDC_PERP", "solana_mint": "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8", "decimals": 8, "issuer": "xStock", "stonk_symbol": "SPCXX", "name": "SPACEX", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [], "verified_at": "2026-11-19T19:01:48.026739+00:00"}, "SPY": {"ticker": "SPY", "fd_ticker": "SPY", "backpack_symbol": "SPY.US_USDC_PERP", "solana_mint": "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", "decimals": 8, "issuer": "xStock", "stonk_symbol": "SPYX", "name": "SP500", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [{"solana_mint": "SPYBo66VJPFjh1pXMb9Le53kDYWTK1zzYVDeVRWtsbi", "stonk_symbol": "SPY", "issuer": "Sunrise", "name": "State Street SPDR S&P 500 ETF Trust", "decimals": 6, "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"}], "verified_at": "2026-11-19T19:01:55.984188+00:00"}, "TSLA": {"ticker": "TSLA", "fd_ticker": "TSLA", "backpack_symbol": "TSLA.US_USDC_PERP", "solana_mint": "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", "decimals": 8, "issuer": "xStock", "stonk_symbol": "TSLAX", "name": "TESLA", "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "also_onchain": [{"solana_mint": "TSLAqBbv4CNCnzWFeB7LmydAyEiNMJtve7DYKLpdK4S", "stonk_symbol": "TSLA", "issuer": "Sunrise", "name": "TSLA", "decimals": 6, "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"}], "verified_at": "2026-11-19T19:02:04.330788+00:00"}}};

let _registryCache = null; // last successfully built/served registry doc

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpGetJson(url, headers = {}, timeoutMs = 25000) {
  const hdrs = { ...UA, ...headers };
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: hdrs,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url.split("?")[0]}`);
      return await resp.json();
    } catch (e) {
      lastErr = e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw new Error(`GET failed: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}

// ---------------------------------------------------------------------------
// Solana RPC (direct HTTPS; endpoint from env, never printed)
// ---------------------------------------------------------------------------

async function rpc(env, method, params) {
  const url =
    (env && env.SOLANA_RPC_URL ? String(env.SOLANA_RPC_URL).trim() : "") ||
    "https://api.mainnet-beta.solana.com";
  let out;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...UA, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30000),
    });
    out = await resp.json();
  } catch (e) {
    throw new Error(`solana_rpc_unavailable: direct: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
  }
  if (out && out.error) {
    throw new Error(`solana_rpc_unavailable: ${JSON.stringify(out.error).slice(0, 200)}`);
  }
  return out ? out.result : null;
}

// ---------------------------------------------------------------------------
// Financial Datasets leg (key from env only; absent -> structured error)
// ---------------------------------------------------------------------------

class FDNotConfigured extends Error {
  constructor() {
    super(
      "Financial Datasets leg is not configured: FINANCIAL_DATASETS_API_KEY " +
        "is not set in this service's environment."
    );
    this.code = "financial_datasets_not_configured";
  }
}

async function fdGet(env, path, params) {
  const key = env && env.FINANCIAL_DATASETS_API_KEY ? String(env.FINANCIAL_DATASETS_API_KEY).trim() : "";
  if (!key) throw new FDNotConfigured();
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${FD_BASE}${path}?${qs}` : `${FD_BASE}${path}`;
  return httpGetJson(url, { "X-API-Key": key });
}

async function fdSnapshot(env, ticker) {
  const body = await fdGet(env, "/prices/snapshot/", { ticker });
  if (body && typeof body === "object") return body.snapshot || body;
  return body;
}

// ---------------------------------------------------------------------------
// Stonk + Backpack legs and the registry build
// ---------------------------------------------------------------------------

async function stonkPairs() {
  const body = await httpGetJson(`${STONK_BASE}/pairs?launchable=true`);
  return ((body && body.data) || {}).pairs || [];
}

async function backpackEquityPerps() {
  const markets = await httpGetJson(`${BACKPACK_BASE}/api/v1/markets`);
  const out = {};
  for (const m of markets || []) {
    const sym = m.symbol || "";
    if (sym.endsWith(".US_USDC_PERP")) out[sym.split(".")[0]] = sym;
  }
  return out;
}

async function backpackMark(symbol) {
  const t = await httpGetJson(
    `${BACKPACK_BASE}/api/v1/ticker?symbol=${encodeURIComponent(symbol)}`
  );
  for (const field of ["markPrice", "lastPrice", "indexPrice"]) {
    const v = t ? t[field] : null;
    if (v !== null && v !== undefined && v !== "" && v !== "0") {
      const n = Number(v);
      if (!Number.isNaN(n)) return [n, field];
    }
  }
  return [null, null];
}

// Map a Stonk pair entry to candidate underlying tickers. xstock entries
// carry the ticker with a trailing 'x' (NVDAX -> NVDA); Backpack Securities
// ('Sunrise') entries carry the plain ticker (NVDA).
function stonkTickerCandidates(pair) {
  const sym = String(pair.symbol || "").toUpperCase();
  const cat = String(pair.category || "").toLowerCase();
  const cands = [];
  if (cat === "xstock" && sym.endsWith("X") && sym.length > 2) cands.push(sym.slice(0, -1));
  cands.push(sym);
  return cands;
}

// Issuer preference when several on-chain versions of one ticker exist.
const CATEGORY_RANK = { xstock: 0, backpack: 1, "backpack-securities": 1 };

async function verifyMint(env, mint) {
  const info = await rpc(env, "getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  if (!info || !info.value) return null;
  const parsed = (((info.value.data || {}).parsed || {}).info || {});
  if (!("decimals" in parsed)) return null;
  return {
    decimals: parsed.decimals,
    supply_raw: parsed.supply,
    mint_authority: parsed.mintAuthority ?? null,
    freeze_authority: parsed.freezeAuthority ?? null,
    owner_program: info.value.owner,
  };
}

async function buildRegistry(env) {
  const started = Date.now();
  const BUDGET_MS = 45000; // soft budget; caller falls back on timeout
  const perps = await backpackEquityPerps();
  const pairs = await stonkPairs();

  const byTicker = {};
  for (const pair of pairs) {
    if (pair.symbolAmbiguous) continue;
    for (const cand of stonkTickerCandidates(pair)) {
      if (cand in perps) {
        (byTicker[cand] = byTicker[cand] || []).push(pair);
        break;
      }
    }
  }
  for (const entries of Object.values(byTicker)) {
    entries.sort(
      (a, b) =>
        (CATEGORY_RANK[String(a.category || "").toLowerCase()] ?? 9) -
        (CATEGORY_RANK[String(b.category || "").toLowerCase()] ?? 9)
    );
  }

  const registry = {};
  for (const ticker of Object.keys(byTicker).sort()) {
    if (Date.now() - started > BUDGET_MS) throw new Error("registry build timed out");
    const verified = [];
    for (const pair of byTicker[ticker].slice(0, 3)) {
      const mint = pair.mint;
      if (!mint) continue;
      let v = null;
      try {
        v = await verifyMint(env, mint);
      } catch {
        v = null; // unverifiable mints never enter
      }
      if (v === null) continue;
      verified.push({
        solana_mint: mint,
        stonk_symbol: pair.symbol,
        issuer: pair.categoryLabel || pair.category,
        name: pair.name,
        decimals: v.decimals,
        token_program: v.owner_program,
      });
    }
    if (!verified.length) continue;
    const primary = verified[0];
    registry[ticker] = {
      ticker,
      fd_ticker: ticker,
      backpack_symbol: perps[ticker],
      solana_mint: primary.solana_mint,
      decimals: primary.decimals,
      issuer: primary.issuer,
      stonk_symbol: primary.stonk_symbol,
      name: primary.name,
      token_program: primary.token_program,
      also_onchain: verified.slice(1),
      verified_at: nowIso(),
    };
  }
  return { generated_at: nowIso(), tickers: registry };
}

function loadRegistry() {
  if (_registryCache) return _registryCache;
  _registryCache = EMBEDDED_REGISTRY;
  return _registryCache;
}

function registryAgeSeconds(doc) {
  try {
    const gen = Date.parse(doc.generated_at);
    if (Number.isNaN(gen)) return null;
    return Math.max(0, Math.floor((Date.now() - gen) / 1000));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Jupiter on-chain executable price
// ---------------------------------------------------------------------------

async function jupiterPriceUsd(mint, decimals) {
  const amount = 10 ** decimals; // exactly 1.0 token
  const qs = new URLSearchParams({
    inputMint: mint,
    outputMint: USDC_MINT,
    amount: String(amount),
    slippageBps: "50",
  }).toString();
  const body = await httpGetJson(`${JUP_QUOTE}?${qs}`, {}, 20000);
  const out = body ? body.outAmount : null;
  if (out === null || out === undefined) return null;
  return Number(out) / 1e6;
}

function bps(a, b) {
  if (a === null || a === undefined || b === null || b === undefined || b === 0) return null;
  return Math.round(((a - b) / b) * 10000 * 10) / 10;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function entry(doc, ticker) {
  const tickers = doc.tickers || {};
  const t = String(ticker || "").toUpperCase();
  if (!(t in tickers)) {
    throw new Error(`unknown ticker '${ticker}'; registry has: ${Object.keys(tickers).sort().join(", ")}`);
  }
  return tickers[t];
}

async function toolEquitiesList(args, env) {
  let doc = loadRegistry();
  let note;
  if (args && args.refresh) {
    try {
      doc = await buildRegistry(env);
      _registryCache = doc;
    } catch (e) {
      doc = EMBEDDED_REGISTRY;
      note = `registry rebuild failed (${String(e && e.message ? e.message : e).slice(0, 200)}); served the embedded registry`;
    }
  }
  const out = {
    source: "registry (Stonk pairs x Backpack equity perps, RPC-verified)",
    as_of: nowIso(),
    registry_generated_at: doc.generated_at,
    staleness_seconds: registryAgeSeconds(doc),
    count: Object.keys(doc.tickers || {}).length,
    tickers: doc.tickers || {},
  };
  if (note) out.note = note;
  return out;
}

async function toolEquitiesQuote(args, env) {
  const doc = loadRegistry();
  const e = entry(doc, (args && args.ticker) || "");
  const as_of = nowIso();
  const legs = {};
  let underlying = null;

  // Leg 1: Financial Datasets underlying snapshot
  try {
    const snap = await fdSnapshot(env, e.fd_ticker);
    const price = snap && typeof snap === "object" ? snap.price : null;
    underlying = price !== null && price !== undefined ? Number(price) : null;
    legs.underlying = {
      source: "financialdatasets.ai /prices/snapshot/",
      as_of,
      price_usd: underlying,
      day_change_percent: snap && typeof snap === "object" ? (snap.day_change_percent ?? null) : null,
    };
  } catch (exc) {
    if (exc && exc.code === "financial_datasets_not_configured") {
      legs.underlying = { source: "financialdatasets.ai", as_of, price_usd: null, error: exc.code, note: String(exc.message) };
    } else {
      legs.underlying = { source: "financialdatasets.ai", as_of, price_usd: null, error: "leg_failed", note: String(exc && exc.message ? exc.message : exc).slice(0, 200) };
    }
  }

  // Leg 2: Backpack perp mark
  let perp = null;
  try {
    const [mark, field] = await backpackMark(e.backpack_symbol);
    perp = mark;
    legs.backpack_perp = {
      source: `backpack.exchange ticker (${field})`,
      as_of,
      symbol: e.backpack_symbol,
      mark_price_usd: perp,
    };
  } catch (exc) {
    legs.backpack_perp = { source: "backpack.exchange", as_of, symbol: e.backpack_symbol, mark_price_usd: null, error: "leg_failed", note: String(exc && exc.message ? exc.message : exc).slice(0, 200) };
  }

  // Leg 3: on-chain executable price via Jupiter
  let onchain = null;
  try {
    onchain = await jupiterPriceUsd(e.solana_mint, e.decimals);
    legs.onchain_token = { source: "jupiter lite-api quote (token->USDC)", as_of, mint: e.solana_mint, price_usd: onchain };
  } catch (exc) {
    legs.onchain_token = { source: "jupiter lite-api quote", as_of, mint: e.solana_mint, price_usd: null, error: "leg_failed", note: String(exc && exc.message ? exc.message : exc).slice(0, 200) };
  }

  return {
    source: "equities_quote (three-way)",
    as_of,
    ticker: e.ticker,
    mint: e.solana_mint,
    issuer: e.issuer,
    legs,
    premium_discount_bps: {
      onchain_vs_underlying: bps(onchain, underlying),
      perp_vs_underlying: bps(perp, underlying),
      onchain_vs_perp: bps(onchain, perp),
    },
    note: "bps legs are null when a leg is unavailable (e.g. FD not configured).",
  };
}

async function toolEquitiesTokenInfo(args, env) {
  const doc = loadRegistry();
  let mint = args && args.mint;
  let ent = null;
  if (!mint && args && args.ticker) {
    ent = entry(doc, args.ticker);
    mint = ent.solana_mint;
  }
  if (!mint) throw new Error("provide 'mint' or a registry 'ticker'");
  const as_of = nowIso();
  const v = await verifyMint(env, mint);
  if (v === null) throw new Error(`mint ${mint} not found / not a token mint on mainnet`);
  await rpc(env, "getTokenSupply", [mint]); // parity with the Python leg (result unused there too)
  const largest = await rpc(env, "getTokenLargestAccounts", [mint]);
  const holders = [];
  for (const h of ((largest || {}).value || []).slice(0, 10)) {
    holders.push({ address: h.address, ui_amount: h.uiAmount });
  }
  const dec = v.decimals;
  let supplyUi = null;
  const rawNum = Number(v.supply_raw);
  if (!Number.isNaN(rawNum)) supplyUi = rawNum / 10 ** dec;
  return {
    source: "solana rpc (getAccountInfo/getTokenSupply/getTokenLargestAccounts)",
    as_of,
    mint,
    ticker: ent ? ent.ticker : null,
    decimals: dec,
    supply_ui: supplyUi,
    supply_raw: v.supply_raw,
    mint_authority: v.mint_authority,
    freeze_authority: v.freeze_authority,
    token_program: v.owner_program,
    top_holders: holders,
  };
}

async function toolEquitiesFundamentals(args, env) {
  const ticker = String((args && args.ticker) || "").toUpperCase();
  if (!ticker) throw new Error("provide 'ticker'");
  const as_of = nowIso();
  try {
    const out = { source: "financialdatasets.ai", as_of, ticker };
    const metrics = await fdGet(env, "/financial-metrics/", { ticker, limit: 1 });
    out.financial_metrics = metrics && typeof metrics === "object" ? metrics.financial_metrics : metrics;
    const facts = await fdGet(env, "/company/facts/", { ticker });
    out.company_facts = facts && typeof facts === "object" ? facts.company_facts : facts;
    const earn = await fdGet(env, "/earnings/", { ticker, limit: 4 });
    out.earnings = earn && typeof earn === "object" ? earn.earnings : earn;
    const news = await fdGet(env, "/news/", { ticker, limit: 5 });
    out.news = news && typeof news === "object" ? news.news : news;
    return out;
  } catch (exc) {
    if (exc && exc.code === "financial_datasets_not_configured") {
      return { source: "financialdatasets.ai", as_of, ticker, error: exc.code, note: String(exc.message) };
    }
    throw exc;
  }
}

async function toolEquitiesCandles(args, env) {
  const doc = loadRegistry();
  const e = entry(doc, (args && args.ticker) || "");
  const source = String((args && args.source) || "backpack").toLowerCase();
  const interval = (args && args.interval) || "1h";
  const as_of = nowIso();
  if (source === "backpack") {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 24 * 3600;
    const qs = new URLSearchParams({
      symbol: e.backpack_symbol,
      interval,
      startTime: String(start),
      endTime: String(end),
    }).toString();
    const rows = await httpGetJson(`${BACKPACK_BASE}/api/v1/klines?${qs}`);
    const candles = (rows || []).map((r) => ({
      t: r.start, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume,
    }));
    return { source: "backpack.exchange klines", as_of, ticker: e.ticker, interval, candles };
  }
  if (source === "fd") {
    try {
      const endD = new Date();
      const startD = new Date(endD.getTime() - 30 * 24 * 3600 * 1000);
      const iso = (d) => d.toISOString().slice(0, 10);
      const body = await fdGet(env, "/prices/", {
        ticker: e.fd_ticker,
        interval: "day",
        interval_multiplier: 1,
        start_date: iso(startD),
        end_date: iso(endD),
      });
      const rows = body && typeof body === "object" ? body.prices : body;
      return { source: "financialdatasets.ai /prices/", as_of, ticker: e.ticker, interval: "day", candles: rows };
    } catch (exc) {
      if (exc && exc.code === "financial_datasets_not_configured") {
        return { source: "financialdatasets.ai", as_of, ticker: e.ticker, error: exc.code, note: String(exc.message) };
      }
      throw exc;
    }
  }
  throw new Error("source must be 'fd' or 'backpack'");
}

async function toolEquitiesWallet(args, env) {
  const address = args && args.address;
  if (!address) throw new Error("provide 'address'");
  const doc = loadRegistry();
  const byMint = {};
  for (const e of Object.values(doc.tickers || {})) byMint[e.solana_mint] = e;
  const as_of = nowIso();
  const positions = [];
  for (const program of [TOKEN_PROGRAM, TOKEN2022_PROGRAM]) {
    const res = await rpc(env, "getTokenAccountsByOwner", [
      address,
      { programId: program },
      { encoding: "jsonParsed" },
    ]);
    for (const acct of (res || {}).value || []) {
      const info = ((((acct.account || {}).data || {}).parsed || {}).info || {});
      const mint = info.mint;
      if (!(mint in byMint)) continue;
      const e = byMint[mint];
      const amt = (info.tokenAmount || {}).uiAmount || 0;
      if (!amt) continue;
      let onchainPx = null;
      try {
        onchainPx = await jupiterPriceUsd(mint, e.decimals);
      } catch { /* degrade */ }
      let underlyingPx = null;
      try {
        const snap = await fdSnapshot(env, e.fd_ticker);
        if (snap && typeof snap === "object" && snap.price !== null && snap.price !== undefined) {
          underlyingPx = Number(snap.price);
        }
      } catch { /* FD may be unconfigured; degrade */ }
      positions.push({
        ticker: e.ticker,
        mint,
        amount: amt,
        onchain_price_usd: onchainPx,
        value_onchain_usd: onchainPx !== null ? amt * onchainPx : null,
        underlying_price_usd: underlyingPx,
        value_underlying_usd: underlyingPx !== null ? amt * underlyingPx : null,
      });
    }
  }
  return {
    source: "solana rpc getTokenAccountsByOwner + jupiter/fd pricing",
    as_of,
    address,
    positions,
    total_value_onchain_usd: positions.reduce((s, p) => s + (p.value_onchain_usd || 0), 0),
  };
}

async function toolEquitiesMarketStatus(args, env) {
  // America/New_York wall clock via Intl (weekday + HH:MM).
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wd = weekdayMap[parts.weekday];
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const openNow = wd !== undefined && wd >= 1 && wd <= 5 && mins >= 9 * 60 + 30 && mins < 16 * 60;
  const etNow = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second} America/New_York (${parts.weekday})`;
  const doc = _registryCache || EMBEDDED_REGISTRY;
  return {
    source: "computed (America/New_York) + leg notes",
    as_of: nowIso(),
    us_market_open: openNow,
    et_now: etNow,
    session: "09:30-16:00 ET, Mon-Fri (holidays not modelled)",
    legs: {
      backpack_perps: "24/7",
      onchain_tokens: "24/7 (Solana)",
      financial_datasets: "underlying trades US market hours; snapshot may be stale when closed",
      registry_staleness_seconds: registryAgeSeconds(doc),
    },
  };
}

const TOOLS = {
  equities_list: {
    description: "Registry of tokenized equities on Solana: ticker -> Financial Datasets ticker, Backpack perp symbol, RPC-verified Solana mint, decimals, issuer. Built by intersecting Backpack equity perps with the Stonk tokenized-stock catalog. Pass refresh=true to rebuild.",
    inputSchema: { type: "object", properties: { refresh: { type: "boolean" } } },
    fn: toolEquitiesList,
  },
  equities_quote: {
    description: "Three-way quote for a tokenized equity: Financial Datasets underlying snapshot vs Backpack perp mark vs on-chain executable price (Jupiter), with premium/discount in bps. Legs degrade to null + note, never crash.",
    inputSchema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] },
    fn: toolEquitiesQuote,
  },
  equities_token_info: {
    description: "On-chain mint truth via Solana RPC: supply, mint/freeze authorities, top holders. Accepts a registry ticker or a raw mint.",
    inputSchema: { type: "object", properties: { ticker: { type: "string" }, mint: { type: "string" } } },
    fn: toolEquitiesTokenInfo,
  },
  equities_fundamentals: {
    description: "Financial Datasets fundamentals for a ticker: financial metrics, company facts, earnings, news. Returns financial_datasets_not_configured when the key is not set.",
    inputSchema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] },
    fn: toolEquitiesFundamentals,
  },
  equities_candles: {
    description: "Candles for a ticker from Backpack (24h of klines, any Backpack interval) or Financial Datasets (daily, 30d). Source-labelled.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string" },
        source: { type: "string", enum: ["fd", "backpack"] },
        interval: { type: "string" },
      },
      required: ["ticker"],
    },
    fn: toolEquitiesCandles,
  },
  equities_wallet: {
    description: "A Solana wallet's holdings of registry tokenized equities, valued at the on-chain price and (when available) the underlying price.",
    inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
    fn: toolEquitiesWallet,
  },
  equities_market_status: {
    description: "US market open/closed (America/New_York 09:30-16:00, Mon-Fri) plus per-leg staleness notes.",
    inputSchema: { type: "object", properties: {} },
    fn: toolEquitiesMarketStatus,
  },
};

// ---------------------------------------------------------------------------
// Minimal MCP (JSON-RPC) layer
// ---------------------------------------------------------------------------

async function mcpHandle(msg, env) {
  const method = (msg && msg.method) || "";
  const mid = msg ? msg.id : undefined;
  if (method.startsWith("notifications/") || mid === undefined || mid === null) return null;
  let result;
  if (method === "initialize") {
    result = {
      protocolVersion: ((msg.params || {}).protocolVersion) || "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "equities-mcp", version: "0.1.0" },
    };
  } else if (method === "ping") {
    result = {};
  } else if (method === "tools/list") {
    result = {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      })),
    };
  } else if (method === "tools/call") {
    const params = msg.params || {};
    const name = params.name || "";
    const args = params.arguments || {};
    if (!(name in TOOLS)) {
      return { jsonrpc: "2.0", id: mid, error: { code: -32602, message: `unknown tool ${name}` } };
    }
    try {
      const out = await TOOLS[name].fn(args, env);
      return {
        jsonrpc: "2.0",
        id: mid,
        result: {
          content: [{ type: "text", text: JSON.stringify(out, null, 1) }],
          structuredContent: out,
          isError: false,
        },
      };
    } catch (exc) {
      return {
        jsonrpc: "2.0",
        id: mid,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "tool_error",
                tool: name,
                note: String(exc && exc.message ? exc.message : exc).slice(0, 400),
              }),
            },
          ],
          isError: true,
        },
      };
    }
  } else {
    return { jsonrpc: "2.0", id: mid, error: { code: -32601, message: `method not found: ${method}` } };
  }
  return { jsonrpc: "2.0", id: mid, result };
}

// ---------------------------------------------------------------------------
// Portal page (fleet MCP style: dark #0b0e14, Solana gradient)
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function portalHtml() {
  const count = Object.keys(EMBEDDED_REGISTRY.tickers || {}).length;
  const generated = EMBEDDED_REGISTRY.generated_at || "not built yet";
  const rows = Object.entries(TOOLS)
    .map(([name, t]) => {
      const desc = t.description.split(". ")[0].replace(/\.+$/, "") + ".";
      return `<div class="tool"><code>${esc(name)}</code><span>${esc(desc)}</span></div>`;
    })
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0e14">
<title>Equities MCP · Tokenized Equities on Solana</title>
<meta name="description" content="Equities MCP: read-only MCP server for tokenized equities on Solana — registry of on-chain stock tokens, three-way quotes (underlying vs perp vs on-chain), mint truth, fundamentals, candles and wallet holdings.">
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:#0b0e14; color:#e6edf3; font:16px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 28px 20px 48px; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:18px; }
  .logo { width:30px; height:30px; border-radius:8px; display:grid; place-items:center; color:#0b0e14; font-weight:800; background:linear-gradient(135deg,#9945FF,#14F195); }
  .brand small { color:#8b98a5; font-weight:500; }
  h1 { font-size:38px; line-height:1.15; margin:34px 0 10px; }
  .grad { background:linear-gradient(90deg,#9945FF,#14F195); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .lead { color:#aeb9c4; font-size:18px; margin:0 0 8px; }
  .status { display:inline-flex; align-items:center; gap:8px; margin:14px 0 4px; padding:6px 12px; border:1px solid #22304a; border-radius:999px; font-size:14px; color:#aeb9c4; }
  .dot { width:9px; height:9px; border-radius:50%; background:#8b98a5; }
  .dot.ok { background:#14F195; } .dot.bad { background:#ff5c5c; }
  .panel { background:#101623; border:1px solid #1e2a3f; border-radius:14px; padding:18px 20px; margin-top:18px; }
  .panel h3 { margin:0 0 12px; font-size:16px; }
  .tool { display:flex; gap:14px; padding:9px 0; border-top:1px solid #1a2436; align-items:baseline; }
  .tool:first-of-type { border-top:none; }
  .tool code { color:#14F195; font-size:14px; white-space:nowrap; min-width:190px; }
  .tool span { color:#aeb9c4; font-size:14px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre.code { background:#0b0e14; border:1px solid #1e2a3f; border-radius:10px; padding:14px; overflow:auto; font-size:13px; color:#c9d4e0; }
  .mono { color:#14F195; word-break:break-all; }
  .muted { color:#8b98a5; font-size:14px; }
  .foot { margin-top:28px; color:#8b98a5; font-size:13px; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  @media (max-width:640px) { .tool { flex-direction:column; gap:2px; } .tool code { min-width:0; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="logo">E</span>Equities MCP <small>· $CLAWD</small></div>
  <h1>Tokenized equities <span class="grad">on Solana</span></h1>
  <p class="lead">A read-only MCP server for the on-chain stock market: which tokenized
  equities exist on Solana, what each token trades at versus the underlying stock and
  the 24/7 perp, and the on-chain truth for every mint. Registry currently tracks
  <b>${count} tickers</b> (built ${esc(generated)}), every mint verified via Solana RPC
  before it enters.</p>
  <div class="status"><span class="dot" id="dot"></span><span id="statusText">Checking…</span></div>

  <div class="panel"><h3>Tools — read-only, <code>equities_</code> namespace</h3>
      ${rows}
  </div>

  <div class="panel"><h3>Connect an MCP client</h3>
    <p class="muted">One Streamable HTTP endpoint. The MCP endpoint is
    <code class="mono" id="endpoint">/mcp</code> (POST, JSON-RPC).</p>
    <pre class="code" id="connectCode">Loading…</pre>
    <p class="muted">Or with curl:
    <code>curl -X POST &lt;this-origin&gt;/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</code></p>
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
    JSON.stringify({mcpServers: {'equities-mcp': {url: origin + '/mcp'}}}, null, 2);
  fetch('/health').then(function(r) { return r.json(); }).then(function(j) {
    document.getElementById('dot').className = 'dot ok';
    document.getElementById('statusText').textContent = 'Live · ' + j.service + ' · ' + j.as_of;
  }).catch(function() {
    document.getElementById('dot').className = 'dot bad';
    document.getElementById('statusText').textContent = 'Health check failed';
  });
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP entrypoint
// ---------------------------------------------------------------------------

function jsonResp(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET") {
      if (path === "/health") {
        return jsonResp(200, { ok: true, service: "equities-mcp", as_of: nowIso() });
      }
      if (path === "/" || path === "/index.html") {
        return new Response(portalHtml(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return jsonResp(404, { error: "not_found" });
    }
    if (request.method === "POST") {
      if (path !== "/mcp") return jsonResp(404, { error: "not_found" });
      let msg;
      try {
        msg = JSON.parse((await request.text()) || "{}");
      } catch {
        return jsonResp(400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        });
      }
      if (Array.isArray(msg)) {
        const replies = [];
        for (const m of msg) {
          const r = await mcpHandle(m, env);
          if (r !== null) replies.push(r);
        }
        return jsonResp(200, replies);
      }
      const resp = await mcpHandle(msg, env);
      if (resp === null) return new Response("", { status: 202 });
      return jsonResp(200, resp);
    }
    return jsonResp(404, { error: "not_found" });
  },
};

// Named exports for the local Node test harness (ignored by Workers).
export { buildRegistry, EMBEDDED_REGISTRY, TOOLS };

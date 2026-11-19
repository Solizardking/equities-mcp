# One MCP Layer — folding the Equities MCP into the fleet's MCP surfaces

Research/design only, 2026-11-19. No service was changed. Live surfaces were
enumerated read-only (public `tools/list` on pumpai.ai and decide.pumpai.ai;
code reads for the OAuth-gated surfaces).

## The pieces as they stand

| Surface | Stack | Tools today | Auth model |
|---|---|---|---|
| **clawdcompute.us/mcp** (portal facade) | Cloudflare Worker `musebook-ai-gateway` (`worker.js`, repo `Solizardking/musebook-ai-gateway`) | 2 portal tools + mirrored upstreams (215 anon-visible: 213 PumpAI) | Public for `auth:false` upstreams; caller's Clerk OAuth Bearer forwarded only to `auth:true` upstreams; portal is itself a Clerk OAuth resource |
| **pumpai.ai/mcp** | Node, Render `clawd-ws-v2` (`src/mcp.mjs` + `src/tools-mcp.mjs` + `src/clawd/tools.mjs`) | **213** (enumerated live) = native defs + CLAWD_TOOLS + 167-entry parity catalog (`src/tools/catalog.json`) | Public reads free; protected tools via x402/$CLAWD gate (`mcp-access.mjs`/`mcp-public-gate.mjs`); wallet tools SIWS, behind `WALLET_TOOLS_ENABLED` |
| **decide.pumpai.ai/mcp** | **The same clawd-ws-v2 service on a second host** — live `initialize` returns identical `serverInfo` (`clawd-pump`, PumpAI 2.4.0) and `tools/list` is byte-identical, 213 tools | 213 (same) | Same as pumpai.ai |
| **Perps MCP** (mcp.perps.percolator.tech) | Python FastMCP, `~/workspace/imperial-perps-mcp-server/server.py` (47 `@_tool()` tools) | 47 | Whole-endpoint Clerk OAuth (Musebook instance, audience-bound per host, `clerk_auth.py`); production /mcp 401s; trading additionally fail-closed (master switch + confirm + confirm token; agent sessions never trade) |
| **Equities MCP** (new) | Python stdlib, `~/workspace/equities-mcp/server.py` | 7, all read-only | None (public reads); FD key is a server-side env secret on this service only |

## How the facade works (the model to copy)

`worker.js` in the gateway repo, `handleMcpPortal` (~line 5517) + `MCP_UPSTREAMS`
(~line 4965):

- Upstreams are a **config array**: `{ id, name, url, auth, prm?, blurb }`.
- `tools/list`: for each upstream (skipping `auth:true` ones when the caller
  sent no token), fetch its list via a stateless initialize→tools/list RPC
  (`mcpUpstreamRpc`), cache it 5 min in GATEWAY_KV
  (`mcp:tools:v2:{id}:{url}:{anon|auth}`), and re-emit each tool renamed
  **`{id}_{tool}`**.
- `tools/call`: split the name on the **first underscore** → upstream id →
  strip the prefix → forward the call (forwarding the caller's Authorization
  header only when `up.auth` is true).
- `portal_list_servers` / `portal_identity` are the portal's own two tools.
  The portal page's server table renders from the same array automatically.

**Adding an upstream is one array entry** — plus two hardcoded strings that
name the current servers (the `initialize` instructions text) if we want them
accurate.

### The one wrinkle: equities tools are already prefixed

Equities' native names are `equities_list`, `equities_quote`, … With upstream
id `equities`, the facade's mechanical rename produces
**`equities_equities_list`** on the wire. Calls still route correctly (split
on first `_` → `equities` → strip → `equities_list`), so config-only *works* —
it just reads badly and breaks the fleet's naming look. Two ways out:

- **A. Config-only (zero code):** accept `equities_equities_*` on the portal.
- **B. Small portal patch (recommended):** an upstream flag (e.g.
  `nativePrefix: true`) — in `tools/list`, don't re-prefix a tool whose name
  already starts with `{id}_`; in `tools/call`, match the upstream by the
  native prefix and forward the name unstripped. ~15 lines in `worker.js`.
  Portal then serves the tools as exactly **`equities_*`** — the namespace is
  the server id, same as every other backend, just not applied twice.

This is a conscious, documented exception to the mechanical `{server}_{tool}`
rule, not a silent one — it needs the dev's sign-off (Decision 1).

## Collision check (enumerated, not assumed)

`equities_*` (7 names) checked against every catalog I could enumerate:

- pumpai.ai/mcp live tools/list: **213 names — no `equities_*`, no collision.**
- decide.pumpai.ai/mcp live tools/list: **identical 213 — no collision.**
- PumpAI parity catalog (`src/tools/catalog.json`, 167): no `equities_*`.
- Perps MCP (`server.py`, 47 tools): no `equities_*`. (It does carry raw
  `stonk_tokens`/`stonk_pairs` passthroughs — same data source as the
  equities registry's catalog leg, different semantics; no name or function
  conflict with the composite `equities_*` tools.)
- Marketplace catalog (478): no `equities_*`.
- Musebook MCP is OAuth-gated so its list wasn't enumerated; its portal
  namespace is `musebook_*` and no `equities_*` name is known anywhere in
  its parity tables.

**Result: `equities_*` is collision-free fleet-wide.** The known Imperial
collision set is untouched by this work (see "Convergence-plan flags").

## Per-surface integration

### 1. clawdcompute.us/mcp — facade registration (do first)

- **Pattern:** proxy/registration into the facade — one `MCP_UPSTREAMS` entry:
  `{ id: "equities", name: "Equities MCP", url: "<equities Render URL>/mcp", auth: false, blurb: "…" }`, plus the prefix patch (option B) and an
  instructions-string touch-up.
- **Namespace on the surface:** `equities_*` (option B) — identical to the
  standalone names, so a tool means the same thing on every door.
- **Auth:** none added. `auth:false` → tools appear in anonymous
  `tools/list`, no token is forwarded, exactly like PumpAI reads. The
  equities service's FD key never leaves the equities service.
- **Size:** config + ~15-line patch in one file; gateway Worker deploy
  (which under standing rules needs the dev's explicit production OK).
- **What a client sees:** anonymous `tools/list` grows 215 → **222**
  (2 portal + 213 `pumpai_*` + 7 `equities_*`); `portal_list_servers`
  lists a fourth backend, public, ready. With a Clerk token the Perps and
  Musebook lists join as today.

### 2. pumpai.ai/mcp — native proxy module (Phase 3)

- **Pattern:** a small proxy module inside clawd-ws-v2, following the
  codebase's existing composition (native defs in `src/mcp.mjs`,
  `CLAWD_TOOLS`, catalog dispatch in `src/tools-mcp.mjs`): 7 tool
  definitions with `readOnlyHint` annotations + a dispatcher that POSTs
  `tools/call` to the equities MCP URL and returns its result. (The Perps
  MCP's `_mcp_proxy_call` is the same pattern in Python — proven twice in
  the fleet.) A native *port* is not possible: equities is Python, this
  service is Node, and a port would duplicate the registry/RPC/FD legs.
- **Namespace:** native names as-is, `equities_*` (PumpAI applies no prefix
  internally; prefixes are applied by the layers above it).
- **Auth:** the tools are public reads, so under PumpAI's doctrine
  ("every tool here is a public read: free, no x402, no bearer; anything
  that writes/pays/trades must be listed in PROTECTED_TOOLS") they join
  the free set — they must **not** be added to `PROTECTED_TOOLS` or
  `WALLET_TOOLS`. Note on `equities_wallet`: it reads any address's
  public on-chain holdings — a chain-data read in the same class as the
  existing `st_get_token_holders`, not a session-wallet tool, so SIWS
  does not apply.
- **Size:** code, ~100–150 lines + tests (`test:mcp` suite exists), one
  clawd-ws-v2 deploy (Render build minutes are the known fleet caveat).

### 3. decide.pumpai.ai/mcp — nothing to build

- Decide is **the same service** as pumpai.ai on a second host (verified
  live: identical serverInfo, identical 213-tool list). Whatever lands on
  pumpai.ai/mcp — including the Phase 3 equities module — appears on
  decide.pumpai.ai/mcp automatically, in the same deploy.
- **Does equities belong there conceptually?** Defensibly yes:
  `equities_quote`'s premium/discount-in-bps is a decision-grade signal
  of exactly the shape the Decide/JEV side consumes (it already judges
  launches with composite scores), and tokenized equities are a plausible
  scanner universe extension. But today there is no separate Decide tool
  registry to opt into — inclusion is automatic, not a design choice.
  If Decide is ever split into its own service, equities inclusion
  becomes a real decision at that point; flag it then.

### 4. Perps MCP — optional, and only behind a conscious auth trade

Two mechanical options, neither recommended as part of the main line:

- **Thin proxy tools:** register 7 wrapper tools in `server.py` using its
  existing `_mcp_proxy_call` helper (already used for
  `pumpai_recent_launches` / `musebook_directory_stats`). ~120 lines.
  Results come back in that helper's `{available, result}` envelope
  unless unwrapped.
- **Native port:** the equities logic is Python, so a port is *possible* —
  but its RPC leg shells out to fleet-local helper scripts that don't
  exist on the Perps Render service, the registry cache assumes a local
  disk file, and the FD key would have to be duplicated into the Perps
  env. Larger, and it forks the backend of record. **Not recommended.**

- **Auth implication (the real cost):** the Perps /mcp gate is
  whole-endpoint Clerk OAuth. Any equities tools hosted there stop being
  public reads and require a Musebook-Clerk token with the Perps
  audience — an access *narrowing* versus every other surface. Nothing
  about the trading gate is affected (equities tools are reads; the
  agent-session "may read, never trade" rule is compatible).
- **Recommendation:** skip. The facade is the door; Perps stays a backend.
  Revisit only if direct-Perps clients demonstrably need equities.

## clawdrouter tools marketplace — yes, list it

The marketplace catalog (`~/workspace/clawd-router-final/tools/catalog.json`,
478 tools; served by the `clawdrouter-tools` Worker) is a listing +
proxy-execution layer, not an MCP host: each entry is
`{ id: "<seller>/<tool>", mcpName, kind, execution, upstream, priceUsd, sellerId, … }`.

Adding equities takes:

- 7 entries: `id: "equities/equities_list"` etc., `execution: "proxy"`,
  `upstream: "<equities Render URL>/mcp"`, `kind: "read"`, first-party
  seller (e.g. `sellerId: "equities"`).
- The catalog's canonical naming pattern
  (`^(pumpai|perps|musebook|portal|clawdrouter|darkx402)_…`) must add
  `equities` as an allowed source — which produces canonical names
  `equities_equities_list` in the marketplace's map unless the generator
  gets the same native-prefix exception as the facade. Decide once
  (Decision 1) and apply it in both places.
- Rebuild `catalog.js` (`cf-worker/build.py`) + redeploy the
  `clawdrouter-tools` Worker (its `deploy.py` is idempotent).
- Pricing: first-party reads in the catalog are mostly free or on the
  marketplace's read tiers; recommend **free at launch** (Decision 5).

Listing is independent of the facade work — the marketplace proxies the
standalone equities URL directly.

## Recommended target architecture — one door, four backends

```
                        ┌─ pumpai.ai/mcp        (public reads, SIWS/x402 gates upstream)
                        ├─ Perps MCP            (Clerk OAuth)
clawdcompute.us/mcp ────┼─ Musebook MCP         (Clerk OAuth)
   THE door             └─ Equities MCP         (public reads)  ← new
   (portal facade)

clawdrouter.trade/tools — marketplace catalog: same backends, listed + proxied per-tool
pumpai.ai/mcp / decide.pumpai.ai/mcp — also serve equities_* natively (Phase 3 proxy module)
Perps MCP — unchanged; no equities hosting (Phase 4 only on explicit call)
```

- **Single door:** clawdcompute.us/mcp, as today. Equities becomes its
  fourth upstream; nothing about the portal's own auth changes.
- **Backend of record:** the standalone Equities MCP on Render. Every
  other surface proxies it — the FD key, the registry build, and the RPC
  legs exist in exactly one place.
- **One name everywhere:** `equities_*` on the standalone server, the
  facade, PumpAI/Decide, and (modulo the generator decision) the
  marketplace.

## Phased plan

**Phase 0 — prerequisites (parallel deploy task + one tiny equities change)**
- Equities MCP live on Render at a stable public URL.
- Add MCP `annotations` (`readOnlyHint: true, destructiveHint: false,
  idempotentHint: true`) to the equities `tools/list` output — currently
  absent. The facade doesn't require them, but the gateway's web tool
  runner filters on `readOnlyHint`, so without them the equities tools
  are invisible in that surface. ~7 lines in `equities-mcp/server.py`.
- Verify: standalone `tools/list` shows 7 tools with annotations;
  `equities_quote` answers for AAPL.

**Phase 1 — facade registration (the one-layer move)**
- Add the `equities` entry to `MCP_UPSTREAMS`; apply the native-prefix
  patch (or accept doubled names, per Decision 1); update the
  `initialize` instructions string and let the portal page pick up the
  new row automatically; blurb copy passes the $CLAWD-only review
  (Decision 6).
- Deploy the gateway Worker (dev's production OK, per standing rules).
- Verify: anonymous `tools/list` on clawdcompute.us/mcp = 222 tools
  incl. 7 `equities_*`; `portal_list_servers` shows equities public +
  ready with count 7; `tools/call equities_quote {ticker:"AAPL"}`
  returns the three-way quote through the portal; Perps/Musebook rows
  unchanged.

**Phase 2 — marketplace listing**
- Add the 7 catalog entries + naming-pattern update; rebuild; redeploy
  `clawdrouter-tools`.
- Verify: clawdrouter.trade/tools shows the equities tools under their
  seller; a proxied call through the marketplace returns a quote;
  catalog total 478 → 485.

**Phase 3 — PumpAI native proxy module**
- Implement the 7 defs + proxy dispatch in clawd-ws-v2, with tests;
  confirm the tools are in the free set (not PROTECTED/WALLET).
- Deploy clawd-ws-v2.
- Verify: pumpai.ai/mcp and decide.pumpai.ai/mcp `tools/list` both =
  220, identical as today; `equities_quote` callable on both hosts;
  no existing tool changed name or gate.

**Phase 4 — optional, dev-gated only**
- Perps proxy wrappers, if a concrete direct-Perps need appears,
  accepting the Clerk-gate narrowing explicitly.

## Convergence-plan flags (contradictions & near-misses, stated plainly)

1. **Imperial collisions are NOT fixed by any of this.** PumpAI's live
   catalog still carries `imperial_health`, `imperial_funding_rates`,
   `imperial_mark_prices`, `imperial_orders`, `imperial_positions`,
   `imperial_place_order`, `imperial_cancel_order` (verified in today's
   live list) duplicating the Perps MCP's canonical set. The standing
   rule stands: Perps is canonical, PumpAI's copies become aliases or
   are removed, never flat-unioned. The facade currently namespaces
   them apart (`pumpai_imperial_*` vs `perps_imperial_*`), so there is
   no wire collision today — but adding equities to PumpAI (Phase 3)
   must not be treated as, or bundled with, a resolution of the
   Imperial duplication.
2. **The native-prefix exception (Decision 1) deviates from the
   facade's mechanical `{server}_{tool}` rule.** It preserves the
   *purpose* (every tool namespaced by its server) but not the letter.
   If the dev wants the rule kept absolute, the fallback is
   `equities_equities_*` on the portal and in the marketplace map.
3. **No trading surface is created or widened.** All 7 equities tools
   are reads; nothing here touches the Perps trading gate, PumpAI's
   x402/SIWS gates, or the portal's "no trading" posture. Compliant
   with the fail-closed constraint.
4. **User-facing copy:** the portal page blurb and marketplace listing
   copy for equities must follow the $CLAWD-only rule — describe the
   data (tokenized equities on Solana), don't promote other tickers;
   individual ticker symbols inside tool *results* are data, not copy.
5. **No new DNS is required** if the equities upstream uses its Render
   hostname. A vanity host (e.g. `equities.clawdcompute.us`) would be a
   new DNS record and needs the dev's explicit OK under the standing
   rule; the `mcp.clawdcompute.us` DNS blocker is untouched either way.

## Decisions for the dev (recommended default first)

1. **Portal wire name:** `equities_*` via the ~15-line native-prefix
   patch *(recommended)* — vs `equities_equities_*`, config-only.
2. **Equities upstream URL:** the Render default hostname
   *(recommended; zero DNS work)* — vs a vanity subdomain (needs DNS OK).
3. **PumpAI native proxy (Phase 3):** do it *(recommended — highest-
   traffic MCP, Decide inherits free)* — vs facade-only.
4. **Perps hosting:** skip *(recommended)* — vs proxy wrappers behind
   the Clerk gate.
5. **Marketplace listing:** list at launch, free read tier
   *(recommended)* — vs a paid read tier, vs later.
6. **Equities blurb copy** on the portal page / marketplace: approve
   the generic "tokenized equities on Solana" wording *(recommended)*
   — wording is the dev's call under the $CLAWD-only copy rule.

## Evidence notes

- Facade mechanics: `~/workspace/musebook-ai-gateway-repo/worker.js`
  (`MCP_UPSTREAMS` ~L4965, `mcpUpstreamRpc`/`mcpUpstreamTools` ~L4987–5017,
  `handleMcpPortal` ~L5517; rename on list, first-underscore split on call).
- PumpAI/Decide identity: live `initialize` + `tools/list` probes,
  2026-11-19 — identical serverInfo and identical 213-name lists.
- PumpAI structure: `~/workspace/clawd-ws-v2/src/mcp.mjs`,
  `src/tools-mcp.mjs`, `src/tools/catalog.json` (167),
  `src/mcp-access.mjs`, `src/mcp-public-gate.mjs`.
- Perps structure: `~/workspace/imperial-perps-mcp-server/server.py`
  (47 tools, `_mcp_proxy_call` ~L436), `clerk_auth.py` (one Musebook
  Clerk AS, per-host audiences, whole-/mcp gate).
- Marketplace: `~/workspace/clawd-router-final/tools/catalog.json`
  (478 entries, naming map v2), `cf-worker/README.md` (Worker shape,
  build/deploy).
- Equities service: `~/workspace/equities-mcp/server.py` (`TOOLS` dict;
  initialize echoes client protocolVersion, stateless, plain-JSON
  responses — all compatible with the facade's upstream client;
  `tools/list` currently emits no `annotations`).

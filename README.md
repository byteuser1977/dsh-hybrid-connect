# dsh-hybrid-connect

> **TL;DR**: A DSH plugin that routes requests to **Trae remote models** (CN/Intl editions) **or** a **local OpenAI-compatible endpoint** (Ollama / llama.cpp / LM Studio / vLLM) through a single loopback entrypoint, auto-routed by `model id`.

- ✅ **Zero-config**: Install and go — auto-discovers installed Trae, reuses login state, pulls model catalog
- ✅ **Dual editions in parallel**: `trae` (CN) + `trae-intl` (Intl) registered unconditionally; groups auto-hide when no credentials
- ✅ **Hybrid routing**: `by-prefix` (only `local@` prefix goes local, default, zero false positives) / `by-id` (hit local `/v1/models` catalog → local, failure falls back to Trae)
- ✅ **Full port**: `install.js` / `upstream.js` / `credentials.js` **byte-for-byte copied** from `dsh-trae-connect` — protocol translation, credential decryption, token refresh, install discovery, SSE dedup, ephemeral session cleanup, 1M context, thinking effort, lock badges… all preserved
- ✅ **Self-contained**: No external dependency on `dsh-trae-connect`; single plugin runs everything

---

## 1. Architecture

```
                DSH Host (PiAiAdapter)
                       │  model = "local@qwen2.5:14b" / "deepseek-v4.1-flash"
                       ▼
        ┌──────────────────────────────────────────┐
        │  createHybridShim  (127.0.0.1, random)   │
        │  Host/Origin loopback check + Bearer     │
        │  ┌────────────────────────────────────┐  │
        │  │ L1  decideRoute(model, edition)    │  │  router.js (zero I/O)
        │  │     kind:"trae" │ kind:"local"     │  │
        │  └───────┬───────────────┬────────────┘  │
        └──────────┼───────────────┼───────────────┘
                   ▼               ▼
        L2a Trae branch            L2b Local branch (local.js, pure proxy)
        upstream.js SSE translate  fetch → /v1/chat/completions
        credentials.js decrypt     no creds, no protocol translation
        install.js discovery
```

| Layer | Responsibility | File | Status |
|-------|----------------|------|--------|
| L0 | DSH picks model → `${shim.baseUrl()}/v1` | `index.js` (`PiAiAdapter`) | ✅ Complete |
| L1 | Route by model id | `router.js` | ✅ Complete (2 strategies, zero false-positive default) |
| L2a | Trae remote protocol | `upstream.js` (**full port**) | ✅ Complete |
| L2b | Local endpoint proxy | `local.js` | ✅ Complete (SSE passthrough + error handling) |
| — | Credential decrypt/refresh | `credentials.js` (**full port**) | ✅ Complete |
| — | Install location discovery | `install.js` (**full port**) | ✅ Complete |

**Port fidelity**: `install.js` / `upstream.js` / `credentials.js` are **byte-for-byte copies** from `dsh-trae-connect` (historical comments and pitfall notes intact); only `index.js` does the wiring.

---

## 2. File Manifest

| File | Lines | Description |
|------|-------|-------------|
| `install.js` | 311 | Byte-for-byte port from `dsh-trae-connect`; registry scan + product.json edition/mirror detection |
| `upstream.js` | 786 | Byte-for-byte port from `dsh-trae-connect`; Trae remote SSE protocol client |
| `credentials.js` | 717 | Byte-for-byte port from `dsh-trae-connect`; tc envelope decryption + ExchangeToken refresh |
| `router.js` | ~100 | New; `by-prefix` / `by-id` dual-strategy routing, catalog cache + failure fallback |
| `local.js` | ~100 | New; local endpoint SSE passthrough / JSON forward, pure proxy no side effects |
| `index.js` | ~730 | Rewritten; wiring + routing hook + 2 P-bug fixes, ported `apply()` skeleton |
| `package.json` | — | **No longer depends on `dsh-trae-connect`** |
| `README.md` | — | This file (English) |
| `README_CN.md` | — | Chinese version |

---

## 3. Routing Strategies (`router.js`)

| Strategy | Behavior | Failure Mode |
|----------|----------|--------------|
| `by-prefix` (default) | Only `local@` prefix → local; everything else → Trae | **Cannot misroute** (does not depend on local server catalog) |
| `by-id` | Model id hits local `/v1/models` catalog → local; miss → Trae | Catalog fetch failure (local server down) **falls back to Trae**, never rejects; `auto` always → Trae |

- No local configured (`localBase` empty) → plugin behaves **identically to pure Trae**, zero overhead.
- Catalog cache 60s TTL, steady-state zero network calls.

---

## 4. Fixes Landed During Port

| Original Issue | This Plugin | Notes |
|----------------|-------------|-------|
| **P4**: Client disconnect doesn't cancel upstream | ✅ **Fixed** | `chatCompletions` uses `res.on("close")` (fires when response stream ends) instead of `req.on("close")` (may fire too early after request body read) |
| **P2**: CN status card incorrectly used intl credits endpoint | ✅ **Fixed** | `createEditionStatus` now passes per-edition `creditsBase`: CN passes `undefined` (hits `fetchCredits`'s own CN default), only intl passes configured value |
| **P5**: Hard-coded static Bearer secret | ✅ **Fixed** | `EDITION_SECRETS` now generates `randomBytes(32)` per edition at module load (per session); `resolveApiKey` has no more `SHARED_SECRET` fallback |
| **P14**: Unbounded request body read | ✅ **Fixed** | `readBody` enforces 16 MiB — checks `Content-Length` up-front and a running total for chunked requests; violation returns 413 `payload_too_large` (not 400) |
| **P10**: SSE `plan_item` non-prefix snapshot re-emitted whole content | ✅ **Fixed** | `plan_item` else-branch no longer re-emits; store stays in sync for future incremental frames, no duplicate text |
| **P1/P8/P9/P11** | ⚠️ **Preserved from port** | These originate in `dsh-trae-connect`'s upstream code; deliberately untouched in "full port". Fix in separate task if needed. |

---

## 5. Config Card Fields (`.volatile()`)

Inherits all `dsh-trae-connect` fields (`useMaximumContextWindow` / `autoDeleteSession` / `dataDirCn` / `dataDirIntl` / `intlRemoteBase` / `intlWebOrigin` / `intlCreditsBase`), plus:

| Field | Default | Description |
|-------|---------|-------------|
| `localBase` | `""` | Local OpenAI-compatible endpoint root (e.g. `http://127.0.0.1:11434/v1`). Empty = disable local routing, plugin behaves exactly like pure Trae. |
| `localKey` | `""` | Local endpoint Bearer key (Ollama usually empty). Empty = no Authorization header sent. |
| `hybridPolicy` | `by-prefix` | `by-prefix` \| `by-id`. |

---

## 6. Registered Providers

Inherits the two from `dsh-trae-connect` (empty catalog = group hidden):

- `trae` (Trae CN)
- `trae-intl` (Trae Intl)

`cordis.patch.yml` only inserts `llm-hybrid`, but `apply()` **registers both** `trae` / `trae-intl` providers internally (consistent with original behavior).

---

## 7. Future Work (Out of Scope for This Port)

1. ~~Request body size limit (P14)~~ ✅ Landed
2. ~~Static Bearer → `randomBytes(32)` per session (P5)~~ ✅ Landed
3. ~~SSE dedup logic fix (P10, `upstream.js` `plan_item` branch)~~ ✅ Landed
4. Cascading fallback (shape C: Trae 502/timeout → auto-retry local)
5. `node:test` unit tests (`router` / `local` / `upstream.parseModelList` / `credentials.decryptStorageValue` are all narrow interfaces / pure functions)

---

## License

MIT (same as `dsh-trae-connect`).
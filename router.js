// router.js — the per-request routing decision for dsh-hybrid-connect.
//
// This is the L1 "hybrid routing layer" of the architecture: it answers one
// question for every OpenAI request that reaches the plugin's loopback shim —
// "is this a Trae remote request, or a local-model request?" — and it answers
// it WITHOUT touching credentials, protocol translation, or any network I/O
// (except the optional by-id local catalog lookup, which is itself cached and
// failure-tolerant).
//
// Two policies (settable live from the Config card):
//   "by-prefix" (default) — a `local@` model-id prefix forces the local
//                           backend; everything else falls through to the
//                           existing Trae translation pipeline. Zero
//                           discovery, zero assumptions about the local
//                           server's model catalog — this policy CANNOT
//                           misroute, which is why it is the default.
//   "by-id"               — the model id is checked against a cached listing
//                           of the local server's /v1/models catalog. If it
//                           matches, route local; otherwise fall through to
//                           Trae. This policy DOES depend on a live local
//                           server, so the catalog is fetched lazily and
//                           cached (refreshed per TTL; failures negative-
//                           cached for a short cooldown so an offline local
//                           server cannot stall every request), and a
//                           discovery failure degrades to "treat as Trae"
//                           (never "reject the request") so an offline local
//                           server cannot take down the Trae path.
//
// The returned route is a plain discriminated union ({kind:"trae"|"local"}) —
// this module knows NOTHING about the Trae protocol (that stays in
// upstream.js) and NOTHING about HTTP forwarding (that stays in local.js).
// Keeping the decision pure is what makes it unit-testable without a running
// server or real credentials.

/** Strip one optional model-id prefix: "local@qwen2.5:14b" → "qwen2.5:14b". */
function stripPrefix(model, prefix) {
	return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

/** Id of the synthetic model dsh-trae-connect always exposes (its fallback roster entry). */
const TRAE_AUTO_MODEL = "auto";

/** How long a successful local /v1/models listing stays authoritative. */
const LOCAL_CATALOG_TTL_MS = 60_000;
/**
 * How long a FAILED /v1/models probe is trusted as "still down" before the
 * next request retries it. Without this negative cache a configured-but-
 * offline local server re-paid a full 5s probe timeout on EVERY by-id request
 * (a failure left no cache entry), stalling the very Trae path it is supposed
 * to fall back to. Failures are cached SHORTER than successes (30s vs 60s) so
 * a local server that comes back online is picked up quickly; the cost of a
 * stale "down" verdict is zero — it routes to Trae, the correct fallback.
 */
const LOCAL_CATALOG_FAILURE_COOLDOWN_MS = 30_000;

/**
 * Create one routing decision function bound to a config accessor.
 *
 * @param {object} options
 * @param {() => string} options.localBase        Config card: local OpenAI-compatible base URL (e.g. http://127.0.0.1:11434/v1). "" = local backend disabled.
 * @param {() => string} options.localKey         Config card: optional bearer key for the local server (Ollama usually needs none).
 * @param {() => "by-prefix"|"by-id"} options.hybridPolicy Config card: routing policy.
 * @param {(msg: string, err?: unknown) => void} [options.logger] Warn/info sink (same shape as ctx.logger.info/warn).
 * @returns {(requestedModel: string, edition: "cn"|"intl") => Promise<{kind:"trae", model:string} | {kind:"local", baseUrl:string, key:string, model:string}>}
 */
export function createRouteDecider({ localBase, localKey, hybridPolicy, logger } = {}) {
	// Local model-id catalog cache, populated lazily on the first "by-id"
	// lookup. The cached state also carries WHICH baseUrl it was probed from:
	// a Config-card edit that retargets localBase must void both the success
	// and the failure verdict, or the old server's answer would be reused for
	// the new one. undefined = not fetched yet / last fetch failed.
	let localCatalog = undefined;
	let localCatalogBase = "";
	let localCatalogAt = 0;
	let localCatalogFailedAt = 0;
	/** In-flight probe promise, shared so concurrent by-id requests fetch once. */
	let localCatalogInflight;

	/** One /v1/models probe; updates the cache state. Never throws. */
	async function probeLocalCatalog(baseUrl) {
		try {
			const response = await fetch(`${baseUrl}/models`, {
				headers: localKey?.()?.trim() ? { Authorization: `Bearer ${localKey().trim()}` } : {},
				signal: AbortSignal.timeout(5_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			const ids = new Set(
				(Array.isArray(payload?.data) ? payload.data : [])
					.map((entry) => String(entry?.id ?? ""))
					.filter((id) => id !== ""),
			);
			localCatalog = ids;
			localCatalogBase = baseUrl;
			localCatalogAt = Date.now();
			return localCatalog;
		} catch (error) {
			localCatalogBase = baseUrl;
			localCatalogFailedAt = Date.now();
			logger?.warn?.(
				`dsh-hybrid-connect: 本地模型目录拉取失败（${baseUrl}/models，${String(error?.message ?? error).slice(0, 120)}）— ${Math.round(LOCAL_CATALOG_FAILURE_COOLDOWN_MS / 1000)}s 内不再重试，按 Trae 兜底`,
			);
			return undefined;
		}
	}

	/** Fetch (or reuse) the local server's model-id set. Never throws; undefined = unavailable. */
	async function ensureLocalCatalog() {
		const baseUrl = String(localBase?.() ?? "").trim().replace(/\/+$/, "");
		if (baseUrl === "") return undefined;
		const now = Date.now();
		if (baseUrl !== localCatalogBase) {
			localCatalog = undefined;
			localCatalogFailedAt = 0;
		}
		if (localCatalog !== undefined && now - localCatalogAt < LOCAL_CATALOG_TTL_MS) return localCatalog;
		// Failure cooldown: a recently failed probe stays failed until the
		// cooldown elapses, so an offline local server costs one probe per
		// window instead of one per request.
		if (now - localCatalogFailedAt < LOCAL_CATALOG_FAILURE_COOLDOWN_MS) return undefined;
		localCatalogInflight ??= probeLocalCatalog(baseUrl).finally(() => {
			localCatalogInflight = undefined;
		});
		return localCatalogInflight;
	}

	/**
	 * Decide the route for ONE request. Async only because "by-id" may need to
	 * consult the local catalog (cached, so steady-state cost is ~0).
	 *
	 * Never throws: a local-catalog failure routes to Trae (the always-available
	 * path) rather than failing the request.
	 */
	return async function decideRoute(requestedModel, edition) {
		const model = String(requestedModel ?? "auto");
		const baseUrl = String(localBase?.() ?? "").trim().replace(/\/+$/, "");
		const policy = hybridPolicy?.() ?? "by-prefix";

		// Local backend not configured → everything is a Trae request, no
		// catalog lookup, no policy branch. This is the "pure Trae" mode and
		// must cost exactly what it did before this layer existed.
		if (baseUrl === "") return { kind: "trae", model };

		if (policy === "by-id") {
			const catalog = await ensureLocalCatalog();
			// Discovery unavailable: fall through to Trae (never reject).
			if (catalog === undefined) return { kind: "trae", model };
			// "auto" is always Trae's own router — never treat it as local.
			if (model !== TRAE_AUTO_MODEL && (catalog.has(model) || catalog.has(stripPrefix(model, "local@")))) {
				return { kind: "local", baseUrl, key: localKey?.() ?? "", model: stripPrefix(model, "local@") };
			}
			return { kind: "trae", model };
		}

		// "by-prefix" (default): only an explicit local@ prefix routes local.
		if (model.startsWith("local@")) {
			return { kind: "local", baseUrl, key: localKey?.() ?? "", model: stripPrefix(model, "local@") };
		}
		return { kind: "trae", model };
	};
}

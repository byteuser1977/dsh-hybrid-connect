// local.js — the L2 "execution layer, local backend" for dsh-hybrid-connect.
//
// This is deliberately the simplest file in the project: unlike the Trae
// branch (upstream.js) which must translate OpenAI requests into Trae's
// remote-session SSE protocol, the local branch is a pure FORWARD — the local
// server already speaks OpenAI natively, so we pass `body` through almost
// verbatim (only the model id is swapped for the routed one) and pipe its
// response (JSON or SSE) straight back to the caller.
//
// Contract with index.js: `forwardToOpenAI(route, body, res, signal)`:
//   - route:  {kind:"local", baseUrl, key, model} from router.js
//   - body:   the already-parsed OpenAI request object (index.js owns parsing)
//   - res:    the (already-header-checked) node:http ServerResponse
//   - signal: AbortSignal wired to the client's connection (same controller
//             the Trae branch uses) so a client disconnect cancels the local
//             fetch too.
// It must NEVER throw after headers are written (index.js's own catch only
// guards the pre-header window); every post-header failure ends the response
// quietly, mirroring the Trae branch's `res.end()` behaviour for zero-byte
// failures.

/** Bounds one local-server response read so a runaway local model cannot pin this process. */
const LOCAL_BODY_TIMEOUT_MS = 120_000;
/**
 * Header deadline for the local fetch. The client abort signal alone cannot
 * bound a local server that accepts the connection but never answers — with
 * only that signal the fetch hangs forever (DSH may not abort a hung request
 * at all), so the headers phase gets its own deadline. It is cleared the
 * moment headers arrive: a healthy SSE stream may legitimately run longer
 * than any fixed ceiling, and mid-stream idle behaviour stays the host's
 * concern (same split as the Trae branch). 300s is generous on purpose — a
 * cold Ollama / llama.cpp first byte can take minutes on a slow box.
 */
const LOCAL_HEADERS_TIMEOUT_MS = 300_000;

function safeMessage(error) {
	return String(error?.message ?? error).slice(0, 300);
}

/** Forward one request to the local OpenAI-compatible endpoint. Never throws. */
export async function forwardToOpenAI(route, body, res, signal) {
	const target = `${String(route.baseUrl).replace(/\/+$/, "")}/chat/completions`;
	// Swap in the routed model id — the caller may have sent `local@<id>` (or a
	// by-id match against a display alias); the local server only knows its own
	// bare id.
	const payload = { ...body, model: route.model };
	const headers = { "Content-Type": "application/json; charset=utf-8" };
	const key = typeof route.key === "string" ? route.key.trim() : "";
	if (key !== "") headers.Authorization = `Bearer ${key}`;

	let response;
	// Header deadline (LOCAL_HEADERS_TIMEOUT_MS) + client-abort wiring, both
	// funnelling into one upstream controller. The deadline is cleared as soon
	// as headers arrive (see the constant's note); the client signal keeps
	// aborting the upstream through the body phase too, exactly like the old
	// `signal: signal` wiring did. When no client signal exists (direct
	// callers), the whole request stays bounded by LOCAL_BODY_TIMEOUT_MS as
	// before.
	const upstream = new AbortController();
	const abortUpstream = () => upstream.abort();
	const detach = () => {
		signal?.removeEventListener("abort", abortUpstream);
		clearTimeout(headersDeadline);
		clearTimeout(bodyDeadline);
	};
	if (signal?.aborted === true) upstream.abort();
	signal?.addEventListener("abort", abortUpstream, { once: true });
	const bodyDeadline = signal === undefined ? setTimeout(abortUpstream, LOCAL_BODY_TIMEOUT_MS) : undefined;
	const headersDeadline = setTimeout(abortUpstream, LOCAL_HEADERS_TIMEOUT_MS);
	try {
		response = await fetch(target, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: upstream.signal,
		});
	} catch (error) {
		detach();
		// Network-level failure (local server down / unreachable): no headers
		// written yet, so a normal OpenAI error is safe here.
		if (!res.headersSent) {
			res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
			res.end(JSON.stringify({ error: { message: `local model upstream: ${safeMessage(error)}`, type: "local_upstream_error", code: "local_upstream_error" } }));
		} else {
			try { res.end(); } catch {}
		}
		return;
	}
	clearTimeout(headersDeadline);

	if (response.status === 404 && !res.headersSent) {
		// Distinguish "local server has no such model" from a transient blip so
		// the caller can decide whether to fall back (that fallback lives in
		// index.js / the caller, not here — this layer never retries).
		detach();
		res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify({ error: { message: `local model "${route.model}" not found on ${route.baseUrl}`, type: "model_not_found", code: "model_not_found" } }));
		return;
	}

	const contentType = String(response.headers.get("content-type") ?? "");
	const isEventStream = contentType.includes("text/event-stream");
	try {
		if (isEventStream && response.ok) {
			// SSE passthrough: relay every byte as it arrives, no re-assembly —
			// the local server already emits OpenAI-shaped chunks, and
			// re-parsing would only add latency and a new class of bugs. Only a
			// successful response is relayed as 200: some gateways answer errors
			// with the SSE content type too, and those must keep their status.
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			const reader = response.body.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (signal?.aborted === true) { await reader.cancel().catch(() => {}); break; }
					res.write(Buffer.from(value));
				}
			} finally {
				reader.releaseLock();
			}
			res.end();
			return;
		}
		// Non-streaming (and non-2xx SSE error responses): buffer, then emit
		// once with the local server's own status + body (local error shapes
		// pass through untouched).
		const text = await response.text();
		if (!res.headersSent) {
			res.writeHead(response.status, {
				"Content-Type": contentType.includes("application/json") ? "application/json; charset=utf-8" : String(contentType || "application/octet-stream"),
				"Cache-Control": "no-store",
			});
		}
		res.end(text);
	} catch (error) {
		// Mid-stream failure (local server died between chunks): headers are
		// already out — end quietly, never attempt a second writeHead.
		try { res.end(); } catch {}
	} finally {
		// Drop the abort wiring on every exit path so a per-request listener
		// never outlives the request.
		detach();
	}
}

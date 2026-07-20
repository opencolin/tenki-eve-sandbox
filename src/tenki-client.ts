/**
 * TenkiClient — a dependency-free client for the Tenki Cloud API.
 *
 * Tenki's API is ConnectRPC (JSON over HTTP/1.1), not REST. Every control-plane
 * call is `POST {baseUrl}/tenki.sandbox.v1.SandboxService/{Method}` with a
 * lowerCamelCase JSON body and a JSON response. Per-session file I/O runs on a
 * separate data-plane endpoint returned at session-create time, authenticated
 * with a short-lived session certificate.
 *
 * The wire details here (headers, the control/data-plane split, the fact that
 * ExecuteCommand returns no output on the live gateway so stdout/stderr must be
 * captured via `sh -c` redirect + data-plane ReadFile) are ported from the
 * live-verified n8n community node (github.com/opencolin/n8n-nodes-tenki).
 */

const CONTROL_SERVICE = "tenki.sandbox.v1.SandboxService";
const DATA_SERVICE = "tenki.sandbox.v1.SandboxSessionDataPlaneService";
const DEFAULT_BASE_URL = "https://api.tenki.cloud";

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;
const RETRYABLE = new Set(["rate_limited", "ratelimited", "resource_exhausted", "resourceexhausted", "unavailable"]);

/** Home directory of the sandbox's `tenki` user; run-code scripts and capture files live here. */
const SANDBOX_HOME = "/home/tenki";

export type Language = "shell" | "python" | "javascript";

export interface ExecResult {
	command: string;
	args: string[];
	stdout: string;
	stderr: string;
	exitCode: number;
	ok: boolean;
	captureError?: string;
}

interface CachedCredential {
	endpoint: string;
	token: string;
	expiresAt?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function safeJson(text: string): Record<string, unknown> | undefined {
	try {
		const p: unknown = JSON.parse(text);
		return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** POSIX single-quote a string for safe use inside `sh -c`. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Tenki's auth header is chosen by token prefix (verbatim from the SDK's auth.ts):
 * `tk_` → Bearer, `ory_st_` → X-Session-Token, otherwise a `tenki_session` cookie.
 */
function authHeaders(token: string): Record<string, string> {
	const t = token.trim();
	if (t.startsWith("tk_")) return { Authorization: `Bearer ${t}` };
	if (t.startsWith("ory_st_")) return { "X-Session-Token": t };
	return { Cookie: `tenki_session=${t}` };
}

function interpreterFor(language: Language): { file: string; command: string; args: string[] } {
	switch (language) {
		case "python":
			return { file: `${SANDBOX_HOME}/main.py`, command: "python3", args: [`${SANDBOX_HOME}/main.py`] };
		case "javascript":
			return { file: `${SANDBOX_HOME}/main.js`, command: "node", args: [`${SANDBOX_HOME}/main.js`] };
		case "shell":
		default:
			return { file: `${SANDBOX_HOME}/main.sh`, command: "sh", args: [`${SANDBOX_HOME}/main.sh`] };
	}
}

export class TenkiClient {
	private readonly baseUrl: string;
	private readonly credCache = new Map<string, CachedCredential>();

	constructor(private readonly token: string, baseUrl: string = DEFAULT_BASE_URL) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	/**
	 * Unary control-plane call, with idempotency-aware retry.
	 *
	 * A rate-limit (HTTP 429 / `rate_limited`) means the request was REJECTED, so it
	 * is safe to retry any method. An ambiguous transient (`unavailable` /
	 * `resource_exhausted`) may have been processed server-side, so we retry it ONLY
	 * for idempotent methods — never `Create*`, where a lost response after the
	 * resource was actually created would double-create a billing session/snapshot/volume.
	 */
	async control(method: string, body: Record<string, unknown> = {}): Promise<Record<string, any>> {
		const url = `${this.baseUrl}/${CONTROL_SERVICE}/${method}`;
		const nonIdempotent = /^Create/.test(method);
		for (let attempt = 0; ; attempt++) {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", ...authHeaders(this.token) },
				body: JSON.stringify(body ?? {}),
			});
			if (res.ok) return (await res.json()) as Record<string, any>;

			const text = await res.text();
			const parsed = safeJson(text);
			const code = typeof parsed?.code === "string" ? parsed.code.toLowerCase() : "";
			const isRateLimit = res.status === 429 || code === "rate_limited" || code === "ratelimited";
			const isAmbiguousTransient = RETRYABLE.has(code) && !isRateLimit;
			const shouldRetry = isRateLimit || (isAmbiguousTransient && !nonIdempotent);
			if (attempt < MAX_RETRIES && shouldRetry) {
				await sleep(Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS));
				continue;
			}
			const msg = (parsed?.message as string) || text || res.statusText;
			throw new Error(`Tenki ${method} failed (${res.status}${code ? ` ${code}` : ""}): ${msg}`);
		}
	}

	/** Mint (and cache per session) the data-plane endpoint + session certificate. */
	private async credentialFor(sessionId: string): Promise<CachedCredential> {
		const cached = this.credCache.get(sessionId);
		if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now())) return cached;

		const resp = await this.control("CreateSessionCredential", { sessionId });
		const cred = (resp.credential as Record<string, any>) ?? resp;
		const token = (cred.credential ?? cred.token) as string;
		const endpoint = (resp.dataPlaneEndpoint ?? resp.data_plane_endpoint ?? resp.routeStatus?.endpoint) as
			| string
			| undefined;

		let expiresAt: number | undefined;
		const raw = cred.expiresAt ?? cred.expires_at;
		if (typeof raw === "string") {
			const p = Date.parse(raw);
			if (!Number.isNaN(p)) expiresAt = p;
		}
		const entry: CachedCredential = { endpoint: endpoint ?? "", token, expiresAt };
		this.credCache.set(sessionId, entry);
		return entry;
	}

	/** Unary data-plane call. The inner request is wrapped as `{ request: { sessionId, ...request } }`. */
	async data(sessionId: string, method: string, request: Record<string, unknown> = {}): Promise<Record<string, any>> {
		const cred = await this.credentialFor(sessionId);
		if (!cred.endpoint) {
			throw new Error(`Could not resolve the data-plane endpoint for session ${sessionId}.`);
		}
		const url = `${cred.endpoint.replace(/\/+$/, "")}/${DATA_SERVICE}/${method}`;
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Connect-Protocol-Version": "1",
				"x-tenki-session-cert": cred.token,
			},
			body: JSON.stringify({ request: { sessionId, ...request } }),
		});
		if (!res.ok) {
			const text = await res.text();
			const parsed = safeJson(text);
			throw new Error(`Tenki data ${method} failed (${res.status}): ${(parsed?.message as string) || text}`);
		}
		const wrapped = (await res.json()) as Record<string, any>;
		return (wrapped.response as Record<string, any>) ?? wrapped;
	}

	/**
	 * Resolve the calling identity + a default workspace/project for CreateSession
	 * (which requires a projectId). Picks the first workspace that has a project so
	 * the (workspace, project) pair stays consistent.
	 */
	async resolveOwner(): Promise<{ ownerType?: string; ownerId?: string; workspaceId?: string; projectId?: string }> {
		const resp = await this.control("WhoAmI", {});
		const workspaces: any[] = Array.isArray(resp.workspaces) ? resp.workspaces : [];
		const ws = workspaces.find((w) => Array.isArray(w?.projects) && w.projects.length > 0) ?? workspaces[0];
		const proj = Array.isArray(ws?.projects) ? ws.projects[0] : undefined;
		return {
			ownerType: resp.ownerType,
			ownerId: resp.ownerId,
			workspaceId: ws?.workspaceId ?? ws?.id,
			projectId: proj?.projectId ?? proj?.id,
		};
	}

	/** Poll GetSession until it reaches (or passes into) the target state. */
	async waitForState(
		sessionId: string,
		target = "RUNNING",
		{ timeoutMs = 180000, intervalMs = 1000 }: { timeoutMs?: number; intervalMs?: number } = {},
	): Promise<Record<string, any>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const resp = await this.control("GetSession", { sessionId });
			const session = (resp.session as Record<string, any>) ?? resp;
			const state = String(session.state ?? "");
			if (state.includes(target)) return session;
			if (["TERMINATED", "ERROR", "FAILED"].some((s) => state.includes(s))) {
				throw new Error(`Session ${sessionId} entered ${state} while waiting for ${target}.`);
			}
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for session ${sessionId} to reach ${target} (last state: ${state}).`);
			}
			await sleep(intervalMs);
		}
	}

	async readTextFile(sessionId: string, path: string): Promise<string> {
		const resp = await this.data(sessionId, "ReadFile", { path });
		const content = (resp.content ?? resp.data ?? resp.file?.content ?? "") as string;
		return content ? Buffer.from(content, "base64").toString("utf8") : "";
	}

	async writeTextFile(sessionId: string, path: string, text: string): Promise<Record<string, any>> {
		const content = Buffer.from(text, "utf8").toString("base64");
		return this.data(sessionId, "WriteFile", { path, content });
	}

	/**
	 * Run a command in a session and return stdout/stderr inline.
	 *
	 * The live gateway's ExecuteCommand does not populate output artifacts, so we
	 * wrap the command in `sh -c '<cmd> > out 2> err'`, then read the capture files
	 * back over the data plane (the only plain-HTTP path to output). Capture-read
	 * failures degrade gracefully into `captureError` rather than losing the run.
	 */
	async execCaptured(
		sessionId: string,
		command: string,
		opts: { args?: string[]; cwd?: string; env?: Record<string, string>; timeoutSeconds?: number } = {},
	): Promise<ExecResult> {
		const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const outPath = `${SANDBOX_HOME}/.mcp-exec-${suffix}.out`;
		const errPath = `${SANDBOX_HOME}/.mcp-exec-${suffix}.err`;

		const execLine = [command, ...(opts.args ?? [])].map(shellQuote).join(" ");
		const cd = opts.cwd && opts.cwd.trim() ? `cd ${shellQuote(opts.cwd.trim())} && ` : "";
		// Group so the redirects capture a `cd` failure too — otherwise a bad cwd
		// exits non-zero with the error escaping to the uncaptured outer shell,
		// leaving BOTH stdout and stderr empty (a confusing silent failure).
		const script = `{ ${cd}${execLine} ; } > ${outPath} 2> ${errPath}`;

		const body: Record<string, unknown> = { sessionId, command: "sh", args: ["-c", script] };
		if (opts.env && Object.keys(opts.env).length) body.env = opts.env;
		if (opts.timeoutSeconds && opts.timeoutSeconds > 0) body.timeout = `${opts.timeoutSeconds}s`;

		const resp = await this.control("ExecuteCommand", body);
		const execution = (resp.execution as Record<string, any>) ?? resp;
		// proto3 omits zero-valued fields: an absent exitCode means 0 (success).
		const exitCode =
			typeof execution.exitCode === "number" ? execution.exitCode : Number(execution.exitCode ?? 0);

		let stdout = "";
		let stderr = "";
		let captureError: string | undefined;
		try {
			stdout = await this.readTextFile(sessionId, outPath);
			stderr = await this.readTextFile(sessionId, errPath);
		} catch (e) {
			captureError = (e as Error).message;
		}
		try {
			await this.control("ExecuteCommand", { sessionId, command: "rm", args: ["-f", outPath, errPath] });
		} catch {
			// Session may have gone away; capture files die with it.
		}

		return {
			command,
			args: opts.args ?? [],
			stdout,
			stderr,
			exitCode,
			ok: exitCode === 0,
			...(captureError ? { captureError } : {}),
		};
	}

	/**
	 * One-shot: boot a throwaway sandbox, run code (shell / python / javascript),
	 * return its output, and terminate the sandbox. Cost-guarded (1 vCPU, 1 GB,
	 * 10-min cap, 5-min idle) so an ephemeral run can never leak a billing session.
	 */
	async runCode(
		language: Language,
		code: string,
		opts: { env?: Record<string, string>; timeoutSeconds?: number } = {},
	): Promise<ExecResult & { sessionId: string; language: Language }> {
		const owner = await this.resolveOwner();
		const create = await this.control("CreateSession", {
			cpuCores: 1,
			memoryMb: 1024,
			maxDuration: "600s",
			idleTimeoutMinutes: 5,
			...(owner.ownerType ? { ownerType: owner.ownerType } : {}),
			...(owner.ownerId ? { ownerId: owner.ownerId } : {}),
			...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}),
			...(owner.projectId ? { projectId: owner.projectId } : {}),
			...(opts.env && Object.keys(opts.env).length ? { env: opts.env } : {}),
		});
		const session = (create.session as Record<string, any>) ?? create;
		const sessionId = (session.id ?? create.sessionId ?? create.id) as string;
		if (!sessionId) throw new Error("runCode: could not read the created session id from CreateSession.");

		try {
			await this.waitForState(sessionId, "RUNNING");
			const { file, command, args } = interpreterFor(language);
			await this.writeTextFile(sessionId, file, code);
			const result = await this.execCaptured(sessionId, command, {
				args,
				env: opts.env,
				timeoutSeconds: opts.timeoutSeconds,
			});
			return { sessionId, language, ...result };
		} finally {
			try {
				await this.control("TerminateSession", { sessionId });
			} catch {
				// Best-effort teardown; the idle/max-duration guards reap it regardless.
			}
		}
	}
}

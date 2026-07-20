/**
 * `tenki()` — a Vercel Eve sandbox backend backed by Tenki Cloud microVMs.
 *
 * Usage in `agent/sandbox.ts`:
 *
 *   import { defineSandbox } from "eve/sandbox";
 *   import { tenki } from "tenki-eve-sandbox";
 *   export default defineSandbox({ backend: tenki() });
 *
 * Set TENKI_API_KEY in the environment (or pass `apiKey`).
 */
import type {
	SandboxBackend,
	SandboxBackendCreateInput,
	SandboxBackendHandle,
	SandboxBackendPrewarmInput,
	SandboxBackendSessionState,
} from "eve/sandbox";

import { TenkiClient } from "./tenki-client.js";
import { makeSession } from "./session.js";

export interface TenkiBackendOptions {
	/** Tenki API key (`tk_…` or a session token). Defaults to TENKI_API_KEY / TENKI_AUTH_TOKEN. */
	apiKey?: string;
	/** Control-plane base URL. Defaults to TENKI_API_ENDPOINT or https://api.tenki.cloud. */
	baseUrl?: string;
	/**
	 * Working directory sandboxes anchor relative paths to. Default `/home/tenki`
	 * — Tenki's data plane confines file I/O to the sandbox user's home, so this
	 * must stay under it (unlike Eve's `/workspace` convention on other backends).
	 */
	workdir?: string;
	/** vCPUs (default 2). */
	cpuCores?: number;
	/** Memory in MB (default 4096). */
	memoryMb?: number;
	/** Disk in GB. */
	diskSizeGb?: number;
	/** Hard lifetime cap in seconds (default 14400 = 4h — a billing backstop). */
	maxDurationSeconds?: number;
	/** Reap after N idle minutes (default 30 — a billing backstop). */
	idleTimeoutMinutes?: number;
	/** Per-command timeout in seconds (default 600). Bounds any single run/spawn so a hung command can't bill forever. */
	maxCommandSeconds?: number;
	/** Allow outbound networking (off by default). */
	allowOutbound?: boolean;
	/** Allow inbound networking (off by default). */
	allowInbound?: boolean;
	/** Project to create sandboxes in (defaults to the key's first project). */
	projectId?: string;
	/** Workspace to create sandboxes in (defaults to the key's first workspace). */
	workspaceId?: string;
	/** Default environment variables for every sandbox. */
	env?: Record<string, string>;
}

/**
 * Construct the Tenki sandbox backend. Pin it explicitly on a
 * {@link https://vercel.com/eve | Eve} sandbox definition to run that agent's
 * sandbox on Tenki regardless of environment.
 */
export function tenki(options: TenkiBackendOptions = {}): SandboxBackend {
	const token = options.apiKey ?? process.env.TENKI_API_KEY ?? process.env.TENKI_AUTH_TOKEN;
	if (!token) {
		throw new Error("tenki backend: no API key. Set TENKI_API_KEY (or pass { apiKey }).");
	}
	const client = new TenkiClient(token, options.baseUrl);
	const workdir = options.workdir ?? "/home/tenki";

	/** Reattach a still-live session from persisted metadata, else create a fresh one. */
	async function bootSession(existing?: Record<string, unknown>): Promise<string> {
		const existingId = typeof existing?.sessionId === "string" ? existing.sessionId : undefined;
		if (existingId) {
			try {
				const got = await client.control("GetSession", { sessionId: existingId });
				const state = String((got.session ?? got).state ?? "");
				if (state.includes("PAUSED")) {
					await client.control("ResumeSession", { sessionId: existingId }).catch(() => undefined);
					await client.waitForState(existingId, "RUNNING");
					return existingId;
				}
				if (state.includes("RUNNING")) return existingId;
			} catch {
				// Persisted session is gone — fall through to a fresh create.
			}
		}

		const owner = await client.resolveOwner();
		const created = await client.control("CreateSession", {
			cpuCores: options.cpuCores ?? 2,
			memoryMb: options.memoryMb ?? 4096,
			...(options.diskSizeGb ? { diskSizeGb: options.diskSizeGb } : {}),
			// Billing safety net: ALWAYS cap idle + lifetime. If the Eve server dies
			// before shutdown()/PauseSession runs, these guards reap the microVM
			// instead of billing it forever (a per-second product). Callers can raise them.
			idleTimeoutMinutes: options.idleTimeoutMinutes ?? 30,
			maxDuration: `${options.maxDurationSeconds ?? 14400}s`,
			...(options.allowOutbound ? { allowOutbound: true } : {}),
			...(options.allowInbound ? { allowInbound: true } : {}),
			...(options.env && Object.keys(options.env).length ? { env: options.env } : {}),
			...(owner.ownerType ? { ownerType: owner.ownerType } : {}),
			...(owner.ownerId ? { ownerId: owner.ownerId } : {}),
			...((options.workspaceId ?? owner.workspaceId) ? { workspaceId: options.workspaceId ?? owner.workspaceId } : {}),
			...((options.projectId ?? owner.projectId) ? { projectId: options.projectId ?? owner.projectId } : {}),
		});
		const session = (created.session ?? created) as Record<string, any>;
		const sessionId = (session.id ?? created.sessionId) as string | undefined;
		if (!sessionId) throw new Error("tenki backend: CreateSession returned no session id.");
		await client.waitForState(sessionId, "RUNNING");
		// Ensure the working directory exists so relative paths resolve. Fail loudly if
		// it can't be created — otherwise every later relative-path op fails cryptically.
		const mk = await client.execCaptured(sessionId, "mkdir", { args: ["-p", workdir] });
		if (!mk.ok) {
			throw new Error(`tenki backend: could not create workdir ${workdir} (exit ${mk.exitCode}): ${mk.stderr.trim() || mk.captureError || "unknown"}`);
		}
		return sessionId;
	}

	return {
		name: "tenki",

		async prewarm(_input: SandboxBackendPrewarmInput): Promise<{ reused: boolean }> {
			// v0: no template snapshotting — every session boots fresh from the base runtime.
			// Roadmap: capture bootstrap state into a Tenki snapshot/template keyed by templateKey.
			return { reused: false };
		},

		async create(input: SandboxBackendCreateInput): Promise<SandboxBackendHandle> {
			const sessionId = await bootSession(input.existingMetadata);
			const session = makeSession(client, sessionId, workdir, options.maxCommandSeconds ?? 600);
			const handle: SandboxBackendHandle = {
				session,
				useSessionFn: async () => session,
				async captureState(): Promise<SandboxBackendSessionState> {
					return { backendName: "tenki", metadata: { sessionId }, sessionKey: input.sessionKey };
				},
				async shutdown(): Promise<void> {
					// Pause (not terminate) so the session reattaches from captured state next start.
					await client.control("PauseSession", { sessionId }).catch(() => undefined);
				},
			};
			return handle;
		},
	};
}

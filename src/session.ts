/**
 * Maps Eve's `SandboxSession` surface onto Tenki primitives.
 *
 * Eve derives its file/exec I/O shape from the AI SDK sandbox type. Each method
 * here implements that shape against the (live-verified) Tenki client:
 *   - run / spawn     -> Tenki ExecuteCommand (with the sh -c capture the gateway needs)
 *   - read / write    -> Tenki data-plane ReadFile/WriteFile (base64 bytes)
 *   - removePath      -> `rm` in the sandbox
 *
 * Relative paths anchor to `workdir` (default `/home/tenki` — Tenki confines
 * file I/O to the sandbox user's home; `/workspace` is rejected). Absolute paths
 * pass through, so agent code hard-coding `/workspace` will fail — use relative paths.
 */
import type { SandboxProcess, SandboxRunOptions, SandboxSession } from "eve/sandbox";
import type { TenkiClient } from "./tenki-client.js";

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function stringToStream(text: string): ReadableStream<Uint8Array> {
	return bytesToStream(new TextEncoder().encode(text));
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

function decodeBytes(bytes: Uint8Array, encoding: string): string {
	if (encoding === "utf-8" || encoding === "utf8") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	return Buffer.from(bytes).toString(encoding as BufferEncoding);
}

function encodeString(text: string, encoding: string): Uint8Array {
	if (encoding === "utf-8" || encoding === "utf8") return new TextEncoder().encode(text);
	return new Uint8Array(Buffer.from(text, encoding as BufferEncoding));
}

/** 1-based, inclusive line slice; keeps line endings, matching Eve's readTextFile. */
function applyLineRange(text: string, opts: { startLine?: number; endLine?: number }): string {
	if (opts.startLine === undefined && opts.endLine === undefined) return text;
	const lines = text.split(/(?<=\n)/);
	const total = lines.length;
	// Clamp startLine to >=1: a 0/negative value must not become slice(-1) (the LAST line).
	const start = Math.max(1, opts.startLine ?? 1);
	const end = Math.min(opts.endLine ?? total, total);
	if (start > total) return "";
	return lines.slice(start - 1, end).join("");
}

/**
 * Build the full Eve `SandboxSession` for a live Tenki session id.
 * `workdir` is the anchor for relative paths.
 */
export function makeSession(
	client: TenkiClient,
	sessionId: string,
	workdir: string,
	maxCommandSeconds = 600,
): SandboxSession {
	const root = workdir.replace(/\/+$/, "") || "/home/tenki";
	const resolvePath = (p: string): string => (p.startsWith("/") ? p : `${root}/${p}`);

	/**
	 * Run a command with a billing-bounded timeout and Eve abort support.
	 * The per-command timeout is enforced server-side (Tenki kills the command),
	 * so a hung command can't bill forever; the abortSignal lets an Eve turn-abort
	 * hand control back promptly.
	 */
	async function runExec(options: SandboxRunOptions) {
		if (options.abortSignal?.aborted) throw new Error("tenki backend: command aborted before start");
		const execP = client.execCaptured(sessionId, "sh", {
			args: ["-c", options.command],
			cwd: options.workingDirectory ?? root,
			env: options.env,
			timeoutSeconds: maxCommandSeconds,
		});
		const signal = options.abortSignal;
		const res = signal
			? await Promise.race([
					execP,
					new Promise<never>((_, reject) => {
						signal.addEventListener("abort", () => reject(new Error("tenki backend: command aborted")), { once: true });
					}),
				])
			: await execP;
		// Surface a capture-read failure instead of letting it read as exit 0 + empty output.
		if (res.captureError) {
			return { ...res, stderr: `${res.stderr}${res.stderr ? "\n" : ""}[tenki: output capture failed: ${res.captureError}]` };
		}
		return res;
	}

	async function readRaw(path: string): Promise<Uint8Array | null> {
		try {
			const resp = await client.data(sessionId, "ReadFile", { path });
			const b64 = (resp.content ?? resp.data ?? resp.file?.content ?? "") as string;
			return b64 ? new Uint8Array(Buffer.from(b64, "base64")) : new Uint8Array(0);
		} catch (e) {
			// Only a genuine "file not found" maps to null (Eve's contract for read*).
			// Tenki surfaces that as a 404 ("no such file or directory"). Any other
			// failure (network, auth, permission) must propagate, not masquerade as missing.
			const msg = (e as Error)?.message ?? "";
			if (/\(404\)|no such file|not found|does not exist/i.test(msg)) return null;
			throw e;
		}
	}

	async function writeRaw(path: string, bytes: Uint8Array): Promise<void> {
		const content = Buffer.from(bytes).toString("base64");
		try {
			await client.data(sessionId, "WriteFile", { path, content });
		} catch (e) {
			// Eve's writeFile contract creates parent dirs recursively; Tenki's WriteFile
			// may not. On a missing-directory failure, create the parent tree and retry once
			// (agents write nested paths like src/index.ts constantly).
			const msg = (e as Error)?.message ?? "";
			const slash = path.lastIndexOf("/");
			if (slash > 0 && /no such file|not a directory|does not exist|\(404\)/i.test(msg)) {
				await client.execCaptured(sessionId, "mkdir", { args: ["-p", path.slice(0, slash)] });
				await client.data(sessionId, "WriteFile", { path, content });
			} else {
				throw e;
			}
		}
	}

	async function spawn(options: SandboxRunOptions): Promise<SandboxProcess> {
		const res = await runExec(options);
		return {
			stdout: stringToStream(res.stdout),
			stderr: stringToStream(res.stderr),
			wait: async () => ({ exitCode: res.exitCode }),
			kill: async () => {
				/* command already ran to completion via the capture path */
			},
		};
	}

	return {
		id: sessionId,
		resolvePath,
		async run(options) {
			const res = await runExec(options);
			return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
		},
		spawn,
		async readFile(options) {
			const bytes = await readRaw(resolvePath(options.path));
			return bytes === null ? null : bytesToStream(bytes);
		},
		async readBinaryFile(options) {
			return readRaw(resolvePath(options.path));
		},
		async readTextFile(options) {
			const bytes = await readRaw(resolvePath(options.path));
			if (bytes === null) return null;
			return applyLineRange(decodeBytes(bytes, options.encoding ?? "utf-8"), options);
		},
		async writeFile(options) {
			await writeRaw(resolvePath(options.path), await streamToBytes(options.content));
		},
		async writeBinaryFile(options) {
			await writeRaw(resolvePath(options.path), options.content);
		},
		async writeTextFile(options) {
			await writeRaw(resolvePath(options.path), encodeString(options.content, options.encoding ?? "utf-8"));
		},
		async setNetworkPolicy() {
			throw new Error(
				"tenki backend: network policy is fixed at sandbox creation (allowInbound/allowOutbound); runtime changes are not supported.",
			);
		},
		async removePath(options) {
			const flags = `-${options.recursive ? "r" : ""}${options.force ? "f" : ""}`;
			const args = flags === "-" ? [resolvePath(options.path)] : [flags, resolvePath(options.path)];
			const res = await client.execCaptured(sessionId, "rm", { args });
			// Honor Eve's contract: a failed remove must throw, not silently report success.
			// (`force` already suppresses missing-path errors at the rm level.)
			if (!res.ok) {
				throw new Error(`tenki backend: removePath(${options.path}) failed (exit ${res.exitCode}): ${res.stderr.trim() || res.captureError || "unknown"}`);
			}
		},
	};
}

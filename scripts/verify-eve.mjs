/**
 * Runtime verification: drive the Tenki backend exactly as Eve's runtime does.
 *
 * Eve's orchestrator calls backend.create(input) → uses the returned
 * handle.session (run / read / write) → handle.shutdown(). This script performs
 * that same sequence against a LIVE Tenki microVM, so a green run proves the
 * backend works end-to-end, not just at the type level.
 *
 *   node scripts/verify-eve.mjs        (reads token from ~/.config/tenki/config.yaml)
 */
import { tenki, TenkiClient } from "../dist/index.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const cfg = readFileSync(`${homedir()}/.config/tenki/config.yaml`, "utf8");
const token = (cfg.match(/^auth_token:\s*(.+)$/m)?.[1] ?? "").trim();
if (!token) {
	console.error("No token in ~/.config/tenki/config.yaml — run `tenki login`.");
	process.exit(1);
}

const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
	console.log(`  ✗ ${m}`);
	process.exitCode = 1;
};

const backend = tenki({ apiKey: token });
console.log(`backend.name = ${backend.name}`);

let sessionId;
try {
	console.log("[1] backend.create(...) — Eve's runtime create path");
	const handle = await backend.create({
		templateKey: null,
		sessionKey: "verify-1",
		runtimeContext: { appRoot: process.cwd() },
	});
	const state = await handle.captureState();
	sessionId = state.metadata.sessionId;
	state.backendName === "tenki" && sessionId ? pass(`session ${sessionId} (state captured)`) : fail("no session/state");
	const session = handle.session;

	console.log("[2] session.run(...) — the command path an agent turn uses");
	const r = await session.run({ command: "echo hello-from-eve-on-tenki; python3 -c 'print(6*7)'" });
	r.exitCode === 0 && r.stdout.includes("hello-from-eve-on-tenki") && r.stdout.includes("42")
		? pass(`exit=${r.exitCode} stdout=${JSON.stringify(r.stdout.trim())}`)
		: fail(`unexpected run result: ${JSON.stringify(r)}`);

	console.log("[3] resolvePath + text write/read round-trip (relative path)");
	pass(`resolvePath("note.txt") = ${session.resolvePath("note.txt")}`);
	await session.writeTextFile({ path: "note.txt", content: "written via eve session" });
	const backText = await session.readTextFile({ path: "note.txt" });
	backText === "written via eve session" ? pass(`read back: ${JSON.stringify(backText)}`) : fail(`text mismatch: ${JSON.stringify(backText)}`);

	console.log("[4] binary write/read round-trip");
	await session.writeBinaryFile({ path: "b.bin", content: new Uint8Array([1, 2, 3, 4]) });
	const bin = await session.readBinaryFile({ path: "b.bin" });
	bin && bin.length === 4 && bin[0] === 1 && bin[3] === 4 ? pass(`bytes back: [${Array.from(bin)}]`) : fail(`binary mismatch: ${bin ? Array.from(bin) : null}`);

	console.log("[5] readTextFile on a missing file -> null (Eve contract)");
	const missing = await session.readTextFile({ path: "does-not-exist.txt" });
	missing === null ? pass("missing file returned null") : fail(`expected null, got ${JSON.stringify(missing)}`);

	console.log("[6] handle.shutdown() — pauses for durable reattach");
	await handle.shutdown();
	pass("shutdown OK (paused)");

	console.log(process.exitCode ? "\nSome checks FAILED ✗" : "\nAll runtime checks passed ✓");
} catch (e) {
	fail(`runtime error: ${e?.message ?? e}`);
} finally {
	if (sessionId) {
		try {
			await new TenkiClient(token).control("TerminateSession", { sessionId });
			console.log(`(cleaned up ${sessionId})`);
		} catch {
			console.log(`(could not terminate ${sessionId}; it self-reaps via idle/max-duration)`);
		}
	}
}

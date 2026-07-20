# tenki-eve-sandbox

**Run your [Vercel Eve](https://vercel.com/eve) agents on [Tenki Cloud](https://tenki.cloud) microVMs.** A drop-in [sandbox backend](https://vercel.com/eve) for Eve — swap Eve's default compute for Tenki's disposable Firecracker microVMs (boot ~2s, per-second billing) in one line.

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { tenki } from "tenki-eve-sandbox";

export default defineSandbox({ backend: tenki() });
```

That's it. Your agent's `run`, file I/O, and processes now execute in a Tenki sandbox.

## Install

```bash
npm install tenki-eve-sandbox
export TENKI_API_KEY=tk_your_key_here    # or pass { apiKey } to tenki()
```

`eve` is a peer dependency (you already have it in an Eve project).

## Options

```ts
tenki({
  apiKey,               // default: TENKI_API_KEY / TENKI_AUTH_TOKEN
  baseUrl,              // default: https://api.tenki.cloud
  workdir,              // default: /home/tenki (Tenki confines file I/O to $HOME)
  cpuCores,             // default: 2
  memoryMb,             // default: 4096
  diskSizeGb,
  maxDurationSeconds,   // hard lifetime cap
  idleTimeoutMinutes,   // reap after N idle minutes
  allowOutbound,        // default: false
  allowInbound,         // default: false
  projectId,            // default: the key's first project
  workspaceId,          // default: the key's first workspace
  env,                  // default env for every sandbox
});
```

## How it works

Eve backends implement a small two-phase contract (`prewarm` at build time, `create` at runtime returning a session handle). This package implements it against the Tenki API:

| Eve `SandboxSession` | Tenki |
|---|---|
| `run` / `spawn` | `ExecuteCommand` (with the `sh -c` capture the gateway needs to return output over HTTP) |
| `readFile` / `readTextFile` / `readBinaryFile` | data-plane `ReadFile` (base64) |
| `writeFile` / `writeTextFile` / `writeBinaryFile` | data-plane `WriteFile` (base64) |
| `removePath` | `rm` in the sandbox |
| session lifecycle | `CreateSession` → `PauseSession`/`ResumeSession` (durable reattach) → per-session credential for the data plane |

The Tenki wire client is ported from the live-verified [n8n node](https://github.com/opencolin/n8n-nodes-tenki) and shared with [tenki-mcp](https://github.com/opencolin/tenki-mcp).

## Status & known limits (v0.1)

- **Type-verified:** `defineSandbox({ backend: tenki() })` compiles against Eve v0.25's published types (direct and lazy-factory forms).
- **Runtime-verified against live Tenki:** driving the backend exactly as Eve's runtime does — `create()` → `session.run()` → text + binary `read`/`write` → missing-file-returns-`null` → `shutdown()` — passes end-to-end against a real microVM (`scripts/verify-eve.mjs`). The remaining gap is a full LLM-in-the-loop `eve dev` turn (the model *choosing* to call the sandbox); the sandbox integration itself is verified.
- **Workdir is `/home/tenki`, not `/workspace`.** Tenki confines file I/O to the sandbox user's home, so relative paths anchor there (other Eve backends use `/workspace`). Override with `workdir`. Agents that hard-code `/workspace` should use relative paths instead.
- **`spawn` is not incrementally streaming.** Tenki returns command output over HTTP after completion, so `spawn` runs to completion and then exposes the buffered stdout/stderr as streams. `run` (the common path) works exactly as expected; truly interactive long-running processes are a roadmap item (needs a Connect/gRPC streaming transport).
- **No template prewarm yet.** Every session boots fresh from the base runtime; `bootstrap()` snapshots aren't captured into Tenki templates yet. Roadmap.
- **Network policy is fixed at creation** (`allowInbound`/`allowOutbound`); runtime `setNetworkPolicy()` throws, like Eve's just-bash backend.

## Roadmap

- Runtime-verify against a live Eve agent and publish the trace
- Template prewarm via Tenki snapshots/templates (fast cold starts)
- Streaming `spawn` over a Connect/gRPC transport
- Preview-URL passthrough for agents that expose a server

## Related

- [tenki-mcp](https://github.com/opencolin/tenki-mcp) — Tenki as an MCP server for any agent
- [n8n-nodes-tenki](https://github.com/opencolin/n8n-nodes-tenki) — Tenki as an n8n node
- [Tenki Cloud](https://tenki.cloud) · [Vercel Eve](https://vercel.com/eve)

## License

MIT

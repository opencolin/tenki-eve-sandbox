# Example: a minimal Eve agent on Tenki

A complete Eve agent is a directory. This one is two files:

- `agent/instructions.md` — the agent (a Markdown prompt)
- `agent/sandbox.ts` — pins the sandbox backend to Tenki via `tenki()`

## Run it

From a real Eve project (`npx eve@latest init my-agent`), drop `agent/sandbox.ts`
in, then:

```bash
npm install tenki-eve-sandbox
export TENKI_API_KEY=tk_your_key_here
npx eve dev
```

Ask the agent to run something ("run `python3 -c 'print(6*7)'`") and it executes
in a Tenki microVM that booted in ~2 seconds.

## Verify the backend without an LLM

To prove the Tenki integration end-to-end without a model in the loop, this
package ships a harness that drives the backend exactly as Eve's runtime does
(create → run → read/write → shutdown) against a live sandbox:

```bash
node scripts/verify-eve.mjs   # reads your `tenki login` credential
```

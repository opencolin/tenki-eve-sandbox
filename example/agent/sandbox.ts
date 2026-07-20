// agent/sandbox.ts — pin this agent's sandbox to Tenki.
//
// This is the entire integration: import tenki(), hand it to defineSandbox.
// Every run / file op in this agent's turns now executes in a Tenki microVM.
import { defineSandbox } from "eve/sandbox";
import { tenki } from "tenki-eve-sandbox";

export default defineSandbox({
	backend: tenki({
		// apiKey defaults to TENKI_API_KEY. Uncomment to tune the microVM:
		// cpuCores: 2,
		// memoryMb: 4096,
		// allowOutbound: true,
		// idleTimeoutMinutes: 10,
	}),
});

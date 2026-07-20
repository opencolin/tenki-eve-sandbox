/**
 * tenki-eve-sandbox — run your Vercel Eve agents on Tenki Cloud microVMs.
 *
 *   import { defineSandbox } from "eve/sandbox";
 *   import { tenki } from "tenki-eve-sandbox";
 *   export default defineSandbox({ backend: tenki() });
 */
export { tenki, tenki as tenkiSandbox, type TenkiBackendOptions } from "./backend.js";
export { TenkiClient } from "./tenki-client.js";

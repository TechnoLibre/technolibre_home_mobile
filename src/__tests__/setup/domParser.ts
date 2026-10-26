/**
 * Vitest setup: a DOMParser for the files of the node environment, where the
 * app's body helpers (chatBody.ts) parse HTML as the web view does. It comes
 * from jsdom, loaded only when the environment has none, so a jsdom file
 * keeps its own and no other DOM global (document, window) appears. App code
 * and syncTestKit never import jsdom.
 */
if (typeof globalThis.DOMParser === "undefined") {
  const { JSDOM } = await import("jsdom");
  globalThis.DOMParser = new JSDOM("").window.DOMParser;
}

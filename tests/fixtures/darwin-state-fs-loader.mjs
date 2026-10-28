const proxy = new URL("./darwin-state-fs-proxy.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:fs" && context.parentURL?.endsWith("/plugins/grok/scripts/lib/state.mjs")) {
    return { url: proxy, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

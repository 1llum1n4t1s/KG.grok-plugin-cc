// Only ACP's Linux admission boundary is substituted; the ACP client remains real.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/scripts/lib/acp.mjs')) {
    if (specifier === './broker-lifecycle.mjs') return { url: new URL('./direct-spawn-simulated-lifecycle.mjs', import.meta.url).href, shortCircuit: true };
    if (specifier === './direct-start-admission.mjs') return { url: new URL('./direct-spawn-simulated-admission.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

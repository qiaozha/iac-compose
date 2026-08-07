import { register as registerImportHook } from "node:module";
import { register as registerTypeScript } from "tsx/esm/api";

registerTypeScript();
const runtimeEntry = import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js";
const importHook = `data:text/javascript,${encodeURIComponent(`
let runtimeUrl = "";
export function initialize(data) {
  runtimeUrl = data.runtimeUrl;
}
export function resolve(specifier, context, nextResolve) {
  if (specifier === "imperative-deploy") {
    return { url: runtimeUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`)}`;
registerImportHook(importHook, {
  data: { runtimeUrl: new URL(runtimeEntry, import.meta.url).href },
});

export function importTypeScript(
  specifier: string,
): Promise<unknown> {
  return import(specifier);
}
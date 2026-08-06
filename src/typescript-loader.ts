import { register } from "tsx/esm/api";

register();

export function importTypeScript(
  specifier: string,
): Promise<unknown> {
  return import(specifier);
}
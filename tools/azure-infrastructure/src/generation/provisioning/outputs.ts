export function outputBindings(value: unknown): string[] {
  const names = new Set<string>();
  const source = JSON.stringify(value);
  for (const match of source.matchAll(/\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

export function containsOutput(value: unknown, output: string): boolean {
  return JSON.stringify(value).includes("${output." + output + "}");
}

export function hasOutputBinding(value: unknown): boolean {
  return /\$\{output\.[A-Za-z][A-Za-z0-9_]*\}/.test(JSON.stringify(value));
}

export function implementationOutput(resourceId: string, suffix: string): string {
  return `DEPLOY_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${suffix}`;
}
export function identifier(value: string): string {
  const parts = value.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  const joined = parts
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
  return /^[A-Za-z_$]/.test(joined) ? joined : `resource${joined}`;
}

export function pascalCase(value: string): string {
  const name = identifier(value);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function typescriptProperty(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function normalizedName(solution: string, resource: string): string {
  return `${solution}-${resource}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

export function entraApplicationUniqueNamePrefix(
  solution: string,
  resource: string,
): string {
  return hyphenatedPrefix(solution, `${resource}-api`, 82);
}

export function hyphenatedPrefix(
  solution: string,
  resource: string,
  maximumPrefixLength: number,
): string {
  const prefix = normalizedName(solution, resource)
    .slice(0, maximumPrefixLength)
    .replace(/-+$/g, "");
  return `${prefix}-`;
}

export function hyphenatedQualifiedPrefix(
  solution: string,
  resource: string,
  qualifier: string,
  maximumPrefixLength: number,
): string {
  const suffix = `-${qualifier}`;
  const prefix = normalizedName(solution, resource)
    .slice(0, maximumPrefixLength - suffix.length)
    .replace(/-+$/g, "");
  return `${prefix}${suffix}-`;
}

export function alphanumericPrefix(
  solution: string,
  resource: string,
  maximumPrefixLength: number,
): string {
  return `${solution}${resource}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, maximumPrefixLength);
}
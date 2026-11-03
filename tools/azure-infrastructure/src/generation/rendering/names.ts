export function generatedLayerName(component: string): string {
  return `generated${pascalIdentifier(component)}Layer`;
}

export function typescriptIdentifier(value: string): string {
  const parts = value.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  const identifier = parts
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
  const candidate = /^[A-Za-z_$]/.test(identifier)
    ? identifier
    : `component${identifier}`;
  if (!candidate || reservedWords.has(candidate)) {
    return `${candidate || "component"}Deployment`;
  }
  return candidate;
}

export function ensureUniqueIdentifiers(
  names: ReadonlyMap<string, string>,
): void {
  const componentsByName = new Map<string, string>();
  for (const [component, name] of names) {
    const existing = componentsByName.get(name);
    if (existing) {
      throw new Error(
        `Components '${existing}' and '${component}' both map to TypeScript identifier '${name}'.`,
      );
    }
    componentsByName.set(name, component);
  }
}

function pascalIdentifier(value: string): string {
  const name = typescriptIdentifier(value);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const reservedWords = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);
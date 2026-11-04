export interface Diagnostic {
  code: string;
  category: "usage" | "configuration" | "compilation" | "artifact" | "execution" | "program";
  message: string;
  target?: string;
  property?: string;
  expected?: string;
  repair: string;
  exitCode?: number | null;
  signal?: string;
}

export class IacComposerError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(
    diagnostic: Diagnostic,
    options?: ErrorOptions & { message?: string },
  ) {
    super(options?.message ?? diagnostic.message, options);
    this.name = "IacComposerError";
    this.diagnostic = diagnostic;
  }
}

export function diagnosticFor(error: unknown): Diagnostic {
  if (error instanceof IacComposerError) return error.diagnostic;
  return {
    code: "PROGRAM_FAILED",
    category: "program",
    message: "The authored program failed. Inspect stderr for the original error.",
    repair: "Inspect the authored program and stderr; check completed steps before retrying.",
  };
}

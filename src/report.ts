import { rename, rm, writeFile } from "node:fs/promises";
import type { Diagnostic } from "./diagnostics.js";

export interface StepEvent {
  type: "step";
  id: number;
  kind: "env" | "provision" | "deploy" | "command";
  name: string;
  projectDirectory: string;
  status: "started" | "succeeded" | "failed" | "skipped" | "previewed";
}

export interface ArtifactEvent {
  type: "artifacts";
  step: string;
  projectDirectory: string;
  outputDirectory: string;
  templateFile: string;
  parametersFile: string;
  manifestFile: string;
  layer?: string;
  dependsOn: readonly string[];
}

export type DeploymentEvent = StepEvent | ArtifactEvent;

export interface ExecutionReport {
  schemaVersion: "1.0";
  command: "run" | "down" | "describe" | "help" | null;
  status: "running" | "succeeded" | "failed";
  dryRun: boolean | null;
  retrySafety: "unknown";
  steps: StepEvent[];
  artifacts: ArtifactEvent[];
  diagnostics: Diagnostic[];
}

export const executionReportSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "command", "status", "dryRun", "retrySafety", "steps", "artifacts", "diagnostics"],
  properties: {
    schemaVersion: { const: "1.0" },
    command: { enum: ["run", "down", "describe", "help", null] },
    status: { enum: ["running", "succeeded", "failed"] },
    dryRun: { enum: [true, false, null] },
    retrySafety: { const: "unknown" },
    steps: { type: "array", items: { $ref: "#/$defs/step" } },
    artifacts: { type: "array", items: { $ref: "#/$defs/artifacts" } },
    diagnostics: { type: "array", items: { $ref: "#/$defs/diagnostic" } },
  },
  $defs: {
    step: {
      type: "object",
      additionalProperties: false,
      required: ["type", "id", "kind", "name", "projectDirectory", "status"],
      properties: {
        type: { const: "step" },
        id: { type: "integer", minimum: 1 },
        kind: { enum: ["env", "provision", "deploy", "command"] },
        name: { type: "string" },
        projectDirectory: { type: "string" },
        status: { enum: ["started", "succeeded", "failed", "skipped", "previewed"] },
      },
    },
    artifacts: {
      type: "object",
      additionalProperties: false,
      required: ["type", "step", "projectDirectory", "outputDirectory", "templateFile", "parametersFile", "manifestFile", "dependsOn"],
      properties: {
        type: { const: "artifacts" },
        step: { type: "string" },
        projectDirectory: { type: "string" },
        outputDirectory: { type: "string" },
        templateFile: { type: "string" },
        parametersFile: { type: "string" },
        manifestFile: { type: "string" },
        layer: { type: "string" },
        dependsOn: { type: "array", items: { type: "string" } },
      },
    },
    diagnostic: {
      type: "object",
      additionalProperties: false,
      required: ["code", "category", "message", "repair"],
      properties: {
        code: { type: "string" },
        category: { enum: ["usage", "configuration", "compilation", "artifact", "execution", "program"] },
        message: { type: "string" },
        target: { type: "string" },
        property: { type: "string" },
        expected: { type: "string" },
        repair: { type: "string" },
        exitCode: { type: ["integer", "null"] },
        signal: { type: "string" },
      },
    },
  },
} as const;

export function createExecutionReport(): ExecutionReport {
  return {
    schemaVersion: "1.0",
    command: null,
    status: "running",
    dryRun: null,
    retrySafety: "unknown",
    steps: [],
    artifacts: [],
    diagnostics: [],
  };
}

export function recordDeploymentEvent(
  report: ExecutionReport,
  event: DeploymentEvent,
): void {
  if (event.type === "artifacts") {
    report.artifacts.push(event);
    return;
  }
  const index = report.steps.findIndex((step) => step.id === event.id);
  if (index < 0) report.steps.push(event);
  else report.steps[index] = event;
}

export async function writeExecutionReport(
  path: string,
  report: ExecutionReport,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

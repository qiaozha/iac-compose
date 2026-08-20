export interface ResourceContractRequirement {
  readonly id: string;
  readonly kind: string;
  readonly requiredBy: readonly string[];
  readonly produces?: readonly string[];
  readonly source?: string;
  readonly access?: readonly {
    readonly principalOutput: string;
    readonly role: string;
  }[];
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly containerPort?: number;
  readonly healthPath?: string;
  readonly authentication?: string;
  readonly authorization?: string;
  readonly [key: string]: unknown;
}

export interface ResourceContract {
  readonly schemaVersion: string;
  readonly solution: {
    readonly name: string;
    readonly enabledComponents: readonly string[];
  };
  readonly resources: readonly ResourceContractRequirement[];
  readonly [key: string]: unknown;
}

export interface RenderResourceRequirementsOptions {
  readonly templates?: Readonly<Record<string, unknown>>;
  readonly componentKinds?: Readonly<Record<string, string>>;
}

export interface RenderedProvisioningFile {
  readonly path: string;
  readonly contents: string;
}
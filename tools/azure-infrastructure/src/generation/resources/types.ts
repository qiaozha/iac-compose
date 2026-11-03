export type {
  ResourceContract,
  ResourceContractRequirement,
} from "../../shared/contracts/resources/types.js";

export interface RenderResourceRequirementsOptions {
  readonly templates?: Readonly<Record<string, unknown>>;
  readonly componentKinds?: Readonly<Record<string, string>>;
}

export interface RenderedProvisioningFile {
  readonly path: string;
  readonly contents: string;
}

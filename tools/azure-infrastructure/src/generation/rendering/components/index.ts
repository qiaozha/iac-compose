import { renderContainerComponentSource } from "./container.js";
import { renderHostedAgentComponentSource } from "./hosted-agent.js";
import type { ComponentSourceOptions } from "./options.js";
import { renderWorkflowComponentSource } from "./workflow.js";

export function renderComponentSource(options: ComponentSourceOptions): string {
  if (options.kind === "hosted-agent") {
    return renderHostedAgentComponentSource(options);
  }
  if (options.kind === "workflow") {
    return renderWorkflowComponentSource(options);
  }
  return renderContainerComponentSource(options);
}
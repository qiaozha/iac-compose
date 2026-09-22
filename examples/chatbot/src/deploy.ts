import { defineDeployment, type Deployment } from "iac-compose";
import { agent } from "./components/agent/index.js";
import { agentServer } from "./components/agent-server/index.js";
import { frontend } from "./components/frontend/index.js";
import { functionApp } from "./components/function-app/index.js";
import { logicApp } from "./components/logic-app/index.js";
import { shared } from "./components/shared/index.js";
import { prepareEnvironment } from "./runtime/environment.js";

const componentDeployments: Record<
  string,
  (deployment: Deployment) => Promise<void>
> = {
  shared: shared,
  agent: agent,
  "agent-server": agentServer,
  "function-app": functionApp,
  frontend: frontend,
  "logic-app": logicApp,
};

export default defineDeployment(async (deployment) => {
  await prepareEnvironment(deployment);
  if (deployment.component) {
    const deployComponent = Object.hasOwn(
      componentDeployments,
      deployment.component,
    )
      ? componentDeployments[deployment.component]
      : undefined;
    if (!deployComponent) {
      throw new Error(
        `Unknown chatbot component '${deployment.component}'. Expected one of: ${Object.keys(componentDeployments).join(", ")}.`,
      );
    }
    await deployComponent(deployment);
    return;
  }
  await shared(deployment);
  await agent(deployment);
  await agentServer(deployment);
  await functionApp(deployment);
  await frontend(deployment);
  await logicApp(deployment);
});
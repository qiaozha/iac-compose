import { defineDeployment, type Deployment } from "imperative-deploy";
import { agent } from "./components/agent/index.js";
import { backend } from "./components/backend/index.js";
import { frontend } from "./components/frontend/index.js";
import { logicApp } from "./components/logic-app/index.js";
import { shared } from "./components/shared/index.js";
import { prepareEnvironment } from "./runtime/environment.js";

const componentDeployments: Record<
  string,
  (deployment: Deployment) => Promise<void>
> = {
  shared,
  "agent": agent,
  "backend": backend,
  "frontend": frontend,
  "logic-app": logicApp,
};

export default defineDeployment(async (deployment) => {
  await prepareEnvironment(deployment);
  if (deployment.component) {
    const deployComponent = componentDeployments[deployment.component];
    if (!deployComponent) {
      throw new Error(
        `Unknown contoso-support component '${deployment.component}'. Expected one of: ${Object.keys(componentDeployments).join(", ")}.`,
      );
    }
    await deployComponent(deployment);
    return;
  }
  await shared(deployment);
  await agent(deployment);
  await backend(deployment);
  await frontend(deployment);
  await logicApp(deployment);
});

import { defineDeployment } from "imperative-deploy";
import { agent } from "./components/agent/index.js";
import { agentServer } from "./components/agent-server/index.js";
import { frontend } from "./components/frontend/index.js";
import { functionApp } from "./components/function-app/index.js";
import { logicApp } from "./components/logic-app/index.js";
import { shared } from "./components/shared/index.js";
import { prepareEnvironment } from "./runtime/environment.js";

export default defineDeployment(async (deployment) => {
  await prepareEnvironment(deployment);
  await shared(deployment);
  await agent(deployment);
  await agentServer(deployment);
  await functionApp(deployment);
  await frontend(deployment);
  await logicApp(deployment);
});
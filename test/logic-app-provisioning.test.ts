import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { loadLogicAppTeamsConfig } from "../examples/chatbot/src/components/logic-app/config.js";
import {
  logicAppsAccessRestrictionArgs,
  logicAppsAccessRestrictionQueryArgs,
} from "../examples/chatbot/src/components/logic-app/index.js";
import { outputBicep } from "../examples/chatbot/src/components/logic-app/provisioning.js";
import { createLogicAppWorkflowDefinition } from "../examples/chatbot/src/components/logic-app/workflow.js";

test("Logic App provisioning emits the complete workflow in one template", () => {
  const template = outputBicep.find((file) => file.path === "main.bicep");
  const parameters = outputBicep.find(
    (file) => file.path === "main.bicepparam",
  );
  const workflow = JSON.stringify(
    createLogicAppWorkflowDefinition("function-app-resource-id"),
  );

  assert.ok(template);
  assert.ok(parameters);
  assert.match(
    template.contents,
    /resource workflow 'Microsoft\.Logic\/workflows@2019-05-01' = if \(deployWorkflow\)/,
  );
  assert.match(
    template.contents,
    /When_a_new_message_is_added_to_a_chat_or_channel/,
  );
  assert.match(template.contents, /functions\/convertActivity/);
  assert.match(workflow, /parameters\('botId'\)/);
  assert.match(workflow, /setProperty\(.+recipient.+28:/);
  assert.doesNotMatch(template.contents, /triggers:\s*\{\}\s*actions:\s*\{\}/);
  assert.match(parameters.contents, /DEPLOY_LOGIC_APP_WORKFLOW/);
  assert.match(parameters.contents, /LOGIC_APP_TEAMS_GROUP_ID/);
  assert.match(parameters.contents, /LOGIC_APP_TEAMS_CHANNEL_IDS/);
  assert.match(parameters.contents, /BOT_ID/);
});

test("Logic App lifecycle provisions instead of patching a workflow JSON file", async () => {
  const componentRoot = resolve(
    "examples/chatbot/src/components/logic-app",
  );
  const lifecycle = await readFile(resolve(componentRoot, "index.ts"), "utf8");

  assert.match(lifecycle, /deployment\.provision\("Logic App resources and workflow"/);
  assert.match(lifecycle, /loadLogicAppTeamsConfig/);
  assert.match(lifecycle, /logicAppTeams\.teamsGroupId/);
  assert.match(lifecycle, /logicAppTeams\.tenantId/);
  assert.match(lifecycle, /logicAppTeams\.teamsChannelIds/);
  assert.match(lifecycle, /parameters:\s*\{\s*teamsGroupId/);
  assert.match(lifecycle, /teamsChannelIds:\s*teamsChannelIds\.join/);
  assert.doesNotMatch(lifecycle, /requiredEnv\("TEAMS_GROUP_ID"\)/);
  assert.match(
    lifecycle,
    /requiredEnv\("AZURE_TENANT_ID"\),\s*teamsTenantId/,
  );
  assert.match(
    lifecycle,
    /#@\$\{azureTenantId\}\/resource\$\{resourceId\}\/edit/,
  );
  assert.match(lifecycle, /account from Teams tenant '\$\{teamsTenantId\}'/);
  assert.doesNotMatch(lifecycle, /fetch\(|readFile\(|workflow-definition\.json/);
  await assert.rejects(access(resolve(componentRoot, "workflow-definition.json")));
});

test("Logic App lifecycle allows workflow traffic to each App Service", async () => {
  assert.deepEqual(
    logicAppsAccessRestrictionArgs("subscription", "resources", "server"),
    [
      "webapp",
      "config",
      "access-restriction",
      "add",
      "--subscription",
      "subscription",
      "--resource-group",
      "resources",
      "--name",
      "server",
      "--rule-name",
      "Allow Logic Apps",
      "--action",
      "Allow",
      "--service-tag",
      "LogicApps",
      "--priority",
      "100",
    ],
  );
  assert.deepEqual(
    logicAppsAccessRestrictionQueryArgs("subscription", "resources", "server"),
    [
      "webapp",
      "config",
      "access-restriction",
      "show",
      "--subscription",
      "subscription",
      "--resource-group",
      "resources",
      "--name",
      "server",
      "--query",
      "ipSecurityRestrictions[?ipAddress=='LogicApps'].name | [0]",
      "--output",
      "tsv",
    ],
  );

  const lifecycle = await readFile(
    resolve("examples/chatbot/src/components/logic-app/index.ts"),
    "utf8",
  );
  for (const name of [
    "AGENT_SERVER_SITE_NAME",
    "FUNCTION_APP_NAME",
    "FRONTEND_SITE_NAME",
  ]) {
    assert.match(lifecycle, new RegExp(`requiredEnv\\(\"${name}\"\\)`));
  }
});

test("Logic App component owns its Teams tenant, group, and channel IDs", async () => {
  const orchestration = await readFile(
    resolve("examples/chatbot/src/deploy.ts"),
    "utf8",
  );
  assert.match(orchestration, /logicApp\(deployment\)/);
  assert.doesNotMatch(orchestration, /logicAppTeams|LogicAppOptions/);
  const [dev, preview, prod] = await Promise.all(
    ["dev", "preview", "prod"].map(loadLogicAppTeamsConfig),
  );
  for (const config of [dev, preview, prod]) {
    assert.match(config.teamsGroupId, /^[0-9a-f-]{36}$/i);
    assert.match(config.tenantId, /^[0-9a-f-]{36}$/i);
    assert.ok(config.teamsChannelIds.length > 0);
    assert.equal(
      new Set(config.teamsChannelIds).size,
      config.teamsChannelIds.length,
    );
  }
  assert.notDeepEqual(dev.teamsChannelIds, preview.teamsChannelIds);
  assert.notDeepEqual(preview.teamsChannelIds, prod.teamsChannelIds);
  await assert.rejects(
    loadLogicAppTeamsConfig("missing"),
    /environment 'missing' was not found/,
  );

  const environment = JSON.parse(
    await readFile(
      resolve("examples/chatbot/src/environments/dev.json"),
      "utf8",
    ),
  ) as Record<string, string>;
  assert.equal("TEAMS_GROUP_ID" in environment, false);
  assert.equal("TEAMS_CHANNEL_IDS" in environment, false);
});

test("Logic App Teams profiles are owned by the chatbot example", async () => {
  await assert.rejects(
    access(resolve("examples/chatbot/scripts/sync-logic-app-config.mjs")),
    { code: "ENOENT" },
  );
  for (const environment of ["dev", "preview", "prod"]) {
    await access(
      resolve(
        "examples/chatbot/src/components/logic-app/config",
        `${environment}.json`,
      ),
    );
  }
});
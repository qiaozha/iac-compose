import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { outputBicep as bootstrap } from "../examples/chatbot/src/components/shared/identity-bootstrap.js";
import { outputBicep as configuration } from "../examples/chatbot/src/components/shared/identity-configuration.js";

test("identity bootstrap emits Graph application and service principal resources", async () => {
  const template = requiredFile(bootstrap, "main.bicep");
  assert.match(
    template,
    /extension 'br:mcr\.microsoft\.com\/bicep\/extensions\/microsoftgraph\/v1\.0:1\.0\.0'/,
  );
  assert.match(template, /Microsoft\.Graph\/applications@v1\.0/);
  assert.match(template, /Microsoft\.Graph\/servicePrincipals@v1\.0/);
  assert.match(template, /serviceManagementReference/);
  assert.match(template, /output SERVER_AUDIENCE/);
  assert.match(template, /SERVER_APPLICATION_UNIQUE_NAME/);
  assert.match(template, /output RAG_SERVICE_SCOPE/);

  const parameters = requiredFile(bootstrap, "main.bicepparam");
  assert.match(parameters, /SERVICE_MANAGEMENT_REFERENCE/);

  const environment = JSON.parse(
    await readFile(
      resolve("examples/chatbot/src/environments/dev.json"),
      "utf8",
    ),
  ) as Record<string, string>;
  assert.equal(
    environment.SERVICE_MANAGEMENT_REFERENCE,
    "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4",
  );
});

test("identity configuration declares permissions and app role assignments", async () => {
  const template = requiredFile(configuration, "main.bicep");
  assert.match(template, /oauth2PermissionScopes/);
  assert.match(template, /preAuthorizedApplications/);
  assert.match(template, /access_as_application/);
  assert.match(template, /Microsoft\.Graph\/appRoleAssignedTo@v1\.0/);
  assert.match(template, /existingPermissionScopes/);
  assert.match(template, /existingApplicationRoles/);
  assert.match(template, /serviceManagementReference/);
  assert.match(template, /preAuthorizeClients == 'true'/);
  assert.match(template, /04b07795-8ddb-461a-bbee-02f9e1bf7b46/);
  assert.doesNotMatch(template, /botClientId/);

  const parameters = requiredFile(configuration, "main.bicepparam");
  assert.match(parameters, /SERVICE_MANAGEMENT_REFERENCE/);
  assert.match(parameters, /SERVER_PREAUTHORIZE_CLIENTS/);
  assert.doesNotMatch(parameters, /readEnvironmentVariable\('BOT_ID',/);

  const lifecycle = await readFile(
    resolve("examples/chatbot/src/components/shared/identity.ts"),
    "utf8",
  );
  assert.doesNotMatch(lifecycle, /["']rest["']|graph\.microsoft\.com/);
  assert.match(lifecycle, /deployment\.provision\("server application registration"/);
  assert.match(lifecycle, /server application permissions/);
  assert.match(lifecycle, /server application pre-authorization/);
});

function requiredFile(
  files: ReadonlyArray<{ path: string; contents: string }>,
  path: string,
): string {
  const file = files.find((candidate) => candidate.path === path);
  assert.ok(file, `missing ${path}`);
  return file.contents;
}
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Deployment, type Command } from "iac-composer";
import { provisionTeamsApplication } from "../src/runtime/services/teams.js";

test("Teams provisioning uses the component-authored lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-teams-"));
  const source = join(root, "source");
  await mkdir(join(source, "env"), { recursive: true });
  const sourceLifecycle = `version: v1.7
provision:
  - uses: teamsApp/create
  - uses: teamsApp/validateAppPackage
`;
  await writeFile(join(source, "teamsapp.yml"), sourceLifecycle);

  class TeamsDeployment extends Deployment {
    override async execute(command: Command): Promise<void> {
      assert.equal(command.cwd, source);
      assert.equal(await readFile(join(source, "teamsapp.yml"), "utf8"), sourceLifecycle);
      const environmentFile = join(source, "env", ".env.iac-composer-dev");
      assert.match(
        await readFile(environmentFile, "utf8"),
        /TEAMS_APP_ID=existing-app-id/,
      );
      assert.equal(command.env?.TEAMS_APP_ID, "existing-app-id");
      await writeFile(
        environmentFile,
        `${await readFile(environmentFile, "utf8")}TEAMS_APP_ID=existing-app-id\n`,
      );
    }
  }

  const outputs = await provisionTeamsApplication(
    new TeamsDeployment({ environment: "dev" }),
    {
      component: "frontend",
      componentDirectory: source,
      existingAppId: "existing-app-id",
      manifestValues: { TEAMS_APP_NAME: "Test app" },
      outputNames: ["teamsAppId"],
    },
  );

  assert.deepEqual(outputs, {
    TEAMS_APP_ID: "existing-app-id",
    teamsAppId: "existing-app-id",
  });
  assert.equal(
    await readFile(join(source, "teamsapp.yml"), "utf8"),
    sourceLifecycle,
  );
});

test("Teams provisioning leaves the generated app package for publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-teams-package-"));
  const source = join(root, "source");
  await mkdir(join(source, "env"), { recursive: true });
  await mkdir(join(source, "appPackage", "build"), { recursive: true });
  await writeFile(join(source, "teamsapp.yml"), "version: v1.7\n");
  await writeFile(
    join(
      source,
      "appPackage",
      "build",
      "appPackage.iac-composer-dev.zip",
    ),
    "package",
  );
  const manifestId = "9668bcb5-a50b-4e39-a136-b3301305de66";
  const commands: Command[] = [];

  class TeamsPackageDeployment extends Deployment {
    override async execute(command: Command): Promise<void> {
      commands.push(command);
      if (command.command === "npx" && command.args?.includes("provision")) {
        const environmentFile = join(
          source,
          "env",
          ".env.iac-composer-dev",
        );
        await writeFile(
          environmentFile,
          `${await readFile(environmentFile, "utf8")}TEAMS_APP_ID=${manifestId}\n`,
        );
      }
    }
  }

  const outputs = await provisionTeamsApplication(
    new TeamsPackageDeployment({ environment: "dev" }),
    {
      component: "frontend",
      componentDirectory: source,
      existingAppId: manifestId,
      manifestValues: { TEAMS_APP_NAME: "Test app" },
      outputNames: ["teamsAppId"],
    },
  );

  assert.deepEqual(outputs, {
    TEAMS_APP_ID: manifestId,
    teamsAppId: manifestId,
  });
  assert.equal(
    await readFile(
      join(
        source,
        "appPackage",
        "build",
        "appPackage.iac-composer-dev.zip",
      ),
      "utf8",
    ),
    "package",
  );
  const environment = await readFile(
    join(source, "env", ".env.iac-composer-dev"),
    "utf8",
  );
  const version = /^TEAMS_APP_VERSION=(\d+)\.(\d+)\.(\d+)$/m.exec(environment);
  assert.ok(version);
  assert.ok(version.slice(1).every((part) => Number(part) <= 65_535));
  assert.equal(
    commands.filter(
      (command) =>
        command.command === "npx" && command.args?.includes("install"),
    ).length,
    0,
  );
  assert.equal(
    commands.filter(
      (command) =>
        command.command === "az" && command.args?.includes("upload"),
    ).length,
    0,
  );
});
for (const currentExists of [false, true]) {
  test(`Teams app ID migration prefers ${currentExists ? "current" : "previous"} state`, async () => {
    const root = await mkdtemp(join(tmpdir(), "iac-composer-teams-state-"));
    const previousAppId = process.env.TEAMS_APP_ID;
    delete process.env.TEAMS_APP_ID;
    try {
      await mkdir(join(root, "env"));
      await writeFile(join(root, "teamsapp.yml"), "version: 1.9\n");
      await writeFile(join(root, "env/.env.iac-compose-dev"), "TEAMS_APP_ID=previous-id\n");
      if (currentExists) {
        await writeFile(join(root, "env/.env.iac-composer-dev"), "TEAMS_APP_ID=current-id\n");
      }
      const expectedId = currentExists ? "current-id" : "previous-id";
      class TeamsDeployment extends Deployment {
        override async execute(command: Command): Promise<void> {
          assert.ok(command.args?.includes("iac-composer-dev"));
          assert.equal(command.env?.TEAMS_APP_ID, expectedId);
        }
      }
      const outputs = await provisionTeamsApplication(
        new TeamsDeployment({ environment: "dev", log: () => {} }),
        { component: "frontend", componentDirectory: root, manifestValues: {} },
      );
      assert.equal(outputs.TEAMS_APP_ID, expectedId);
      assert.match(
        await readFile(join(root, "env/.env.iac-composer-dev"), "utf8"),
        new RegExp(`TEAMS_APP_ID=${expectedId}`),
      );
    } finally {
      if (previousAppId === undefined) delete process.env.TEAMS_APP_ID;
      else process.env.TEAMS_APP_ID = previousAppId;
      await rm(root, { recursive: true, force: true });
    }
  });
}

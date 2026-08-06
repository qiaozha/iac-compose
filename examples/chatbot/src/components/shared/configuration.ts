import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  authorizationError,
  captureAzure,
  ensureRoleAssignment,
  retry,
  runAzure,
  type Deployment,
} from "imperative-deploy";
import { requiredEnv } from "../../runtime/environment.js";
import { botConfigRoot } from "../../runtime/paths.js";

const keyVaultSecretsOfficer = "b86a8fe4-44ce-4948-aee5-eccb2c155cd7";
const appConfigurationDataOwner = "5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b";

export async function seedRuntimeConfiguration(
  deployment: Deployment,
): Promise<void> {
  await seedKeyVault(deployment);
  await seedAppConfiguration(deployment);
}

async function seedKeyVault(deployment: Deployment): Promise<void> {
  const vault = requiredEnv("KEY_VAULT_NAME");
  const resourceGroup = requiredEnv("AZURE_RESOURCE_GROUP");
  const subscription = requiredEnv("AZURE_SUBSCRIPTION_ID");
  const principalId = requiredEnv("DEVELOPER_PRINCIPAL_ID");
  await ensureRoleAssignment(deployment, {
    principalId,
    principalType: process.env.DEVELOPER_PRINCIPAL_TYPE ?? "User",
    role: keyVaultSecretsOfficer,
    scope: `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.KeyVault/vaults/${vault}`,
  });

  const values = {
    "AI-SEARCH-APIKEY": await captureAzure(deployment, [
      "search",
      "admin-key",
      "show",
      "--service-name",
      requiredEnv("SEARCH_SERVICE_NAME"),
      "--resource-group",
      resourceGroup,
      "--query",
      "primaryKey",
      "--output",
      "tsv",
    ]),
  };
  for (const [name, value] of Object.entries(values)) {
    const path = resolve(tmpdir(), `deploy-js-${randomUUID()}`);
    await writeFile(path, value.trim(), { mode: 0o600 });
    try {
      await retry(
        () =>
          runAzure(deployment, [
            "keyvault",
            "secret",
            "set",
            "--vault-name",
            vault,
            "--name",
            name,
            "--file",
            path,
            "--output",
            "none",
          ]),
        { shouldRetry: authorizationError },
      );
    } finally {
      await rm(path, { force: true });
    }
  }
}

async function seedAppConfiguration(deployment: Deployment): Promise<void> {
  const store = requiredEnv("APP_CONFIG_NAME");
  const resourceGroup = requiredEnv("AZURE_RESOURCE_GROUP");
  const subscription = requiredEnv("AZURE_SUBSCRIPTION_ID");
  await ensureRoleAssignment(deployment, {
    principalId: requiredEnv("DEVELOPER_PRINCIPAL_ID"),
    principalType: process.env.DEVELOPER_PRINCIPAL_TYPE ?? "User",
    role: appConfigurationDataOwner,
    scope: `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.AppConfiguration/configurationStores/${store}`,
  });

  await setAppConfigurationValues(deployment, appConfigurationValues());
}

export async function setAppConfigurationValues(
  deployment: Deployment,
  values: Record<string, string>,
): Promise<void> {
  const store = requiredEnv("APP_CONFIG_NAME");
  for (const [key, value] of Object.entries(values)) {
    await retry(
      () =>
        runAzure(deployment, [
          "appconfig",
          "kv",
          "set",
          "--name",
          store,
          "--auth-mode",
          "login",
          "--key",
          key,
          "--value",
          value,
          "--yes",
          "--output",
          "none",
        ]),
      { shouldRetry: authorizationError },
    );
  }
}

function appConfigurationValues(): Record<string, string> {
  const value = (name: string, fallback: string): string =>
    process.env[name]?.trim() || fallback;
  const search = requiredEnv("SEARCH_SERVICE_NAME");
  const storage = requiredEnv("STORAGE_ACCOUNT_NAME");
  const vault = requiredEnv("KEY_VAULT_NAME");
  const ai = requiredEnv("AI_RESOURCE_NAME");
  const cosmos = requiredEnv("COSMOSDB_ACCOUNT_NAME");
  const registry =
    process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT?.trim() ||
    requiredEnv("CONTAINER_REGISTRY_LOGIN_SERVER");
  return {
    ADO_RESOURCE_SCOPE: "499b84ac-1321-427f-aa17-267ca6975798/.default",
    AI_FOUNDRY_AGENT_COMPLETION_MODEL: "gpt-5.4",
    AI_FOUNDRY_AGENT_REASONING_EFFORT: "medium",
    AOAI_CHAT_COMPLETIONS_MODEL: "gpt-5.1",
    AOAI_CHAT_COMPLETIONS_MODEL_REASONING_EFFORT: "medium",
    AOAI_CHAT_COMPLETIONS_TEMPERATURE: "0.1",
    AOAI_CHAT_COMPLETIONS_TOP_P: "0.8",
    AOAI_CHAT_CONTEXT_MAX_TOKENS: "100000",
    AOAI_CHAT_MAX_TOKENS: "10000",
    AOAI_CHAT_REASONING_MODEL: "gpt-5.1",
    AOAI_CHAT_REASONING_MODEL_REASONING_EFFORT: "high",
    AOAI_CHAT_REASONING_MODEL_TEMPERATURE: "0.1",
    AI_SEARCH_AGENT: value(
      "AI_SEARCH_AGENT",
      value("AI_SEARCH_KNOWLEDGE_BASE", "azure-sdk-knowledgebase"),
    ),
    AI_SEARCH_INDEX: value("AI_SEARCH_INDEX", "azure-sdk-knowledge"),
    AI_SEARCH_INDEXER: value("AI_SEARCH_INDEXER", "azure-sdk-knowledge-indexer"),
    AI_SEARCH_KNOWLEDGE_BASE: value("AI_SEARCH_KNOWLEDGE_BASE", "azure-sdk-knowledgebase"),
    AI_SEARCH_KNOWLEDGE_SOURCE: value("AI_SEARCH_KNOWLEDGE_SOURCE", "azure-sdk-knowledge-source"),
    AI_SEARCH_KNOWLEDGE_BASE_API: value(
      "AI_SEARCH_KNOWLEDGE_BASE_API",
      "{AI_SEARCH_BASE_URL}/knowledgebases/{AI_SEARCH_AGENT}/retrieve?api-version=2026-04-01",
    ),
    AI_SEARCH_TOPK: "10",
    ENABLE_TENANT_MEMORY_SEARCH: "true",
    MEMORY_STORE_EMBEDDING_MODEL: "text-embedding-ada-002",
    MEMORY_USER_STORE_NAME: "azure-sdk-qa-bot-user-memory-store",
    GITHUB_APP_ID: value("GITHUB_APP_ID", "1086291"),
    GITHUB_APP_INSTALLATION_OWNER: value("GITHUB_APP_INSTALLATION_OWNER", "Azure"),
    GITHUB_APP_KEY_NAME: value("GITHUB_APP_KEY_NAME", "azure-sdk-automation"),
    GITHUB_APP_KEYVAULT_URL: value(
      "GITHUB_APP_KEYVAULT_URL",
      "https://azuresdkengkeyvault.vault.azure.net",
    ),
    STORAGE_FEEDBACK_CONTAINER: "feedback",
    STORAGE_KNOWLEDGE_CONTAINER: "knowledge",
    STORAGE_RECORDS_CONTAINER: "records",
    ACR_LOGIN_SERVER: registry,
    AI_FOUNDRY_PROJECT_ENDPOINT: requiredEnv("FOUNDRY_PROJECT_ENDPOINT").replace(/\/+$/, ""),
    AI_SEARCH_SERVICE_NAME: search,
    AI_SEARCH_BASE_URL: `https://${search}.search.windows.net`,
    AOAI_CHAT_COMPLETIONS_ENDPOINT: `https://${ai}.openai.azure.com`,
    AZURE_COSMOSDB_ENDPOINT: `https://${cosmos}.documents.azure.com`,
    KEYVAULT_ENDPOINT: `https://${vault}.vault.azure.net`,
    STORAGE_ACCOUNT_NAME: storage,
    STORAGE_BASE_URL: `https://${storage}.blob.core.windows.net`,
  };
}

export async function uploadBotConfiguration(
  deployment: Deployment,
): Promise<void> {
  const environment = requiredEnv("AZURE_ENV_NAME");
  const source = resolve(botConfigRoot, environment);
  const files = await collectFiles(source).catch((error) => {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  });
  for (const file of files) {
    const blobName = relative(source, file).split("\\").join("/");
    let uploadPath = file;
    if ([".json", ".yaml", ".yml"].includes(extname(file).toLowerCase())) {
      const expanded = expandEnvironment(await readFile(file, "utf8"));
      uploadPath = resolve(tmpdir(), `deploy-js-config-${randomUUID()}`);
      await writeFile(uploadPath, expanded);
    }
    try {
      await runAzure(deployment, [
        "storage",
        "blob",
        "upload",
        "--account-name",
        requiredEnv("STORAGE_ACCOUNT_NAME"),
        "--container-name",
        "bot-configs",
        "--name",
        blobName,
        "--file",
        uploadPath,
        "--auth-mode",
        "login",
        "--overwrite",
        "--only-show-errors",
      ]);
    } finally {
      if (uploadPath !== file) await rm(uploadPath, { force: true });
    }
  }
}

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.isFile() && (await stat(path)).isFile()) files.push(path);
  }
  return files;
}

function expandEnvironment(source: string): string {
  return source.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    return requiredEnv(name);
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
import * as readline from "node:readline/promises";
import type { AtlasClient } from "@atlas/client";
import {
  DEFAULT_SETUP_WORKSPACE_NAME,
  getUserConfigPath,
  type ProviderModelOption,
  promptForProviderConfig,
  slugifySetupWorkspaceName,
  type UserProviderName,
  validateSetupEmail,
  validateSetupName,
  validateSetupPassword,
  validateSetupWorkspaceName,
} from "@atlas/core";
import type { SetupAuthRequest } from "@atlas/core/contract";

function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      reject(new Error("Terminal does not support raw mode"));
      return;
    }

    stdout.write(prompt);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let password = "";

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          // Enter or EOF
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          resolve(password);
          return;
        }

        if (char === "\u0003") {
          // Ctrl+C
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          process.exit(130);
        }

        if (char === "\u007f" || char === "\b") {
          // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (char >= " " && char <= "~") {
          // Printable ASCII
          password += char;
          stdout.write("*");
        }
      }
    };

    stdin.on("data", onData);
  });
}

export function buildCliSetupRequest(input: {
  confirmPassword: string;
  email: string;
  name: string;
  password: string;
  workspaceName: string;
}): { error: string } | { request: SetupAuthRequest } {
  const nameError = validateSetupName(input.name);
  if (nameError) {
    return { error: nameError };
  }

  const emailError = validateSetupEmail(input.email);
  if (emailError) {
    return { error: emailError };
  }

  const passwordError = validateSetupPassword(
    input.password,
    input.confirmPassword
  );
  if (passwordError) {
    return { error: passwordError };
  }

  const workspaceName =
    input.workspaceName.trim() || DEFAULT_SETUP_WORKSPACE_NAME;
  const workspaceNameError = validateSetupWorkspaceName(workspaceName);
  if (workspaceNameError) {
    return { error: workspaceNameError };
  }

  return {
    request: {
      admin: {
        email: input.email.trim(),
        name: input.name.trim(),
        password: input.password,
      },
      organization: {
        name: workspaceName,
        slug: slugifySetupWorkspaceName(workspaceName),
      },
    },
  };
}

export async function ensureUserConfiguredViaCli(
  client: AtlasClient
): Promise<boolean> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    return false;
  }

  console.log("Atlas admin setup\n");
  console.log("No admin user found. Let's create one.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let name: string;
  let email: string;
  try {
    name = await rl.question("Name: ");
    email = await rl.question("Email: ");
  } finally {
    rl.close();
  }

  const password = await readPassword("Password: ");
  const confirmPassword = await readPassword("Confirm password: ");

  const workspaceRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let workspaceName: string;
  try {
    workspaceName = await workspaceRl.question(
      `Workspace name [${DEFAULT_SETUP_WORKSPACE_NAME}]: `
    );
  } finally {
    workspaceRl.close();
  }

  const built = buildCliSetupRequest({
    confirmPassword,
    email,
    name,
    password,
    workspaceName,
  });

  if ("error" in built) {
    console.log(built.error);
    return false;
  }

  try {
    await client.setupUser(built.request);
    console.log("Admin user created successfully.");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Failed to create admin user: ${message}`);
    return false;
  }
}

export async function ensureProviderConfiguredViaCli(
  client: AtlasClient
): Promise<boolean> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    return false;
  }

  const catalog = await client.getModels();
  const modelHelpers = createModelHelpers(catalog.models);

  console.log("Atlas setup\n");
  console.log("No API key found. Let's configure one.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const config = await promptForProviderConfig({
      question: (prompt) => rl.question(prompt),
      writeLine: (line) => console.log(line),
      ...modelHelpers,
    });

    const instance = config.providers[0]!;
    const model =
      instance.customModels?.find((entry) => entry.default)?.id ??
      instance.customModels?.[0]?.id ??
      modelHelpers.getDefaultModel(instance.type);

    const result = await client.configureProvider({
      apiKey: instance.apiKey,
      baseUrl: instance.baseUrl,
      customModels: instance.customModels,
      displayName:
        instance.type === "openai_compatible" ? instance.label : undefined,
      hostMode: instance.hostMode,
      model,
      provider: instance.type,
      wireApi:
        instance.type === "openai_compatible" ? instance.wireApi : undefined,
    });

    console.log(
      `\nProvider configured (${result.provider}, ${result.currentModel}).`
    );
    console.log(`Saved to ${getUserConfigPath()}\n`);

    return true;
  } finally {
    rl.close();
  }
}

function createModelHelpers(models: ProviderModelOption[]) {
  return {
    getDefaultModel: (provider: UserProviderName) => {
      const providerModels = models.filter(
        (model) => model.provider === provider
      );
      return (
        providerModels.find((model) => model.default)?.id ??
        providerModels[0]?.id ??
        "gpt-5.4"
      );
    },
    getModelById: (modelId: string) =>
      models.find((model) => model.id === modelId),
    getModelsForProvider: (provider: UserProviderName) =>
      models.filter((model) => model.provider === provider),
  };
}

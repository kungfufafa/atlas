import * as readline from "node:readline/promises";
import type { AtlasClient } from "@atlas/client";
import {
  DEFAULT_SETUP_WORKSPACE_NAME,
  getUserConfigPath,
  isSubscriptionProvider,
  type ProviderInstance,
  type ProviderModelOption,
  promptForProviderConfig,
  type SubscriptionAuthState,
  type SubscriptionLoginStartResponse,
  type SubscriptionLoginStatusResponse,
  type SubscriptionProviderKind,
  slugifySetupWorkspaceName,
  type UserProviderName,
  validateSetupEmail,
  validateSetupName,
  validateSetupPassword,
  validateSetupWorkspaceName,
} from "@atlas/core";
import type {
  ConfigureProviderRequest,
  SetupAuthRequest,
} from "@atlas/core/contract";
import { formatCliDisplayPath, isCliVerbose } from "./display-path";
import { printLine } from "./terminal-safe";

function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      reject(new Error("Terminal does not support raw mode"));
      return;
    }

    stdout.write(prompt);

    const wasPaused = stdin.isPaused();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let password = "";

    const restoreStdin = () => {
      stdin.setRawMode(false);
      if (wasPaused) {
        stdin.pause();
      }
      stdin.removeListener("data", onData);
      stdout.write("\n");
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          // Enter or EOF
          restoreStdin();
          resolve(password);
          return;
        }

        if (char === "\u0003") {
          // Ctrl+C
          restoreStdin();
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
    printLine(`Failed to create admin user: ${message}`);
    return false;
  }
}

export async function ensureProviderConfiguredViaCli(
  client: AtlasClient,
  signal?: AbortSignal
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
      writeLine: printLine,
      ...modelHelpers,
    });

    const instance = config.providers[0]!;
    if (isSubscriptionProvider(instance.type)) {
      await ensureCliSubscriptionAuthenticated(client, instance.type, {
        signal,
        writeLine: printLine,
      });
    }
    const result = await client.configureProvider(
      buildCliConfigureProviderRequest(instance, modelHelpers.getDefaultModel)
    );

    printLine(
      `\nProvider configured (${result.provider}, ${result.currentModel}).`
    );
    console.log(
      `Saved to ${formatCliDisplayPath(getUserConfigPath(), isCliVerbose())}\n`
    );

    return true;
  } finally {
    rl.close();
  }
}

const CLI_SUBSCRIPTION_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const CLI_SUBSCRIPTION_LOGIN_POLL_MS = 2000;

interface CliSubscriptionClient {
  cancelSubscriptionLogin(
    kind: SubscriptionProviderKind,
    loginId: string
  ): Promise<{ ok: true }>;
  getSubscriptionAuth(
    kind: SubscriptionProviderKind
  ): Promise<SubscriptionAuthState>;
  getSubscriptionLoginStatus(
    kind: SubscriptionProviderKind,
    loginId: string
  ): Promise<SubscriptionLoginStatusResponse>;
  startSubscriptionLogin(
    kind: SubscriptionProviderKind,
    request?: { method?: "browser" | "device" }
  ): Promise<SubscriptionLoginStartResponse>;
}

interface CliSubscriptionLoginOptions {
  now?: () => number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  sleep?: (delayMs: number) => Promise<void>;
  timeoutMs?: number;
  writeLine?: (line: string) => void;
}

export async function ensureCliSubscriptionAuthenticated(
  client: CliSubscriptionClient,
  kind: SubscriptionProviderKind,
  options: CliSubscriptionLoginOptions = {}
): Promise<void> {
  const writeLine = options.writeLine ?? printLine;
  throwIfCliLoginAborted(options.signal);
  const auth = await client.getSubscriptionAuth(kind);
  throwIfCliLoginAborted(options.signal);
  if (auth.authenticated) {
    return;
  }

  const started = await client.startSubscriptionLogin(
    kind,
    kind === "chatgpt" ? { method: "device" } : {}
  );

  try {
    throwIfCliLoginAborted(options.signal);
    writeSubscriptionLoginInstructions(started, writeLine);

    const now = options.now ?? Date.now;
    const deadline =
      now() + (options.timeoutMs ?? CLI_SUBSCRIPTION_LOGIN_TIMEOUT_MS);
    const sleep =
      options.sleep ??
      ((delayMs: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    const pollIntervalMs =
      options.pollIntervalMs ?? CLI_SUBSCRIPTION_LOGIN_POLL_MS;

    let status = await client.getSubscriptionLoginStatus(kind, started.loginId);
    throwIfCliLoginAborted(options.signal);
    while (status.status === "pending" && now() < deadline) {
      await waitForCliLoginPoll(pollIntervalMs, sleep, options.signal);
      status = await client.getSubscriptionLoginStatus(kind, started.loginId);
      throwIfCliLoginAborted(options.signal);
    }

    if (status.status === "completed" && status.account?.authenticated) {
      writeLine(`${kind === "chatgpt" ? "ChatGPT" : "Claude"} connected.`);
      return;
    }

    if (status.status === "pending") {
      throw new Error(
        "Subscription login timed out. Start setup again to retry."
      );
    }

    throw new Error(
      status.error ??
        `Subscription login was ${status.status}. Start setup again to retry.`
    );
  } catch (error) {
    try {
      await client.cancelSubscriptionLogin(kind, started.loginId);
    } catch {
      // The server may be unreachable or the login may already be terminal.
    }
    throw error;
  }
}

function throwIfCliLoginAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error("Subscription login cancelled.");
  error.name = "AbortError";
  throw error;
}

async function waitForCliLoginPoll(
  delayMs: number,
  sleep: (delayMs: number) => Promise<void>,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) {
    await sleep(delayMs);
    return;
  }
  throwIfCliLoginAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const error = new Error("Subscription login cancelled.");
      error.name = "AbortError";
      reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(delayMs).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function writeSubscriptionLoginInstructions(
  started: SubscriptionLoginStartResponse,
  writeLine: (line: string) => void
): void {
  writeLine("");
  writeLine(started.instructions);
  if (started.loginCommand) {
    writeLine(`Run on the Atlas host: ${started.loginCommand}`);
  }
  if (started.verificationUrl) {
    writeLine(`Verification URL: ${started.verificationUrl}`);
  }
  if (started.userCode) {
    writeLine(`Device code: ${started.userCode}`);
  }
  if (started.authUrl) {
    writeLine(`Login URL: ${started.authUrl}`);
  }
  writeLine("Waiting for sign-in...");
}

export function buildCliConfigureProviderRequest(
  instance: ProviderInstance,
  getDefaultModel: (provider: UserProviderName) => string
): ConfigureProviderRequest {
  if (isSubscriptionProvider(instance.type)) {
    return { provider: instance.type };
  }

  const model =
    instance.customModels?.find((entry) => entry.default)?.id ??
    instance.customModels?.[0]?.id ??
    getDefaultModel(instance.type);

  return {
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
  };
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

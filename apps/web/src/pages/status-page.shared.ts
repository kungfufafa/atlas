import type {
  LlmUsageReportGroupBy,
  SystemStatusResponse,
  WorkerProcessInfo,
} from "@atlas/core/contract";
import {
  Clock01Icon,
  HashtagIcon,
  Message01Icon,
  SmartPhone01Icon,
} from "hugeicons-react";
import { PAGE_PATHS } from "@/lib/navigation";

export type StatusTone = "ok" | "warn" | "bad";

type ServiceStatusTone = "ok" | "warn" | "bad" | "muted";

const RESOURCE_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

function formatResourceNumber(value: number | null, suffix: string): string {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return "—";
  }

  return `${RESOURCE_NUMBER_FORMAT.format(value)}${suffix}`;
}

function formatWorkerUptime(uptimeSeconds: number | null): string {
  if (
    uptimeSeconds === null ||
    !Number.isFinite(uptimeSeconds) ||
    uptimeSeconds < 0
  ) {
    return "—";
  }

  const totalSeconds = Math.floor(uptimeSeconds);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}

export function formatWorkerResources(
  process: WorkerProcessInfo | null | undefined
): string {
  if (
    !process ||
    (process.cpuPercent === null &&
      process.memoryMb === null &&
      process.uptimeSeconds === null)
  ) {
    return "—";
  }

  const cpu = formatResourceNumber(process.cpuPercent, "%");
  const memory = formatResourceNumber(process.memoryMb, " MB");
  const uptime = formatWorkerUptime(process.uptimeSeconds);

  return `CPU ${cpu} · Memory ${memory} · Uptime ${uptime}`;
}

export function buildServiceColumns(status: SystemStatusResponse) {
  const { automationWorker, telegramWorker, whatsappWorker, discordWorker } =
    status;

  return [
    {
      icon: Clock01Icon,
      title: "Automation",
      ...automationServiceStatus(automationWorker),
    },
    {
      icon: Message01Icon,
      title: "Telegram",
      ...telegramServiceStatus(telegramWorker),
    },
    {
      icon: SmartPhone01Icon,
      title: "WhatsApp",
      ...whatsappServiceStatus(whatsappWorker),
    },
    {
      icon: HashtagIcon,
      title: "Discord",
      ...discordServiceStatus(discordWorker),
    },
  ] satisfies Array<{
    icon: typeof Clock01Icon;
    title: string;
    status: string;
    tone: ServiceStatusTone;
  }>;
}

function automationServiceStatus(
  automationWorker: SystemStatusResponse["automationWorker"]
): { status: string; tone: ServiceStatusTone } {
  if (!automationWorker.process?.managed) {
    return { status: "PM2 unavailable", tone: "warn" };
  }

  if (!automationWorker.running) {
    return { status: "Offline", tone: "bad" };
  }

  if (automationWorker.activeRuns > 0) {
    return { status: "Running jobs", tone: "ok" };
  }

  return { status: "Healthy", tone: "ok" };
}

function telegramServiceStatus(
  telegramWorker: SystemStatusResponse["telegramWorker"]
): { status: string; tone: ServiceStatusTone } {
  if (!telegramWorker.configured) {
    return { status: "Not set up", tone: "muted" };
  }

  if (!telegramWorker.running) {
    return { status: "Offline", tone: "bad" };
  }

  if (!telegramWorker.paired) {
    return { status: "Awaiting pairing", tone: "warn" };
  }

  return { status: "Healthy", tone: "ok" };
}

function whatsappServiceStatus(
  whatsappWorker: SystemStatusResponse["whatsappWorker"]
): { status: string; tone: ServiceStatusTone } {
  if (!whatsappWorker.configured) {
    return { status: "Not set up", tone: "muted" };
  }

  if (!whatsappWorker.running) {
    return { status: "Offline", tone: "bad" };
  }

  if (!whatsappWorker.paired) {
    return { status: "Awaiting pairing", tone: "warn" };
  }

  if (!whatsappWorker.connected) {
    return { status: "Disconnected", tone: "bad" };
  }

  return { status: "Healthy", tone: "ok" };
}

function discordServiceStatus(
  discordWorker: SystemStatusResponse["discordWorker"]
): { status: string; tone: ServiceStatusTone } {
  if (!discordWorker.configured) {
    return { status: "Not set up", tone: "muted" };
  }

  if (!discordWorker.running) {
    return { status: "Offline", tone: "bad" };
  }

  if (!discordWorker.paired) {
    return { status: "Awaiting pairing", tone: "warn" };
  }

  if (!discordWorker.connected) {
    return { status: "Disconnected", tone: "bad" };
  }

  return { status: "Healthy", tone: "ok" };
}

export type StatusSummaryAction = {
  label: string;
  to: string;
};

export function deriveSummary(status: SystemStatusResponse): {
  tone: StatusTone;
  title: string;
  description: string;
  action?: StatusSummaryAction;
} {
  if (!status.server.ok) {
    return {
      description: "Restart Atlas and check your connection.",
      title: "Server offline",
      tone: "bad",
    };
  }

  if (!status.automationWorker.ok) {
    return {
      description: "Start the automation worker to resume scheduled runs.",
      title: "Automation worker stopped",
      tone: "bad",
    };
  }

  if (status.telegramWorker.configured && !status.telegramWorker.running) {
    return {
      action: { label: "Open Integrations", to: PAGE_PATHS.integrations },
      description:
        "Start the Telegram worker (bun run dev:telegram) to receive messages.",
      title: "Telegram bridge offline",
      tone: "warn",
    };
  }

  if (status.whatsappWorker.configured && !status.whatsappWorker.running) {
    return {
      action: { label: "Open Integrations", to: PAGE_PATHS.integrations },
      description: "Start the WhatsApp worker to receive messages.",
      title: "WhatsApp offline",
      tone: "warn",
    };
  }

  if (status.discordWorker.configured && !status.discordWorker.running) {
    return {
      action: { label: "Open Integrations", to: PAGE_PATHS.integrations },
      description:
        "Start the bridge worker from Integrations → Discord to receive messages.",
      title: "Discord bridge offline",
      tone: "warn",
    };
  }

  if (status.telegramWorker.configured && !status.telegramWorker.paired) {
    return {
      action: { label: "Open Integrations", to: PAGE_PATHS.integrations },
      description:
        "Finish Telegram pairing before this bridge can receive messages.",
      title: "Telegram awaiting pairing",
      tone: "warn",
    };
  }

  if (status.whatsappWorker.configured && !status.whatsappWorker.paired) {
    return {
      action: { label: "Open Integrations", to: PAGE_PATHS.integrations },
      description:
        "Finish WhatsApp pairing before this bridge can receive messages.",
      title: "WhatsApp awaiting pairing",
      tone: "warn",
    };
  }

  if (
    status.whatsappWorker.configured &&
    status.whatsappWorker.paired &&
    !status.whatsappWorker.connected
  ) {
    return {
      action: { label: "Open Integrations", to: PAGE_PATHS.integrations },
      description:
        "The WhatsApp worker is running but its socket is disconnected.",
      title: "WhatsApp bridge disconnected",
      tone: "warn",
    };
  }

  if (status.discordWorker.configured && !status.discordWorker.paired) {
    return {
      action: { label: "Open Integrations", to: PAGE_PATHS.integrations },
      description:
        "Finish Discord pairing before this bridge can receive messages.",
      title: "Discord awaiting pairing",
      tone: "warn",
    };
  }

  if (
    status.discordWorker.configured &&
    status.discordWorker.paired &&
    !status.discordWorker.connected
  ) {
    return {
      action: { label: "Open Integrations", to: PAGE_PATHS.integrations },
      description:
        "The Discord worker is running but its gateway is disconnected.",
      title: "Discord bridge disconnected",
      tone: "warn",
    };
  }

  if (
    !(
      status.server.providerConfigured &&
      status.automationWorker.providerConfigured
    )
  ) {
    return {
      action: { label: "Open Settings", to: PAGE_PATHS.settings },
      description:
        "Configure an LLM provider before chat or automation runs can succeed.",
      title: "Running with warnings",
      tone: "warn",
    };
  }

  return {
    description: "Server, workers, and bridges are healthy.",
    title: "All systems operational",
    tone: "ok",
  };
}

export function usageBreakdownGroups(
  canManageBudget: boolean
): LlmUsageReportGroupBy[] {
  return canManageBudget
    ? [
        "user",
        "profile",
        "channel",
        "provider",
        "model",
        "capability",
        "credential",
      ]
    : ["user", "profile", "channel", "provider", "model", "capability"];
}

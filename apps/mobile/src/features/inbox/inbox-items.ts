import type {
  OrgMemoryProposal,
  SkillProposal,
  StoredAutomation,
} from "@atlas/core/contract";

export type InboxKind =
  | "automation-run"
  | "org-memory-proposal"
  | "skill-proposal";

export interface InboxItem {
  automationId?: string;
  count: number;
  createdAt?: string;
  description: string;
  id: string;
  kind: InboxKind;
  kindLabel: string;
  profileId?: string;
  proposalId?: string;
  title: string;
}

export function buildInboxItems(input: {
  automations: StoredAutomation[];
  memoryProposals?: OrgMemoryProposal[];
  skillProposals?: SkillProposal[];
  unreadByAutomationId?: Record<string, number>;
}): InboxItem[] {
  const items: InboxItem[] = [];
  const unread = input.unreadByAutomationId ?? {};

  for (const automation of input.automations) {
    const count = unread[automation.id] ?? 0;
    if (count <= 0) {
      continue;
    }

    items.push({
      automationId: automation.id,
      count,
      createdAt: automation.lastRunAt ?? undefined,
      description:
        count === 1
          ? "1 unread automation run"
          : `${count} unread automation runs`,
      id: `automation-${automation.id}`,
      kind: "automation-run",
      kindLabel: "Automation",
      title: automation.name,
    });
  }

  for (const proposal of input.memoryProposals ?? []) {
    items.push({
      count: 1,
      createdAt: proposal.createdAt,
      description: proposal.bullet,
      id: `org-memory-${proposal.id}`,
      kind: "org-memory-proposal",
      kindLabel: "Org memory",
      proposalId: proposal.id,
      title: "Memory proposal",
    });
  }

  for (const proposal of input.skillProposals ?? []) {
    items.push({
      count: 1,
      createdAt: proposal.createdAt,
      description: proposal.skillName,
      id: `skill-proposal-${proposal.id}`,
      kind: "skill-proposal",
      kindLabel: "Skill proposal",
      profileId: proposal.profileId,
      proposalId: proposal.id,
      title: `${proposal.action} · ${proposal.skillName}`,
    });
  }

  return items;
}

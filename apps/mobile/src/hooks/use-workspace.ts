import type {
  ArtifactFile,
  KnowledgeBaseDocument,
  ListProfileChangeHistoryResponse,
  SessionSummary,
} from "@atlas/core/contract";
import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { mergeSessionsByRecency } from "@/features/chat/sessions";
import {
  getNextProfileHistoryOffset,
  mergeProfileHistoryPages,
  PROFILE_HISTORY_PAGE_SIZE,
} from "@/features/profiles/profile-history";
import {
  useAtlasQuery,
  useOrgKey,
  useReadyAtlasClient,
  useServerQueryKey,
} from "@/hooks/use-atlas-query";
import { useProfilesQuery } from "@/hooks/use-profiles";
import { queryKeys } from "@/lib/query-keys";

export function useAllSessionsQuery() {
  const client = useReadyAtlasClient();
  const profilesQuery = useProfilesQuery();
  const orgKey = useOrgKey();
  const profileIds = (profilesQuery.data ?? []).map((profile) => profile.id);
  const queryKey = useServerQueryKey(["sessions-all"]);

  return useQuery({
    enabled: Boolean(client) && profilesQuery.data !== undefined,
    queryFn: async (): Promise<SessionSummary[]> => {
      if (!client) {
        throw new Error("Not connected.");
      }
      const groups = await Promise.all(
        profileIds.map(
          async (profileId) =>
            (await client.listSessions(profileId, "web")).sessions
        )
      );
      return mergeSessionsByRecency(groups);
    },
    queryKey: [...queryKey, "org", orgKey, "profiles", profileIds],
  });
}

export function useAllArtifactsQuery() {
  const client = useReadyAtlasClient();
  const profilesQuery = useProfilesQuery();
  const orgKey = useOrgKey();
  const profileIds = (profilesQuery.data ?? []).map((profile) => profile.id);
  const queryKey = useServerQueryKey(queryKeys.artifactsAll);

  return useQuery({
    enabled: Boolean(client) && profilesQuery.data !== undefined,
    queryFn: async (): Promise<
      Array<ArtifactFile & { profileId: string; profileName: string }>
    > => {
      if (!client) {
        throw new Error("Not connected.");
      }
      const groups = await Promise.all(
        (profilesQuery.data ?? []).map(async (profile) => {
          const response = await client.listProfileArtifacts(profile.id, {
            limit: 100,
          });
          return response.artifacts.map((artifact) => ({
            ...artifact,
            profileId: profile.id,
            profileName: profile.name,
          }));
        })
      );
      return groups
        .flat()
        .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
    },
    queryKey: [...queryKey, "org", orgKey, "profiles", profileIds],
  });
}

export function useAutomationsQuery() {
  return useAtlasQuery(queryKeys.automations, (client) =>
    client.listAutomations()
  );
}

export function useTasksQuery() {
  return useAtlasQuery(queryKeys.tasks, (client) => client.listTasks());
}

export function useToolsQuery() {
  return useAtlasQuery(
    queryKeys.tools,
    async (client) => (await client.listTools()).tools
  );
}

export function useSkillsQuery() {
  return useAtlasQuery(
    queryKeys.skills,
    async (client) => (await client.listSkills()).skills
  );
}

export function useMcpQuery() {
  return useAtlasQuery(
    queryKeys.mcp,
    async (client) => (await client.listMcpServers()).servers
  );
}

export function useMcpServerQuery(serverId: string) {
  return useAtlasQuery(queryKeys.mcpServer(serverId), async (client) => {
    const response = await client.getMcpServer(serverId);
    return response.server;
  });
}

export function useToolQuery(toolId: string) {
  return useAtlasQuery(queryKeys.tool(toolId), async (client) => {
    const response = await client.getTool(toolId);
    return response.tool;
  });
}

export function useSkillQuery(skillId: string) {
  return useAtlasQuery(queryKeys.skill(skillId), async (client) => {
    const response = await client.getSkill(skillId);
    return response.skill;
  });
}

export function useAllKnowledgeQuery() {
  const client = useReadyAtlasClient();
  const profilesQuery = useProfilesQuery();
  const orgKey = useOrgKey();
  const profiles = profilesQuery.data ?? [];
  const queryKey = useServerQueryKey(queryKeys.knowledgeAll);
  const profileIds = profiles.map((profile) => profile.id);

  return useQuery({
    enabled: Boolean(client) && profilesQuery.data !== undefined,
    queryFn: async (): Promise<
      Array<KnowledgeBaseDocument & { profileId: string; profileName: string }>
    > => {
      if (!client) {
        throw new Error("Not connected.");
      }
      const groups = await Promise.all(
        profiles.map(async (profile) => {
          const response = await client.listKnowledgeBase(profile.id);
          return response.documents.map((document) => ({
            ...document,
            profileId: profile.id,
            profileName: profile.name,
          }));
        })
      );
      return groups
        .flat()
        .sort((left, right) => (left.uploadedAt < right.uploadedAt ? 1 : -1));
    },
    queryKey: [...queryKey, "org", orgKey, "profiles", profileIds],
  });
}

export function useKnowledgeQuery(profileId: string | null | undefined) {
  return useAtlasQuery(
    queryKeys.knowledge(profileId ?? "none"),
    (client) => client.listKnowledgeBase(profileId ?? ""),
    { enabled: Boolean(profileId) }
  );
}

export function useComposioToolkitsQuery() {
  return useAtlasQuery(queryKeys.composioToolkits, (client) =>
    client.listComposioToolkits()
  );
}

export function useSubscriptionAuthQuery(kind: "chatgpt" | "claude") {
  return useAtlasQuery(queryKeys.subscription(kind), (client) =>
    client.getSubscriptionAuth(kind)
  );
}

export function useProvidersQuery() {
  return useAtlasQuery(queryKeys.providers, (client) => client.listProviders());
}

export function useModelsQuery() {
  return useAtlasQuery(queryKeys.models, (client) => client.getModels());
}

export function useSystemStatusQuery() {
  return useAtlasQuery(queryKeys.system, (client) => client.getSystemStatus());
}

export function useOrgMemoryProposalsQuery(
  orgId: string | null | undefined,
  enabled = true
) {
  return useAtlasQuery(
    queryKeys.orgMemoryProposals(orgId ?? "none"),
    (client) => client.listOrgMemoryProposals(orgId ?? "", "pending"),
    { enabled: Boolean(orgId) && enabled, refetchInterval: 30_000 }
  );
}

export function useSkillProposalsQuery(
  orgId: string | null | undefined,
  enabled = true
) {
  return useAtlasQuery(
    queryKeys.skillProposals(orgId ?? "none"),
    (client) => client.listSkillProposals(orgId ?? "", { status: "pending" }),
    { enabled: Boolean(orgId) && enabled, refetchInterval: 30_000 }
  );
}

export function useMembersQuery(orgId: string | null | undefined) {
  return useAtlasQuery(
    queryKeys.members(orgId ?? "none"),
    (client) => client.listOrgMembers(orgId ?? ""),
    { enabled: Boolean(orgId) }
  );
}

export function useProfileQuery(profileId: string) {
  return useAtlasQuery(queryKeys.profile(profileId), async (client) => {
    const response = await client.getProfile(profileId);
    return response.profile;
  });
}

export function useProfileHistoryQuery(profileId: string, enabled = true) {
  const client = useReadyAtlasClient();
  const orgKey = useOrgKey();
  const queryKey = useServerQueryKey(queryKeys.profileHistory(profileId));
  const query = useInfiniteQuery<
    ListProfileChangeHistoryResponse,
    Error,
    InfiniteData<ListProfileChangeHistoryResponse, number>,
    readonly unknown[],
    number
  >({
    enabled: Boolean(client) && enabled,
    getNextPageParam: (_lastPage, pages) => getNextProfileHistoryOffset(pages),
    initialPageParam: 0,
    queryFn: async ({
      pageParam,
    }): Promise<ListProfileChangeHistoryResponse> => {
      if (!client) {
        throw new Error("Not connected.");
      }
      return client.listProfileChangeHistory(profileId, {
        limit: PROFILE_HISTORY_PAGE_SIZE,
        offset: pageParam,
      });
    },
    queryKey: [...queryKey, "org", orgKey],
  });

  return {
    ...query,
    data: query.data ? mergeProfileHistoryPages(query.data.pages) : undefined,
  };
}

export function useSoulQuery(profileId: string) {
  return useAtlasQuery(queryKeys.soul(profileId), (client) =>
    client.getProfileSoulStack(profileId)
  );
}

export function useAutomationQuery(automationId: string) {
  return useAtlasQuery(queryKeys.automation(automationId), (client) =>
    client.getAutomation(automationId)
  );
}

export function useAutomationRunsQuery(automationId: string) {
  return useAtlasQuery(queryKeys.automationRuns(automationId), (client) =>
    client.listAutomationRuns(automationId)
  );
}

export function useTaskQuery(taskId: string) {
  return useAtlasQuery(queryKeys.task(taskId), (client) =>
    client.getTask(taskId)
  );
}

export function useTaskRunsQuery(taskId: string) {
  return useAtlasQuery(queryKeys.taskRuns(taskId), (client) =>
    client.listTaskRuns(taskId)
  );
}

export function useIntegrationsQuery() {
  return useAtlasQuery(queryKeys.integrations, async (client) => {
    const [telegram, whatsapp, discord, email, composio] = await Promise.all([
      client.getTelegramSettings(),
      client.getWhatsAppSettings(),
      client.getDiscordSettings(),
      client.getEmailSettings(),
      client.getComposioSettings(),
    ]);
    return { composio, discord, email, telegram, whatsapp };
  });
}

export function useTimezoneQuery() {
  return useAtlasQuery(queryKeys.timezone, (client) => client.getTimezone());
}

export function useUserContextQuery() {
  return useAtlasQuery(queryKeys.userContext, (client) =>
    client.getUserContext({ includeContent: true })
  );
}

export function useOrgMemoryQuery(orgId: string | null | undefined) {
  return useAtlasQuery(
    queryKeys.orgMemory(orgId ?? "none"),
    (client) => client.getOrgMemory(orgId ?? ""),
    { enabled: Boolean(orgId) }
  );
}

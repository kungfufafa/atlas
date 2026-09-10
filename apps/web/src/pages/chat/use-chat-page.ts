import type { RemoteChatSession } from "@atlas/client";
import type {
  AgentChannel,
  AgentQuestionAnswer,
  AgentQuestionnaire,
  AgentTodo,
  ChatContextUsage,
  ProfileSummary,
  ThinkingEffort,
} from "@atlas/core/contract";
import type { FileUIPart } from "ai";
import { nanoid } from "nanoid";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import type { QueuedComposerMessage } from "@/components/chat/ChatMessageQueuePanel";
import { useActiveChatProfile } from "@/context/use-active-chat-profile";
import { useAppContext } from "@/context/use-app-context";
import { useAuth } from "@/context/use-auth";
import { useProfileQuery } from "@/hooks/use-app-queries";
import {
  useBranchSessionMutation,
  useUpdateSessionMutation,
} from "@/hooks/use-resource-mutations";
import {
  buildThinkingSettingsPayload,
  useSaveThinkingSettings,
  useThinkingSettings,
} from "@/hooks/use-thinking-settings";
import {
  buildChatBasePath,
  buildChatPath,
  buildNewChatPath,
  type ChatListItem,
  chatMessagesToListItems,
  clearFailedChatTurn,
  consumeStoredChatDraft,
  isReadOnlySessionChannel,
  parseChatRouteParams,
  pickKnownProfileId,
  readFailedChatTurn,
  readInitialDraftChatProfileId,
  readRequestedDraftFromNewChatSearch,
  readRequestedDraftKeyFromNewChatSearch,
  readStoredActiveChatProfileId,
  resolveDefaultProfileId,
  sessionStorageKey,
  storeFailedChatTurn,
} from "@/lib/chat-history";
import {
  filePartsToDisplayDocuments,
  filePartsToDocumentAttachments,
  filePartsToImageAttachments,
} from "@/lib/chat-images";
import {
  appendOutgoingMessages,
  buildStreamHandlers,
  deriveChatStatus,
  finalizeStreamingMessages,
  isAbortError,
  removeUnacceptedOutgoingMessages,
} from "@/lib/chat-stream";
import {
  isActiveTurnConflictError,
  isMissingChatSessionError,
  reconnectActiveSessionStream,
  seedStreamingStateForActiveTurn,
} from "@/lib/chat-stream-resume";
import { client, formatError } from "@/lib/client";
import {
  decodeModelSelection,
  effectiveProfileModelSelection,
  groupModelsByProvider,
  resolveModelDefaultReasoningEffort,
  resolveModelReasoningEffortValues,
  resolveModelThinkingSupport,
  resolveModelVisionSupport,
} from "@/lib/models";
import { SETUP_PATH } from "@/lib/navigation";
import { isViewerRole } from "@/lib/org-roles";
import {
  buildAutoEnableThinkingPayload,
  DEFAULT_THINKING_EFFORT,
  shouldAutoEnableThinking,
  shouldBlockThinkingEffortChange,
  shouldShowThinkingBlocks,
  shouldShowThinkingEffort,
} from "@/lib/thinking-settings";
import {
  appendFailedTurnIfNeeded,
  buildChatAttachmentScopeKey,
  canSelectSessionModel,
  findFailedRetryPrompt,
  findRetryCheckpoint,
  findRetryPrompt,
  isSupersededChatTurn,
  markStreamingTurnFailed,
  messagesWithoutFailedTurn,
  resolveFailedRetryPayload,
  shouldResetChatOnWorkspaceChange,
} from "@/pages/chat/chat-page.shared";
import {
  ChatSendQueue,
  guardChatStateUpdates,
  stopChatSessionTurn,
} from "./chat-send-queue";

interface SendMessageOptions {
  initialMessages?: ChatListItem[];
  questionnaireAnswers?: AgentQuestionAnswer[];
  sessionOverride?: RemoteChatSession;
}

interface QueuedSend {
  conflictRetries?: number;
  files: FileUIPart[];
  id: string;
  options: SendMessageOptions;
  readiness?: SendReadiness;
  text: string;
}

interface SendReadiness {
  reject: (error: unknown) => void;
  resolve: () => void;
}

function sessionAttachmentHistoryOptions(sessionId: string) {
  return {
    resolveAttachmentUrl: (attachmentId: string, inline: boolean) =>
      client.getSessionAttachmentUrl(sessionId, attachmentId, inline),
  };
}

export function useChatPage() {
  const { activeOrg, user } = useAuth();
  const canManageProfileModel =
    user?.isPlatformAdmin === true || activeOrg?.role === "admin";
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const routeSession = useMemo(() => parseChatRouteParams(params), [params]);
  const { health, models } = useAppContext();
  const {
    profileId: liveChatProfileId,
    setProfileId: setLiveChatProfileId,
    registerChatProfileSwitchHandler,
  } = useActiveChatProfile();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profileId, setProfileId] = useState(() =>
    readInitialDraftChatProfileId({
      routeProfileId: parseChatRouteParams(params)?.profileId,
      search: location.search,
    })
  );
  const [session, setSession] = useState<RemoteChatSession | null>(null);
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const [canUpdateSessionModel, setCanUpdateSessionModel] = useState(true);
  const [sessionChannel, setSessionChannel] = useState<AgentChannel>("web");
  const [messages, setMessages] = useState<ChatListItem[]>([]);
  const [agentTodos, setAgentTodos] = useState<AgentTodo[]>([]);
  const [agentQuestionnaire, setAgentQuestionnaire] =
    useState<AgentQuestionnaire | null>(null);
  const [contextUsage, setContextUsage] = useState<ChatContextUsage | null>(
    null
  );
  const [streamBusy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const busy = streamBusy || stopping;
  const [lastSuccessfulTurnAt, setLastSuccessfulTurnAt] = useState<
    number | null
  >(null);
  const [turnStartedAt, setTurnStartedAt] = useState<string | null>(null);
  const [branchingMessageId, setBranchingMessageId] = useState<string | null>(
    null
  );
  const [canStop, setCanStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState("");
  const [queuedMessages, setQueuedMessages] = useState<QueuedComposerMessage[]>(
    []
  );
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamGenerationRef = useRef(0);
  const executeQueuedSendRef = useRef<(item: QueuedSend) => Promise<void>>(
    async () => undefined
  );
  const messageQueueRef = useRef<ChatSendQueue<QueuedSend> | null>(null);
  if (!messageQueueRef.current) {
    messageQueueRef.current = new ChatSendQueue(
      (item) => executeQueuedSendRef.current(item),
      (items) =>
        setQueuedMessages(
          items.map((item) => ({
            attachmentCount: item.files.length,
            id: item.id,
            text: item.text,
          }))
        ),
      (err, item) => {
        item.readiness?.reject(err);
        setError(formatError(err));
      }
    );
  }
  const messageQueue = messageQueueRef.current;
  const resumedTurnIdRef = useRef<string | null>(null);
  const stoppingGenerationRef = useRef<number | null>(null);
  const sessionRef = useRef<RemoteChatSession | null>(null);
  const skipNextProfileSessionRef = useRef(false);
  const loadedRouteRef = useRef<string | null>(null);
  const profileIdRef = useRef(profileId);
  const busyRef = useRef(busy);
  const activeSessionIdRef = useRef<string | null>(null);
  const workspaceIdRef = useRef(activeOrg?.id ?? null);

  useEffect(() => {
    profileIdRef.current = profileId;
  }, [profileId]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    sessionRef.current = session;
    activeSessionIdRef.current = session?.id ?? null;
  }, [session]);

  const supersedeInFlightTurn = useCallback(() => {
    streamGenerationRef.current += 1;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    resumedTurnIdRef.current = null;
    stoppingGenerationRef.current = null;
    setStopping(false);
    return streamGenerationRef.current;
  }, []);

  const buildTurnStreamHandlers = useCallback(
    (generation: number, onAccepted?: () => void) => {
      const isCurrent = () => streamGenerationRef.current === generation;
      return buildStreamHandlers(
        guardChatStateUpdates(setMessages, isCurrent),
        {
          onAccepted: () => {
            if (isCurrent()) {
              onAccepted?.();
            }
          },
          onContextUsage: guardChatStateUpdates(setContextUsage, isCurrent),
          onQuestionnaireUpdated: guardChatStateUpdates(
            setAgentQuestionnaire,
            isCurrent
          ),
          onTodosUpdated: guardChatStateUpdates(setAgentTodos, isCurrent),
        }
      );
    },
    []
  );

  useEffect(
    () => () => {
      supersedeInFlightTurn();
      messageQueue.reset();
      // StrictMode replays effects after cancelling the first resume request.
      // Release its route claim so the replay can load persisted messages.
      loadedRouteRef.current = null;
    },
    [messageQueue, supersedeInFlightTurn]
  );

  // Composer / in-page switches update profileId first; push to shared context.
  useEffect(() => {
    if (!profileId || profileId === liveChatProfileId) {
      return;
    }
    setLiveChatProfileId(profileId);
  }, [profileId, liveChatProfileId, setLiveChatProfileId]);

  const syncChatUrl = useCallback(
    (nextProfileId: string, sessionId: string) => {
      const routeKey = `${nextProfileId}:${sessionId}`;
      const targetPath = buildChatPath(nextProfileId, sessionId);
      loadedRouteRef.current = routeKey;
      if (location.pathname !== targetPath) {
        navigate(targetPath, { replace: true });
      }
    },
    [location.pathname, navigate]
  );

  const chatStatus = useMemo(
    () => deriveChatStatus(busy, error, messages),
    [busy, error, messages]
  );

  const showOfflineHint = health != null && !health.providerConfigured;
  const branchSessionMutation = useBranchSessionMutation();
  const updateSessionMutation = useUpdateSessionMutation();
  const { data: thinkingSettings, isLoading: thinkingSettingsLoading } =
    useThinkingSettings();
  const saveThinkingSettingsMutation = useSaveThinkingSettings();
  const thinkingAutoEnableRef = useRef(false);
  const activeProfileQuery = useProfileQuery(
    canManageProfileModel ? profileId || null : null
  );

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === profileId),
    [profiles, profileId]
  );
  const availableSkills = activeProfileQuery.data?.skills ?? [];

  const providerModelGroups = useMemo(
    () => groupModelsByProvider(models?.models ?? []),
    [models?.models]
  );

  const profileModelSelection = useMemo(
    () =>
      effectiveProfileModelSelection(activeProfile?.model, providerModelGroups),
    [activeProfile?.model, providerModelGroups]
  );

  const currentModelSelection = useMemo(
    () =>
      effectiveProfileModelSelection(
        sessionModel ?? profileModelSelection,
        providerModelGroups
      ),
    [profileModelSelection, providerModelGroups, sessionModel]
  );

  const renderModelLabel = useCallback(
    (selection: string | null) => {
      if (!selection) {
        return "Select model";
      }
      const decoded = decodeModelSelection(selection);
      if (!decoded) {
        return selection;
      }
      if (decoded.providerId === "__unknown__") {
        return decoded.modelId;
      }
      const group = providerModelGroups.find(
        (entry) => entry.providerId === decoded.providerId
      );
      return (
        group?.models.find((model) => model.id === decoded.modelId)?.name ??
        decoded.modelId
      );
    },
    [providerModelGroups]
  );

  const activeModelSupportsThinking = useMemo(
    () =>
      resolveModelThinkingSupport(currentModelSelection, providerModelGroups),
    [currentModelSelection, providerModelGroups]
  );

  const activeModelReasoningEffortValues = useMemo(
    () =>
      resolveModelReasoningEffortValues(
        currentModelSelection,
        providerModelGroups
      ),
    [currentModelSelection, providerModelGroups]
  );

  const activeModelDefaultReasoningEffort = useMemo(
    () =>
      resolveModelDefaultReasoningEffort(
        currentModelSelection,
        providerModelGroups
      ),
    [currentModelSelection, providerModelGroups]
  );

  const activeModelSupportsVision = useMemo(
    () => resolveModelVisionSupport(currentModelSelection, providerModelGroups),
    [currentModelSelection, providerModelGroups]
  );

  const readOnlySession = isReadOnlySessionChannel(sessionChannel);
  const workspaceReadOnly = isViewerRole(activeOrg?.role);
  const modelSelectionAllowed = canSelectSessionModel({
    canUpdateExistingSession: canUpdateSessionModel,
    hasSession: session !== null,
    readOnlySession,
    workspaceReadOnly,
  });
  const showThinking = shouldShowThinkingBlocks(activeModelSupportsThinking);
  const thinkingEffortVisible = shouldShowThinkingEffort(
    activeModelSupportsThinking
  );
  const thinkingEffort = thinkingSettings?.effort ?? DEFAULT_THINKING_EFFORT;
  const thinkingEffortDisabled =
    busy ||
    thinkingSettingsLoading ||
    saveThinkingSettingsMutation.isPending ||
    readOnlySession ||
    workspaceReadOnly;

  const handleModelChange = useCallback(
    (selection: string | null) => {
      if (
        !profileId ||
        busy ||
        updateSessionMutation.isPending ||
        !modelSelectionAllowed
      ) {
        return;
      }
      if (selection && !decodeModelSelection(selection)) {
        return;
      }

      const previousModel = sessionModel;
      setSessionModel(selection);
      if (!session) {
        return;
      }

      const updatedSessionId = session.id;
      void updateSessionMutation
        .mutateAsync({
          channel: sessionChannel,
          input: { model: selection },
          profileId,
          sessionId: updatedSessionId,
        })
        .catch((err) => {
          if (activeSessionIdRef.current !== updatedSessionId) {
            return;
          }
          setSessionModel(previousModel);
          setError(formatError(err));
        });
    },
    [
      busy,
      profileId,
      modelSelectionAllowed,
      session,
      sessionChannel,
      sessionModel,
      updateSessionMutation,
    ]
  );

  const loadProfiles = useCallback(async () => {
    const requestedOrgId = activeOrg?.id ?? null;
    try {
      const response = await client.listProfiles();
      if (workspaceIdRef.current !== requestedOrgId) {
        return;
      }
      setProfiles(response.profiles);
      if (!routeSession && response.profiles.length > 0) {
        setProfileId((current) => {
          const resolved = pickKnownProfileId(
            response.profiles,
            current,
            readStoredActiveChatProfileId()
          );
          if (resolved) {
            return resolved;
          }
          return resolveDefaultProfileId(response.profiles) ?? "";
        });
      }
    } catch (err) {
      if (workspaceIdRef.current !== requestedOrgId) {
        return;
      }
      setError(formatError(err));
    }
  }, [routeSession, activeOrg?.id]);

  const enterDraftChat = useCallback(
    (nextProfileId: string) => {
      supersedeInFlightTurn();
      localStorage.removeItem(sessionStorageKey(nextProfileId));
      skipNextProfileSessionRef.current = true;
      loadedRouteRef.current = null;
      messageQueue.reset();
      setQueuedMessages([]);
      sessionRef.current = null;
      activeSessionIdRef.current = null;
      setSession(null);
      setSessionModel(null);
      setCanUpdateSessionModel(true);
      setSessionChannel("web");
      setMessages([]);
      setError(null);
      setAgentTodos([]);
      setAgentQuestionnaire(null);
      setContextUsage(null);
      setBusy(false);
      setCanStop(false);
      setTurnStartedAt(null);
      // Keep ChatPage mounted; ?new=1 still carries the profile if we left /chat.
      if (location.pathname !== buildChatBasePath()) {
        navigate(buildNewChatPath(nextProfileId), { replace: true });
      }
    },
    [location.pathname, messageQueue, navigate, supersedeInFlightTurn]
  );

  useEffect(() => {
    const nextOrgId = activeOrg?.id ?? null;
    const previousOrgId = workspaceIdRef.current;
    workspaceIdRef.current = nextOrgId;
    if (!shouldResetChatOnWorkspaceChange(previousOrgId, nextOrgId)) {
      return;
    }

    supersedeInFlightTurn();
    messageQueue.reset();
    skipNextProfileSessionRef.current = true;
    loadedRouteRef.current = null;
    setQueuedMessages([]);
    sessionRef.current = null;
    activeSessionIdRef.current = null;
    setSession(null);
    setSessionModel(null);
    setCanUpdateSessionModel(true);
    setSessionChannel("web");
    setMessages([]);
    setError(null);
    setAgentTodos([]);
    setAgentQuestionnaire(null);
    setContextUsage(null);
    setBusy(false);
    setCanStop(false);
    setTurnStartedAt(null);
    setComposerDraft("");
    setProfileId("");

    if (location.pathname !== buildChatBasePath()) {
      navigate(buildChatBasePath(), { replace: true });
    }
  }, [
    activeOrg?.id,
    location.pathname,
    messageQueue,
    navigate,
    supersedeInFlightTurn,
  ]);

  const handleThinkingEffortChange = useCallback(
    (effort: ThinkingEffort) => {
      if (!profileId || effort === thinkingEffort) {
        return;
      }

      if (
        shouldBlockThinkingEffortChange(busy) ||
        saveThinkingSettingsMutation.isPending
      ) {
        if (busy) {
          setError("Wait for the current response to finish.");
        }
        return;
      }

      void saveThinkingSettingsMutation
        .mutateAsync(buildThinkingSettingsPayload(effort))
        .catch((err) => {
          setError(formatError(err));
        });
    },
    [profileId, thinkingEffort, busy, saveThinkingSettingsMutation]
  );

  useEffect(() => {
    if (
      !shouldAutoEnableThinking(
        thinkingSettings,
        activeModelSupportsThinking,
        busy,
        thinkingAutoEnableRef.current,
        {
          hasMessages: messages.length > 0,
          hasProfileId: Boolean(profileId),
          hasRouteSession: Boolean(routeSession),
          hasSession: Boolean(session),
        }
      )
    ) {
      return;
    }

    let cancelled = false;
    thinkingAutoEnableRef.current = true;
    const startedProfileId = profileId;

    void saveThinkingSettingsMutation
      .mutateAsync(buildAutoEnableThinkingPayload(thinkingSettings!))
      .then(() => {
        if (cancelled) {
          return;
        }
        if (profileIdRef.current !== startedProfileId) {
          return;
        }
        if (busyRef.current || routeSession) {
          return;
        }
        if (activeModelSupportsThinking !== true) {
          return;
        }
        enterDraftChat(startedProfileId);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        thinkingAutoEnableRef.current = false;
        setError(formatError(err));
      });

    return () => {
      cancelled = true;
    };
  }, [
    thinkingSettings,
    activeModelSupportsThinking,
    busy,
    profileId,
    routeSession,
    session,
    messages.length,
    saveThinkingSettingsMutation,
    enterDraftChat,
  ]);

  const resumeSession = useCallback(
    async (nextProfileId: string, sessionId: string) => {
      if (
        activeSessionIdRef.current !== sessionId ||
        profileIdRef.current !== nextProfileId
      ) {
        messageQueue.reset();
      }
      activeSessionIdRef.current = sessionId;
      const generation = supersedeInFlightTurn();
      const releaseQueue = messageQueue.hold();
      setBusy(true);
      setError(null);
      try {
        skipNextProfileSessionRef.current = nextProfileId !== profileId;
        const {
          canUpdateModel,
          channel,
          messages: storedMessages,
          messageMeta,
          model,
          todos,
          questionnaire,
          contextUsage: nextContextUsage,
        } = await client.getSessionMessages(sessionId);
        if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
          return;
        }
        localStorage.setItem(sessionStorageKey(nextProfileId), sessionId);
        const nextSession = client.createChatSession(sessionId, channel);
        let listItems = chatMessagesToListItems(
          storedMessages,
          messageMeta,
          sessionAttachmentHistoryOptions(sessionId)
        );
        const storedFailedTurn =
          channel === "web" ? readFailedChatTurn(sessionId) : null;

        if (storedFailedTurn) {
          listItems = appendFailedTurnIfNeeded(listItems, storedFailedTurn);
        }

        setProfileId(nextProfileId);
        setSessionChannel(channel);
        sessionRef.current = nextSession;
        setSession(nextSession);
        setSessionModel(model);
        setCanUpdateSessionModel(canUpdateModel);
        setMessages(listItems);
        setAgentTodos(todos);
        setAgentQuestionnaire(questionnaire);
        setContextUsage(nextContextUsage ?? null);
        setError(null);
        syncChatUrl(nextProfileId, sessionId);

        if (channel === "web") {
          const status = await client.getSessionStatus(sessionId);
          if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
            return;
          }

          if (status.active) {
            resumedTurnIdRef.current = status.turnId ?? null;
            setCanStop(true);
            setTurnStartedAt(status.startedAt ?? new Date().toISOString());
            listItems = seedStreamingStateForActiveTurn(listItems);
            setMessages(listItems);

            const abortController = new AbortController();
            streamAbortRef.current = abortController;

            const { reconnected } = await reconnectActiveSessionStream({
              handlers: buildTurnStreamHandlers(generation),
              messages: listItems,
              onActiveTurn: (turnId) => {
                if (
                  !isSupersededChatTurn(streamGenerationRef.current, generation)
                ) {
                  resumedTurnIdRef.current = turnId ?? null;
                }
              },
              sessionId,
              signal: abortController.signal,
            });
            if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
              return;
            }

            const refreshed = await client.getSessionMessages(sessionId);
            if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
              return;
            }
            let refreshedItems = chatMessagesToListItems(
              refreshed.messages,
              refreshed.messageMeta,
              sessionAttachmentHistoryOptions(sessionId)
            );
            const failedAfterReconnect = readFailedChatTurn(sessionId);

            if (failedAfterReconnect && !reconnected) {
              refreshedItems = appendFailedTurnIfNeeded(
                refreshedItems,
                failedAfterReconnect
              );
            } else if (reconnected) {
              clearFailedChatTurn(sessionId);
              setError(null);
            }

            setMessages(refreshedItems);
            setAgentTodos(refreshed.todos);
            setAgentQuestionnaire(refreshed.questionnaire);
            setContextUsage(refreshed.contextUsage ?? null);
            setSessionModel(refreshed.model);
            setCanUpdateSessionModel(refreshed.canUpdateModel);

            if (reconnected) {
              setLastSuccessfulTurnAt(Date.now());
            }
          }
        }
        messageQueue.resume();
      } catch (err) {
        if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
          return;
        }
        if (isAbortError(err)) {
          setMessages((current) => finalizeStreamingMessages(current));
          return;
        }

        messageQueue.pause();
        setError(formatError(err));
      } finally {
        const superseded = isSupersededChatTurn(
          streamGenerationRef.current,
          generation
        );
        if (!superseded) {
          streamAbortRef.current = null;
          resumedTurnIdRef.current = null;
        }
        setCanStop((current) => (superseded ? current : false));
        setBusy((current) => (superseded ? current : false));
        setTurnStartedAt((current) => (superseded ? current : null));
        releaseQueue();
      }
    },
    [
      buildTurnStreamHandlers,
      messageQueue,
      profileId,
      supersedeInFlightTurn,
      syncChatUrl,
    ]
  );

  const handleBranchMessage = useCallback(
    async (message: ChatListItem) => {
      if (
        !(session && profileId) ||
        workspaceReadOnly ||
        typeof message.historyIndex !== "number"
      ) {
        return;
      }
      setBranchingMessageId(message.id);
      setError(null);
      const generation = streamGenerationRef.current;
      try {
        const result = await branchSessionMutation.mutateAsync({
          channel: "web",
          messageIndex: message.historyIndex,
          profileId,
          sessionId: session.id,
        });
        if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
          return;
        }
        await resumeSession(profileId, result.sessionId);
      } catch (err) {
        if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
          return;
        }
        setError(formatError(err));
      } finally {
        setBranchingMessageId(null);
      }
    },
    [
      branchSessionMutation,
      profileId,
      resumeSession,
      session,
      workspaceReadOnly,
    ]
  );

  const handleProfileSwitch = useCallback(
    (nextProfileId: string) => {
      if (
        !nextProfileId ||
        nextProfileId === profileIdRef.current ||
        busyRef.current
      ) {
        return;
      }
      setProfileId(nextProfileId);
      enterDraftChat(nextProfileId);
    },
    [enterDraftChat]
  );

  useEffect(
    () =>
      registerChatProfileSwitchHandler((nextProfileId) => {
        if (
          !nextProfileId ||
          nextProfileId === profileIdRef.current ||
          busyRef.current
        ) {
          return;
        }
        setProfileId(nextProfileId);
        enterDraftChat(nextProfileId);
      }),
    [registerChatProfileSwitchHandler, enterDraftChat]
  );

  // Layout effect so session is cleared before the syncChatUrl effect can
  // re-push the previous /chat/:profile/:session URL (first-click blink).
  useLayoutEffect(() => {
    if (searchParams.get("new") !== "1") {
      return;
    }
    const requestedProfile = searchParams.get("profile")?.trim() || null;
    const inlineDraft = readRequestedDraftFromNewChatSearch(location.search);
    const draftKey = readRequestedDraftKeyFromNewChatSearch(location.search);
    const storedDraft = draftKey ? consumeStoredChatDraft(draftKey) : null;
    const requestedDraft = inlineDraft ?? storedDraft;
    const targetProfileId = requestedProfile || profileIdRef.current;

    if (targetProfileId) {
      localStorage.removeItem(sessionStorageKey(targetProfileId));
    }
    skipNextProfileSessionRef.current = true;
    loadedRouteRef.current = null;
    messageQueue.reset();
    supersedeInFlightTurn();
    setQueuedMessages([]);
    sessionRef.current = null;
    activeSessionIdRef.current = null;
    setSession(null);
    setSessionModel(null);
    setCanUpdateSessionModel(true);
    setSessionChannel("web");
    setMessages([]);
    setError(null);
    setAgentTodos([]);
    setAgentQuestionnaire(null);
    setContextUsage(null);
    setBusy(false);
    setCanStop(false);
    setTurnStartedAt(null);

    if (requestedProfile && requestedProfile !== profileIdRef.current) {
      setProfileId(requestedProfile);
    }

    if (requestedDraft) {
      setComposerDraft(requestedDraft);
    }

    navigate(buildChatBasePath(), { replace: true });
  }, [
    searchParams,
    navigate,
    location.search,
    messageQueue,
    supersedeInFlightTurn,
  ]);

  useEffect(() => {
    if (!profileId || routeSession) {
      return;
    }
    if (skipNextProfileSessionRef.current) {
      skipNextProfileSessionRef.current = false;
      return;
    }
    enterDraftChat(profileId);
  }, [profileId, routeSession, enterDraftChat]);

  useEffect(() => {
    if (!routeSession) {
      return;
    }
    const routeKey = `${routeSession.profileId}:${routeSession.sessionId}`;
    if (loadedRouteRef.current === routeKey) {
      return;
    }
    loadedRouteRef.current = routeKey;
    skipNextProfileSessionRef.current = true;
    void resumeSession(routeSession.profileId, routeSession.sessionId);
  }, [routeSession, resumeSession]);

  useEffect(() => {
    if (!(session && profileId)) {
      return;
    }
    // Stale session state must never overwrite an intentional draft /chat URL.
    // send/resume call syncChatUrl explicitly when a session should be reflected.
    if (location.pathname === buildChatBasePath()) {
      return;
    }
    syncChatUrl(profileId, session.id);
  }, [session, profileId, syncChatUrl, location.pathname]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const stopStreaming = useCallback(() => {
    const generation = streamGenerationRef.current;
    const abortController = streamAbortRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!abortController || stoppingGenerationRef.current === generation) {
      return;
    }
    if (!sessionId) {
      abortController.abort();
      return;
    }
    stoppingGenerationRef.current = generation;
    setStopping(true);
    const releaseQueue = messageQueue.hold();
    const isCurrent = () => streamGenerationRef.current === generation;
    const turnId = resumedTurnIdRef.current;
    void (async () => {
      try {
        await stopChatSessionTurn({
          abortStream: () => abortController.abort(),
          cancelTurn: (expectedTurnId, signal) =>
            client.cancelSessionTurn(sessionId, expectedTurnId, { signal }),
          getStatus: (signal) => client.getSessionStatus(sessionId, { signal }),
          isCurrent,
          turnId,
        });
        if (isCurrent()) {
          messageQueue.resume();
        }
      } catch (err) {
        if (isCurrent()) {
          messageQueue.pause();
          setError(formatError(err));
        }
      } finally {
        if (isCurrent()) {
          stoppingGenerationRef.current = null;
          setStopping(false);
        }
        releaseQueue();
      }
    })();
  }, [messageQueue]);

  const executeSend = useCallback(
    async (
      text: string,
      files: FileUIPart[] = [],
      options: SendMessageOptions = {},
      queueItem?: QueuedSend,
      readiness?: SendReadiness
    ) => {
      const generation = ++streamGenerationRef.current;
      setBusy(true);
      setTurnStartedAt(new Date().toISOString());
      setError(null);

      const images = filePartsToImageAttachments(files);
      const documents = filePartsToDocumentAttachments(files);
      const displayDocuments = filePartsToDisplayDocuments(files);

      if (options.initialMessages) {
        setMessages(options.initialMessages);
        setAgentTodos([]);
        setAgentQuestionnaire(null);
      }

      setAgentQuestionnaire(null);

      const displayImages = images.map((image) => ({
        mediaType: image.mediaType,
        url: `data:${image.mediaType};base64,${image.data}`,
      }));
      const useImageAttachments = activeModelSupportsVision === false;
      const outgoingOptions = {
        imageAttachments:
          useImageAttachments && displayImages.length > 0
            ? displayImages
            : undefined,
        questionnaireAnswers: options.questionnaireAnswers,
        retryFiles: files,
        thinkingEnabled: showThinking,
      };

      appendOutgoingMessages(
        setMessages,
        text,
        useImageAttachments ? [] : displayImages,
        displayDocuments.length > 0 ? displayDocuments : undefined,
        outgoingOptions
      );

      let activeSession = options.sessionOverride ?? sessionRef.current;
      let pendingNewSession = false;
      let accepted = false;

      if (!activeSession) {
        try {
          activeSession = await client.createSession("web", {
            model: sessionModel ?? undefined,
            profileId,
          });
          if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
            readiness?.reject(
              new DOMException("The chat changed before sending.", "AbortError")
            );
            return;
          }
          pendingNewSession = true;
        } catch (err) {
          if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
            readiness?.reject(err);
            return;
          }
          setError(formatError(err));
          messageQueue.pause();
          setMessages((current) => current.slice(0, -2));
          if (queueItem && !readiness) {
            messageQueue.restore(queueItem);
          }
          streamAbortRef.current = null;
          setCanStop(false);
          setBusy(false);
          setTurnStartedAt(null);
          readiness?.reject(err);
          return;
        }
      }

      const turnSession = activeSession;
      const acceptTurn = () => {
        if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
          return;
        }
        accepted = true;
        if (pendingNewSession) {
          pendingNewSession = false;
          localStorage.setItem(sessionStorageKey(profileId), turnSession.id);
          activeSessionIdRef.current = turnSession.id;
          setSessionChannel("web");
          sessionRef.current = turnSession;
          setSession(turnSession);
          setCanUpdateSessionModel(true);
          syncChatUrl(profileId, turnSession.id);
        }
        readiness?.resolve();
      };

      const abortController = new AbortController();
      streamAbortRef.current = abortController;
      setCanStop(true);

      try {
        await turnSession.sendStream(
          {
            documents: documents.length > 0 ? documents : undefined,
            images: images.length > 0 ? images : undefined,
            message: text,
            relatedQuestions: true,
          },
          buildTurnStreamHandlers(generation, acceptTurn),
          { signal: abortController.signal }
        );
        acceptTurn();
        if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
          return;
        }

        const {
          canUpdateModel,
          messages: storedMessages,
          messageMeta,
          model: nextSessionModel,
          todos,
          questionnaire,
          contextUsage: nextContextUsage,
        } = await client.getSessionMessages(turnSession.id);
        if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
          return;
        }
        clearFailedChatTurn(turnSession.id);
        setMessages(
          chatMessagesToListItems(
            storedMessages,
            messageMeta,
            sessionAttachmentHistoryOptions(activeSession.id)
          )
        );
        setAgentTodos(todos);
        setAgentQuestionnaire(questionnaire);
        setContextUsage(nextContextUsage ?? null);
        setSessionModel(nextSessionModel);
        setCanUpdateSessionModel(canUpdateModel);
        setLastSuccessfulTurnAt(Date.now());
      } catch (err) {
        readiness?.reject(err);
        if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
          return;
        }
        if (isAbortError(err)) {
          setMessages((current) => finalizeStreamingMessages(current));
          return;
        }

        const message = formatError(err);

        if (!accepted && isActiveTurnConflictError(err) && activeSession) {
          messageQueue.pause();
          setError("The agent is still responding to your last message.");
          setMessages(removeUnacceptedOutgoingMessages);
          if (queueItem && !readiness) {
            messageQueue.restore(queueItem);
          }
          if (!queueItem?.conflictRetries) {
            if (queueItem) {
              queueItem.conflictRetries = 1;
            }
            await resumeSession(profileId, activeSession.id);
          }
          return;
        }

        if (!accepted && isMissingChatSessionError(err) && profileId) {
          messageQueue.pause();
          localStorage.removeItem(sessionStorageKey(profileId));
          activeSessionIdRef.current = null;
          sessionRef.current = null;
          setError("Chat session expired. Send again to start a new session.");
          setMessages(removeUnacceptedOutgoingMessages);
          setAgentQuestionnaire(null);
          if (queueItem && !readiness) {
            messageQueue.restore(queueItem);
          }
          return;
        }

        setError(null);
        if (
          activeSession &&
          text.trim() &&
          images.length === 0 &&
          documents.length === 0
        ) {
          storeFailedChatTurn(activeSession.id, { error: message, text });
        }
        setMessages((current) => markStreamingTurnFailed(current, message));
      } finally {
        const superseded = isSupersededChatTurn(
          streamGenerationRef.current,
          generation
        );
        setCanStop((current) => (superseded ? current : false));
        setBusy((current) => (superseded ? current : false));
        setTurnStartedAt((current) => (superseded ? current : null));
        if (!superseded) {
          streamAbortRef.current = null;
        }
      }
    },
    [
      buildTurnStreamHandlers,
      messageQueue,
      profileId,
      resumeSession,
      syncChatUrl,
      showThinking,
      activeModelSupportsVision,
      sessionModel,
    ]
  );

  useLayoutEffect(() => {
    executeQueuedSendRef.current = (item) =>
      executeSend(item.text, item.files, item.options, item, item.readiness);
  }, [executeSend]);

  const sendMessage = useCallback(
    async (
      text: string,
      files: FileUIPart[] = [],
      options: SendMessageOptions = {}
    ) => {
      if (readOnlySession || workspaceReadOnly) {
        return;
      }

      const images = filePartsToImageAttachments(files);
      const documents = filePartsToDocumentAttachments(files);

      if (
        (!text.trim() && images.length === 0 && documents.length === 0) ||
        !profileId
      ) {
        return;
      }

      const queuedItem: QueuedSend = { files, id: nanoid(), options, text };
      if (messageQueue.busy) {
        messageQueue.enqueue(queuedItem);
        messageQueue.resume();
        return;
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const readiness: SendReadiness = {
          reject: (error) => {
            if (settled) {
              return;
            }
            settled = true;
            reject(error);
          },
          resolve: () => {
            if (settled) {
              return;
            }
            settled = true;
            resolve();
          },
        };

        queuedItem.readiness = readiness;
        messageQueue.enqueue(queuedItem);
        messageQueue.resume();
      });
    },
    [messageQueue, profileId, readOnlySession, workspaceReadOnly]
  );

  const handleTryAgainMessage = useCallback(
    async (message: ChatListItem) => {
      if (busy || !profileId || workspaceReadOnly) {
        return;
      }

      if (message.failed) {
        const prompt = findFailedRetryPrompt(messages, message);
        const retryPayload = resolveFailedRetryPayload(prompt);

        if (retryPayload.status === "missing") {
          setError("Could not find a prompt to retry.");
          return;
        }

        if (retryPayload.status === "attachments_unavailable") {
          setError(
            "Original attachments are no longer available. Attach them again to retry."
          );
          return;
        }

        setBranchingMessageId(message.id);
        setError(null);

        try {
          if (session) {
            clearFailedChatTurn(session.id);
          }

          await sendMessage(retryPayload.text, retryPayload.files, {
            initialMessages: messagesWithoutFailedTurn(messages, message),
            sessionOverride: session ?? undefined,
          });
        } catch (err) {
          setError(formatError(err));
        } finally {
          setBranchingMessageId(null);
        }

        return;
      }

      const prompt = findRetryPrompt(messages, message);

      if (!prompt?.content.trim()) {
        setError("Could not find a prompt to try again.");
        return;
      }

      if (prompt.images?.length || prompt.documents?.length) {
        setError("Try again is available for text-only prompts.");
        return;
      }

      const checkpoint = findRetryCheckpoint(messages, prompt);

      if (checkpoint && !session) {
        setError(
          "Chat session is unavailable. Please send a new message instead."
        );
        return;
      }

      setBranchingMessageId(message.id);
      setError(null);
      const generation = streamGenerationRef.current;

      try {
        let retrySession: RemoteChatSession;
        let initialMessages: ChatListItem[] = [];

        if (checkpoint && session) {
          const result = await branchSessionMutation.mutateAsync({
            channel: "web",
            messageIndex: checkpoint.historyIndex!,
            profileId,
            sessionId: session.id,
          });
          retrySession = client.createChatSession(result.sessionId, "web");
          initialMessages = messages.filter(
            (item) =>
              typeof item.historyIndex === "number" &&
              item.historyIndex <= checkpoint.historyIndex!
          );
        } else {
          retrySession = await client.createSession("web", {
            model: sessionModel ?? undefined,
            profileId,
          });
        }

        if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
          return;
        }

        localStorage.setItem(sessionStorageKey(profileId), retrySession.id);
        activeSessionIdRef.current = retrySession.id;
        sessionRef.current = retrySession;
        setSession(retrySession);
        syncChatUrl(profileId, retrySession.id);

        await sendMessage(prompt.content, [], {
          initialMessages,
          sessionOverride: retrySession,
        });
      } catch (err) {
        if (isSupersededChatTurn(streamGenerationRef.current, generation)) {
          return;
        }
        setError(formatError(err));
      } finally {
        setBranchingMessageId(null);
      }
    },
    [
      branchSessionMutation,
      busy,
      messages,
      profileId,
      sendMessage,
      session,
      sessionModel,
      syncChatUrl,
      workspaceReadOnly,
    ]
  );

  const isEmptyState = messages.length === 0 && !busy;
  const attachmentScopeKey = buildChatAttachmentScopeKey({
    draftKey: location.key,
    orgId: activeOrg?.id,
    profileId,
    sessionId: session?.id,
  });
  const composerDisabled =
    !profileId ||
    readOnlySession ||
    workspaceReadOnly ||
    updateSessionMutation.isPending;

  return {
    activeModelSupportsVision,
    activeProfile,
    agentQuestionnaire,
    agentTodos,
    attachmentScopeKey,
    availableSkills,
    branchingMessageId,
    busy,
    canManageProfileModel,
    canStop,
    canUpdateSessionModel: modelSelectionAllowed,
    chatStatus,
    composerDisabled,
    composerDraft,
    contextUsage: isEmptyState ? null : contextUsage,
    currentModelSelection,
    error,
    handleBranchMessage,
    handleModelChange,
    handleProfileSwitch,
    handleThinkingEffortChange,
    handleTryAgainMessage,
    health,
    isEmptyState,
    lastSuccessfulTurnAt,
    messages,
    navigateSetup: () => navigate(SETUP_PATH),
    profileId,
    profileModelSelection,
    profiles,
    providerModelGroups,
    queuedMessages,
    readOnlySession,
    renderModelLabel,
    sendMessage,
    session,
    sessionChannel,
    setComposerDraft,
    showOfflineHint,
    showThinking,
    stopStreaming,
    thinkingDefaultEffort: activeModelDefaultReasoningEffort,
    thinkingEffort,
    thinkingEffortDisabled,
    thinkingEffortValues: activeModelReasoningEffortValues,
    thinkingEffortVisible,
    turnStartedAt,
    workspaceReadOnly,
  };
}

export type ChatPageState = ReturnType<typeof useChatPage>;

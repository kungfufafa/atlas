import type { RemoteChatSession } from "@atlas/client";
import { formatError } from "@atlas/client";
import type {
  AgentTodo,
  ApprovalRequest,
  DocumentAttachment,
  ImageAttachment,
  SessionMessagesResponse,
} from "@atlas/core/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ChatListItem } from "@/features/chat/chat-items";
import {
  chatMessagesToListItems,
  isAbortError,
} from "@/features/chat/chat-items";
import {
  appendOutgoingMessages,
  buildStreamHandlers,
  createReplayAwareHandlers,
  finalizeStreamingMessages,
  materializedToolCallIds,
  seedStreamingStateForActiveTurn,
} from "@/features/chat/chat-stream";
import { useNetwork } from "@/features/network/network-context";
import { useServer } from "@/features/server/server-context";
import {
  useOrgKey,
  useReadyAtlasClient,
  useServerQueryClient,
} from "@/hooks/use-atlas-query";
import { queryKeys } from "@/lib/query-keys";

export interface ChatSendInput {
  documents?: DocumentAttachment[];
  images?: ImageAttachment[];
  message: string;
}

export function useChatSession(profileId: string, sessionId?: string) {
  const client = useReadyAtlasClient();
  const orgKey = useOrgKey();
  const queryClient = useServerQueryClient();
  const { isOffline, isOnline } = useNetwork();
  const { activeServer, isCurrentServer } = useServer();
  const sourceServerId = activeServer?.id ?? null;
  const belongsToActiveServer = useCallback(
    () => isCurrentServer(sourceServerId),
    [isCurrentServer, sourceServerId]
  );
  const [messages, setMessages] = useState<ChatListItem[]>([]);
  const [todos, setTodos] = useState<AgentTodo[]>([]);
  const [relatedQuestions, setRelatedQuestions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(Boolean(sessionId));
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(
    sessionId
  );
  const sessionRef = useRef<RemoteChatSession | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const stoppedRef = useRef(false);
  const shouldResyncOnReconnectRef = useRef(false);
  const messagesRef = useRef<ChatListItem[]>([]);
  messagesRef.current = messages;

  const applySessionMessages = useCallback(
    (response: SessionMessagesResponse) => {
      const items = chatMessagesToListItems(response.messages);
      setMessages(items);
      setTodos(response.todos);
      const lastAssistant = [...items]
        .reverse()
        .find((item) => item.role === "assistant");
      setRelatedQuestions(lastAssistant?.relatedQuestions ?? []);
    },
    []
  );

  const getSessionMessagesKey = useCallback(
    (id: string) => queryKeys.sessionMessages(profileId, id, orgKey),
    [orgKey, profileId]
  );

  const cacheSessionMessages = useCallback(
    (id: string, response: SessionMessagesResponse) => {
      queryClient.setQueryData(getSessionMessagesKey(id), response);
    },
    [getSessionMessagesKey, queryClient]
  );

  const handlers = useCallback(
    () =>
      buildStreamHandlers(setMessages, {
        isCurrent: belongsToActiveServer,
        onRelatedQuestions: setRelatedQuestions,
        onTodosUpdated: setTodos,
      }),
    [belongsToActiveServer]
  );

  const refreshSession = useCallback(
    async (id: string) => {
      if (!client) {
        return;
      }
      const stored = await client.getSessionMessages(id);
      if (!belongsToActiveServer()) {
        return;
      }
      cacheSessionMessages(id, stored);
      applySessionMessages(stored);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.sessions(profileId),
      });
      await queryClient.invalidateQueries({ queryKey: ["sessions-all"] });
    },
    [
      applySessionMessages,
      belongsToActiveServer,
      cacheSessionMessages,
      client,
      profileId,
      queryClient,
    ]
  );

  const reconnectActiveTurn = useCallback(
    async (id: string) => {
      if (
        !(client && belongsToActiveServer()) ||
        isOffline ||
        sendingRef.current ||
        stoppedRef.current
      ) {
        return false;
      }

      const status = await client.getSessionStatus(id);
      if (!(belongsToActiveServer() && status.active)) {
        return false;
      }

      sendingRef.current = true;
      setIsSending(true);
      setError(null);
      const abort = new AbortController();
      abortRef.current = abort;

      const seeded = seedStreamingStateForActiveTurn(messagesRef.current);
      setMessages(seeded);
      messagesRef.current = seeded;

      try {
        await client.subscribeSessionStream(
          id,
          createReplayAwareHandlers(
            handlers(),
            materializedToolCallIds(seeded)
          ),
          { signal: abort.signal }
        );
        if (!belongsToActiveServer()) {
          return false;
        }
        await refreshSession(id);
        return true;
      } catch (caught) {
        if (!belongsToActiveServer()) {
          return false;
        }
        if (isAbortError(caught) && stoppedRef.current) {
          setMessages((current) => finalizeStreamingMessages(current));
          return false;
        }
        if (!isAbortError(caught)) {
          setError(formatError(caught));
        }
        return false;
      } finally {
        if (belongsToActiveServer()) {
          abortRef.current = null;
          sendingRef.current = false;
          setIsSending(false);
        }
      }
    },
    [belongsToActiveServer, client, handlers, isOffline, refreshSession]
  );
  const reconnectRef = useRef(reconnectActiveTurn);
  reconnectRef.current = reconnectActiveTurn;

  useEffect(() => {
    if (!client) {
      abortRef.current?.abort();
      abortRef.current = null;
      sessionRef.current = null;
      sendingRef.current = false;
      stoppedRef.current = true;
      setActiveSessionId(undefined);
      setError(null);
      setMessages([]);
      setTodos([]);
      setRelatedQuestions([]);
      setIsLoading(Boolean(sessionId));
      setIsSending(false);
      return;
    }

    if (sessionId && sessionRef.current?.id === sessionId) {
      return;
    }

    abortRef.current?.abort();
    abortRef.current = null;
    stoppedRef.current = false;
    setError(null);
    setTodos([]);
    setRelatedQuestions([]);

    if (!sessionId) {
      sessionRef.current = null;
      setActiveSessionId(undefined);
      setMessages([]);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setActiveSessionId(sessionId);
    sessionRef.current = client.createChatSession(sessionId, "web");

    const cached = queryClient.getQueryData<SessionMessagesResponse>(
      getSessionMessagesKey(sessionId)
    );
    if (cached) {
      applySessionMessages(cached);
      setIsLoading(false);
    }

    if (isOffline) {
      if (!cached) {
        setIsLoading(false);
      }
      return () => {
        cancelled = true;
        abortRef.current?.abort();
      };
    }

    void client
      .getSessionMessages(sessionId)
      .then(async (response) => {
        if (cancelled || !belongsToActiveServer()) {
          return;
        }
        cacheSessionMessages(sessionId, response);
        applySessionMessages(response);
        setIsLoading(false);
        await reconnectRef.current(sessionId);
      })
      .catch((caught: unknown) => {
        if (!cancelled && belongsToActiveServer()) {
          setError(formatError(caught));
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [
    applySessionMessages,
    belongsToActiveServer,
    cacheSessionMessages,
    client,
    getSessionMessagesKey,
    isOffline,
    queryClient,
    sessionId,
  ]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !sessionRef.current) {
        return;
      }
      void reconnectActiveTurn(sessionRef.current.id);
    });
    return () => {
      sub.remove();
    };
  }, [reconnectActiveTurn]);

  useEffect(() => {
    if (isOffline) {
      shouldResyncOnReconnectRef.current = true;
      return;
    }
    if (
      !(isOnline && shouldResyncOnReconnectRef.current && sessionRef.current)
    ) {
      return;
    }

    const session = sessionRef.current;
    shouldResyncOnReconnectRef.current = false;
    void refreshSession(session.id)
      .catch(() => {
        // A second connection loss is represented by the global offline state.
      })
      .finally(() => {
        void reconnectActiveTurn(session.id);
      });
  }, [isOffline, isOnline, reconnectActiveTurn, refreshSession]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    abortRef.current?.abort();
  }, []);

  const decideApproval = useCallback(
    async (approval: ApprovalRequest, decision: "approved" | "denied") => {
      if (isOffline) {
        setError("You're offline. Reconnect before responding to an approval.");
        return;
      }
      if (!(belongsToActiveServer() && client && sessionRef.current)) {
        setError("Not connected.");
        return;
      }
      try {
        await client.decideApproval(
          sessionRef.current.id,
          approval.id,
          decision
        );
        if (!belongsToActiveServer()) {
          return;
        }
        setMessages((current) =>
          current.map((message) =>
            message.approval?.id === approval.id
              ? {
                  ...message,
                  approval: {
                    ...message.approval,
                    status: decision === "approved" ? "approved" : "denied",
                  },
                }
              : message
          )
        );
      } catch (caught) {
        if (belongsToActiveServer()) {
          setError(formatError(caught));
        }
      }
    },
    [belongsToActiveServer, client, isOffline]
  );

  const send = useCallback(
    async (input: ChatSendInput) => {
      if (isOffline) {
        setError("You're offline. Reconnect before sending a message.");
        return;
      }
      if (!(belongsToActiveServer() && client)) {
        setError("Not connected.");
        return;
      }

      const trimmed = input.message.trim();
      const attachmentCount =
        (input.images?.length ?? 0) + (input.documents?.length ?? 0);
      if ((!trimmed && attachmentCount === 0) || sendingRef.current) {
        return;
      }

      stoppedRef.current = false;
      sendingRef.current = true;
      setError(null);
      setRelatedQuestions([]);
      setIsSending(true);
      setMessages((current) =>
        appendOutgoingMessages(current, trimmed, attachmentCount)
      );

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        let session = sessionRef.current;
        if (!session) {
          session = await client.createSession("web", { profileId });
          if (!belongsToActiveServer()) {
            return;
          }
          sessionRef.current = session;
          setActiveSessionId(session.id);
          await queryClient.invalidateQueries({
            queryKey: queryKeys.sessions(profileId),
          });
          await queryClient.invalidateQueries({ queryKey: ["sessions-all"] });
        }

        if (!belongsToActiveServer()) {
          return;
        }
        await session.sendStream(
          {
            documents: input.documents,
            images: input.images,
            message: trimmed || "(attachment)",
            relatedQuestions: true,
          },
          handlers(),
          { signal: abort.signal }
        );

        if (!belongsToActiveServer()) {
          return;
        }
        await refreshSession(session.id);
      } catch (caught) {
        if (!belongsToActiveServer()) {
          return;
        }
        if (isAbortError(caught)) {
          setMessages((current) => finalizeStreamingMessages(current));
          const liveSession = sessionRef.current;
          if (!stoppedRef.current && liveSession) {
            queueMicrotask(() => {
              void reconnectRef.current(liveSession.id);
            });
          }
          return;
        }
        setError(formatError(caught));
        setMessages((current) =>
          current.filter((message) => !message.streaming)
        );
      } finally {
        if (belongsToActiveServer()) {
          abortRef.current = null;
          sendingRef.current = false;
          setIsSending(false);
        }
      }
    },
    [
      belongsToActiveServer,
      client,
      handlers,
      isOffline,
      profileId,
      queryClient,
      refreshSession,
    ]
  );

  return {
    activeSessionId,
    decideApproval,
    error,
    isLoading,
    isSending,
    messages,
    relatedQuestions,
    send,
    stop,
    todos,
  };
}

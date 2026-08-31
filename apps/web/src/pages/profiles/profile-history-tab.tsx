import type {
  ListProfileChangeHistoryResponse,
  ProfileChangeEvent,
} from "@atlas/core/contract";
import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/context/use-auth";
import {
  formatSessionRelativeTime,
  formatSessionTimestamp,
} from "@/lib/chat-history";
import { client, formatError } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";
import {
  canViewProfileHistory,
  formatProfileChangeActor,
  formatProfileChangeField,
  formatProfileChangeSource,
  formatProfileChangeValue,
  getNextProfileHistoryOffset,
  mergeProfileHistoryPages,
  PROFILE_HISTORY_PAGE_SIZE,
} from "@/pages/profiles/profile-history.shared";

function HistoryValuePanel({
  event,
  label,
  value,
}: {
  event: ProfileChangeEvent;
  label: "After" | "Before";
  value: string | null;
}) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </h3>
      <pre className="max-h-[45dvh] min-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/35 p-3 font-mono text-xs leading-relaxed">
        {formatProfileChangeValue(value, event.field)}
      </pre>
    </section>
  );
}

function HistoryChangeDialog({
  event,
  onOpenChange,
}: {
  event: ProfileChangeEvent | null;
  onOpenChange: (open: boolean) => void;
}) {
  if (!event) {
    return null;
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100%-1.5rem)] flex-col overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{formatProfileChangeField(event.field)}</DialogTitle>
          <DialogDescription>
            <time
              dateTime={event.createdAt}
              title={formatSessionTimestamp(event.createdAt)}
            >
              {formatSessionRelativeTime(event.createdAt)}
            </time>
            {" · "}
            {formatProfileChangeSource(event.source)}
            {" · "}
            {formatProfileChangeActor(event.actorUserId)}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-4 overflow-y-auto sm:grid-cols-2">
          <HistoryValuePanel
            event={event}
            label="Before"
            value={event.beforeValue}
          />
          <HistoryValuePanel
            event={event}
            label="After"
            value={event.afterValue}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ProfileHistoryTab({ profileId }: { profileId: string }) {
  const { activeOrg, user } = useAuth();
  const canView = canViewProfileHistory({
    isPlatformAdmin: user?.isPlatformAdmin === true,
    orgRole: activeOrg?.role,
  });
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isLoading,
    refetch,
  } = useInfiniteQuery<
    ListProfileChangeHistoryResponse,
    Error,
    InfiniteData<ListProfileChangeHistoryResponse, number>,
    readonly unknown[],
    number
  >({
    enabled: canView,
    getNextPageParam: (_lastPage, pages) => getNextProfileHistoryOffset(pages),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      client.listProfileChangeHistory(profileId, {
        limit: PROFILE_HISTORY_PAGE_SIZE,
        offset: pageParam,
      }),
    queryKey: [...queryKeys.profiles.history(profileId), "pages"],
  });

  if (!canView) {
    return null;
  }

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading history…</p>;
  }

  if (error && !data) {
    return (
      <p className="text-destructive text-sm">
        {formatError(error)}{" "}
        <Button
          className="relative h-auto p-0 after:absolute after:top-1/2 after:left-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2"
          onClick={() => void refetch()}
          type="button"
          variant="link"
        >
          Retry
        </Button>
      </p>
    );
  }

  const events = mergeProfileHistoryPages(data?.pages ?? []);
  if (events.length === 0) {
    return <p className="text-muted-foreground text-sm">No changes yet.</p>;
  }

  const openEvent = events.find((event) => event.id === openEventId) ?? null;

  return (
    <>
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {events.map((event) => (
          <li key={event.id}>
            <button
              aria-haspopup="dialog"
              className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
              onClick={() => setOpenEventId(event.id)}
              type="button"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sm">
                  {formatProfileChangeField(event.field)}
                </span>
                <span className="mt-0.5 block truncate text-muted-foreground text-xs">
                  {formatProfileChangeSource(event.source)}
                  {" · "}
                  <time
                    className="tabular-nums"
                    dateTime={event.createdAt}
                    title={formatSessionTimestamp(event.createdAt)}
                  >
                    {formatSessionRelativeTime(event.createdAt)}
                  </time>
                  {" · "}
                  {formatProfileChangeActor(event.actorUserId)}
                </span>
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">
                View
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hasNextPage ? (
        <div className="mt-3 flex flex-col items-center gap-2">
          {isFetchNextPageError ? (
            <p className="text-destructive text-sm">{formatError(error)}</p>
          ) : null}
          <Button
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            size="sm"
            type="button"
            variant="outline"
          >
            {isFetchingNextPage ? <Spinner className="size-4" /> : null}
            {isFetchNextPageError ? "Retry" : "Load more"}
          </Button>
        </div>
      ) : null}
      <HistoryChangeDialog
        event={openEvent}
        onOpenChange={(open) => {
          if (!open) {
            setOpenEventId(null);
          }
        }}
      />
    </>
  );
}

import type { FileUIPart } from "ai";
import { nanoid } from "nanoid";
import type { ChangeEventHandler, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttachmentCapacityTracker } from "@/components/ai-elements/attachment-capacity";
import type {
  AttachmentsContext,
  PromptInputControllerProps,
} from "@/components/ai-elements/prompt-input-context";
import { useOptionalPromptInputController } from "@/components/ai-elements/prompt-input-context";

type FileErrorCode =
  | "accept"
  | "file_read"
  | "max_files"
  | "max_file_size"
  | "processing";

export type UsePromptInputFileStateOptions = {
  accept?: string;
  globalDrop?: boolean;
  syncHiddenInput?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  prepareFiles?: (files: File[]) => File[] | Promise<File[]>;
  onError?: (err: { code: FileErrorCode; message: string }) => void;
};

export type UsePromptInputFileStateResult = {
  usingProvider: boolean;
  controller: PromptInputControllerProps | null;
  files: (FileUIPart & { id: string })[];
  inputRef: RefObject<HTMLInputElement | null>;
  formRef: RefObject<HTMLFormElement | null>;
  add: (fileList: File[] | FileList) => Promise<void>;
  remove: (id: string) => void;
  clearAttachments: () => void;
  clear: () => void;
  openFileDialog: () => void;
  handleChange: ChangeEventHandler<HTMLInputElement>;
  attachmentsCtx: AttachmentsContext;
};

export function usePromptInputFileState({
  accept,
  globalDrop,
  syncHiddenInput,
  maxFiles,
  maxFileSize,
  prepareFiles,
  onError,
}: UsePromptInputFileStateOptions): UsePromptInputFileStateResult {
  const controller = useOptionalPromptInputController();
  const usingProvider = !!controller;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const [items, setItems] = useState<(FileUIPart & { id: string })[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const files = usingProvider ? controller.attachments.files : items;

  const filesRef = useRef(files);
  const capacityTrackerRef = useRef<AttachmentCapacityTracker | null>(null);
  if (!capacityTrackerRef.current) {
    capacityTrackerRef.current = new AttachmentCapacityTracker(files.length);
  }
  const capacityTracker = capacityTrackerRef.current;

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const openFileDialogLocal = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const matchesAccept = useCallback(
    (f: File) => {
      if (!accept || accept.trim() === "") {
        return true;
      }

      const fileType = f.type.split(";")[0]?.trim().toLowerCase() ?? "";
      const fileName = f.name.toLowerCase();
      const patterns = accept
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      return patterns.some((pattern) => {
        const normalizedPattern = pattern.toLowerCase();

        if (pattern.endsWith("/*")) {
          const prefix = pattern.slice(0, -1);
          return fileType.startsWith(prefix);
        }

        if (pattern.startsWith(".")) {
          return fileName.endsWith(normalizedPattern);
        }

        return fileType === normalizedPattern;
      });
    },
    [accept]
  );

  const removeLocal = useCallback(
    (id: string) =>
      setItems((prev) => {
        const found = prev.find((file) => file.id === id);
        if (found?.url) {
          URL.revokeObjectURL(found.url);
        }
        return prev.filter((file) => file.id !== id);
      }),
    []
  );

  const add = useCallback(
    async (fileList: File[] | FileList): Promise<void> => {
      const incoming = [...fileList];
      const acceptedByType = incoming.filter((file) => matchesAccept(file));
      const rejectedTypeCount = incoming.length - acceptedByType.length;

      if (rejectedTypeCount > 0) {
        onError?.({
          code: "accept",
          message: `${rejectedTypeCount} file${rejectedTypeCount === 1 ? "" : "s"} did not match the accepted types.`,
        });
      }
      if (acceptedByType.length === 0) {
        return;
      }

      const { overflowCount, reservation } = capacityTracker.reserve(
        acceptedByType.length,
        maxFiles
      );
      if (overflowCount > 0) {
        onError?.({
          code: "max_files",
          message: `${overflowCount} file${overflowCount === 1 ? " was" : "s were"} not added because the attachment limit was reached.`,
        });
      }
      if (!reservation) {
        return;
      }

      const candidates = acceptedByType.slice(0, reservation.count);
      setPendingCount(capacityTracker.pendingCount);

      try {
        const prepared = prepareFiles
          ? await prepareFiles(candidates)
          : candidates;
        if (!capacityTracker.isActive(reservation)) {
          return;
        }

        const acceptedAfterPreparation = prepared
          .slice(0, reservation.count)
          .filter((file) => matchesAccept(file));
        const sized = acceptedAfterPreparation.filter((file) =>
          maxFileSize ? file.size <= maxFileSize : true
        );
        const rejectedSizeCount =
          acceptedAfterPreparation.length - sized.length;
        if (rejectedSizeCount > 0) {
          onError?.({
            code: "max_file_size",
            message: `${rejectedSizeCount} file${rejectedSizeCount === 1 ? "" : "s"} exceeded the maximum size.`,
          });
        }
        if (sized.length === 0) {
          return;
        }

        if (usingProvider) {
          await controller.attachments.add(sized);
        } else {
          const next = sized.map((file) => ({
            filename: file.name,
            id: nanoid(),
            mediaType: file.type,
            type: "file" as const,
            url: URL.createObjectURL(file),
          }));
          setItems((previous) => [...previous, ...next]);
        }

        capacityTracker.commit(reservation, sized.length);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          onError?.({
            code: "file_read",
            message:
              error instanceof Error
                ? error.message
                : "Could not process the selected files.",
          });
        }
      } finally {
        capacityTracker.release(reservation);
        setPendingCount(capacityTracker.pendingCount);
      }
    },
    [
      capacityTracker,
      controller,
      matchesAccept,
      maxFileSize,
      maxFiles,
      onError,
      prepareFiles,
      usingProvider,
    ]
  );

  const clearAttachments = useCallback(() => {
    capacityTracker.clear();
    setPendingCount(0);
    if (usingProvider) {
      controller?.attachments.clear();
    } else {
      setItems((prev) => {
        for (const file of prev) {
          if (file.url) {
            URL.revokeObjectURL(file.url);
          }
        }
        return [];
      });
    }
  }, [capacityTracker, usingProvider, controller]);

  const remove = useCallback(
    (id: string) => {
      if (filesRef.current.some((file) => file.id === id)) {
        capacityTracker.removeCommitted();
      }
      if (usingProvider) {
        controller.attachments.remove(id);
      } else {
        removeLocal(id);
      }
    },
    [capacityTracker, controller, removeLocal, usingProvider]
  );
  const openFileDialog = usingProvider
    ? controller.attachments.openFileDialog
    : openFileDialogLocal;

  const clear = useCallback(() => {
    clearAttachments();
  }, [clearAttachments]);

  useEffect(() => {
    if (!usingProvider) {
      return;
    }
    controller.__registerFileInput(inputRef, () => inputRef.current?.click());
  }, [usingProvider, controller]);

  useEffect(() => {
    if (syncHiddenInput && inputRef.current && files.length === 0) {
      inputRef.current.value = "";
    }
  }, [files, syncHiddenInput]);

  useEffect(() => {
    const form = formRef.current;
    if (!form) {
      return;
    }
    if (globalDrop) {
      return;
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        void add(e.dataTransfer.files);
      }
    };
    form.addEventListener("dragover", onDragOver);
    form.addEventListener("drop", onDrop);
    return () => {
      form.removeEventListener("dragover", onDragOver);
      form.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  useEffect(() => {
    if (!globalDrop) {
      return;
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        void add(e.dataTransfer.files);
      }
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  useEffect(
    () => () => {
      if (!usingProvider) {
        for (const f of filesRef.current) {
          if (f.url) {
            URL.revokeObjectURL(f.url);
          }
        }
      }
    },
    [usingProvider]
  );

  const handleChange: ChangeEventHandler<HTMLInputElement> = useCallback(
    (event) => {
      if (event.currentTarget.files) {
        void add(event.currentTarget.files);
      }
      event.currentTarget.value = "";
    },
    [add]
  );

  const attachmentsCtx = useMemo<AttachmentsContext>(
    () => ({
      add,
      clear: clearAttachments,
      fileInputRef: inputRef,
      files: files.map((item) => ({ ...item, id: item.id })),
      openFileDialog,
      pendingCount,
      remove,
    }),
    [files, add, remove, clearAttachments, openFileDialog, pendingCount]
  );

  return {
    add,
    attachmentsCtx,
    clear,
    clearAttachments,
    controller,
    files,
    formRef,
    handleChange,
    inputRef,
    openFileDialog,
    remove,
    usingProvider,
  };
}

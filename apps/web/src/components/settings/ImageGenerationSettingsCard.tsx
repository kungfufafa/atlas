import { useEffect, useMemo, useState } from "react";
import { SettingsModelTile } from "@/components/settings/settings-model-tile";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useModelsQuery } from "@/hooks/use-app-queries";
import {
  useImageGenerationSettings,
  useSaveImageGenerationSettings,
} from "@/hooks/use-image-generation-settings";
import { formatError } from "@/lib/client";
import {
  encodeModelSelection,
  GEMINI_IMAGE_GENERATION_MODEL_OPTIONS,
  groupModelsByProvider,
  OPENAI_IMAGE_GENERATION_MODEL_OPTIONS,
  profileModelLabel,
  profileModelSelectionValue,
} from "@/lib/models";

const CLEAR_IMAGE_GENERATION_MODEL_VALUE = "__image_generation_unset__";

export function ImageGenerationSettingsCard() {
  const [formError, setFormError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string>("");
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const { data: modelsResponse } = useModelsQuery();
  const { data: imageGenerationSettings } = useImageGenerationSettings();
  const saveImageGenerationMutation = useSaveImageGenerationSettings();

  const providerModelGroups = useMemo(
    () => groupModelsByProvider(modelsResponse?.models ?? []),
    [modelsResponse?.models]
  );

  const imageModelGroups = useMemo(() => {
    const groups: typeof providerModelGroups = [];

    for (const group of providerModelGroups) {
      if (group.models.some((model) => model.provider === "openai")) {
        groups.push({
          ...group,
          models: OPENAI_IMAGE_GENERATION_MODEL_OPTIONS.map((option) => ({
            id: option.id,
            name: option.name,
            provider: "openai" as const,
          })),
        });
      } else if (group.models.some((model) => model.provider === "gemini")) {
        groups.push({
          ...group,
          models: GEMINI_IMAGE_GENERATION_MODEL_OPTIONS.map((option) => ({
            id: option.id,
            name: option.name,
            provider: "gemini" as const,
          })),
        });
      } else if (
        group.models.some(
          (model) =>
            model.provider === "openai_compatible" ||
            model.provider === "openrouter" ||
            model.provider === "fireworks"
        )
      ) {
        groups.push({
          ...group,
          models: group.models.map((m) => ({
            id: m.id,
            name: m.name,
            provider: m.provider,
          })),
        });
      }
    }

    return groups;
  }, [providerModelGroups]);

  const imageUnavailable = imageModelGroups.length === 0;

  const selectionValue = useMemo(() => {
    if (!selection) {
      return CLEAR_IMAGE_GENERATION_MODEL_VALUE;
    }

    return (
      profileModelSelectionValue(selection, imageModelGroups) ||
      CLEAR_IMAGE_GENERATION_MODEL_VALUE
    );
  }, [selection, imageModelGroups]);

  useEffect(() => {
    setSelection(imageGenerationSettings?.model ?? "");
  }, [imageGenerationSettings?.model]);

  useEffect(() => {
    if (!savedHint) {
      return;
    }

    const timeout = window.setTimeout(() => setSavedHint(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [savedHint]);

  return (
    <SettingsModelTile
      footer={
        savedHint || formError ? (
          <>
            {savedHint ? (
              <p
                className="text-emerald-700 text-xs dark:text-emerald-300"
                role="status"
              >
                {savedHint}
              </p>
            ) : null}
            {formError ? (
              <p className="text-destructive text-xs" role="alert">
                {formError}
              </p>
            ) : null}
          </>
        ) : undefined
      }
      title="Image generation model"
    >
      <Select
        disabled={saveImageGenerationMutation.isPending || imageUnavailable}
        onValueChange={(value) => {
          if (!value) {
            return;
          }

          const model =
            value === CLEAR_IMAGE_GENERATION_MODEL_VALUE ? null : String(value);

          setFormError(null);
          setSelection(model ?? "");
          setSavedHint(null);

          saveImageGenerationMutation.mutate(model, {
            onError: (error) => {
              setSelection(imageGenerationSettings?.model ?? "");
              setFormError(formatError(error));
            },
            onSuccess: (saved) => {
              setSelection(saved.model ?? "");
              setSavedHint(
                saved.model
                  ? `Saved · ${profileModelLabel(saved.model, imageModelGroups)}`
                  : "Cleared"
              );
            },
          });
        }}
        value={selectionValue}
      >
        <SelectTrigger
          aria-label="Image generation model"
          className="h-9 w-full"
        >
          <SelectValue placeholder="Select image generation model">
            {selection
              ? profileModelLabel(selection, imageModelGroups)
              : imageUnavailable
                ? "No image providers"
                : "Not configured"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent
          alignItemWithTrigger={false}
          className="w-max min-w-72 max-w-[min(24rem,92vw)]"
        >
          <SelectItem value={CLEAR_IMAGE_GENERATION_MODEL_VALUE}>
            Not configured
          </SelectItem>
          {imageModelGroups.flatMap((group) =>
            group.models.map((model) => (
              <SelectItem
                key={`${group.providerId}:${model.id}`}
                value={encodeModelSelection(group.providerId, model.id)}
              >
                {group.providerLabel}: {model.name}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </SettingsModelTile>
  );
}

import type {
  CapabilityCatalogEntry,
  CapabilityTargetOption,
} from "@atlas/core/contract";
import type { CapabilityBindingV1 } from "@atlas/core/provider-capabilities";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
} from "hugeicons-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  useCapabilityCatalog,
  useCapabilityMappings,
  useCapabilityOptions,
  useSaveCapabilityMapping,
} from "@/hooks/use-capability-routing";
import {
  buildCapabilityBinding,
  capabilityBindingSelections,
  DISABLED_CAPABILITY_SELECTION,
  encodeCapabilityTarget,
  NO_PRIMARY_CAPABILITY_SELECTION,
} from "@/lib/capability-routing";
import { formatError } from "@/lib/client";

interface CapabilityRouteEditorProps {
  binding: CapabilityBindingV1 | undefined;
  capability: CapabilityCatalogEntry;
  onSave: (capabilityId: string, binding: CapabilityBindingV1) => Promise<void>;
  options: CapabilityTargetOption[];
  saving: boolean;
}

interface TargetSelectProps {
  ariaLabel: string;
  blockedSelections: ReadonlySet<string>;
  disabled?: boolean;
  id?: string;
  includeDisabledChoice?: boolean;
  includeNoPrimaryChoice?: boolean;
  onValueChange: (value: string) => void;
  options: CapabilityTargetOption[];
  placeholder: string;
  value: string;
}

export function CapabilityRoutingCard() {
  const catalogQuery = useCapabilityCatalog();
  const mappingsQuery = useCapabilityMappings();
  const optionsQuery = useCapabilityOptions();
  const saveMutation = useSaveCapabilityMapping();
  const loading =
    catalogQuery.isLoading || mappingsQuery.isLoading || optionsQuery.isLoading;
  const queryError =
    catalogQuery.error ?? mappingsQuery.error ?? optionsQuery.error;

  const capabilities = useMemo(
    () =>
      (catalogQuery.data?.capabilities ?? []).filter(
        (capability) => capability.routable
      ),
    [catalogQuery.data?.capabilities]
  );

  if (loading) {
    return <CapabilityRoutingSkeleton />;
  }

  return (
    <Card className="w-full shadow-none">
      <CardHeader className="border-border border-b px-4 py-3">
        <div className="space-y-0.5">
          <CardTitle className="font-medium text-sm leading-snug tracking-normal">
            Capability routing
          </CardTitle>
          <CardDescription className="text-xs leading-snug">
            Fallbacks are checked only before a request is sent. Provider errors
            are not retried on another model.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="divide-y divide-border p-0">
        {queryError ? (
          <p className="px-4 py-3 text-destructive text-sm" role="alert">
            {formatError(queryError)}
          </p>
        ) : null}
        {capabilities.length === 0 && !queryError ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            No configurable capabilities are installed.
          </p>
        ) : null}
        {capabilities.map((capability) => (
          <CapabilityRouteEditor
            binding={mappingsQuery.data?.config.bindings[capability.id]}
            capability={capability}
            key={capability.id}
            onSave={async (capabilityId, binding) => {
              await saveMutation.mutateAsync({ binding, capabilityId });
            }}
            options={(optionsQuery.data?.options ?? []).filter(
              (option) => option.capabilityId === capability.id
            )}
            saving={
              saveMutation.isPending &&
              saveMutation.variables?.capabilityId === capability.id
            }
          />
        ))}
      </CardContent>
    </Card>
  );
}

function CapabilityRouteEditor({
  binding,
  capability,
  onSave,
  options,
  saving,
}: CapabilityRouteEditorProps) {
  const initial = capabilityBindingSelections(binding);
  const [primary, setPrimary] = useState(initial.primary);
  const [fallbacks, setFallbacks] = useState(initial.fallbacks);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const sortedOptions = useMemo(
    () =>
      [...options].sort(
        (left, right) =>
          left.providerLabel.localeCompare(right.providerLabel) ||
          left.modelName.localeCompare(right.modelName)
      ),
    [options]
  );
  const usedSelections = useMemo(
    () => new Set([primary, ...fallbacks]),
    [fallbacks, primary]
  );
  const canAddFallback = sortedOptions.some((option) => {
    const selection = optionSelection(option);
    return option.effective.selectable && !usedSelections.has(selection);
  });

  useEffect(() => {
    const next = capabilityBindingSelections(binding);
    setPrimary(next.primary);
    setFallbacks(next.fallbacks);
  }, [binding]);

  useEffect(() => {
    if (!saved) {
      return;
    }
    const timeout = window.setTimeout(() => setSaved(false), 2500);
    return () => window.clearTimeout(timeout);
  }, [saved]);

  const save = async () => {
    setFormError(null);
    setSaved(false);
    try {
      await onSave(capability.id, buildCapabilityBinding(primary, fallbacks));
      setSaved(true);
    } catch (error) {
      setFormError(formatError(error));
    }
  };

  return (
    <section className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-foreground text-sm">
            {capability.label}
          </h3>
          {saved ? (
            <p
              className="text-emerald-700 text-xs dark:text-emerald-300"
              role="status"
            >
              Saved
            </p>
          ) : null}
          {formError ? (
            <p className="text-destructive text-xs" role="alert">
              {formError}
            </p>
          ) : null}
        </div>
        <Button disabled={saving} onClick={save} size="sm" type="button">
          {saving ? (
            <>
              <Spinner className="mr-2" />
              Saving…
            </>
          ) : (
            "Save"
          )}
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center">
        <label
          className="font-medium text-muted-foreground text-xs"
          htmlFor={`${capability.id}-primary`}
        >
          Primary model
        </label>
        <TargetSelect
          ariaLabel={`${capability.label} primary model`}
          blockedSelections={new Set(fallbacks)}
          id={`${capability.id}-primary`}
          includeDisabledChoice
          includeNoPrimaryChoice
          onValueChange={(value) => {
            setSaved(false);
            setFormError(null);
            setPrimary(value);
            setFallbacks((current) =>
              value === DISABLED_CAPABILITY_SELECTION
                ? []
                : current.filter((selection) => selection !== value)
            );
          }}
          options={sortedOptions}
          placeholder="Select primary model"
          value={primary}
        />
      </div>

      {fallbacks.map((fallback, index) => {
        const blocked = new Set([primary, ...fallbacks]);
        blocked.delete(fallback);
        return (
          <div
            className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-center"
            key={`${capability.id}-fallback-${index + 1}`}
          >
            <span className="font-medium text-muted-foreground text-xs">
              Fallback {index + 1}
            </span>
            <TargetSelect
              ariaLabel={`${capability.label} fallback ${index + 1}`}
              blockedSelections={blocked}
              id={`${capability.id}-fallback-${index + 1}`}
              onValueChange={(value) => {
                setSaved(false);
                setFormError(null);
                setFallbacks((current) =>
                  current.map((selection, itemIndex) =>
                    itemIndex === index ? value : selection
                  )
                );
              }}
              options={sortedOptions}
              placeholder="Select fallback model"
              value={fallback}
            />
            <div className="flex items-center gap-1">
              <Button
                aria-label={`Move fallback ${index + 1} up`}
                disabled={index === 0 || saving}
                onClick={() => {
                  setFallbacks((current) =>
                    moveItem(current, index, index - 1)
                  );
                  setSaved(false);
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <ArrowUp01Icon aria-hidden className="size-4" />
              </Button>
              <Button
                aria-label={`Move fallback ${index + 1} down`}
                disabled={index === fallbacks.length - 1 || saving}
                onClick={() => {
                  setFallbacks((current) =>
                    moveItem(current, index, index + 1)
                  );
                  setSaved(false);
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <ArrowDown01Icon aria-hidden className="size-4" />
              </Button>
              <Button
                aria-label={`Remove fallback ${index + 1}`}
                disabled={saving}
                onClick={() => {
                  setFallbacks((current) =>
                    current.filter((_, itemIndex) => itemIndex !== index)
                  );
                  setSaved(false);
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Delete02Icon aria-hidden className="size-4" />
              </Button>
            </div>
          </div>
        );
      })}

      <Button
        disabled={
          saving || primary === DISABLED_CAPABILITY_SELECTION || !canAddFallback
        }
        onClick={() => {
          const next = sortedOptions.find((option) => {
            const selection = optionSelection(option);
            return (
              option.effective.selectable && !usedSelections.has(selection)
            );
          });
          if (next) {
            setFallbacks((current) => [...current, optionSelection(next)]);
            setSaved(false);
          }
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        <Add01Icon aria-hidden className="mr-1.5 size-4" />
        Add fallback
      </Button>

      {sortedOptions.every((option) => !option.effective.selectable) ? (
        <p className="text-muted-foreground text-xs">
          No eligible models. Connect a provider with verified support.
        </p>
      ) : null}
    </section>
  );
}

function TargetSelect({
  ariaLabel,
  blockedSelections,
  disabled = false,
  id,
  includeDisabledChoice = false,
  includeNoPrimaryChoice = false,
  onValueChange,
  options,
  placeholder,
  value,
}: TargetSelectProps) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        if (next) {
          onValueChange(String(next));
        }
      }}
      value={value}
    >
      <SelectTrigger aria-label={ariaLabel} className="h-9 w-full" id={id}>
        <SelectValue placeholder={placeholder}>
          {selectionLabel(value, options, includeDisabledChoice)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        className="w-max min-w-72 max-w-[min(28rem,92vw)]"
      >
        {includeDisabledChoice ? (
          <SelectItem value={DISABLED_CAPABILITY_SELECTION}>
            Disabled
          </SelectItem>
        ) : null}
        {includeNoPrimaryChoice ? (
          <SelectItem value={NO_PRIMARY_CAPABILITY_SELECTION}>
            No primary (fallbacks only)
          </SelectItem>
        ) : null}
        {options.map((option) => {
          const selection = optionSelection(option);
          const unavailable = !option.effective.selectable;
          return (
            <SelectItem
              disabled={unavailable || blockedSelections.has(selection)}
              key={`${option.capabilityId}:${selection}`}
              value={selection}
            >
              {optionLabel(option)}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function optionSelection(option: CapabilityTargetOption): string {
  return encodeCapabilityTarget({
    modelId: option.modelId,
    providerId: option.providerId,
  });
}

function optionLabel(option: CapabilityTargetOption): string {
  const base = `${option.providerLabel}: ${option.modelName}`;
  if (option.effective.selectable) {
    return base;
  }
  return `${base} — ${unavailableReason(option)}`;
}

function unavailableReason(option: CapabilityTargetOption): string {
  if (option.effective.reasons.includes("credentials-missing")) {
    return "credentials missing";
  }
  if (option.effective.reasons.includes("handler-missing")) {
    return "Atlas adapter unavailable";
  }
  if (option.effective.reasons.includes("model-unsupported")) {
    return "unsupported";
  }
  if (option.effective.reasons.includes("model-unknown")) {
    return "support not verified";
  }
  return "unavailable";
}

function selectionLabel(
  selection: string,
  options: CapabilityTargetOption[],
  includeDisabledChoice: boolean
): string {
  if (includeDisabledChoice && selection === DISABLED_CAPABILITY_SELECTION) {
    return "Disabled";
  }
  if (selection === NO_PRIMARY_CAPABILITY_SELECTION) {
    return "No primary (fallbacks only)";
  }
  const option = options.find(
    (candidate) => optionSelection(candidate) === selection
  );
  return option ? optionLabel(option) : "Select model";
}

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) {
    next.splice(to, 0, item);
  }
  return next;
}

function CapabilityRoutingSkeleton() {
  return (
    <Card aria-hidden className="w-full animate-pulse shadow-none">
      <CardContent className="space-y-4 p-4">
        <div className="h-4 w-36 rounded bg-muted" />
        <div className="h-9 w-full rounded bg-muted" />
        <div className="h-9 w-full rounded bg-muted" />
        <div className="h-9 w-full rounded bg-muted" />
      </CardContent>
    </Card>
  );
}

import type { ApprovalRequest } from "@atlas/core/contract";
import { useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

function ApprovalCard({
  approval,
  onDecide,
  readOnly,
}: {
  approval: ApprovalRequest;
  onDecide: (
    approval: ApprovalRequest,
    decision: "approved" | "denied"
  ) => Promise<void>;
  readOnly?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const pending = approval.status === "pending" && !readOnly;

  const decide = (decision: "approved" | "denied") => {
    if (busy || !pending) {
      return;
    }
    setBusy(true);
    void onDecide(approval, decision).finally(() => {
      setBusy(false);
    });
  };

  return (
    <View className="gap-2 border-amber-500/30 border-b bg-amber-500/10 px-4 py-3">
      <Text className="font-medium">{approval.title}</Text>
      {approval.consequenceSummary ? (
        <Text className="text-muted-foreground text-sm">
          {approval.consequenceSummary}
        </Text>
      ) : null}
      {pending ? (
        <View className="flex-row gap-2">
          <Button
            className="flex-1"
            disabled={busy}
            onPress={() => decide("approved")}
          >
            <Text>Confirm</Text>
          </Button>
          <Button
            className="flex-1"
            disabled={busy}
            onPress={() => decide("denied")}
            variant="outline"
          >
            <Text>Deny</Text>
          </Button>
        </View>
      ) : (
        <Text className="text-muted-foreground text-sm">{approval.status}</Text>
      )}
    </View>
  );
}

export { ApprovalCard };

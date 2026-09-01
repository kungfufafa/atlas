import type { ProfileSummary } from "@atlas/core/contract";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

function ProfileSelector({
  disabled = false,
  onSelect,
  profiles,
  selectedProfileId,
}: {
  disabled?: boolean;
  onSelect: (profileId: string) => void;
  profiles: readonly Pick<ProfileSummary, "id" | "isDefault" | "name">[];
  selectedProfileId: string | null;
}) {
  if (profiles.length === 0) {
    return null;
  }

  return (
    <View className="border-border border-b py-3">
      <Text className="mb-2 px-4 font-heading text-sm">Profile</Text>
      <ScrollView
        contentContainerClassName="gap-2 px-4"
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        <View accessibilityRole="radiogroup" className="flex-row gap-2">
          {profiles.map((profile) => {
            const selected = profile.id === selectedProfileId;
            return (
              <Pressable
                accessibilityLabel={
                  profile.isDefault
                    ? `${profile.name}, default profile`
                    : profile.name
                }
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled }}
                className={cn(
                  "min-h-11 justify-center rounded-full border border-border px-3",
                  selected && "border-foreground bg-accent"
                )}
                disabled={disabled}
                key={profile.id}
                onPress={() => onSelect(profile.id)}
              >
                <Text className="text-sm">{profile.name}</Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

export { ProfileSelector };

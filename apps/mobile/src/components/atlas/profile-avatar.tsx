import type { ProfileSummary } from "@atlas/core/contract";
import { Image } from "expo-image";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import { useAtlasQuery, useServerQueryClient } from "@/hooks/use-atlas-query";
import { arrayBufferToAvatarUri } from "@/lib/profile-avatar";
import { queryKeys } from "@/lib/query-keys";

type AvatarProfile = Pick<
  ProfileSummary,
  "hasAvatar" | "id" | "isSuper" | "name" | "updatedAt"
>;

const FALLBACK_AVATARS = {
  default: require("../../../assets/images/avatars/default-agent.png"),
  super: require("../../../assets/images/avatars/super-agent.png"),
};

const AVATAR_SIZES = {
  lg: 64,
  md: 48,
  sm: 36,
  xl: 88,
} as const;

const AVATAR_CACHE_GC_MS = 2 * 60 * 1000;

function fallbackAvatar(profile: AvatarProfile) {
  if (profile.isSuper) {
    return FALLBACK_AVATARS.super;
  }
  return FALLBACK_AVATARS.default;
}

export function ProfileAvatar({
  profile,
  size = "md",
}: {
  profile: AvatarProfile;
  size?: keyof typeof AVATAR_SIZES;
}) {
  const pixels = AVATAR_SIZES[size];
  const queryClient = useServerQueryClient();
  const avatarQuery = useAtlasQuery(
    queryKeys.profileAvatar(profile.id),
    async (client) => {
      const cacheKey = `${profile.updatedAt}-${Date.now()}`;
      const response = await client.getProfileAvatar(profile.id, cacheKey);
      return {
        revision: profile.updatedAt,
        uri: arrayBufferToAvatarUri(response.data, response.contentType),
      };
    },
    {
      enabled: profile.hasAvatar,
      gcTime: AVATAR_CACHE_GC_MS,
      staleTime: Number.POSITIVE_INFINITY,
    }
  );
  const refreshingRevisionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!profile.hasAvatar) {
      refreshingRevisionRef.current = null;
      queryClient.removeQueries({
        queryKey: queryKeys.profileAvatar(profile.id),
      });
      return;
    }
    if (
      !avatarQuery.data ||
      avatarQuery.data.revision === profile.updatedAt ||
      refreshingRevisionRef.current === profile.updatedAt
    ) {
      return;
    }

    const revision = profile.updatedAt;
    refreshingRevisionRef.current = revision;
    void (async () => {
      try {
        await avatarQuery.refetch();
      } finally {
        if (refreshingRevisionRef.current === revision) {
          refreshingRevisionRef.current = null;
        }
      }
    })();
  }, [
    avatarQuery.data,
    avatarQuery.refetch,
    profile.hasAvatar,
    profile.id,
    profile.updatedAt,
    queryClient,
  ]);

  const uploadedAvatarUri = profile.hasAvatar
    ? (avatarQuery.data?.uri ?? null)
    : null;

  return (
    <View
      accessibilityLabel={`${profile.name} profile photo`}
      accessibilityRole="image"
      accessible
      className="shrink-0 overflow-hidden rounded-full border border-border bg-muted"
      style={{ height: pixels, width: pixels }}
    >
      <Image
        contentFit="cover"
        recyclingKey={`${profile.id}-fallback-${profile.isSuper ? "super" : "default"}`}
        source={fallbackAvatar(profile)}
        style={{ height: pixels, width: pixels }}
      />
      {uploadedAvatarUri ? (
        <Image
          contentFit="cover"
          recyclingKey={`${profile.id}-uploaded`}
          source={{ uri: uploadedAvatarUri }}
          style={{
            height: pixels,
            left: 0,
            position: "absolute",
            top: 0,
            width: pixels,
          }}
          transition={160}
        />
      ) : null}
    </View>
  );
}

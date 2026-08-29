import { atlasColors } from "@atlas/design-tokens";
import { EyeIcon, EyeOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { type ComponentPropsWithoutRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useAppTheme } from "@/features/theme/theme-provider";
import { cn } from "@/lib/utils";
import { Input } from "./input";

type PasswordInputProps = Omit<
  ComponentPropsWithoutRef<typeof Input>,
  "secureTextEntry"
>;

function PasswordInput({ className, ...props }: PasswordInputProps) {
  const [isVisible, setIsVisible] = useState(false);
  const { resolved } = useAppTheme();
  const color = atlasColors[resolved].mutedForeground;

  return (
    <View className="relative">
      <Input
        {...props}
        className={cn("pr-12", className)}
        secureTextEntry={!isVisible}
      />
      <Pressable
        accessibilityLabel={isVisible ? "Hide password" : "Show password"}
        accessibilityRole="button"
        className="absolute top-0 right-0 h-10 native:h-12 w-11 items-center justify-center rounded-r-lg web:focus-visible:outline-none web:focus-visible:ring-2 web:focus-visible:ring-ring"
        disabled={props.editable === false}
        hitSlop={8}
        onPress={() => setIsVisible((visible) => !visible)}
      >
        <HugeiconsIcon
          color={color}
          icon={isVisible ? EyeOffIcon : EyeIcon}
          size={20}
        />
      </Pressable>
    </View>
  );
}

export { PasswordInput };

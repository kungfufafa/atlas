import type * as React from "react";
import { Text } from "react-native";
import { cn } from "@/lib/utils";

function Label({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof Text>) {
  return (
    <Text
      className={cn(
        "font-medium native:text-base text-foreground text-sm",
        className
      )}
      {...props}
    />
  );
}

export { Label };

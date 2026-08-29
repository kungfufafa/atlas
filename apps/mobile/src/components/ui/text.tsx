import * as Slot from "@rn-primitives/slot";
import type { SlottableTextProps, TextRef } from "@rn-primitives/types";
import * as React from "react";
import { Text as RNText } from "react-native";
import { cn } from "@/lib/utils";

const TextClassContext = React.createContext<string | undefined>(undefined);

const Text = React.forwardRef<TextRef, SlottableTextProps>(
  ({ asChild = false, className, ...props }, ref) => {
    const textClass = React.useContext(TextClassContext);
    const Component = asChild ? Slot.Text : RNText;
    return (
      <Component
        className={cn(
          "web:select-text font-sans text-base text-foreground leading-5",
          textClass,
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Text.displayName = "Text";

export { Text, TextClassContext };

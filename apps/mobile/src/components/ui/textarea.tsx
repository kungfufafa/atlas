import * as React from "react";
import { TextInput } from "react-native";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  React.ElementRef<typeof TextInput>,
  React.ComponentPropsWithoutRef<typeof TextInput>
>(({ className, placeholderClassName, ...props }, ref) => (
  <TextInput
    className={cn(
      "min-h-[44px] rounded-lg border border-input bg-background px-3 py-2 native:text-base text-foreground placeholder:text-muted-foreground",
      props.editable === false && "opacity-50",
      className
    )}
    multiline
    placeholderClassName={cn("text-muted-foreground", placeholderClassName)}
    ref={ref}
    textAlignVertical="top"
    {...props}
  />
));
Textarea.displayName = "Textarea";

export { Textarea };

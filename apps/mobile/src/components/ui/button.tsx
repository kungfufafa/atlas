import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Pressable } from "react-native";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group flex items-center justify-center rounded-lg web:ring-offset-background web:transition-colors web:focus-visible:outline-none web:focus-visible:ring-2 web:focus-visible:ring-ring web:focus-visible:ring-offset-2",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-10 native:h-12 native:px-5 px-4 py-2",
        icon: "h-10 native:h-12 native:w-12 w-10",
        lg: "h-11 native:h-14 native:px-8 px-8",
        sm: "h-9 native:h-10 native:px-4 px-3",
      },
      variant: {
        default: "bg-primary web:hover:opacity-90 active:opacity-90",
        destructive: "bg-destructive web:hover:opacity-90 active:opacity-90",
        ghost:
          "web:hover:bg-accent web:hover:text-accent-foreground active:bg-accent",
        outline:
          "border border-input bg-background web:hover:bg-accent web:hover:text-accent-foreground active:bg-accent",
        secondary: "bg-secondary web:hover:opacity-80 active:opacity-80",
      },
    },
  }
);

const buttonTextVariants = cva(
  "web:pointer-events-none web:whitespace-nowrap font-medium native:text-base text-sm",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "",
        icon: "",
        lg: "native:text-lg",
        sm: "",
      },
      variant: {
        default: "text-primary-foreground",
        destructive: "text-destructive-foreground",
        ghost: "group-active:text-accent-foreground",
        outline: "group-active:text-accent-foreground",
        secondary:
          "text-secondary-foreground group-active:text-secondary-foreground",
      },
    },
  }
);

type ButtonProps = React.ComponentPropsWithoutRef<typeof Pressable> &
  VariantProps<typeof buttonVariants>;

const Button = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  ButtonProps
>(({ className, size, variant, ...props }, ref) => (
  <TextClassContext.Provider
    value={buttonTextVariants({
      className: "web:pointer-events-none",
      size,
      variant,
    })}
  >
    <Pressable
      className={cn(
        props.disabled && "web:pointer-events-none opacity-50",
        buttonVariants({ className, size, variant })
      )}
      ref={ref}
      role="button"
      {...props}
    />
  </TextClassContext.Provider>
));
Button.displayName = "Button";

export type { ButtonProps };
export { Button, buttonTextVariants, buttonVariants };

import { ViewIcon, ViewOffIcon } from "hugeicons-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function PasswordInput({
  className,
  disabled,
  ...props
}: React.ComponentProps<typeof Input>) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="relative flex items-center">
      <Input
        className={cn("pr-9", className)}
        disabled={disabled}
        type={showPassword ? "text" : "password"}
        {...props}
      />
      <Button
        aria-label={showPassword ? "Hide password" : "Show password"}
        className="absolute right-1 text-muted-foreground hover:text-foreground"
        disabled={disabled}
        onClick={() => setShowPassword((prev) => !prev)}
        size="icon-xs"
        tabIndex={-1}
        type="button"
        variant="ghost"
      >
        {showPassword ? (
          <ViewOffIcon className="size-4" />
        ) : (
          <ViewIcon className="size-4" />
        )}
      </Button>
    </div>
  );
}

export { PasswordInput };

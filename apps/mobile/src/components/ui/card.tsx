import { Text, type TextProps, View, type ViewProps } from "react-native";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

function Card({ className, ...props }: ViewProps) {
  return (
    <View
      className={cn(
        "rounded-xl border border-border bg-card shadow-foreground/10 shadow-sm",
        className
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ViewProps) {
  return <View className={cn("gap-1.5 p-4", className)} {...props} />;
}

function CardTitle({ className, ...props }: TextProps) {
  return (
    <Text
      className={cn(
        "font-semibold native:text-xl text-card-foreground text-lg tracking-tight",
        className
      )}
      role="heading"
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: TextProps) {
  return (
    <Text
      className={cn(
        "native:text-base text-muted-foreground web:text-sm",
        className
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: ViewProps) {
  return (
    <TextClassContext.Provider value="text-card-foreground">
      <View className={cn("p-4 pt-0", className)} {...props} />
    </TextClassContext.Provider>
  );
}

function CardFooter({ className, ...props }: ViewProps) {
  return (
    <View
      className={cn("flex-row items-center p-4 pt-0", className)}
      {...props}
    />
  );
}

export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
};

import { Alert, View } from "react-native";
import { Text } from "@/components/ui/text";
import {
  parseMarkdownBlocks,
  parseMarkdownInline,
} from "@/features/chat/markdown";
import { isSafeHttpUrl, openExternalUrl } from "@/lib/open-url";
import { cn } from "@/lib/utils";

function InlineText({ className, text }: { className?: string; text: string }) {
  return (
    <Text className={className} selectable>
      {parseMarkdownInline(text).map((part, index) => {
        if (part.type === "bold") {
          return (
            <Text className="font-semibold" key={index} selectable>
              {part.text}
            </Text>
          );
        }
        if (part.type === "italic") {
          return (
            <Text className="italic" key={index} selectable>
              {part.text}
            </Text>
          );
        }
        if (part.type === "code") {
          return (
            <Text className="font-mono text-xs" key={index} selectable>
              {part.text}
            </Text>
          );
        }
        if (part.type === "link") {
          return (
            <Text
              className="underline"
              key={index}
              onPress={() => {
                if (!isSafeHttpUrl(part.href)) {
                  return;
                }

                void openExternalUrl(part.href).catch(() => {
                  Alert.alert("Could not open link.");
                });
              }}
              selectable
            >
              {part.text}
            </Text>
          );
        }
        return (
          <Text key={index} selectable>
            {part.text}
          </Text>
        );
      })}
    </Text>
  );
}

function MarkdownView({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text);

  return (
    <View className="gap-2">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <Text
              className="font-mono text-xs"
              key={`code-${index}`}
              selectable
            >
              {block.text}
            </Text>
          );
        }
        if (block.type === "heading") {
          return (
            <InlineText
              className={cn(
                "font-semibold",
                block.level === 1 ? "text-lg" : "text-base"
              )}
              key={`h-${index}`}
              text={block.text}
            />
          );
        }
        if (block.type === "quote") {
          return (
            <View className="border-border border-l-2 pl-2" key={`q-${index}`}>
              <InlineText className="text-muted-foreground" text={block.text} />
            </View>
          );
        }
        if (block.type === "list") {
          return (
            <View className="gap-1" key={`l-${index}`}>
              {block.items.map((item, itemIndex) => (
                <InlineText
                  key={`li-${itemIndex}`}
                  text={`${block.ordered ? `${itemIndex + 1}.` : "•"} ${item}`}
                />
              ))}
            </View>
          );
        }
        return <InlineText key={`p-${index}`} text={block.text} />;
      })}
    </View>
  );
}

export { MarkdownView };

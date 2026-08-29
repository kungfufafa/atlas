import {
  FlashList,
  type FlashListProps,
  type FlashListRef,
} from "@shopify/flash-list";
import { useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";

function FlexFlashList<T>(
  props: FlashListProps<T> & { ref?: React.Ref<FlashListRef<T>> }
) {
  const [height, setHeight] = useState(0);

  const onLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    if (next > 0 && next !== height) {
      setHeight(next);
    }
  };

  return (
    <View onLayout={onLayout} style={{ flex: 1, overflow: "hidden" }}>
      {height > 0 ? <FlashList {...props} style={{ height }} /> : null}
    </View>
  );
}

export { FlexFlashList };

import { mount, View } from "nsh";
import { ZoomImage } from "../views/ZoomImage";

// The zoom layer's image viewer on a stage of its own, for `ZoomImage.test.tsx`:
// a test-pattern picture in a fixed box, exercised by presses, drags and keys.
//
//   nsh dev dev/ZoomStage.tsx

mount(() => (
  <View class="flex-1 items-center justify-center bg-background">
    <ZoomImage src="/tmp/pipi-zoom-pattern.png" title="pattern" natural={{ width: 1200, height: 800 }} box={{ width: 600, height: 400 }} />
  </View>
));

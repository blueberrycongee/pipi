// A bare stage for reviewing one wallpaper preset shader: the shader full
// window, no app chrome. The preset (and any uniform overrides) comes from
// storage (`stage.config`), which PresetStage.test.tsx sets:
//
//   { preset: "jelly", dark: true, uniforms: { phase: 12 } }
import { mount, Shader, Storage, Text, View } from "nsh";
import { WALLPAPER_PRESET_DEFS, wallpaperPresetUniforms, type WallpaperPreset } from "../lib/wallpaper-presets";

interface StageConfig {
  preset?: string;
  dark?: boolean;
  uniforms?: Record<string, number>;
}

Storage.getItem("stage.config").then((raw) => {
  const config: StageConfig = raw ? JSON.parse(raw) : {};
  const ids = Object.keys(WALLPAPER_PRESET_DEFS) as WallpaperPreset[];
  const preset = ids.find((id) => id === config.preset) ?? ids[0]!;
  const dark = config.dark !== false;
  mount(() => (
    <View class="flex-1">
      <Shader
        source={WALLPAPER_PRESET_DEFS[preset].source}
        uniforms={{ ...wallpaperPresetUniforms(dark, 0), ...(config.uniforms ?? {}) }}
        class="absolute inset-0"
      />
      <Text class="text-transparent text-[1px]">stage</Text>
    </View>
  ));
});

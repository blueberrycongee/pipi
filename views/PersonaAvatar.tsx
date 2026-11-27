import { effect, Image, signal, untracked, View } from "nsh";
import { tr } from "../lib/i18n";
import type { Mood } from "../mascot/geometry";
import { Pip } from "../mascot/Pip";

/**
 * A persona's circular avatar: its copied image when one is set, the Pip mascot
 * otherwise. A missing or unreadable image falls back to the mascot rather than
 * leaving an empty circle.
 */
export function PersonaAvatar(props: {
  avatar?: string | (() => string | undefined);
  size: number;
  mood?: Mood;
  still?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const avatar = () => (typeof props.avatar === "function" ? props.avatar() : props.avatar);
  const failed = signal(false);
  let seen = untracked(avatar);
  effect(() => {
    if (avatar() !== seen) {
      seen = avatar();
      failed.set(false);
    }
  });
  const custom = () => Boolean(avatar()) && !failed();
  return (
    <If
      when={custom()}
      else={
        <View testID={props.testID} class="size-full items-center justify-center">
          <Pip size={props.size} mood={props.mood ?? "idle"} still={props.still ?? true} />
        </View>
      }
    >
      <View
        testID={props.testID}
        accessibilityLabel={props.accessibilityLabel ?? tr("Personal agent avatar", "个人智能体头像")}
        class="size-full overflow-hidden rounded-full bg-muted"
      >
        <Image src={avatar()!} class="size-full" style={{ objectFit: "cover" }} onError={() => failed.set(true)} />
      </View>
    </If>
  );
}

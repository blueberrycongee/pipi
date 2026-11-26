// AgentLogo keeps its inner PiMark / Canvas / Icon mounted when upstream
// reactive wrappers update with the same id or stay within the same branch.
//
//   nsh test ui/AgentLogo.test.tsx
import { signal } from "nsh";
import { expect, test } from "nsh/test";
import { _setAgentLogoMountObserver, AgentLogo } from "./AgentLogo";

test("AgentLogo does not remount PiMark, Canvas, or Icon when upstream wrapper ticks with the same kind", () => {
  const mounts: string[] = [];
  _setAgentLogoMountObserver((kind) => mounts.push(kind));
  try {
    const wrapper = signal({ id: "pi", status: "ready" as "ready" | "off", tick: 0 });
    <AgentLogo id={wrapper().id} status={wrapper().status} size={14} />;

    expect(mounts).toEqual(["pi"]);

    // Upstream wrapper object changes with same id or status: zero remounts.
    wrapper.set({ id: "pi", status: "ready", tick: 1 });
    wrapper.set({ id: "pi", status: "off", tick: 2 });
    expect(mounts).toEqual(["pi"]);

    // Switching to a glyph agent mounts the Canvas branch once.
    wrapper.set({ id: "claude", status: "ready", tick: 3 });
    expect(mounts).toEqual(["pi", "glyph"]);

    // Ticking with same glyph id or switching to another glyph agent keeps the same Canvas mounted.
    wrapper.set({ id: "claude", status: "ready", tick: 4 });
    wrapper.set({ id: "claude", status: "off", tick: 5 });
    wrapper.set({ id: "codex", status: "ready", tick: 6 });
    expect(mounts).toEqual(["pi", "glyph"]);

    // Switching to an unknown id mounts the fallback Icon once and keeps it mounted across ticks.
    wrapper.set({ id: "custom-acp", status: "ready", tick: 7 });
    wrapper.set({ id: "custom-acp", status: "off", tick: 8 });
    wrapper.set({ id: "another-custom", status: "ready", tick: 9 });
    expect(mounts).toEqual(["pi", "glyph", "fallback"]);
  } finally {
    _setAgentLogoMountObserver(null);
  }
});

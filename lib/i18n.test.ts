import { signal } from "nsh";
import { expect, test } from "nsh/test";
import { compactPath, dayGroup, relativeTime } from "./format";
import { formatAgentMeta, resolveLang } from "./i18n";
import { setLanguage } from "../store/prefs";
import { toolSummary, Transcript } from "../pi/transcript";

test("resolves BCP 47 locale tags to English or Chinese", () => {
  expect(resolveLang("en-US")).toBe("en");
  expect(resolveLang("fr-FR")).toBe("en");
  expect(resolveLang("zh")).toBe("zh");
  expect(resolveLang("zh-Hans-CN")).toBe("zh");
  expect(resolveLang("zh-Hant-TW")).toBe("zh");
});

test("formats relative times and day groups in English and Chinese", () => {
  const now = new Date("2026-05-10T12:00:00Z").getTime();
  expect(relativeTime(now - 10_000, now, "en")).toBe("now");
  expect(relativeTime(now - 10_000, now, "zh")).toBe("刚刚");
  expect(relativeTime(now - 5 * 60_000, now, "zh")).toBe("5分钟");
  expect(relativeTime(now - 2 * 3_600_000, now, "zh")).toBe("2小时");
  expect(relativeTime(now - 3 * 86_400_000, now, "zh")).toBe("3天");

  expect(dayGroup(now - 60_000, now, "en")).toBe("Today");
  expect(dayGroup(now - 60_000, now, "zh")).toBe("今天");
  expect(dayGroup(now - 26 * 3_600_000, now, "zh")).toBe("昨天");
  expect(dayGroup(now - 4 * 86_400_000, now, "zh")).toBe("过去 7 天");
  expect(dayGroup(now - 12 * 86_400_000, now, "zh")).toBe("更早");
});

test("localizes transcript summaries and tool summaries reactively", () => {
  const lang = signal<"en" | "zh">("en");
  const t = new Transcript(() => lang());
  t.apply({ type: "compaction_end", reason: "manual", result: { tokensBefore: 12000, summary: "sum" }, aborted: false });
  expect(t.rows()[0]).toMatchObject({ kind: "summary", title: "Context compacted from 12k tokens" });

  lang.set("zh");
  const tZh = new Transcript(() => lang());
  tZh.apply({ type: "compaction_end", reason: "manual", result: { tokensBefore: 12000, summary: "sum" }, aborted: false });
  expect(tZh.rows()[0]).toMatchObject({ kind: "summary", title: "上下文已从 12k tokens 压缩" });

  expect(toolSummary("grep", { pattern: "TODO", path: "src" }, "en")).toBe("TODO  in src");
  expect(toolSummary("grep", { pattern: "TODO", path: "src" }, "zh")).toBe("TODO  于 src");
});

test("middle-shortens long paths and localizes probed agent metadata cleanly", () => {
  const shortened = compactPath("~/.nvm/versions/node/v24.13.0/bin/claude", 34);
  expect(shortened.startsWith("~/.nvm/…/")).toBe(true);
  expect(shortened.endsWith("/bin/claude")).toBe(true);
  expect(shortened.length).toBeLessThanOrEqual(34);

  setLanguage("zh");
  const piMeta = formatAgentMeta(
    {
      id: "pi",
      available: true,
      binaryPath: "/Users/pip/.nvm/versions/node/v24.13.0/bin/pi",
      version: "Pi 1.5.0",
      statusText: "Signed in (~/.pi/agent/auth.json) · Pi 1.5.0",
    },
    "/Users/pip",
  );
  expect(piMeta.versionBadge).toBe("v1.5.0");
  expect(piMeta.statusLabel).toBe("已登录");
  expect(piMeta.fullPath).toBe("~/.nvm/versions/node/v24.13.0/bin/pi");

  const codexMeta = formatAgentMeta(
    {
      id: "codex",
      available: true,
      binaryPath: "/Users/pip/.nvm/versions/node/v24.13.0/bin/codex",
      version: "codex-cli 0.166.0",
      statusText: "Signed in (~/.codex/auth.json) · codex-cli 0.166.0",
    },
    "/Users/pip",
  );
  expect(codexMeta.versionBadge).toBe("v0.166.0");
  expect(codexMeta.statusLabel).toBe("已登录");
  expect(codexMeta.fullPath).toBe("~/.nvm/versions/node/v24.13.0/bin/codex");
  expect(codexMeta.displayPath?.includes("…")).toBe(true);

  const missingMeta = formatAgentMeta(
    { id: "opencode", available: false, statusText: "Not installed (opencode not found on PATH)" },
    "/Users/pip",
  );
  expect(missingMeta.statusLabel).toBe("未检测到安装");
  setLanguage("system");
});

import { expect, test } from "nsh/test";
import { TextView } from "nsh/base";
import { titleWords } from "./doc-wire";
import { PENDING_LINK_URL } from "./mend";
import {
  classifyMediaKind,
  composeFileMessage,
  extensionLabel,
  extractBlockMedia,
  extractMarkdownMediaPaths,
  extractPresentedMedia,
  extractToolResultMedia,
  formatBytes,
  formatMediaDuration,
  isPresentFilesTool,
  isRichPasteFile,
  normalizeMcpToolName,
  resolveMediaTarget,
  splitFileMessage,
} from "./media";

test("classifies images, video, audio, documents, archives, and generic files", () => {
  expect(classifyMediaKind("shot.png")).toBe("image");
  expect(classifyMediaKind("photo.HEIC")).toBe("image");
  expect(classifyMediaKind("vector.svg")).toBe("document");
  expect(classifyMediaKind("clip.mp4")).toBe("video");
  expect(classifyMediaKind("demo.mov")).toBe("video");
  expect(classifyMediaKind("voice.mp3")).toBe("audio");
  expect(classifyMediaKind("note.wav")).toBe("audio");
  expect(classifyMediaKind("report.pdf")).toBe("document");
  expect(classifyMediaKind("bundle.zip")).toBe("archive");
  expect(classifyMediaKind("src/App.tsx")).toBe("file");
  expect(classifyMediaKind(undefined, "audio/mpeg")).toBe("audio");
  expect(classifyMediaKind(undefined, "image/svg+xml")).toBe("document");

  expect(extensionLabel("report.pdf")).toBe("PDF");
  expect(extensionLabel(undefined, "audio/mpeg")).toBe("MP3");
  expect(isRichPasteFile("/tmp/demo.mp4")).toBe(true);
  expect(isRichPasteFile("/tmp/report.pdf")).toBe(true);
  expect(isRichPasteFile("/tmp/AGENTS.md")).toBe(false);
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatMediaDuration(125)).toBe("2:05");
});

test("resolves relative, tilde, file://, data:, and https:// media targets safely", () => {
  expect(resolveMediaTarget("", "/work")).toBeUndefined();
  expect(resolveMediaTarget(PENDING_LINK_URL, "/work")).toBeUndefined();
  expect(resolveMediaTarget("#section", "/work")).toBeUndefined();
  expect(resolveMediaTarget("javascript:alert(1)", "/work")).toBeUndefined();

  const rel = resolveMediaTarget("./out/../shots/ui.png#L2", "/Users/pip/proj");
  expect(rel).toMatchObject({ kind: "image", path: "/Users/pip/proj/shots/ui.png", src: "/Users/pip/proj/shots/ui.png", title: "ui.png" });

  const tilde = resolveMediaTarget("~/Movies/demo.mp4", "/Users/pip/proj", "/Users/pip");
  expect(tilde).toMatchObject({ kind: "video", path: "/Users/pip/Movies/demo.mp4", src: "/Users/pip/Movies/demo.mp4", title: "demo.mp4" });

  const fileUrl = resolveMediaTarget("file:///Users/pip/My%20Video.mov", "/work");
  expect(fileUrl).toMatchObject({ kind: "video", path: "/Users/pip/My Video.mov", title: "My Video.mov" });

  const dataUrl = resolveMediaTarget("data:image/png;base64,iVBORw0KGgo=");
  expect(dataUrl).toMatchObject({ kind: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });

  const remote = resolveMediaTarget("https://example.com/assets/demo.mp4?token=1");
  expect(remote).toMatchObject({ kind: "video", remoteUrl: "https://example.com/assets/demo.mp4?token=1", title: "demo.mp4" });
  expect(remote?.path).toBeUndefined();
});

test("serializes and parses trailing attachment blocks without touching mid-sentence text", () => {
  const files = [
    { path: "/tmp/demo.mp4", name: "demo.mp4", kind: "video" as const, mimeType: "video/mp4", size: 2048 },
    { path: '/tmp/say "hi".pdf', name: 'say "hi".pdf', kind: "document" as const, mimeType: "application/pdf", size: 512 },
  ];
  const wire = composeFileMessage("Review this clip", files);
  expect(splitFileMessage(wire)).toEqual({ said: "Review this clip", files });
  expect(titleWords(wire)).toBe("Review this clip");

  const filesOnly = composeFileMessage("", files);
  expect(splitFileMessage(filesOnly)).toEqual({ said: "", files });
  expect(titleWords(filesOnly)).toBe("demo.mp4");

  const mentioned = 'Mentioning <attachment path="/tmp/x.png" kind="image" /> inline only';
  expect(splitFileMessage(mentioned)).toEqual({ said: mentioned, files: [] });
});

test("extracts pure and mixed media from parsed Markdown blocks", () => {
  const pureImg = TextView.parse("![Preview](./shot.png)", { streaming: false }).blocks[0];
  const imgRes = extractBlockMedia(pureImg, "/repo", "/Users/pip");
  expect(imgRes.mode).toBe("pure");
  expect(imgRes.items[0]).toMatchObject({ kind: "image", path: "/repo/shot.png", title: "Preview" });

  const multiVideo = TextView.parse("![Clip](demo.mp4)\n![Voice](audio.mp3)", { streaming: false }).blocks[0];
  const multiRes = extractBlockMedia(multiVideo, "/repo");
  expect(multiRes.mode).toBe("pure");
  expect(multiRes.items.map((i) => i.kind)).toEqual(["video", "audio"]);

  const pdfLink = TextView.parse("[Design PDF](docs/spec.pdf)", { streaming: false }).blocks[0];
  const pdfRes = extractBlockMedia(pdfLink, "/repo");
  expect(pdfRes.mode).toBe("pure");
  expect(pdfRes.items[0]).toMatchObject({ kind: "document", path: "/repo/docs/spec.pdf", title: "Design PDF" });

  const codeLink = TextView.parse("[App.tsx](src/App.tsx)", { streaming: false }).blocks[0];
  expect(extractBlockMedia(codeLink, "/repo").mode).toBe("none");

  const mixed = TextView.parse("Here is the demo: ![Demo](demo.mp4) and [audio](voice.wav).", { streaming: false }).blocks[0];
  const mixedRes = extractBlockMedia(mixed, "/repo");
  expect(mixedRes.mode).toBe("mixed");
  expect(mixedRes.items.map((i) => i.kind)).toEqual(["video", "audio"]);
  expect(mixedRes.strippedBlock?.content.some((n) => n.type === "image")).toBe(false);

  const pending = TextView.parse(`![Streaming](${PENDING_LINK_URL})`, { streaming: true }).blocks[0];
  expect(extractBlockMedia(pending, "/repo").mode).toBe("none");

  const used = extractMarkdownMediaPaths("Look at ![a](shot.png) and [b](./demo.mp4)", "/repo");
  expect(used.has("/repo/shot.png")).toBe(true);
  expect(used.has("/repo/demo.mp4")).toBe(true);
});

test("extracts presented files and tool-returned images/resources", () => {
  const presented = extractPresentedMedia(
    {
      id: "call_1",
      name: "mcp__pipi__present_files",
      args: { files: [{ path: "out/video.mp4" }] },
      output: "",
      details: {
        pipiMedia: true,
        title: "Artifacts",
        items: [{ path: "/repo/out/video.mp4", kind: "video", title: "Final render", size: 4096 }],
      },
    },
    "/repo",
  );
  expect(presented?.title).toBe("Artifacts");
  expect(presented?.items[0]).toMatchObject({ kind: "video", path: "/repo/out/video.mp4", title: "Final render", size: 4096 });

  const toolItems = extractToolResultMedia(
    {
      id: "call_2",
      name: "screenshot",
      args: {},
      output: "captured",
      imageBlocks: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      resources: [{ type: "resource", uri: "file:///tmp/trace.mp4", name: "trace.mp4", mimeType: "video/mp4" }],
    },
    "/repo",
  );
  expect(toolItems.map((i) => i.kind)).toEqual(["image", "video"]);
  expect(toolItems[1].path).toBe("/tmp/trace.mp4");
});

test("recognizes present_files and pipi MCP tool names across all harness formats without false positives", () => {
  expect(normalizeMcpToolName("Run mcp_pipi_present_files")).toBe("present_files");
  expect(normalizeMcpToolName("Running mcp_pipi_present_files")).toBe("present_files");
  expect(normalizeMcpToolName("mcp_pipi_sessions_list")).toBe("sessions_list");
  expect(normalizeMcpToolName("Run mcp_pipi_workspaces_list")).toBe("workspaces_list");
  expect(normalizeMcpToolName("pipi:present_files")).toBe("present_files");
  expect(normalizeMcpToolName("mcp/pipi/session_start")).toBe("session_start");
  expect(normalizeMcpToolName("Run git status")).toBe("run_git_status");

  for (const name of [
    "present_files",
    "Present files",
    "Run present_files",
    "Running present_files",
    "mcp__pipi__present_files",
    "Run mcp__pipi__present_files",
    "mcp_pipi_present_files",
    "Run mcp_pipi_present_files",
    "Running mcp_pipi_present_files",
    "pipi:present_files",
    "pipi/present_files",
    "pipi.present_files",
    "pipi__present_files",
    "pipi_present_files",
    "mcp:pipi:present_files",
    "mcp/pipi/present_files",
    "mcp_custom_present_files",
    "custom-server:present_files",
  ]) {
    expect(isPresentFilesTool(name)).toBe(true);
  }

  for (const name of [
    "read_file",
    "present_files_helper",
    "represent_files",
    "rg -n present_files lib/",
    "File lib/present_files.ts",
    "Run ./present_files",
    "Run scripts/present_files",
  ]) {
    expect(isPresentFilesTool(name)).toBe(false);
  }
});

test("extractPresentedMedia handles Antigravity ACP args fallback and renamed pipiMedia payloads", () => {
  // Antigravity ACP: empty toolResult content/details, full file list in args, title prefixed with "Run mcp_pipi_".
  const agy = extractPresentedMedia(
    {
      id: "call_agy",
      name: "Run mcp_pipi_present_files",
      args: {
        title: "Before & After",
        files: [
          { path: "/repo/.nsh/shots/before.png", title: "Before", caption: "Old layout" },
          { path: ".nsh/shots/after.png", title: "After" },
        ],
      },
      output: "",
    },
    "/repo",
  );
  expect(agy?.title).toBe("Before & After");
  expect(agy?.items).toHaveLength(2);
  expect(agy?.items[0]).toMatchObject({ kind: "image", path: "/repo/.nsh/shots/before.png", title: "Before", caption: "Old layout" });
  expect(agy?.items[1]).toMatchObject({ kind: "image", path: "/repo/.nsh/shots/after.png", title: "After" });

  // Arbitrary ACP display title (e.g. toolSummary) still surfaces when pipiMedia sentinel is present in details or output.
  const byDetails = extractPresentedMedia(
    {
      id: "call_custom_details",
      name: "Present before and after previews",
      args: {},
      output: "",
      details: { pipiMedia: true, title: "Previews", items: [{ path: "/repo/a.png", kind: "image" }] },
    },
    "/repo",
  );
  expect(byDetails?.title).toBe("Previews");
  expect(byDetails?.items[0]?.path).toBe("/repo/a.png");

  const byOutput = extractPresentedMedia(
    {
      id: "call_custom_output",
      name: "Show screenshots",
      args: {},
      output: JSON.stringify({ pipiMedia: true, items: [{ path: "/repo/b.png", kind: "image" }] }),
    },
    "/repo",
  );
  expect(byOutput?.items[0]?.path).toBe("/repo/b.png");

  // Unrelated tool with a `files` argument and no pipiMedia sentinel is never misclassified as presented media.
  expect(
    extractPresentedMedia(
      {
        id: "call_other",
        name: "lint_files",
        args: { files: [{ path: "/repo/a.png" }] },
        output: "",
      },
      "/repo",
    ),
  ).toBeUndefined();
});

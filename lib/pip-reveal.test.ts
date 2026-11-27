import { expect, test } from "nsh/test";
import type { ChatRow } from "../views/Rows";
import {
  arrangePipRows,
  makePipInterleaveRecord,
  PipRevealController,
  type PipInterleaveRecord,
  pipRevealDelayMs,
  resolvePipInterleaves,
  scanPipRows,
} from "./pip-reveal";

const full = "Alpha one.\n\nBeta two.\n\nGamma three.";
const bubble = (turnId: string, rowId: string, index: number, text: string, total = 3): ChatRow =>
  ({
    kind: "pip-bubble",
    id: `${rowId}#b${index}`,
    rowId,
    bubbleIndex: index,
    first: index === 0,
    last: index === total - 1,
    blocks: [],
    copyText: text,
    fullText: full,
    wide: false,
    pip: { lead: index === 0, tail: index === total - 1, indent: true, fullText: full, meta: { turnId, hasDetails: false } },
  }) as ChatRow;
const footer = (turnId: string): ChatRow =>
  ({ kind: "pip-footer", id: `foot:${turnId}`, text: full, pip: { lead: false, tail: false, indent: true, fullText: full, meta: { turnId, hasDetails: false } } }) as ChatRow;
const user = (id: string, text: string): ChatRow => ({ kind: "user", id, text, images: 0, sms: { first: true, last: true } }) as ChatRow;
const clusterRows = (turnId = "turn:a", withUser = false): ChatRow[] => [
  user("u0", "question"),
  bubble(turnId, "a", 0, "Alpha one."),
  bubble(turnId, "a", 1, "Beta two."),
  bubble(turnId, "a", 2, "Gamma three."),
  footer(turnId),
  ...(withUser ? [user("u1", "wait, one more thing")] : []),
];
const ids = (rows: readonly ChatRow[]) => rows.map((row) => row.id);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("reveal cadence stays inside the capped 320–480ms texting rhythm", () => {
  expect(pipRevealDelayMs("hi")).toBe(320);
  expect(pipRevealDelayMs("x".repeat(24))).toBe(360);
  expect(pipRevealDelayMs("x".repeat(100))).toBe(480);
  expect(pipRevealDelayMs("x".repeat(1000))).toBe(480);
});

test("a persisted crossing restores A1 → U → A2 → A3 statically with coherent bubble groups", () => {
  const rows = clusterRows("turn:a", true);
  const scan = scanPipRows(rows);
  const record = makePipInterleaveRecord(scan, scan.clusters[0], scan.users[1], 1, 10);
  const splits = resolvePipInterleaves(rows, [record]);
  const arranged = arrangePipRows(rows, splits);
  expect(ids(arranged)).toEqual(["u0", "a#b0", "u1", "a#b1", "a#b2", `foot:turn:a`]);
  const first = arranged[1] as Extract<ChatRow, { kind: "pip-bubble" }>;
  const second = arranged[3] as Extract<ChatRow, { kind: "pip-bubble" }>;
  const third = arranged[4] as Extract<ChatRow, { kind: "pip-bubble" }>;
  expect([first.first, first.last, first.pip.tail]).toEqual([true, true, true]);
  expect([second.first, second.last, second.pip.tail]).toEqual([true, false, false]);
  expect([third.first, third.last, third.pip.tail]).toEqual([false, true, true]);
  const crossed = arranged[2] as Extract<ChatRow, { kind: "user" }>;
  expect([crossed.sms?.first, crossed.sms?.last]).toEqual([true, true]);
});

test("a live multi-bubble reply mounts one bubble at a time and holds footer rows until the last one", async () => {
  const rows = clusterRows();
  const controller = new PipRevealController({ notify: () => undefined, isLiveRow: () => true, reduceMotion: () => false });
  const first = controller.apply(rows, []);
  expect(first.pending).toBe(true);
  expect(ids(first.rows)).toEqual(["u0", "a#b0"]);
  await wait(345);
  const second = controller.apply(rows, []);
  expect(ids(second.rows)).toEqual(["u0", "a#b0", "a#b1"]);
  await wait(345);
  const third = controller.apply(rows, []);
  expect(third.pending).toBe(false);
  expect(ids(third.rows)).toEqual(["u0", "a#b0", "a#b1", "a#b2", "foot:turn:a"]);
  controller.reset();
});

test("a user message during reveal lands immediately after visible bubbles, and later bubbles cross after it", async () => {
  const rows = clusterRows("turn:a", true);
  const records: PipInterleaveRecord[] = [];
  const controller = new PipRevealController({
    notify: () => undefined,
    isLiveRow: () => true,
    reduceMotion: () => false,
    onInterleave: (record) => records.push(record),
  });
  const first = controller.apply(rows, []);
  expect(ids(first.rows)).toEqual(["u0", "a#b0", "u1"]);
  expect(records.length).toBe(1);
  expect(records[0].before).toBe(1);
  await wait(345);
  const second = controller.apply(rows, []);
  expect(ids(second.rows)).toEqual(["u0", "a#b0", "u1", "a#b1"]);
  await wait(345);
  const third = controller.apply(rows, []);
  expect(ids(third.rows)).toEqual(["u0", "a#b0", "u1", "a#b1", "a#b2", "foot:turn:a"]);
  controller.reset();
});

test("message_edit closes out the reveal and shows the replacement whole instead of losing words", () => {
  const rows = clusterRows();
  const controller = new PipRevealController({ notify: () => undefined, isLiveRow: () => true, reduceMotion: () => false });
  expect(ids(controller.apply(rows, []).rows)).toEqual(["u0", "a#b0"]);
  const edited = rows.map((row) =>
    row.kind === "pip-bubble" && row.bubbleIndex === 1
      ? ({ ...row, copyText: "Beta edited.", versions: [{ content: "Beta two.", at: 1 }, { content: "Beta edited.", at: 2 }] } as ChatRow)
      : row,
  );
  const flushed = controller.apply(edited, []);
  expect(flushed.pending).toBe(false);
  expect(ids(flushed.rows)).toEqual(["u0", "a#b0", "a#b1", "a#b2", "foot:turn:a"]);
  controller.reset();
});

test("history and reduced motion never enter the sequential queue", () => {
  for (const reduced of [false, true]) {
    const controller = new PipRevealController({ notify: () => undefined, isLiveRow: () => false, reduceMotion: () => reduced });
    const result = controller.apply(clusterRows(), []);
    expect(result.pending).toBe(false);
    expect(ids(result.rows)).toEqual(["u0", "a#b0", "a#b1", "a#b2", "foot:turn:a"]);
  }
  const reduced = new PipRevealController({ notify: () => undefined, isLiveRow: () => true, reduceMotion: () => true });
  expect(ids(reduced.apply(clusterRows(), []).rows)).toEqual(["u0", "a#b0", "a#b1", "a#b2", "foot:turn:a"]);
});

test("a crossing does not steal the tail avatar from surfaced media after the bubbles", () => {
  const turnId = "turn:media";
  const media = {
    kind: "media",
    id: "media:1",
    items: [],
    pip: { lead: false, tail: true, indent: true, fullText: full, meta: { turnId, hasDetails: false } },
  } as ChatRow;
  const rows = [user("u0", "question"), bubble(turnId, "a", 0, "Alpha one."), bubble(turnId, "a", 1, "Beta two."), bubble(turnId, "a", 2, "Gamma three."), media, footer(turnId), user("u1", "wait")];
  const scan = scanPipRows(rows);
  const record = makePipInterleaveRecord(scan, scan.clusters[0], scan.users[1], 1, 10);
  const arranged = arrangePipRows(rows, resolvePipInterleaves(rows, [record]));
  const lastBubble = arranged.find((row) => row.id === "a#b2") as Extract<ChatRow, { kind: "pip-bubble" }>;
  expect(lastBubble.pip.tail).toBe(false);
});

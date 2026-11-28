import { expect, open, test, type App } from "nsh/test";

// Three messages to Pip in quick succession (260ms apart, while Pip is still
// working on the first), recorded once a display frame (`harness.trace`,
// `ui/motion-trace.ts`): each bubble's entrance channels, its opacity, its
// laid-out frame (the list's scroll included), the springy lag of every row,
// Pip's working footer and the list's offset — what the compositor draws,
// frame by frame (screenshots on macOS come ~110ms apart and cannot).
//
// What used to go wrong, frame-exact: every send under a full conversation
// lifted the column 65–77pt in one frame (the list's own follow landing a
// frame after the room appeared, so Pip's working row dropped and came back);
// the second and third bubbles popped at 0.6 opacity with a "Queued" seat
// each, and the first kept its receipt seat over them, so the queue letting
// go collapsed 24pt in one frame.
//
//   nsh test PipBurst.test.tsx --target macos

interface Sample {
  t: number;
  id: string;
  v: Record<string, number>;
}

const SEND = 7000;
const LONG = Array.from({ length: 7 }, (_, i) => `Thought ${i + 1}: the manifest names its entry points, and each one is read before the tests run.`).join("\n\n");

async function burst(storage: Record<string, string>, reducedMotion = false) {
  const app = await open("./Harness.tsx", {
    width: 760,
    height: 560,
    platform: "macos",
    locale: "en-US",
    reducedMotion,
    storage: { "harness.scenario": "stream", ...storage },
  });
  await app.press("id:sidebar-pip");
  return app;
}

async function film(app: App): Promise<Sample[]> {
  await app.waitUntil(() => Boolean(app.storage()["harness.traceOut"]), { timeout: 30000 });
  return JSON.parse(app.storage()["harness.traceOut"]) as Sample[];
}

const series = (samples: Sample[], id: string) => samples.filter((s) => s.id === id);
/** The bubbles sent while recording (not those already on screen when it began). */
const bubbleIds = (samples: Sample[]) => {
  const before = new Set(samples.filter((s) => s.t < 50).map((s) => s.id));
  return [...new Set(samples.filter((s) => /^u\d+$/.test(s.id) && s.v.eo !== undefined && !before.has(s.id)).map((s) => s.id))];
};

/** Per row: where it is drawn, how opaque, frame by frame — each change once. */
function print(samples: Sample[], only?: RegExp) {
  for (const id of [...new Set(samples.map((s) => s.id))]) {
    if (only && !only.test(id)) continue;
    let last = "";
    const lines: string[] = [];
    for (const s of series(samples, id)) {
      const v = s.v;
      const vy = v.y !== undefined ? Math.round((v.y + (v.ey ?? 0) + (v.lag ?? 0)) * 2) / 2 : undefined;
      const op = Math.round((v.eo ?? 1) * (v.dim ?? 1) * (v.fo ?? 1) * 100) / 100;
      const parts = [
        vy !== undefined ? `${vy}` : "",
        v.h !== undefined ? `h${Math.round(v.h)}` : "",
        op !== 1 ? `o${op}` : "",
        v.lag ? `lag${v.lag.toFixed(1)}` : "",
        v.scroll !== undefined ? `sc${Math.round(v.scroll * 2) / 2}` : "",
      ].filter(Boolean).join(" ");
      if (parts === last) continue;
      last = parts;
      lines.push(`${s.t}:${parts}`);
    }
    console.log(`[${id}] ${lines.join(" | ")}`);
  }
}

/** Every sent bubble enters once: born invisible (no frame drawn at full ink before its pop-in), never dimmed by a queue, never fading back. */
function entersOnce(samples: Sample[]) {
  const ids = bubbleIds(samples);
  expect(ids.length).toBe(3);
  for (const id of ids) {
    const s = series(samples, id).filter((x) => x.v.eo !== undefined);
    expect(s[0].v.eo).toBeLessThan(0.2);
    let peak = 0;
    for (const x of s) {
      expect(x.v.dim ?? 1).toBe(1);
      const o = x.v.eo * (x.v.dim ?? 1);
      expect(o).toBeGreaterThanOrEqual(peak - 0.01);
      peak = Math.max(peak, o);
    }
    expect(peak).toBeGreaterThan(0.99);
  }
}

/** One receipt for the run, under its last bubble: the rows above it sit 3pt apart, a cluster. */
function oneSeat(samples: Sample[]) {
  const ids = bubbleIds(samples);
  const height = (id: string) => series(samples, `${id}#row`).at(-1)?.v.h ?? 0;
  for (const id of ids.slice(0, -1)) expect(height(id)).toBeLessThan(40);
  expect(height(ids[ids.length - 1])).toBeGreaterThan(60);
}

test("a burst of three sends to an empty Pip: one entrance each, one receipt, nothing above moves", async () => {
  const app = await burst({
    "harness.pace": "120",
    "harness.trace": `${SEND - 300}:1600`,
    "harness.then": `${SEND}:send:say hi;${SEND + 260}:send:are you there;${SEND + 520}:send:one more thing`,
  });
  const samples = await film(app);
  print(samples, /^(footer|u\d+(#row)?)$/);
  entersOnce(samples);
  oneSeat(samples);
  // The conversation is shorter than the pane: what was sent stays put while the next one lands under it.
  for (const id of bubbleIds(samples)) {
    const ys = series(samples, `${id}#row`).map((s) => s.v.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1);
  }
}, 600000);

test("a burst of three sends under a full conversation glides the column — no frame lifts it at once", async () => {
  const SENT = 14000;
  const app = await burst({
    "harness.pace": "20",
    "harness.reply": LONG,
    "harness.trace": `${SENT - 300}:1250`,
    "harness.then": `5000:send:tell me everything;${SENT}:send:say hi;${SENT + 260}:send:are you there;${SENT + 520}:send:one more thing`,
  });
  const samples = await film(app);
  print(samples, /^(footer|list|u\d+#row|user:u\d+)$/);
  entersOnce(samples);
  oneSeat(samples);
  // Every row of the column, frame to frame: a glide moves a few points a frame; a snap moved 65–77.
  let worst = { d: 0, id: "", t: 0 };
  for (const id of new Set(samples.filter((s) => /^(user|pip-bubble|pip-footer):/.test(s.id)).map((s) => s.id))) {
    const s = series(samples, id).filter((x) => x.v.y !== undefined);
    for (let i = 1; i < s.length; i++) {
      const d = Math.abs(s[i].v.y + (s[i].v.lag ?? 0) - (s[i - 1].v.y + (s[i - 1].v.lag ?? 0)));
      if (d > worst.d) worst = { d, id, t: s[i].t };
    }
  }
  console.log(`[worst frame-to-frame move] ${worst.d.toFixed(1)}pt ${worst.id} @${worst.t}ms`);
  expect(worst.d).toBeLessThan(12);
  // The list scrolls only forward through the burst, and only by gliding.
  const scroll = series(samples, "list").map((s) => s.v.scroll);
  for (let i = 1; i < scroll.length; i++) {
    expect(scroll[i]).toBeGreaterThanOrEqual(scroll[i - 1] - 0.5);
    expect(scroll[i] - scroll[i - 1]).toBeLessThan(12);
  }
  expect(scroll[scroll.length - 1] - scroll[0]).toBeGreaterThan(100);
  // The springy lag: the rows above each arrival trail the glide, a few points at most, and come home.
  const lags = samples.filter((s) => s.v.lag !== undefined).map((s) => s.v.lag);
  const most = Math.max(...lags);
  console.log(`[lag] peak ${most.toFixed(2)}pt`);
  expect(most).toBeGreaterThan(0.5);
  expect(most).toBeLessThanOrEqual(6.01);
  expect(Math.min(...lags)).toBeGreaterThan(-0.5);
}, 600000);

test("under Reduced Motion a burst lands at once: no pop-in, no room opening, no lag", async () => {
  const app = await burst(
    {
      "harness.pace": "120",
      "harness.trace": `${SEND - 300}:1400`,
      "harness.then": `${SEND}:send:say hi;${SEND + 260}:send:are you there;${SEND + 520}:send:one more thing`,
    },
    true,
  );
  const samples = await film(app);
  const ids = bubbleIds(samples);
  expect(ids.length).toBe(3);
  for (const s of samples) {
    if (s.v.eo !== undefined) expect(s.v.eo).toBe(1);
    if (s.v.ey !== undefined) expect(s.v.ey).toBe(0);
    if (s.v.lag !== undefined) expect(s.v.lag).toBe(0);
    if (s.v.dim !== undefined) expect(s.v.dim).toBe(1);
  }
  oneSeat(samples);
}, 600000);

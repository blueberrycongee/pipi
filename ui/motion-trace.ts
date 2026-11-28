// A frame-by-frame recorder for the transcript's motion, off unless a harness
// turns it on (`harness.trace`). Screenshots on a real platform come ~110ms
// apart and native animations keep the platform's own clock, so a film cannot
// see one 16ms frame; this reads what the compositor is drawing instead: each
// registered `AnimatedValue` where it moves (`getValue`, on the UI thread) and
// each registered view's laid-out frame, once per display frame.

import { type AnimatedValue, cleanup, type ViewRef } from "nsh";

export interface MotionSample {
  /** ms since the recording began. */
  t: number;
  /** The probe's row id (read each frame: list cells are recycled), or `list`. */
  id: string;
  /** The channels read this frame, by name, and the laid-out frame (`y`, `h`) of its node. */
  v: Record<string, number>;
}

interface Probe {
  id: () => string;
  values: Record<string, AnimatedValue>;
  node?: () => ViewRef | undefined;
}

let enabled = false;
const probes = new Set<Probe>();

export const motionTraceOn = () => enabled;
export function enableMotionTrace() {
  enabled = true;
}

/** Registers what a row moves with (and the view whose frame it moves), for the life of the calling component. */
export function traceMotion(id: () => string, values: Record<string, AnimatedValue>, node?: () => ViewRef | undefined) {
  if (!enabled) return;
  const probe: Probe = { id, values, node };
  probes.add(probe);
  cleanup(() => probes.delete(probe));
}

/** Records every probe once a display frame for `ms`; a probe's channels and frame merge into one sample per row per frame. */
export function recordMotion(ms: number): Promise<MotionSample[]> {
  const out = new Map<string, MotionSample>();
  const pending: Promise<void>[] = [];
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const t = Date.now() - start;
      for (const probe of probes) {
        const id = probe.id();
        if (!id) continue;
        const names = Object.keys(probe.values);
        const node = probe.node?.();
        pending.push(
          Promise.all([Promise.all(names.map((n) => probe.values[n].getValue())), node ? node.measure() : Promise.resolve(null)])
            .then(([vals, frame]) => {
              const key = `${t}:${id}`;
              const sample = out.get(key) ?? { t, id, v: {} };
              names.forEach((n, i) => (sample.v[n] = Math.round(vals[i] * 1000) / 1000));
              if (frame) {
                sample.v.x = Math.round(frame.pagePosition.x * 10) / 10;
                sample.v.y = Math.round(frame.pagePosition.y * 10) / 10;
                sample.v.h = Math.round(frame.bounds.size.height * 10) / 10;
              }
              out.set(key, sample);
            })
            .catch(() => undefined),
        );
      }
      if (t < ms) requestAnimationFrame(tick);
      else void Promise.all(pending).then(() => resolve([...out.values()].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))));
    };
    requestAnimationFrame(tick);
  });
}

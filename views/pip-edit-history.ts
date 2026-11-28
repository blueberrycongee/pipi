import { signal, untracked } from "nsh";

const EDIT_HISTORY_OPEN_MS = 90;
const EDIT_HISTORY_CLOSE_MS = 200;

type EditHistoryState = { open: boolean; pinned: boolean; suppressed: boolean };
const CLOSED_EDIT_HISTORY: EditHistoryState = { open: false, pinned: false, suppressed: false };
const editHistoryStates = signal<Record<string, EditHistoryState>>({});
const editHistoryHoverParts = new Map<string, Set<string>>();
const editHistoryTimers = new Map<string, { open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout>; suppress?: ReturnType<typeof setTimeout> }>();

export function editHistoryState(key: string): EditHistoryState {
  return editHistoryStates()[key] ?? CLOSED_EDIT_HISTORY;
}

function patchEditHistory(key: string, patch: Partial<EditHistoryState>) {
  const next = { ...editHistoryState(key), ...patch };
  editHistoryStates.update((all) => {
    const copy = { ...all };
    if (!next.open && !next.pinned && !next.suppressed) delete copy[key];
    else copy[key] = next;
    return copy;
  });
}

function editHistoryTimerSlot(key: string) {
  let slot = editHistoryTimers.get(key);
  if (!slot) {
    slot = {};
    editHistoryTimers.set(key, slot);
  }
  return slot;
}

function clearEditHistoryTimer(key: string, kind: "open" | "close" | "suppress") {
  const slot = editHistoryTimers.get(key);
  const timer = slot?.[kind];
  if (timer) clearTimeout(timer);
  if (slot) delete slot[kind];
}

function clearEditHistoryTimers(key: string) {
  for (const kind of ["open", "close", "suppress"] as const) clearEditHistoryTimer(key, kind);
}

function editHistoryHovered(key: string) {
  return (editHistoryHoverParts.get(key)?.size ?? 0) > 0;
}

function scheduleEditHistorySuppressionClear(key: string) {
  clearEditHistoryTimer(key, "suppress");
  editHistoryTimerSlot(key).suppress = setTimeout(() => {
    clearEditHistoryTimer(key, "suppress");
    patchEditHistory(key, { suppressed: false });
  }, EDIT_HISTORY_CLOSE_MS);
}

function addEditHistoryHover(key: string, part: "trigger" | "history" | "bridge") {
  let parts = editHistoryHoverParts.get(key);
  if (!parts) {
    parts = new Set();
    editHistoryHoverParts.set(key, parts);
  }
  parts.add(part);
}

export function enterEditHistory(key: string, part: "trigger" | "history") {
  addEditHistoryHover(key, part);
  clearEditHistoryTimer(key, "close");
  const state = untracked(() => editHistoryState(key));
  if (state.open || state.suppressed || editHistoryTimerSlot(key).open) return;
  editHistoryTimerSlot(key).open = setTimeout(() => {
    clearEditHistoryTimer(key, "open");
    if (editHistoryHovered(key) && !untracked(() => editHistoryState(key)).suppressed) patchEditHistory(key, { open: true });
  }, EDIT_HISTORY_OPEN_MS);
}

export function enterEditHistoryBridge(key: string) {
  addEditHistoryHover(key, "bridge");
  if (untracked(() => editHistoryState(key)).open) clearEditHistoryTimer(key, "close");
}

export function leaveEditHistory(key: string, part: "trigger" | "history" | "bridge") {
  const parts = editHistoryHoverParts.get(key);
  parts?.delete(part);
  if (parts?.size === 0) editHistoryHoverParts.delete(key);
  clearEditHistoryTimer(key, "open");
  if (editHistoryHovered(key)) return;
  const state = untracked(() => editHistoryState(key));
  if (state.suppressed) {
    scheduleEditHistorySuppressionClear(key);
    return;
  }
  if (!state.open || state.pinned) return;
  clearEditHistoryTimer(key, "close");
  editHistoryTimerSlot(key).close = setTimeout(() => {
    clearEditHistoryTimer(key, "close");
    const now = untracked(() => editHistoryState(key));
    if (!editHistoryHovered(key) && !now.pinned) patchEditHistory(key, { open: false });
  }, EDIT_HISTORY_CLOSE_MS);
}

function suppressEditHistory(key: string) {
  patchEditHistory(key, { suppressed: true });
  scheduleEditHistorySuppressionClear(key);
}

export function toggleEditHistoryPin(key: string) {
  clearEditHistoryTimers(key);
  const state = untracked(() => editHistoryState(key));
  if (state.pinned) {
    patchEditHistory(key, { pinned: false, open: false });
    suppressEditHistory(key);
  } else {
    patchEditHistory(key, { pinned: true, open: true, suppressed: false });
  }
}

export function closeEditHistory(key: string) {
  clearEditHistoryTimers(key);
  patchEditHistory(key, { pinned: false, open: false });
  suppressEditHistory(key);
}


let escapeBlocked = () => false;
export function setEditHistoryEscapeBlocker(blocked: () => boolean) {
  escapeBlocked = blocked;
}
export function editHistoryEscapeBlocked() {
  return escapeBlocked();
}

export function resetEditHistories() {
  for (const key of Array.from(editHistoryTimers.keys())) clearEditHistoryTimers(key);
  editHistoryTimers.clear();
  editHistoryHoverParts.clear();
  editHistoryStates.set({});
}

export function closeAnyEditHistory() {
  const entries = Object.keys(untracked(() => editHistoryStates()))
    .map((key) => [key, editHistoryState(key)] as const)
    .filter(([, state]) => state.open);
  for (const [key] of entries) closeEditHistory(key);
  return entries.length > 0;
}

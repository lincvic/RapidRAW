import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { Invokes } from '../components/ui/AppProperties';
import type { PersistedAdjustments } from '../types/imageLoading';
import type { Adjustments } from '../utils/adjustments';

const HISTORY_DEBOUNCE_MS = 500;
const SAVE_DEBOUNCE_MS = 300;

export type EditorInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type HistoryCommit = (adjustments: Adjustments) => void;

interface PendingHistory {
  commit: HistoryCommit;
  generation: number;
  value: Adjustments;
}

export interface SuspendedHistoryToken {
  readonly commit: HistoryCommit;
  readonly generation: number;
  readonly value: Adjustments;
}

interface SaveRecord {
  id: number;
  value: PersistedAdjustments;
}

interface ActiveSave {
  promise: Promise<void>;
  record: SaveRecord;
}

interface SaveState {
  active: ActiveSave | null;
  failed: SaveRecord | null;
  flushPromise: Promise<void> | null;
  holdCount: number;
  holdPromise: Promise<void> | null;
  nextId: number;
  queue: SaveRecord[];
  releaseHold: (() => void) | null;
  scheduled: SaveRecord | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const clone = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) as T;
  }
  return value;
};

export interface EditorPersistence {
  cancelPendingHistory(): void;
  cancelPendingSave(path: string): Promise<void>;
  flushPendingSave(path: string): Promise<void>;
  restorePendingHistory(token: SuspendedHistoryToken | null | undefined): void;
  runAfterEditorSave(path: string, complete: () => Promise<unknown> | unknown): Promise<void>;
  runEditorMutation(
    path: string,
    mutate: () => Promise<unknown>,
    commit: (historyToken: SuspendedHistoryToken | null) => void,
  ): Promise<void>;
  runEditorTransition(path: string | null | undefined, commit: () => void, shouldCommit?: () => boolean): Promise<void>;
  scheduleHistory(value: Adjustments, commit: HistoryCommit): void;
  scheduleSave(path: string, value: PersistedAdjustments | undefined): void;
  suspendPendingHistory(): SuspendedHistoryToken | null;
}

export function createEditorPersistence(invoke: EditorInvoke): EditorPersistence {
  let historyGeneration = 0;
  let historyTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingHistory: PendingHistory | null = null;
  const restoredTokens = new WeakSet<SuspendedHistoryToken>();
  const saves = new Map<string, SaveState>();

  const clearHistoryTimer = () => {
    if (historyTimer !== null) {
      clearTimeout(historyTimer);
      historyTimer = null;
    }
  };

  const armHistoryTimer = (pending: PendingHistory) => {
    clearHistoryTimer();
    pendingHistory = pending;
    historyTimer = setTimeout(() => {
      if (pendingHistory !== pending) return;
      pendingHistory = null;
      historyTimer = null;
      pending.commit(clone(pending.value));
    }, HISTORY_DEBOUNCE_MS);
  };

  const scheduleHistory = (value: Adjustments, commit: HistoryCommit) => {
    const pending = {
      commit,
      generation: ++historyGeneration,
      value: clone(value),
    };
    armHistoryTimer(pending);
  };

  const cancelPendingHistory = () => {
    clearHistoryTimer();
    pendingHistory = null;
  };

  const suspendPendingHistory = (): SuspendedHistoryToken | null => {
    if (pendingHistory === null) return null;
    const token = pendingHistory;
    clearHistoryTimer();
    pendingHistory = null;
    return token;
  };

  const restorePendingHistory = (token: SuspendedHistoryToken | null | undefined) => {
    if (!token || restoredTokens.has(token)) return;
    restoredTokens.add(token);
    if (pendingHistory !== null || token.generation < historyGeneration) return;
    armHistoryTimer({ commit: token.commit, generation: token.generation, value: clone(token.value) });
  };

  const getSaveState = (path: string): SaveState => {
    const existing = saves.get(path);
    if (existing) return existing;
    const created: SaveState = {
      active: null,
      failed: null,
      flushPromise: null,
      holdCount: 0,
      holdPromise: null,
      nextId: 0,
      queue: [],
      releaseHold: null,
      scheduled: null,
      timer: null,
    };
    saves.set(path, created);
    return created;
  };

  const clearSaveTimer = (state: SaveState) => {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  };

  const deleteSaveStateIfIdle = (path: string, state: SaveState) => {
    if (
      saves.get(path) === state &&
      state.active === null &&
      state.failed === null &&
      state.flushPromise === null &&
      state.holdCount === 0 &&
      state.holdPromise === null &&
      state.queue.length === 0 &&
      state.scheduled === null &&
      state.timer === null
    ) {
      saves.delete(path);
    }
  };

  const newestRecord = (records: Array<SaveRecord | null | undefined>): SaveRecord => {
    const available = records.filter((record): record is SaveRecord => record !== null && record !== undefined);
    return available.reduce((newest, record) => (record.id > newest.id ? record : newest));
  };

  const failSave = (state: SaveState, record: SaveRecord) => {
    state.failed = newestRecord([state.failed, record, state.queue.at(-1), state.scheduled]);
    state.queue = [];
    state.scheduled = null;
    clearSaveTimer(state);
  };

  const pumpSaveQueue = (path: string, state: SaveState) => {
    if (state.active !== null || state.queue.length === 0) return;
    const record = state.queue.shift() as SaveRecord;
    const active = {} as ActiveSave;
    const operation = Promise.resolve()
      .then(() => invoke(Invokes.SaveMetadataAndUpdateThumbnail, { path, adjustments: record.value }))
      .then(
        () => {
          if (state.active !== active) return;
          state.active = null;
          if (state.failed && state.failed.id <= record.id) state.failed = null;
          pumpSaveQueue(path, state);
          deleteSaveStateIfIdle(path, state);
        },
        (error) => {
          if (state.active === active) state.active = null;
          failSave(state, record);
          throw error;
        },
      );
    active.promise = operation;
    active.record = record;
    state.active = active;
    void operation.catch(() => undefined);
  };

  const enqueueSave = (path: string, state: SaveState, record: SaveRecord) => {
    state.queue.push(record);
    pumpSaveQueue(path, state);
  };

  const triggerScheduledSave = (path: string, state: SaveState) => {
    const scheduled = state.scheduled;
    if (scheduled === null) return;
    clearSaveTimer(state);
    state.scheduled = null;
    enqueueSave(path, state, scheduled);
  };

  const armSaveTimer = (path: string, state: SaveState, record: SaveRecord) => {
    if (state.holdCount > 0) return;
    state.timer = setTimeout(() => {
      if (state.scheduled !== record) return;
      triggerScheduledSave(path, state);
    }, SAVE_DEBOUNCE_MS);
  };

  const acquireSaveHold = (state: SaveState) => {
    clearSaveTimer(state);
    state.holdCount += 1;
    if (state.holdCount > 1) return;
    state.holdPromise = new Promise<void>((resolve) => {
      state.releaseHold = resolve;
    });
  };

  const releaseSaveHold = (path: string, state: SaveState, armPendingTimer: boolean) => {
    if (state.holdCount === 0) return;
    state.holdCount -= 1;
    if (state.holdCount > 0) return;

    const release = state.releaseHold;
    state.holdPromise = null;
    state.releaseHold = null;
    release?.();

    if (armPendingTimer && state.scheduled) armSaveTimer(path, state, state.scheduled);
    deleteSaveStateIfIdle(path, state);
  };

  const scheduleSave = (path: string, value: PersistedAdjustments | undefined) => {
    if (value === undefined) return;
    const state = getSaveState(path);
    const record = { id: ++state.nextId, value: clone(value) };
    clearSaveTimer(state);

    if (state.failed !== null) {
      state.failed = record;
      state.scheduled = null;
      return;
    }

    state.scheduled = record;
    armSaveTimer(path, state, record);
  };

  const hasPendingSave = (state: SaveState): boolean =>
    state.active !== null || state.failed !== null || state.queue.length > 0 || state.scheduled !== null;

  const drainSaveState = async (path: string, state: SaveState, onDrained?: () => void): Promise<void> => {
    while (true) {
      triggerScheduledSave(path, state);
      pumpSaveQueue(path, state);

      if (state.active !== null) {
        const active = state.active;
        await active.promise;
        continue;
      }

      if (state.queue.length > 0) continue;

      if (state.failed !== null) {
        enqueueSave(path, state, state.failed);
        continue;
      }

      await Promise.resolve();
      if (!hasPendingSave(state)) {
        onDrained?.();
        return;
      }
    }
  };

  const flushPendingSave = (path: string): Promise<void> => {
    const state = saves.get(path);
    if (!state) return Promise.resolve();
    if (state.holdPromise !== null) {
      return state.holdPromise.then(() => flushPendingSave(path));
    }
    if (state.flushPromise !== null) return state.flushPromise;

    const operation = drainSaveState(path, state);

    state.flushPromise = operation;
    void operation.then(
      () => {
        if (state.flushPromise === operation) {
          state.flushPromise = null;
          deleteSaveStateIfIdle(path, state);
        }
      },
      () => {
        if (state.flushPromise === operation) state.flushPromise = null;
      },
    );
    return operation;
  };

  const cancelPendingSave = async (path: string): Promise<void> => {
    const state = saves.get(path);
    if (!state) return;
    clearSaveTimer(state);
    state.scheduled = null;

    if (state.flushPromise !== null) {
      await state.flushPromise;
      return;
    }

    while (state.active !== null || state.queue.length > 0) {
      pumpSaveQueue(path, state);
      const active = state.active;
      if (active !== null) await active.promise;
    }
    deleteSaveStateIfIdle(path, state);
  };

  const acquireSaveHoldAfterFlush = async (path: string): Promise<SaveState> => {
    while (true) {
      const preflight = flushPendingSave(path);
      const state = getSaveState(path);
      if (state.holdCount > 0) {
        await preflight;
        continue;
      }

      acquireSaveHold(state);
      try {
        await preflight;
        return state;
      } catch (error) {
        releaseSaveHold(path, state, true);
        throw error;
      }
    }
  };

  const runWithClosedSaveWindow = async (path: string, complete: () => Promise<unknown> | unknown): Promise<void> => {
    while (true) {
      const preflight = flushPendingSave(path);
      const state = getSaveState(path);
      if (state.holdCount > 0) {
        await preflight;
        continue;
      }

      acquireSaveHold(state);
      try {
        await preflight;
      } catch (error) {
        releaseSaveHold(path, state, true);
        throw error;
      }

      if (hasPendingSave(state)) {
        releaseSaveHold(path, state, false);
        continue;
      }

      try {
        await complete();
      } finally {
        releaseSaveHold(path, state, true);
      }
      return;
    }
  };

  const runEditorTransition = async (
    path: string | null | undefined,
    commit: () => void,
    shouldCommit: () => boolean = () => true,
  ): Promise<void> => {
    const historyToken = suspendPendingHistory();
    let didCommit = false;
    const guardedCommit = () => {
      if (!shouldCommit()) return;
      cancelPendingHistory();
      commit();
      didCommit = true;
    };
    try {
      if (path) {
        await runWithClosedSaveWindow(path, guardedCommit);
      } else {
        guardedCommit();
      }
    } catch (error) {
      restorePendingHistory(historyToken);
      throw error;
    }

    if (!didCommit) restorePendingHistory(historyToken);
  };

  const runAfterEditorSave = async (path: string, complete: () => Promise<unknown> | unknown): Promise<void> => {
    await runWithClosedSaveWindow(path, complete);
  };

  const runEditorMutation = async (
    path: string,
    mutate: () => Promise<unknown>,
    commit: (historyToken: SuspendedHistoryToken | null) => void,
  ): Promise<void> => {
    const historyToken = suspendPendingHistory();
    let heldState: SaveState | null = null;
    try {
      heldState = await acquireSaveHoldAfterFlush(path);
      await mutate();
      await drainSaveState(path, heldState, () => commit(historyToken));
      releaseSaveHold(path, heldState, true);
      heldState = null;
    } catch (error) {
      if (heldState) releaseSaveHold(path, heldState, true);
      restorePendingHistory(historyToken);
      throw error;
    }
  };

  return {
    cancelPendingHistory,
    cancelPendingSave,
    flushPendingSave,
    restorePendingHistory,
    runAfterEditorSave,
    runEditorMutation,
    runEditorTransition,
    scheduleHistory,
    scheduleSave,
    suspendPendingHistory,
  };
}

const defaultEditorPersistence = createEditorPersistence((command, args) => tauriInvoke(command, args));

export const cancelPendingHistory = defaultEditorPersistence.cancelPendingHistory;
export const cancelPendingSave = defaultEditorPersistence.cancelPendingSave;
export const flushPendingSave = defaultEditorPersistence.flushPendingSave;
export const restorePendingHistory = defaultEditorPersistence.restorePendingHistory;
export const runAfterEditorSave = defaultEditorPersistence.runAfterEditorSave;
export const runEditorMutation = defaultEditorPersistence.runEditorMutation;
export const runEditorTransition = defaultEditorPersistence.runEditorTransition;
export const scheduleHistory = defaultEditorPersistence.scheduleHistory;
export const scheduleSave = defaultEditorPersistence.scheduleSave;
export const suspendPendingHistory = defaultEditorPersistence.suspendPendingHistory;

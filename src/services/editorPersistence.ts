import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { Invokes } from '../components/ui/AppProperties';
import type { PersistedAdjustments } from '../types/imageLoading';
import type { Adjustments } from '../utils/adjustments';
import { EditorImageLoadCancelledError } from './editorImageLoad';

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

interface InFlightHistoryOwnership {
  claimedByReset: boolean;
  readonly id: number;
  readonly token: SuspendedHistoryToken | null;
}

export enum ResetBarrierOutcome {
  Success = 'success',
  PreflightSaveFailure = 'preflight_save_failure',
  RecoverableFailure = 'recoverable_failure',
  UnsafeSidecarFailure = 'unsafe_sidecar_failure',
}

export interface ResetBarrierToken {
  readonly path: string;
  readonly generation: number;
  readonly preflightDrain: Promise<void>;
}

export class EditorResetBarrierCancelledError extends EditorImageLoadCancelledError {
  readonly outcome: Exclude<ResetBarrierOutcome, ResetBarrierOutcome.Success>;

  constructor(outcome: Exclude<ResetBarrierOutcome, ResetBarrierOutcome.Success>) {
    super();
    this.name = 'EditorResetBarrierCancelledError';
    this.outcome = outcome;
  }
}

export interface ResetAdjustmentsErrorPayload {
  kind: string;
  path: string;
  message: string;
  rollback_succeeded: boolean;
}

export interface AuthoritativeResetOptions<TSnapshot> {
  path: string;
  rollbackValue: PersistedAdjustments | undefined;
  beginReload(historyToken: SuspendedHistoryToken | null): TSnapshot;
  restoreReload(snapshot: TSnapshot): void;
  invokeReset(): Promise<unknown>;
  onSuccess(): void;
  beginRecoveryReload(): void;
}

const parseResetErrorCandidate = (candidate: unknown): ResetAdjustmentsErrorPayload | null => {
  if (candidate === null || typeof candidate !== 'object') return null;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.kind !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.message !== 'string' ||
    typeof value.rollback_succeeded !== 'boolean'
  ) {
    return null;
  }
  return {
    kind: value.kind,
    path: value.path,
    message: value.message,
    rollback_succeeded: value.rollback_succeeded,
  };
};

export const parseResetAdjustmentsError = (error: unknown): ResetAdjustmentsErrorPayload | null => {
  const direct = parseResetErrorCandidate(error);
  if (direct) return direct;

  const serialized =
    typeof error === 'string'
      ? error
      : error instanceof Error && typeof error.message === 'string'
        ? error.message
        : null;
  if (!serialized) return null;
  try {
    return parseResetErrorCandidate(JSON.parse(serialized));
  } catch {
    return null;
  }
};

export const resetAdjustmentsErrorMessage = (error: unknown): string => {
  const payload = parseResetAdjustmentsError(error);
  if (payload) return `${payload.message} [${payload.path}]`;
  return error instanceof Error ? error.message : String(error);
};

interface SaveRecord {
  id: number;
  value: PersistedAdjustments;
}

interface ActiveSave {
  promise: Promise<void>;
  record: SaveRecord;
}

interface ResetBarrierState {
  buffered: SaveRecord | null;
  completion: Promise<void>;
  reject: (error: EditorResetBarrierCancelledError) => void;
  resolve: () => void;
  token: ResetBarrierToken;
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
  resetBarrier: ResetBarrierState | null;
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
  beginResetBarrier(path: string, rollbackValue: PersistedAdjustments | undefined): ResetBarrierToken;
  cancelPendingHistory(): void;
  cancelPendingSave(path: string): Promise<void>;
  flushPendingSave(path: string): Promise<void>;
  finishResetBarrier(token: ResetBarrierToken, outcome: ResetBarrierOutcome): PersistedAdjustments | undefined;
  restorePendingHistory(token: SuspendedHistoryToken | null | undefined, commit?: HistoryCommit): void;
  runAuthoritativeReset<TSnapshot>(options: AuthoritativeResetOptions<TSnapshot>): Promise<void>;
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
  const inFlightHistoryOwnerships = new Map<number, InFlightHistoryOwnership>();
  const restoredTokens = new WeakSet<SuspendedHistoryToken>();
  const saves = new Map<string, SaveState>();
  let nextHistoryOwnershipId = 0;
  let resetBarrierGeneration = 0;

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

  const beginHistoryOwnership = (): InFlightHistoryOwnership => {
    const ownership = {
      claimedByReset: false,
      id: ++nextHistoryOwnershipId,
      token: suspendPendingHistory(),
    };
    inFlightHistoryOwnerships.set(ownership.id, ownership);
    return ownership;
  };

  const finishHistoryOwnership = (ownership: InFlightHistoryOwnership, restore: boolean) => {
    if (!inFlightHistoryOwnerships.delete(ownership.id)) return;
    if (restore && !ownership.claimedByReset) restorePendingHistory(ownership.token);
  };

  const claimHistoryForReset = (): SuspendedHistoryToken | null => {
    let newest = suspendPendingHistory();
    inFlightHistoryOwnerships.forEach((ownership) => {
      if (ownership.claimedByReset) return;
      ownership.claimedByReset = true;
      if (ownership.token && (!newest || ownership.token.generation > newest.generation)) {
        newest = ownership.token;
      }
    });
    return newest;
  };

  const restorePendingHistory = (token: SuspendedHistoryToken | null | undefined, commit?: HistoryCommit) => {
    if (!token || restoredTokens.has(token)) return;
    restoredTokens.add(token);
    if (pendingHistory !== null || token.generation < historyGeneration) return;
    armHistoryTimer({ commit: commit ?? token.commit, generation: token.generation, value: clone(token.value) });
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
      resetBarrier: null,
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
      state.resetBarrier === null &&
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

  const newestRecordOrNull = (records: Array<SaveRecord | null | undefined>): SaveRecord | null => {
    const available = records.filter((record): record is SaveRecord => record !== null && record !== undefined);
    return available.length === 0 ? null : newestRecord(available);
  };

  const failSave = (state: SaveState, record: SaveRecord) => {
    state.failed = newestRecord([state.failed, record, state.queue.at(-1), state.scheduled]);
    state.queue = [];
    state.scheduled = null;
    clearSaveTimer(state);
  };

  const startSave = (path: string, state: SaveState, record: SaveRecord): Promise<void> => {
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
    return operation;
  };

  const pumpSaveQueue = (path: string, state: SaveState) => {
    if (state.resetBarrier !== null || state.active !== null || state.queue.length === 0) return;
    const record = state.queue.shift() as SaveRecord;
    startSave(path, state, record);
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

    if (state.resetBarrier !== null) {
      state.resetBarrier.buffered = newestRecordOrNull([state.resetBarrier.buffered, record]);
      return;
    }

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
    if (state.resetBarrier !== null) {
      return state.resetBarrier.completion.then(() => flushPendingSave(path));
    }
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

  const beginResetBarrier = (path: string, rollbackValue: PersistedAdjustments | undefined): ResetBarrierToken => {
    const state = getSaveState(path);
    if (state.resetBarrier !== null) throw new Error(`A reset barrier is already active for '${path}'`);

    clearSaveTimer(state);
    const dormantFailed = state.active === null ? state.failed : null;
    const rollbackRecord = rollbackValue === undefined ? null : { id: ++state.nextId, value: clone(rollbackValue) };
    const buffered = newestRecordOrNull([state.failed, state.queue.at(-1), state.scheduled, rollbackRecord]);
    state.queue = [];
    state.scheduled = null;

    let resolve!: () => void;
    let reject!: (error: EditorResetBarrierCancelledError) => void;
    const completion = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void completion.catch(() => undefined);
    const existingHold = state.holdPromise;
    const existingDrain =
      state.active?.promise ?? (dormantFailed === null ? state.flushPromise : null) ?? Promise.resolve();
    const existingWork = existingHold ? existingHold.then(() => existingDrain) : existingDrain;
    const generation = ++resetBarrierGeneration;
    const preflightDrain = existingWork.then(() => {
      if (state.resetBarrier?.token.generation !== generation || dormantFailed === null) return;
      return startSave(path, state, dormantFailed);
    });
    const token = Object.freeze({
      path,
      generation,
      preflightDrain,
    });
    state.resetBarrier = { buffered, completion, reject, resolve, token };
    return token;
  };

  const finishResetBarrier = (
    token: ResetBarrierToken,
    outcome: ResetBarrierOutcome,
  ): PersistedAdjustments | undefined => {
    const state = saves.get(token.path);
    const barrier = state?.resetBarrier;
    if (!state || !barrier || barrier.token.generation !== token.generation) {
      throw new Error(`Cannot finish stale reset barrier for '${token.path}'`);
    }

    const retained = newestRecordOrNull([barrier.buffered, state.failed, state.queue.at(-1), state.scheduled]);
    clearSaveTimer(state);
    state.failed = outcome === ResetBarrierOutcome.PreflightSaveFailure ? retained : null;
    state.queue = [];
    state.scheduled = null;
    state.resetBarrier = null;

    if (outcome === ResetBarrierOutcome.Success) {
      barrier.resolve();
    } else {
      barrier.reject(new EditorResetBarrierCancelledError(outcome));
    }
    deleteSaveStateIfIdle(token.path, state);
    return outcome === ResetBarrierOutcome.Success || !retained ? undefined : clone(retained.value);
  };

  const resetFailureIsRecoverable = (error: unknown): boolean => {
    const payload = parseResetAdjustmentsError(error);
    return (
      payload?.rollback_succeeded === true &&
      payload.kind !== 'read' &&
      payload.kind !== 'parse' &&
      payload.kind !== 'rollback'
    );
  };

  const runAuthoritativeReset = async <TSnapshot>(options: AuthoritativeResetOptions<TSnapshot>): Promise<void> => {
    const historyToken = claimHistoryForReset();
    let barrier: ResetBarrierToken;
    try {
      barrier = beginResetBarrier(options.path, options.rollbackValue);
    } catch (error) {
      restorePendingHistory(historyToken);
      throw error;
    }

    let snapshot: TSnapshot;
    try {
      snapshot = options.beginReload(historyToken);
    } catch (error) {
      finishResetBarrier(barrier, ResetBarrierOutcome.PreflightSaveFailure);
      restorePendingHistory(historyToken);
      throw error;
    }

    try {
      await barrier.preflightDrain;
    } catch (error) {
      options.restoreReload(snapshot);
      finishResetBarrier(barrier, ResetBarrierOutcome.PreflightSaveFailure);
      throw error;
    }

    try {
      await options.invokeReset();
    } catch (error) {
      options.restoreReload(snapshot);
      if (resetFailureIsRecoverable(error)) {
        const recoveryValue = finishResetBarrier(barrier, ResetBarrierOutcome.RecoverableFailure);
        if (recoveryValue !== undefined) {
          scheduleSave(options.path, recoveryValue);
          await flushPendingSave(options.path);
        }
        options.beginRecoveryReload();
      } else {
        finishResetBarrier(barrier, ResetBarrierOutcome.UnsafeSidecarFailure);
      }
      throw error;
    }

    finishResetBarrier(barrier, ResetBarrierOutcome.Success);
    options.onSuccess();
  };

  const cancelPendingSave = async (path: string): Promise<void> => {
    const state = saves.get(path);
    if (!state) return;
    if (state.resetBarrier !== null) {
      await state.resetBarrier.completion;
      return cancelPendingSave(path);
    }
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
      const resetBarrier = saves.get(path)?.resetBarrier;
      if (resetBarrier) {
        await resetBarrier.completion;
        continue;
      }

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
      const resetBarrier = saves.get(path)?.resetBarrier;
      if (resetBarrier) {
        await resetBarrier.completion;
        continue;
      }

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
    const historyOwnership = beginHistoryOwnership();
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
      finishHistoryOwnership(historyOwnership, true);
      throw error;
    }

    finishHistoryOwnership(historyOwnership, !didCommit);
  };

  const runAfterEditorSave = async (path: string, complete: () => Promise<unknown> | unknown): Promise<void> => {
    await runWithClosedSaveWindow(path, complete);
  };

  const runEditorMutation = async (
    path: string,
    mutate: () => Promise<unknown>,
    commit: (historyToken: SuspendedHistoryToken | null) => void,
  ): Promise<void> => {
    const historyOwnership = beginHistoryOwnership();
    let heldState: SaveState | null = null;
    try {
      heldState = await acquireSaveHoldAfterFlush(path);
      await mutate();
      await drainSaveState(path, heldState, () =>
        commit(historyOwnership.claimedByReset ? null : historyOwnership.token),
      );
      releaseSaveHold(path, heldState, true);
      heldState = null;
      finishHistoryOwnership(historyOwnership, false);
    } catch (error) {
      if (heldState) releaseSaveHold(path, heldState, true);
      finishHistoryOwnership(historyOwnership, true);
      throw error;
    }
  };

  return {
    beginResetBarrier,
    cancelPendingHistory,
    cancelPendingSave,
    flushPendingSave,
    finishResetBarrier,
    restorePendingHistory,
    runAuthoritativeReset,
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
export const beginResetBarrier = defaultEditorPersistence.beginResetBarrier;
export const cancelPendingSave = defaultEditorPersistence.cancelPendingSave;
export const flushPendingSave = defaultEditorPersistence.flushPendingSave;
export const finishResetBarrier = defaultEditorPersistence.finishResetBarrier;
export const restorePendingHistory = defaultEditorPersistence.restorePendingHistory;
export const runAuthoritativeReset = defaultEditorPersistence.runAuthoritativeReset;
export const runAfterEditorSave = defaultEditorPersistence.runAfterEditorSave;
export const runEditorMutation = defaultEditorPersistence.runEditorMutation;
export const runEditorTransition = defaultEditorPersistence.runEditorTransition;
export const scheduleHistory = defaultEditorPersistence.scheduleHistory;
export const scheduleSave = defaultEditorPersistence.scheduleSave;
export const suspendPendingHistory = defaultEditorPersistence.suspendPendingHistory;

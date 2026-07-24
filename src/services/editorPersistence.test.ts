import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as asyncNavigation from '../utils/asyncNavigation';
import { createEditorNavigationTransitions } from '../utils/asyncNavigation';
import { normalizeLoadedAdjustments, type Adjustments } from '../utils/adjustments';
import {
  createEditorPersistence,
  EditorResetBarrierCancelledError,
  ResetBarrierOutcome,
  type EditorInvoke,
} from './editorPersistence';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const adjustment = (exposure: number): Adjustments => normalizeLoadedAdjustments({ exposure });

const createHarness = () => {
  const invoke = vi.fn<EditorInvoke>();
  const persistence = createEditorPersistence(invoke);
  return { invoke, persistence };
};

describe('shared editor history persistence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('collapses adjustment bursts from independent callers into the latest history snapshot', () => {
    const { persistence } = createHarness();
    const committed: Adjustments[] = [];
    const callerA = (value: Adjustments) => persistence.scheduleHistory(value, (next) => committed.push(next));
    const callerB = (value: Adjustments) => persistence.scheduleHistory(value, (next) => committed.push(next));

    callerA(adjustment(1));
    callerB(adjustment(2));
    vi.advanceTimersByTime(500);

    expect(committed).toEqual([expect.objectContaining({ exposure: 2 })]);
  });

  it('cancels a pre-navigation history snapshot before it can arrive', () => {
    const { persistence } = createHarness();
    const committed: Adjustments[] = [];
    persistence.scheduleHistory(adjustment(1), (next) => committed.push(next));

    persistence.cancelPendingHistory();
    vi.advanceTimersByTime(500);

    expect(committed).toEqual([]);
  });

  it('suspends and restores the latest history snapshot after an aborted transition', () => {
    const { persistence } = createHarness();
    const committed: Adjustments[] = [];
    persistence.scheduleHistory(adjustment(1), (next) => committed.push(next));
    persistence.scheduleHistory(adjustment(2), (next) => committed.push(next));

    const token = persistence.suspendPendingHistory();
    vi.advanceTimersByTime(500);
    expect(committed).toEqual([]);

    persistence.restorePendingHistory(token);
    vi.advanceTimersByTime(500);
    expect(committed).toEqual([expect.objectContaining({ exposure: 2 })]);
  });

  it('discards suspended history when a transition succeeds', () => {
    const { persistence } = createHarness();
    const committed: Adjustments[] = [];
    persistence.scheduleHistory(adjustment(1), (next) => committed.push(next));

    expect(persistence.suspendPendingHistory()).not.toBeNull();
    vi.advanceTimersByTime(500);

    expect(committed).toEqual([]);
  });

  it('does not let an old restored token overwrite newer history and restores each token only once', () => {
    const { persistence } = createHarness();
    const committed: Adjustments[] = [];
    persistence.scheduleHistory(adjustment(1), (next) => committed.push(next));
    const oldToken = persistence.suspendPendingHistory();
    persistence.scheduleHistory(adjustment(2), (next) => committed.push(next));

    persistence.restorePendingHistory(oldToken);
    persistence.restorePendingHistory(oldToken);
    vi.advanceTimersByTime(500);

    expect(committed).toEqual([expect.objectContaining({ exposure: 2 })]);
  });
});

describe('per-path editor save queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('never invokes a save for undefined persistence output', async () => {
    const { invoke, persistence } = createHarness();

    persistence.scheduleSave('/image.raf', undefined);
    await vi.advanceTimersByTimeAsync(300);
    await persistence.flushPendingSave('/image.raf');

    expect(invoke).not.toHaveBeenCalled();
  });

  it('serializes saves for one path in trigger order', async () => {
    const first = deferred();
    const second = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    persistence.scheduleSave('/image.raf', adjustment(1));
    await vi.advanceTimersByTimeAsync(300);
    persistence.scheduleSave('/image.raf', adjustment(2));
    await vi.advanceTimersByTimeAsync(300);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1]).toMatchObject({ adjustments: { exposure: 1 } });

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toMatchObject({ adjustments: { exposure: 2 } });

    second.resolve();
    await persistence.flushPendingSave('/image.raf');
  });

  it('flushes debounce immediately, deduplicates concurrent flushes, and awaits the invoke', async () => {
    const write = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(write.promise);
    persistence.scheduleSave('/image.raf', adjustment(1));

    let firstSettled = false;
    let secondSettled = false;
    const firstFlush = persistence.flushPendingSave('/image.raf').then(() => {
      firstSettled = true;
    });
    const secondFlush = persistence.flushPendingSave('/image.raf').then(() => {
      secondSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    write.resolve();
    await Promise.all([firstFlush, secondFlush]);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
  });

  it('owns a deep snapshot of the caller value as soon as a save is scheduled', async () => {
    const { invoke, persistence } = createHarness();
    invoke.mockResolvedValue(undefined);
    const callerValue = adjustment(1);
    const scheduledValue = structuredClone(callerValue);

    persistence.scheduleSave('/image.raf', callerValue);
    callerValue.exposure = 99;
    callerValue.curves.luma[0].x = 99;
    await vi.advanceTimersByTimeAsync(300);
    await persistence.flushPendingSave('/image.raf');

    expect(invoke.mock.calls[0][1]).toEqual({ path: '/image.raf', adjustments: scheduledValue });
  });

  it('cancels queued debounce work but still awaits an in-flight write', async () => {
    const write = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(write.promise);
    persistence.scheduleSave('/image.raf', adjustment(1));
    await vi.advanceTimersByTimeAsync(300);
    persistence.scheduleSave('/image.raf', adjustment(2));

    let settled = false;
    const cancellation = persistence.cancelPendingSave('/image.raf').then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(settled).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    write.resolve();
    await cancellation;
    expect(settled).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('retains the exact newest value after rejection and clears it only after a successful retry', async () => {
    const failedWrite = deferred();
    const retryWrite = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockImplementationOnce(() => failedWrite.promise).mockImplementationOnce(() => retryWrite.promise);
    const newest = adjustment(2);

    persistence.scheduleSave('/image.raf', adjustment(1));
    await vi.advanceTimersByTimeAsync(300);
    const failedFlush = persistence.flushPendingSave('/image.raf');
    persistence.scheduleSave('/image.raf', newest);
    failedWrite.reject(new Error('disk full'));
    await expect(failedFlush).rejects.toThrow('disk full');

    const retryFlush = persistence.flushPendingSave('/image.raf');
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toEqual({ path: '/image.raf', adjustments: newest });

    retryWrite.resolve();
    await retryFlush;
    await persistence.flushPendingSave('/image.raf');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed save snapshot isolated from later caller mutations before retry', async () => {
    const failedWrite = deferred();
    const retryWrite = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockImplementationOnce(() => failedWrite.promise).mockImplementationOnce(() => retryWrite.promise);
    const callerValue = adjustment(4);
    const scheduledValue = structuredClone(callerValue);

    persistence.scheduleSave('/image.raf', callerValue);
    await vi.advanceTimersByTimeAsync(300);
    failedWrite.reject(new Error('disk full'));
    await expect(persistence.flushPendingSave('/image.raf')).rejects.toThrow('disk full');

    callerValue.exposure = 88;
    callerValue.curves.luma[0].x = 88;
    const retry = persistence.flushPendingSave('/image.raf');
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls[1][1]).toEqual({ path: '/image.raf', adjustments: scheduledValue });

    retryWrite.resolve();
    await retry;
  });

  it('drains an in-flight write and the already-debounced newest write', async () => {
    const first = deferred();
    const newest = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => newest.promise);
    persistence.scheduleSave('/image.raf', adjustment(1));
    await vi.advanceTimersByTimeAsync(300);
    persistence.scheduleSave('/image.raf', adjustment(2));

    let settled = false;
    const flush = persistence.flushPendingSave('/image.raf').then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(1);

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    newest.resolve();
    await flush;
    expect(settled).toBe(true);
  });
});

describe('navigation save barriers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps the active image request intact when an image switch save fails, then advances it after retry', async () => {
    const failedWrite = deferred();
    const retryWrite = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockImplementationOnce(() => failedWrite.promise).mockImplementationOnce(() => retryWrite.promise);
    const committedHistory: Adjustments[] = [];
    const newest = adjustment(2);
    const selectedImagePathRef = { current: '/old.raf' as string | null };
    const navigationGenerationRef = { current: 3 };
    let editorPath = '/old.raf';
    const transitions = createEditorNavigationTransitions({
      selectedImagePathRef,
      navigationGenerationRef,
      releaseEditorPreviews: vi.fn(),
      clearEditorSession: vi.fn(),
    });
    const switchImage = () => {
      transitions.beginImageSelection('/new.raf');
      editorPath = '/new.raf';
    };

    persistence.scheduleHistory(newest, (value) => committedHistory.push(value));
    persistence.scheduleSave('/old.raf', newest);
    const firstTransition = persistence.runEditorTransition('/old.raf', switchImage);
    await vi.advanceTimersByTimeAsync(0);
    expect({ editorPath, path: selectedImagePathRef.current, generation: navigationGenerationRef.current }).toEqual({
      editorPath: '/old.raf',
      path: '/old.raf',
      generation: 3,
    });

    failedWrite.reject(new Error('save failed'));
    await expect(firstTransition).rejects.toThrow('save failed');
    expect({ editorPath, path: selectedImagePathRef.current, generation: navigationGenerationRef.current }).toEqual({
      editorPath: '/old.raf',
      path: '/old.raf',
      generation: 3,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(committedHistory).toEqual([newest]);

    const secondTransition = persistence.runEditorTransition('/old.raf', switchImage);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls[1][1]).toEqual({ path: '/old.raf', adjustments: newest });
    retryWrite.resolve();
    await secondTransition;

    expect({ editorPath, path: selectedImagePathRef.current, generation: navigationGenerationRef.current }).toEqual({
      editorPath: '/new.raf',
      path: '/new.raf',
      generation: 4,
    });
  });

  it('keeps A active when A is reselected while B is waiting for A to save', async () => {
    const createIntentTracker = (
      asyncNavigation as typeof asyncNavigation & {
        createNavigationIntentTracker?: (generationRef: { current: number }) => {
          begin: () => number;
          isCurrent: (generation: number) => boolean;
        };
      }
    ).createNavigationIntentTracker;
    expect(createIntentTracker).toBeTypeOf('function');
    if (!createIntentTracker) return;

    const save = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(save.promise);
    const selectedImagePathRef = { current: '/a.raf' as string | null };
    const navigationGenerationRef = { current: 7 };
    const intentTracker = createIntentTracker({ current: 0 });
    const transitions = createEditorNavigationTransitions({
      selectedImagePathRef,
      navigationGenerationRef,
      releaseEditorPreviews: vi.fn(),
      clearEditorSession: vi.fn(),
    });
    let editorPath = '/a.raf';

    const bIntent = intentTracker.begin();
    persistence.scheduleSave('/a.raf', adjustment(2));
    const pendingB = persistence.runEditorTransition('/a.raf', () => {
      if (!intentTracker.isCurrent(bIntent)) return;
      transitions.beginImageSelection('/b.raf');
      editorPath = '/b.raf';
    });
    await vi.advanceTimersByTimeAsync(0);

    const repeatedAIntent = intentTracker.begin();
    expect(repeatedAIntent).toBe(2);
    expect(editorPath).toBe('/a.raf');
    expect(navigationGenerationRef.current).toBe(7);

    save.resolve();
    await pendingB;

    expect(editorPath).toBe('/a.raf');
    expect(selectedImagePathRef.current).toBe('/a.raf');
    expect(navigationGenerationRef.current).toBe(7);
  });

  it('restores suspended history when a navigation becomes stale at its save barrier', async () => {
    const save = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(save.promise);
    const committedHistory: Adjustments[] = [];
    const clear = vi.fn();
    let isCurrent = true;
    persistence.scheduleHistory(adjustment(5), (value) => committedHistory.push(value));
    persistence.scheduleSave('/a.raf', adjustment(5));

    const transition = (
      persistence.runEditorTransition as (
        path: string,
        commit: () => void,
        shouldCommit: () => boolean,
      ) => Promise<void>
    )('/a.raf', clear, () => isCurrent);
    await vi.advanceTimersByTimeAsync(0);
    isCurrent = false;
    save.resolve();
    await transition;
    await vi.advanceTimersByTimeAsync(500);

    expect(clear).not.toHaveBeenCalled();
    expect(committedHistory).toEqual([expect.objectContaining({ exposure: 5 })]);
  });

  it.each(['clearForBackToLibrary', 'clearForFolderSelection', 'clearForAlbumSelection'] as const)(
    'drains the active save before running the %s route callback',
    async (route) => {
      const save = deferred();
      const { invoke, persistence } = createHarness();
      invoke.mockReturnValue(save.promise);
      const selectedImagePathRef = { current: '/old.raf' as string | null };
      const navigationGenerationRef = { current: 8 };
      let editorPath: string | null = '/old.raf';
      const transitions = createEditorNavigationTransitions({
        selectedImagePathRef,
        navigationGenerationRef,
        releaseEditorPreviews: vi.fn(),
        clearEditorSession: () => {
          editorPath = null;
        },
      });

      persistence.scheduleSave('/old.raf', adjustment(3));
      const operation = persistence.runEditorTransition('/old.raf', transitions[route]);
      await vi.advanceTimersByTimeAsync(0);
      expect({ editorPath, path: selectedImagePathRef.current, generation: navigationGenerationRef.current }).toEqual({
        editorPath: '/old.raf',
        path: '/old.raf',
        generation: 8,
      });

      save.resolve();
      await operation;
      expect({ editorPath, path: selectedImagePathRef.current, generation: navigationGenerationRef.current }).toEqual({
        editorPath: null,
        path: null,
        generation: 9,
      });
    },
  );

  it('drains a save scheduled immediately after a transition starts', async () => {
    const save = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(save.promise);
    const commit = vi.fn();

    const operation = persistence.runEditorTransition('/old.raf', commit);
    persistence.scheduleSave('/old.raf', adjustment(3));
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();

    save.resolve();
    await operation;
    expect(commit).toHaveBeenCalledOnce();
  });
});

describe('backend adjustment mutation barriers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('waits for the queued save and restores history when the backend mutation fails', async () => {
    const save = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(save.promise);
    const committedHistory: Adjustments[] = [];
    const mutate = vi.fn().mockRejectedValue(new Error('reset failed'));
    const commit = vi.fn();
    const latest = adjustment(3);

    persistence.scheduleHistory(latest, (value) => committedHistory.push(value));
    persistence.scheduleSave('/image.raf', latest);
    const operation = persistence.runEditorMutation('/image.raf', mutate, commit);
    await vi.advanceTimersByTimeAsync(0);

    expect(mutate).not.toHaveBeenCalled();
    save.resolve();
    await expect(operation).rejects.toThrow('reset failed');
    expect(mutate).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(committedHistory).toEqual([latest]);
  });

  it('commits the reload with suspended history only after the backend mutation succeeds', async () => {
    const mutation = deferred();
    const { persistence } = createHarness();
    const commit = vi.fn();

    persistence.scheduleHistory(adjustment(4), vi.fn());
    const operation = persistence.runEditorMutation('/image.raf', () => mutation.promise, commit);
    await vi.advanceTimersByTimeAsync(0);
    expect(commit).not.toHaveBeenCalled();

    mutation.resolve();
    await operation;
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ exposure: 4 }) }));
  });

  it('holds edits made during a backend mutation and flushes them before reload commit', async () => {
    const mutation = deferred();
    const lateSave = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(lateSave.promise);
    const commit = vi.fn();

    const operation = persistence.runEditorMutation('/image.raf', () => mutation.promise, commit);
    await vi.advanceTimersByTimeAsync(0);
    persistence.scheduleSave('/image.raf', adjustment(5));
    await vi.advanceTimersByTimeAsync(300);
    expect(invoke).not.toHaveBeenCalled();

    mutation.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();

    lateSave.resolve();
    await operation;
    expect(commit).toHaveBeenCalledOnce();
  });

  it('holds a save scheduled immediately after a backend mutation starts', async () => {
    const mutation = deferred();
    const save = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(save.promise);
    const mutate = vi.fn(() => mutation.promise);
    const commit = vi.fn();

    const operation = persistence.runEditorMutation('/image.raf', mutate, commit);
    persistence.scheduleSave('/image.raf', adjustment(6));
    await vi.advanceTimersByTimeAsync(0);
    expect(mutate).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(300);
    expect(invoke).not.toHaveBeenCalled();

    mutation.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();

    save.resolve();
    await operation;
    expect(commit).toHaveBeenCalledOnce();
  });

  it('drains a save queued in the microtask after mutation resolution before committing reload', async () => {
    const mutation = deferred();
    const lateSave = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(lateSave.promise);
    const commit = vi.fn();

    const operation = persistence.runEditorMutation('/image.raf', () => mutation.promise, commit);
    await vi.advanceTimersByTimeAsync(0);
    mutation.resolve();
    queueMicrotask(() => persistence.scheduleSave('/image.raf', adjustment(7)));
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();

    lateSave.resolve();
    await operation;
    expect(commit).toHaveBeenCalledOnce();
  });

  it('commits in the same continuation as the final held-drain check', async () => {
    const mutation = deferred();
    const lateSave = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(lateSave.promise);
    const order: string[] = [];
    const commit = vi.fn(() => order.push('commit'));

    const operation = persistence.runEditorMutation('/image.raf', () => mutation.promise, commit);
    await vi.advanceTimersByTimeAsync(0);
    mutation.resolve();
    queueMicrotask(() => {
      queueMicrotask(() => {
        order.push('schedule');
        persistence.scheduleSave('/image.raf', adjustment(8));
      });
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(commit).toHaveBeenCalledOnce();
    expect(order).toEqual(['commit', 'schedule']);
    expect(invoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(invoke).toHaveBeenCalledOnce();
    lateSave.resolve();
    await operation;
  });

  it('restores suspended history when the post-mutation held drain rejects', async () => {
    const mutation = deferred();
    const lateSave = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(lateSave.promise);
    const restoredHistory: Adjustments[] = [];
    const pendingHistory = adjustment(8);
    const commit = vi.fn();

    persistence.scheduleHistory(pendingHistory, (value) => restoredHistory.push(value));
    const operation = persistence.runEditorMutation('/image.raf', () => mutation.promise, commit);
    await vi.advanceTimersByTimeAsync(0);
    mutation.resolve();
    queueMicrotask(() => persistence.scheduleSave('/image.raf', adjustment(9)));
    await vi.advanceTimersByTimeAsync(300);
    expect(invoke).toHaveBeenCalledOnce();

    lateSave.reject(new Error('late save failed'));
    await expect(operation).rejects.toThrow('late save failed');
    expect(commit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(restoredHistory).toEqual([pendingHistory]);
  });
});

describe('authoritative reset barriers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('buffers every save for the path and blocks flush until successful reset completion', async () => {
    const { invoke, persistence } = createHarness();
    const rollback = adjustment(2);
    const newest = adjustment(3);
    persistence.scheduleSave('/image.raf', adjustment(1));

    const barrier = persistence.beginResetBarrier('/image.raf', rollback);
    persistence.scheduleSave('/image.raf', newest);
    let flushSettled = false;
    const flush = persistence.flushPendingSave('/image.raf').then(() => {
      flushSettled = true;
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(invoke).not.toHaveBeenCalled();
    expect(flushSettled).toBe(false);
    expect(await barrier.preflightDrain).toBeUndefined();

    expect(persistence.finishResetBarrier(barrier, ResetBarrierOutcome.Success)).toBeUndefined();
    await flush;
    expect(flushSettled).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('waits only for the already-in-flight save and never pumps buffered work during reset', async () => {
    const active = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(active.promise);
    persistence.scheduleSave('/image.raf', adjustment(1));
    await vi.advanceTimersByTimeAsync(300);

    const barrier = persistence.beginResetBarrier('/image.raf', adjustment(2));
    persistence.scheduleSave('/image.raf', adjustment(3));
    let preflightSettled = false;
    const preflight = barrier.preflightDrain.then(() => {
      preflightSettled = true;
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(invoke).toHaveBeenCalledOnce();
    expect(preflightSettled).toBe(false);

    active.resolve();
    await preflight;
    expect(invoke).toHaveBeenCalledOnce();

    persistence.finishResetBarrier(barrier, ResetBarrierOutcome.Success);
    await persistence.flushPendingSave('/image.raf');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('makes a waiting loader receive typed cancellation on recoverable failure, then requeues the newest value', async () => {
    const { invoke, persistence } = createHarness();
    invoke.mockResolvedValue(undefined);
    const rollback = adjustment(4);
    const newest = adjustment(5);
    const barrier = persistence.beginResetBarrier('/image.raf', rollback);
    persistence.scheduleSave('/image.raf', newest);
    const waitingLoader = persistence.flushPendingSave('/image.raf');

    const recovery = persistence.finishResetBarrier(barrier, ResetBarrierOutcome.RecoverableFailure);

    await expect(waitingLoader).rejects.toMatchObject({
      name: 'EditorResetBarrierCancelledError',
      outcome: ResetBarrierOutcome.RecoverableFailure,
    });
    expect(recovery).toEqual(newest);
    persistence.scheduleSave('/image.raf', recovery);
    await persistence.flushPendingSave('/image.raf');
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0][1]).toEqual({ path: '/image.raf', adjustments: newest });
  });

  it('discards unsafe buffered disk work while cancelling the loader', async () => {
    const { invoke, persistence } = createHarness();
    const barrier = persistence.beginResetBarrier('/image.raf', adjustment(6));
    persistence.scheduleSave('/image.raf', adjustment(7));
    const waitingLoader = persistence.flushPendingSave('/image.raf');

    const retained = persistence.finishResetBarrier(barrier, ResetBarrierOutcome.UnsafeSidecarFailure);

    expect(retained).toMatchObject({ exposure: 7 });
    await expect(waitingLoader).rejects.toBeInstanceOf(EditorResetBarrierCancelledError);
    await persistence.flushPendingSave('/image.raf');
    await vi.advanceTimersByTimeAsync(300);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the newest failed value retryable when the preflight save rejects', async () => {
    const failed = deferred();
    const retry = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockImplementationOnce(() => failed.promise).mockImplementationOnce(() => retry.promise);
    persistence.scheduleSave('/image.raf', adjustment(1));
    await vi.advanceTimersByTimeAsync(300);

    const barrier = persistence.beginResetBarrier('/image.raf', adjustment(2));
    const waitingLoader = persistence.flushPendingSave('/image.raf');
    failed.reject(new Error('preflight disk failure'));
    await expect(barrier.preflightDrain).rejects.toThrow('preflight disk failure');
    persistence.finishResetBarrier(barrier, ResetBarrierOutcome.PreflightSaveFailure);
    await expect(waitingLoader).rejects.toMatchObject({
      outcome: ResetBarrierOutcome.PreflightSaveFailure,
    });

    const retried = persistence.flushPendingSave('/image.raf');
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toMatchObject({ adjustments: { exposure: 2 } });
    retry.resolve();
    await retried;
  });

  it('requires the current opaque token to finish a barrier', () => {
    const { persistence } = createHarness();
    const barrier = persistence.beginResetBarrier('/image.raf', adjustment(1));
    const stale = { ...barrier, generation: barrier.generation - 1 };

    expect(() => persistence.finishResetBarrier(stale, ResetBarrierOutcome.Success)).toThrow(/stale reset barrier/i);
    persistence.finishResetBarrier(barrier, ResetBarrierOutcome.Success);
  });

  it('releases a metadata loader only after reset success and success-side cache work', async () => {
    const reset = deferred();
    const { invoke, persistence } = createHarness();
    const events: string[] = [];
    const operation = persistence.runAuthoritativeReset({
      path: '/image.raf',
      rollbackValue: adjustment(1),
      beginReload: () => {
        events.push('begin_reload');
        return { snapshot: true };
      },
      restoreReload: () => events.push('restore'),
      invokeReset: () => {
        events.push('reset');
        return reset.promise;
      },
      onSuccess: () => events.push('delete_cache'),
      beginRecoveryReload: () => events.push('fresh_reload'),
    });
    await vi.advanceTimersByTimeAsync(0);
    const loader = persistence.flushPendingSave('/image.raf').then(() => events.push('load_metadata'));
    persistence.scheduleSave('/image.raf', adjustment(2));
    await vi.advanceTimersByTimeAsync(300);

    expect(events).toEqual(['begin_reload', 'reset']);
    expect(invoke).not.toHaveBeenCalled();

    reset.resolve();
    await operation;
    await loader;
    expect(events).toEqual(['begin_reload', 'reset', 'delete_cache', 'load_metadata']);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('lets a transition wait behind an open reset barrier without acquiring a deadlocking save hold', async () => {
    const reset = deferred();
    const { persistence } = createHarness();
    const events: string[] = [];
    const resetOperation = persistence.runAuthoritativeReset({
      path: '/image.raf',
      rollbackValue: adjustment(1),
      beginReload: () => {
        events.push('begin_reload');
        return { snapshot: true };
      },
      restoreReload: () => events.push('restore'),
      invokeReset: async () => {
        events.push('reset');
        await reset.promise;
      },
      onSuccess: () => events.push('reset_success'),
      beginRecoveryReload: () => events.push('fresh_reload'),
    });
    await vi.advanceTimersByTimeAsync(0);

    let transitionSettled = false;
    const transition = persistence
      .runEditorTransition('/image.raf', () => events.push('transition'))
      .then(() => {
        transitionSettled = true;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['begin_reload', 'reset']);

    reset.resolve();
    await resetOperation;
    await vi.advanceTimersByTimeAsync(0);
    expect(transitionSettled).toBe(true);
    await transition;
    expect(events).toEqual(['begin_reload', 'reset', 'reset_success', 'transition']);
  });

  it('waits for an existing mutation hold before invoking an authoritative reset', async () => {
    const mutation = deferred();
    const reset = deferred();
    const { persistence } = createHarness();
    const events: string[] = [];
    const mutationOperation = persistence.runEditorMutation(
      '/image.raf',
      async () => {
        events.push('mutation');
        await mutation.promise;
      },
      () => events.push('mutation_commit'),
    );
    await vi.advanceTimersByTimeAsync(0);

    const invokeReset = vi.fn(async () => {
      events.push('reset');
      await reset.promise;
    });
    const resetOperation = persistence.runAuthoritativeReset({
      path: '/image.raf',
      rollbackValue: adjustment(2),
      beginReload: () => {
        events.push('begin_reload');
        return { snapshot: true };
      },
      restoreReload: () => events.push('restore'),
      invokeReset,
      onSuccess: () => events.push('reset_success'),
      beginRecoveryReload: () => events.push('fresh_reload'),
    });
    await vi.advanceTimersByTimeAsync(0);
    const invokedBeforeMutationFinished = invokeReset.mock.calls.length;

    mutation.resolve();
    await mutationOperation;
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeReset).toHaveBeenCalledOnce();
    reset.resolve();
    await resetOperation;

    expect(invokedBeforeMutationFinished).toBe(0);
    expect(events).toEqual(['mutation', 'begin_reload', 'mutation_commit', 'reset', 'reset_success']);
  });

  it('never invokes reset when a save preflight held by another mutation rejects', async () => {
    const save = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(save.promise);
    const mutate = vi.fn();
    persistence.scheduleSave('/image.raf', adjustment(1));
    const mutationOperation = persistence.runEditorMutation('/image.raf', mutate, vi.fn()).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledOnce();

    const invokeReset = vi.fn();
    const restoreReload = vi.fn();
    const resetOperation = persistence
      .runAuthoritativeReset({
        path: '/image.raf',
        rollbackValue: adjustment(1),
        beginReload: () => ({ snapshot: true }),
        restoreReload,
        invokeReset,
        onSuccess: vi.fn(),
        beginRecoveryReload: vi.fn(),
      })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeReset).not.toHaveBeenCalled();

    save.reject(new Error('held preflight failed'));
    await expect(mutationOperation).resolves.toMatchObject({ message: 'held preflight failed' });
    await expect(resetOperation).resolves.toMatchObject({ message: 'held preflight failed' });
    expect(mutate).not.toHaveBeenCalled();
    expect(restoreReload).toHaveBeenCalledOnce();
    expect(invokeReset).not.toHaveBeenCalled();
  });

  it('cancels the old loader, persists the newest edit, then starts one fresh reload after recoverable failure', async () => {
    const reset = deferred();
    const { invoke, persistence } = createHarness();
    const events: string[] = [];
    const committedHistory: Adjustments[] = [];
    const pendingHistory = adjustment(7);
    let capturedHistory: ReturnType<typeof persistence.suspendPendingHistory> = null;
    let retryHistory: ReturnType<typeof persistence.suspendPendingHistory> = null;
    invoke.mockImplementation(async () => {
      events.push('save');
    });
    const backendError = {
      kind: 'write',
      path: '/image.raf.rrdata',
      message: 'synthetic write failure',
      rollback_succeeded: true,
    };
    persistence.scheduleHistory(pendingHistory, (value) => committedHistory.push(value));
    const operation = persistence
      .runAuthoritativeReset({
        path: '/image.raf',
        rollbackValue: adjustment(3),
        beginReload: (historyToken) => {
          events.push('begin_reload');
          capturedHistory = historyToken;
          return { historyToken };
        },
        restoreReload: ({ historyToken }) => {
          events.push('restore');
          persistence.restorePendingHistory(historyToken);
        },
        invokeReset: () => {
          events.push('reset');
          return reset.promise;
        },
        onSuccess: () => events.push('delete_cache'),
        beginRecoveryReload: () => {
          events.push('fresh_reload');
          retryHistory = persistence.suspendPendingHistory();
          persistence.restorePendingHistory(retryHistory);
        },
      })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    const oldLoader = persistence.flushPendingSave('/image.raf').catch((error) => error);
    const newest = adjustment(4);
    persistence.scheduleSave('/image.raf', newest);

    reset.reject(backendError);
    expect(await operation).toEqual(backendError);
    expect(await oldLoader).toMatchObject({
      outcome: ResetBarrierOutcome.RecoverableFailure,
    });
    expect(events).toEqual(['begin_reload', 'reset', 'restore', 'save', 'fresh_reload']);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0][1]).toEqual({ path: '/image.raf', adjustments: newest });
    await vi.advanceTimersByTimeAsync(500);
    expect(committedHistory).toEqual([pendingHistory]);
    persistence.restorePendingHistory(capturedHistory);
    persistence.restorePendingHistory(retryHistory);
    await vi.advanceTimersByTimeAsync(500);
    expect(committedHistory).toEqual([pendingHistory]);
  });

  it('retries a retained recovery-save failure before a consecutive reset and aborts if the retry fails', async () => {
    const firstRecoverySave = deferred();
    const secondPreflightRetry = deferred();
    const retainedRetry = deferred();
    const { invoke, persistence } = createHarness();
    invoke
      .mockImplementationOnce(() => firstRecoverySave.promise)
      .mockImplementationOnce(() => secondPreflightRetry.promise)
      .mockImplementationOnce(() => retainedRetry.promise);
    const backendError = {
      kind: 'write',
      path: '/image.raf.rrdata',
      message: 'synthetic write failure',
      rollback_succeeded: true,
    };
    const firstSaveError = new Error('first recovery save failed');
    const firstOperation = persistence
      .runAuthoritativeReset({
        path: '/image.raf',
        rollbackValue: adjustment(1),
        beginReload: () => ({ snapshot: 'first' }),
        restoreReload: vi.fn(),
        invokeReset: () => Promise.reject(backendError),
        onSuccess: vi.fn(),
        beginRecoveryReload: vi.fn(),
      })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledOnce();

    firstRecoverySave.reject(firstSaveError);
    await expect(firstOperation).resolves.toBe(firstSaveError);

    const retryError = new Error('second preflight retry failed');
    const restoreReload = vi.fn();
    const invokeReset = vi.fn();
    const onSuccess = vi.fn();
    const beginRecoveryReload = vi.fn();
    const secondOperation = persistence
      .runAuthoritativeReset({
        path: '/image.raf',
        rollbackValue: adjustment(2),
        beginReload: () => ({ snapshot: 'second' }),
        restoreReload,
        invokeReset,
        onSuccess,
        beginRecoveryReload,
      })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toMatchObject({ adjustments: { exposure: 1 } });
    expect(invokeReset).not.toHaveBeenCalled();

    secondPreflightRetry.reject(retryError);
    await expect(secondOperation).resolves.toBe(retryError);
    expect(restoreReload).toHaveBeenCalledOnce();
    expect(invokeReset).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(beginRecoveryReload).not.toHaveBeenCalled();

    const retainedFlush = persistence.flushPendingSave('/image.raf');
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls[2][1]).toMatchObject({ adjustments: { exposure: 2 } });
    retainedRetry.resolve();
    await retainedFlush;
  });

  it('invokes a consecutive reset only after its retained recovery-save retry succeeds', async () => {
    const firstRecoverySave = deferred();
    const secondPreflightRetry = deferred();
    const reset = deferred();
    const { invoke, persistence } = createHarness();
    invoke
      .mockImplementationOnce(() => firstRecoverySave.promise)
      .mockImplementationOnce(() => secondPreflightRetry.promise);
    const backendError = {
      kind: 'write',
      path: '/image.raf.rrdata',
      message: 'synthetic write failure',
      rollback_succeeded: true,
    };
    const firstSaveError = new Error('first recovery save failed');
    const firstOperation = persistence
      .runAuthoritativeReset({
        path: '/image.raf',
        rollbackValue: adjustment(3),
        beginReload: () => ({ snapshot: 'first' }),
        restoreReload: vi.fn(),
        invokeReset: () => Promise.reject(backendError),
        onSuccess: vi.fn(),
        beginRecoveryReload: vi.fn(),
      })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledOnce();

    firstRecoverySave.reject(firstSaveError);
    await expect(firstOperation).resolves.toBe(firstSaveError);

    const restoreReload = vi.fn();
    const invokeReset = vi.fn(() => reset.promise);
    const onSuccess = vi.fn();
    const beginRecoveryReload = vi.fn();
    let secondOperationSettled = false;
    const secondOperation = persistence
      .runAuthoritativeReset({
        path: '/image.raf',
        rollbackValue: adjustment(4),
        beginReload: () => ({ snapshot: 'second' }),
        restoreReload,
        invokeReset,
        onSuccess,
        beginRecoveryReload,
      })
      .then(() => {
        secondOperationSettled = true;
      });
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toMatchObject({ adjustments: { exposure: 3 } });
    expect(invokeReset).not.toHaveBeenCalled();
    expect(secondOperationSettled).toBe(false);

    secondPreflightRetry.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeReset).toHaveBeenCalledOnce();
    expect(secondOperationSettled).toBe(false);

    reset.resolve();
    await secondOperation;
    expect(restoreReload).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(beginRecoveryReload).not.toHaveBeenCalled();
  });

  it.each(['read', 'parse', 'rollback'])(
    'restores memory but performs no save or reload for unsafe %s failure',
    async (kind) => {
      const reset = deferred();
      const { invoke, persistence } = createHarness();
      const restoreReload = vi.fn();
      const beginRecoveryReload = vi.fn();
      const committedHistory: Adjustments[] = [];
      const pendingHistory = adjustment(7);
      let capturedHistory: ReturnType<typeof persistence.suspendPendingHistory> = null;
      const backendError = {
        kind,
        path: '/image.raf.rrdata',
        message: `synthetic ${kind} failure`,
        rollback_succeeded: false,
      };
      persistence.scheduleHistory(pendingHistory, (value) => committedHistory.push(value));
      const operation = persistence
        .runAuthoritativeReset({
          path: '/image.raf',
          rollbackValue: adjustment(5),
          beginReload: (historyToken) => {
            capturedHistory = historyToken;
            return { historyToken };
          },
          restoreReload: ({ historyToken }) => {
            restoreReload();
            persistence.restorePendingHistory(historyToken);
          },
          invokeReset: () => reset.promise,
          onSuccess: vi.fn(),
          beginRecoveryReload,
        })
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      const oldLoader = persistence.flushPendingSave('/image.raf').catch((error) => error);
      persistence.scheduleSave('/image.raf', adjustment(6));

      reset.reject(backendError);
      expect(await operation).toEqual(backendError);
      expect(await oldLoader).toMatchObject({ outcome: ResetBarrierOutcome.UnsafeSidecarFailure });
      expect(restoreReload).toHaveBeenCalledOnce();
      expect(beginRecoveryReload).not.toHaveBeenCalled();
      await persistence.flushPendingSave('/image.raf');
      await vi.advanceTimersByTimeAsync(500);
      expect(invoke).not.toHaveBeenCalled();
      expect(committedHistory).toEqual([pendingHistory]);
      persistence.restorePendingHistory(capturedHistory);
      await vi.advanceTimersByTimeAsync(500);
      expect(committedHistory).toEqual([pendingHistory]);
    },
  );

  it('aborts before reset on preflight failure and restores the newest history token exactly once', async () => {
    const save = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(save.promise);
    const invokeReset = vi.fn();
    const committedHistory: Adjustments[] = [];
    const newest = adjustment(9);
    let capturedHistory: ReturnType<typeof persistence.suspendPendingHistory> = null;
    persistence.scheduleHistory(newest, (value) => committedHistory.push(value));
    persistence.scheduleSave('/image.raf', newest);
    await vi.advanceTimersByTimeAsync(300);

    const operation = persistence
      .runAuthoritativeReset({
        path: '/image.raf',
        rollbackValue: newest,
        beginReload: (historyToken) => {
          capturedHistory = historyToken;
          return { historyToken };
        },
        restoreReload: (snapshot) => persistence.restorePendingHistory(snapshot.historyToken),
        invokeReset,
        onSuccess: vi.fn(),
        beginRecoveryReload: vi.fn(),
      })
      .catch((error) => error);
    const oldLoader = persistence.flushPendingSave('/image.raf').catch((error) => error);
    save.reject(new Error('preflight disk failure'));

    await expect(operation).resolves.toMatchObject({ message: 'preflight disk failure' });
    expect(await oldLoader).toMatchObject({ outcome: ResetBarrierOutcome.PreflightSaveFailure });
    expect(invokeReset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(committedHistory).toEqual([newest]);
    persistence.restorePendingHistory(capturedHistory);
    await vi.advanceTimersByTimeAsync(500);
    expect(committedHistory).toEqual([newest]);
  });

  it('transfers stale navigation history ownership to a concurrent failed reset', async () => {
    const save = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(save.promise);
    const latest = adjustment(11);
    const committedHistory: Adjustments[] = [];
    const navigationCommit = vi.fn();
    const resetError = {
      kind: 'read',
      path: '/image.raf.rrdata',
      message: 'synthetic reset read failure',
      rollback_succeeded: false,
    };
    let sessionGeneration = 1;
    const editGeneration = sessionGeneration;
    let navigationIsCurrent = true;

    persistence.scheduleHistory(latest, (value) => {
      if (sessionGeneration === editGeneration) committedHistory.push(value);
    });
    persistence.scheduleSave('/image.raf', latest);
    const transition = persistence.runEditorTransition('/image.raf', navigationCommit, () => navigationIsCurrent);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledOnce();
    navigationIsCurrent = false;

    const beginReload = vi.fn((historyToken: ReturnType<typeof persistence.suspendPendingHistory>) => {
      sessionGeneration += 1;
      return { historyToken };
    });
    const restoreReload = vi.fn((snapshot: { historyToken: ReturnType<typeof persistence.suspendPendingHistory> }) => {
      const restoredGeneration = ++sessionGeneration;
      persistence.restorePendingHistory(snapshot.historyToken, (value) => {
        if (sessionGeneration === restoredGeneration) committedHistory.push(value);
      });
    });
    const invokeReset = vi.fn().mockRejectedValue(resetError);
    const resetOperation = persistence
      .runAuthoritativeReset({
        path: '/image.raf',
        rollbackValue: latest,
        beginReload,
        restoreReload,
        invokeReset,
        onSuccess: vi.fn(),
        beginRecoveryReload: vi.fn(),
      })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    const reloadsBeforeNavigationReleasedHistory = beginReload.mock.calls.length;

    save.resolve();
    await transition;
    await vi.advanceTimersByTimeAsync(0);
    expect(await resetOperation).toEqual(resetError);
    await vi.advanceTimersByTimeAsync(500);

    expect(reloadsBeforeNavigationReleasedHistory).toBe(1);
    expect(navigationCommit).not.toHaveBeenCalled();
    expect(invokeReset).toHaveBeenCalledOnce();
    expect(beginReload).toHaveBeenCalledWith(expect.objectContaining({ value: latest }));
    expect(restoreReload).toHaveBeenCalledOnce();
    expect(committedHistory).toEqual([latest]);
  });

  it('transfers mutation-owned history to reset without committing it twice', async () => {
    const mutation = deferred();
    const { persistence } = createHarness();
    const latest = adjustment(12);
    const committedHistory: Adjustments[] = [];
    const resetError = {
      kind: 'parse',
      path: '/image.raf.rrdata',
      message: 'synthetic reset parse failure',
      rollback_succeeded: false,
    };
    let sessionGeneration = 1;
    const editGeneration = sessionGeneration;
    let mutationHistory: ReturnType<typeof persistence.suspendPendingHistory> | undefined;

    persistence.scheduleHistory(latest, (value) => {
      if (sessionGeneration === editGeneration) committedHistory.push(value);
    });
    const mutationOperation = persistence.runEditorMutation(
      '/image.raf',
      () => mutation.promise,
      (historyToken) => {
        mutationHistory = historyToken;
      },
    );
    await vi.advanceTimersByTimeAsync(0);

    const beginReload = vi.fn((historyToken: ReturnType<typeof persistence.suspendPendingHistory>) => {
      sessionGeneration += 1;
      return { historyToken };
    });
    const restoreReload = vi.fn((snapshot: { historyToken: ReturnType<typeof persistence.suspendPendingHistory> }) => {
      const restoredGeneration = ++sessionGeneration;
      persistence.restorePendingHistory(snapshot.historyToken, (value) => {
        if (sessionGeneration === restoredGeneration) committedHistory.push(value);
      });
    });
    const resetOperation = persistence
      .runAuthoritativeReset({
        path: '/image.raf',
        rollbackValue: latest,
        beginReload,
        restoreReload,
        invokeReset: vi.fn().mockRejectedValue(resetError),
        onSuccess: vi.fn(),
        beginRecoveryReload: vi.fn(),
      })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);

    mutation.resolve();
    await mutationOperation;
    await vi.advanceTimersByTimeAsync(0);
    expect(await resetOperation).toEqual(resetError);
    await vi.advanceTimersByTimeAsync(500);

    expect(beginReload).toHaveBeenCalledWith(expect.objectContaining({ value: latest }));
    expect(mutationHistory).toBeNull();
    expect(restoreReload).toHaveBeenCalledOnce();
    expect(committedHistory).toEqual([latest]);
  });
});

describe('external editor completion barrier', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not run completion until a save queued behind an in-flight save succeeds', async () => {
    const firstSave = deferred();
    const newestSave = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockImplementationOnce(() => firstSave.promise).mockImplementationOnce(() => newestSave.promise);
    const complete = vi.fn();

    persistence.scheduleSave('/external.raf', adjustment(6));
    const operation = persistence.runAfterEditorSave('/external.raf', complete);
    await vi.advanceTimersByTimeAsync(0);
    persistence.scheduleSave('/external.raf', adjustment(7));
    await vi.advanceTimersByTimeAsync(300);
    expect(complete).not.toHaveBeenCalled();

    firstSave.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toMatchObject({ adjustments: { exposure: 7 } });
    expect(complete).not.toHaveBeenCalled();

    newestSave.resolve();
    await operation;
    expect(complete).toHaveBeenCalledOnce();
  });

  it('drains a save scheduled immediately after completion starts', async () => {
    const save = deferred();
    const { invoke, persistence } = createHarness();
    invoke.mockReturnValue(save.promise);
    const complete = vi.fn();

    const operation = persistence.runAfterEditorSave('/external.raf', complete);
    persistence.scheduleSave('/external.raf', adjustment(8));
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();

    save.resolve();
    await operation;
    expect(complete).toHaveBeenCalledOnce();
  });
});

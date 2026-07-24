import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as asyncNavigation from '../utils/asyncNavigation';
import { createEditorNavigationTransitions } from '../utils/asyncNavigation';
import { normalizeLoadedAdjustments, type Adjustments } from '../utils/adjustments';
import { createEditorPersistence, type EditorInvoke } from './editorPersistence';

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

import { describe, expect, it, vi } from 'vitest';
import * as asyncNavigation from './asyncNavigation';
import {
  createEditorNavigationTransitions,
  createNavigationIntentTracker,
  isReadyNavigationTarget,
  navigateAndRunOnSuccess,
  navigateExternalEditSource,
  resolveForCurrentNavigation,
} from './asyncNavigation';

describe('async navigation outcomes', () => {
  it('runs dependent state changes only after navigation succeeds', async () => {
    const onSuccess = vi.fn();

    await expect(navigateAndRunOnSuccess('/generated.tif', vi.fn().mockResolvedValue(false), onSuccess)).resolves.toBe(
      false,
    );
    expect(onSuccess).not.toHaveBeenCalled();

    await expect(navigateAndRunOnSuccess('/generated.tif', vi.fn().mockResolvedValue(true), onSuccess)).resolves.toBe(
      true,
    );
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('accepts an external-edit target only when the requested image is ready', () => {
    expect(isReadyNavigationTarget('/requested.raf', null)).toBe(false);
    expect(isReadyNavigationTarget('/requested.raf', { path: '/previous.raf', isReady: true })).toBe(false);
    expect(isReadyNavigationTarget('/requested.raf', { path: '/requested.raf', isReady: false })).toBe(false);
    expect(isReadyNavigationTarget('/requested.raf', { path: '/requested.raf', isReady: true })).toBe(true);
  });

  it('routes external-edit navigation failure and rejection through the active abort contract', async () => {
    const abort = vi.fn();
    await expect(
      navigateExternalEditSource('/external.raf', vi.fn().mockResolvedValue(false), () => true, abort),
    ).resolves.toBe(false);
    expect(abort).toHaveBeenLastCalledWith('Could not open the external edit source.');

    await expect(
      navigateExternalEditSource('/external.raf', vi.fn().mockRejectedValue('save failed'), () => true, abort),
    ).resolves.toBe(false);
    expect(abort).toHaveBeenLastCalledWith('save failed');

    abort.mockClear();
    await navigateExternalEditSource('/external.raf', vi.fn().mockResolvedValue(false), () => false, abort);
    expect(abort).not.toHaveBeenCalled();
  });

  it('keeps staged external navigation pending until the matching image is ready', async () => {
    const navigateAndWaitForReady = (
      asyncNavigation as typeof asyncNavigation & {
        navigateAndWaitForReady?: (
          path: string,
          navigate: (path: string) => Promise<boolean>,
          getTarget: () => { path: string; isReady: boolean } | null,
          subscribe: (onChange: () => void) => () => void,
          isActive: () => boolean,
          signal?: AbortSignal,
        ) => Promise<boolean>;
      }
    ).navigateAndWaitForReady;
    expect(navigateAndWaitForReady).toBeTypeOf('function');
    if (!navigateAndWaitForReady) return;

    let target: { path: string; isReady: boolean } | null = { path: '/external.raf', isReady: false };
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const notify = () => listeners.forEach((listener) => listener());

    let settled = false;
    const ready = navigateAndWaitForReady(
      '/external.raf',
      vi.fn().mockResolvedValue(true),
      () => target,
      subscribe,
      () => true,
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    target = { path: '/external.raf', isReady: true };
    notify();
    await expect(ready).resolves.toBe(true);
    expect(listeners.size).toBe(0);

    target = { path: '/external.raf', isReady: false };
    const failed = navigateAndWaitForReady(
      '/external.raf',
      vi.fn().mockResolvedValue(true),
      () => target,
      subscribe,
      () => true,
    );
    await Promise.resolve();
    target = null;
    notify();
    await expect(failed).resolves.toBe(false);
    expect(listeners.size).toBe(0);

    target = { path: '/external.raf', isReady: false };
    let abortRequestActive = true;
    let abortSettled = false;
    const abortController = new AbortController();
    const aborted = navigateAndWaitForReady(
      '/external.raf',
      vi.fn().mockResolvedValue(true),
      () => target,
      subscribe,
      () => abortRequestActive,
      abortController.signal,
    ).then((result) => {
      abortSettled = true;
      return result;
    });
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    abortRequestActive = false;
    abortController.abort();
    await expect(aborted).resolves.toBe(false);
    expect(abortSettled).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it('invalidates an export when a same-source external session is replaced', async () => {
    type ExportToken = { sessionGeneration: number; exportGeneration: number };
    const createOperationTracker = (
      asyncNavigation as typeof asyncNavigation & {
        createExternalEditOperationTracker?: () => {
          beginSession: () => {
            generation: number;
            invalidatedExport: ExportToken | null;
            invalidatedExportDispatchInFlight?: boolean;
            invalidatedExportWasDispatched?: boolean;
          };
          beginExport: (sessionGeneration: number) => ExportToken | null;
          commitExportIfCurrent: (token: ExportToken, commit: () => void) => boolean;
          commitExportCompletionIfCurrent?: (token: ExportToken, commit: () => void) => boolean;
          currentExport: () => ExportToken | null;
          finishExport: (token: ExportToken) => boolean;
          markExportDispatchStarted?: (token: ExportToken) => boolean;
          markExportDispatched?: (token: ExportToken) => boolean;
          markSessionPrepared?: (sessionGeneration: number) => boolean;
        };
      }
    ).createExternalEditOperationTracker;
    expect(createOperationTracker).toBeTypeOf('function');
    if (!createOperationTracker) return;

    const firstSession = { source: '/same.raf', output: '/first.tif', format: 'tif' };
    const replacementSession = { source: '/same.raf', output: '/second.jpg', format: 'jpg' };
    expect(replacementSession.source).toBe(firstSession.source);
    const tracker = createOperationTracker();
    const firstGeneration = tracker.beginSession().generation;
    expect(tracker.markSessionPrepared).toBeTypeOf('function');
    if (!tracker.markSessionPrepared) return;
    tracker.markSessionPrepared(firstGeneration);
    const firstExport = tracker.beginExport(firstGeneration);
    expect(firstExport).not.toBeNull();
    if (!firstExport) return;

    const replacement = tracker.beginSession();
    expect(replacement.invalidatedExport).toBe(firstExport);
    expect(replacement.invalidatedExportWasDispatched).toBe(false);
    expect(tracker.commitExportIfCurrent(firstExport, vi.fn())).toBe(false);

    const exits: string[] = [];
    tracker.markSessionPrepared(replacement.generation);
    const replacementExport = tracker.beginExport(replacement.generation);
    expect(replacementExport).not.toBeNull();
    if (!replacementExport) return;
    expect(tracker.commitExportCompletionIfCurrent).toBeTypeOf('function');
    expect(tracker.markExportDispatchStarted).toBeTypeOf('function');
    expect(tracker.markExportDispatched).toBeTypeOf('function');
    if (
      !tracker.commitExportCompletionIfCurrent ||
      !tracker.markExportDispatchStarted ||
      !tracker.markExportDispatched
    ) {
      return;
    }
    expect(tracker.commitExportCompletionIfCurrent(replacementExport, () => exits.push('stale-success'))).toBe(false);
    expect(tracker.markExportDispatchStarted(replacementExport)).toBe(true);
    expect(tracker.markExportDispatched(replacementExport)).toBe(true);
    expect(
      tracker.commitExportCompletionIfCurrent(replacementExport, () => exits.push(replacementSession.output)),
    ).toBe(true);
    expect(exits).toEqual(['/second.jpg']);

    expect(tracker.finishExport(replacementExport)).toBe(true);
    expect(tracker.currentExport()).toBeNull();
    expect(tracker.commitExportIfCurrent(replacementExport, () => exits.push('untagged-success'))).toBe(false);
    expect(exits).toEqual(['/second.jpg']);

    const dispatchedTracker = createOperationTracker();
    const dispatchedSession = dispatchedTracker.beginSession();
    if (!dispatchedTracker.markSessionPrepared) return;
    dispatchedTracker.markSessionPrepared(dispatchedSession.generation);
    const dispatchedExport = dispatchedTracker.beginExport(dispatchedSession.generation);
    expect(dispatchedExport).not.toBeNull();
    expect(dispatchedTracker.markExportDispatchStarted).toBeTypeOf('function');
    if (!dispatchedExport || !dispatchedTracker.markExportDispatchStarted || !dispatchedTracker.markExportDispatched) {
      return;
    }
    dispatchedTracker.markExportDispatchStarted(dispatchedExport);
    dispatchedTracker.markExportDispatched(dispatchedExport);
    expect(dispatchedTracker.beginSession().invalidatedExportWasDispatched).toBe(true);

    const inFlightTracker = createOperationTracker();
    const inFlightSession = inFlightTracker.beginSession();
    if (!inFlightTracker.markSessionPrepared) return;
    inFlightTracker.markSessionPrepared(inFlightSession.generation);
    const inFlightExport = inFlightTracker.beginExport(inFlightSession.generation);
    expect(inFlightExport).not.toBeNull();
    if (!inFlightExport || !inFlightTracker.markExportDispatchStarted) return;
    inFlightTracker.markExportDispatchStarted(inFlightExport);
    const inFlightReplacement = inFlightTracker.beginSession();
    expect(inFlightReplacement.invalidatedExportDispatchInFlight).toBe(true);

    const cancelInvalidatedExport = (
      asyncNavigation as typeof asyncNavigation & {
        cancelInvalidatedExternalEditExport?: (
          sessionStart: typeof inFlightReplacement,
          waitForDispatch: (token: ExportToken) => Promise<boolean>,
          cancel: () => Promise<void>,
        ) => Promise<void>;
      }
    ).cancelInvalidatedExternalEditExport;
    expect(cancelInvalidatedExport).toBeTypeOf('function');
    if (!cancelInvalidatedExport) return;
    let resolveDispatch!: (accepted: boolean) => void;
    const dispatchResult = new Promise<boolean>((resolve) => {
      resolveDispatch = resolve;
    });
    const cancel = vi.fn().mockResolvedValue(undefined);
    const cancellation = cancelInvalidatedExport(inFlightReplacement, () => dispatchResult, cancel);
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
    resolveDispatch(true);
    await cancellation;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps a replacement external session unprepared until cancellation and matching readiness finish', async () => {
    type ExportToken = { sessionGeneration: number; exportGeneration: number };
    const createOperationTracker = (
      asyncNavigation as typeof asyncNavigation & {
        createExternalEditOperationTracker?: () => {
          beginSession: () => { generation: number };
          beginExport: (sessionGeneration: number) => ExportToken | null;
          markSessionPrepared?: (sessionGeneration: number) => boolean;
        };
      }
    ).createExternalEditOperationTracker;
    const createPreparationCoordinator = (
      asyncNavigation as typeof asyncNavigation & {
        createExternalEditPreparationCoordinator?: () => {
          prepare: (
            cancelInvalidated: () => Promise<boolean>,
            navigateUntilReady: () => Promise<boolean>,
            isCurrent: () => boolean,
          ) => Promise<boolean>;
        };
      }
    ).createExternalEditPreparationCoordinator;
    expect(createOperationTracker).toBeTypeOf('function');
    expect(createPreparationCoordinator).toBeTypeOf('function');
    if (!createOperationTracker || !createPreparationCoordinator) return;

    const tracker = createOperationTracker();
    expect(tracker.markSessionPrepared).toBeTypeOf('function');
    if (!tracker.markSessionPrepared) return;
    const replacement = tracker.beginSession();
    expect(tracker.beginExport(replacement.generation)).toBeNull();

    let resolveCancel!: (result: boolean) => void;
    const cancelResult = new Promise<boolean>((resolve) => {
      resolveCancel = resolve;
    });
    let resolveReady!: (result: boolean) => void;
    const readyResult = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    const navigateUntilReady = vi.fn(() => readyResult);
    const preparation = createPreparationCoordinator().prepare(
      () => cancelResult,
      navigateUntilReady,
      () => true,
    );

    await Promise.resolve();
    expect(navigateUntilReady).not.toHaveBeenCalled();
    expect(tracker.beginExport(replacement.generation)).toBeNull();

    resolveCancel(true);
    await vi.waitFor(() => expect(navigateUntilReady).toHaveBeenCalledOnce());
    expect(tracker.beginExport(replacement.generation)).toBeNull();

    resolveReady(true);
    await expect(preparation).resolves.toBe(true);
    expect(tracker.markSessionPrepared(replacement.generation)).toBe(true);
    expect(tracker.beginExport(replacement.generation)).not.toBeNull();

    const rejectedTracker = createOperationTracker();
    const rejectedSession = rejectedTracker.beginSession();
    const rejectedNavigation = vi.fn().mockResolvedValue(true);
    await expect(
      createPreparationCoordinator().prepare(
        () => Promise.reject(new Error('cancel failed')),
        rejectedNavigation,
        () => true,
      ),
    ).resolves.toBe(false);
    expect(rejectedNavigation).not.toHaveBeenCalled();
    expect(rejectedTracker.beginExport(rejectedSession.generation)).toBeNull();
  });

  it('discards a late async result after a newer navigation wins', async () => {
    let currentPath = '/requested.raf';
    let currentGeneration = 1;
    let resolveLookup!: (value: boolean) => void;
    const lookup = new Promise<boolean>((resolve) => {
      resolveLookup = resolve;
    });

    const result = resolveForCurrentNavigation(
      '/requested.raf',
      () => currentPath,
      () => lookup,
      1,
      () => currentGeneration,
    );
    currentPath = '/newer.raf';
    currentGeneration = 2;
    resolveLookup(true);

    await expect(result).resolves.toBeUndefined();
  });

  it('does not publish a selection before its deferred cache probe resolves', async () => {
    const resolveAndCommit = (
      asyncNavigation as typeof asyncNavigation & {
        resolveAndCommitForCurrentNavigationIntent?: <T>(
          requestGeneration: number,
          currentGeneration: () => number,
          resolve: () => Promise<T>,
          commit: (value: T) => Promise<boolean> | boolean,
        ) => Promise<boolean>;
      }
    ).resolveAndCommitForCurrentNavigationIntent;
    expect(resolveAndCommit).toBeTypeOf('function');
    if (!resolveAndCommit) return;

    let resolveProbe!: (value: boolean) => void;
    const probe = new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    });
    let currentIntent = 4;
    const publishSelection = vi.fn().mockReturnValue(true);

    const operation = resolveAndCommit(
      4,
      () => currentIntent,
      () => probe,
      publishSelection,
    );
    await Promise.resolve();
    expect(publishSelection).not.toHaveBeenCalled();

    resolveProbe(false);
    await expect(operation).resolves.toBe(true);
    expect(publishSelection).toHaveBeenCalledOnce();
    expect(publishSelection).toHaveBeenCalledWith(false);

    currentIntent = 5;
  });

  it('does not apply deferred cache metadata after the live editor becomes dirty or starts dragging', async () => {
    interface SessionState {
      adjustmentLoadContext: { dirty: boolean; reconciled: boolean } | null;
      adjustmentSessionGeneration: number;
      adjustments: { exposure: number };
      isSliderDragging: boolean;
      selectedImage: { isReady: boolean; path: string } | null;
    }
    const resolveAndCommit = (
      asyncNavigation as typeof asyncNavigation & {
        resolveAndCommitForCleanEditorSession?: <TValue, TState extends SessionState>(
          requestedPath: string,
          requestGeneration: number,
          resolve: () => Promise<TValue>,
          getCurrent: () => TState,
          shouldCommit: (current: TState, value: TValue) => boolean,
          commit: (current: TState, value: TValue) => void,
        ) => Promise<boolean>;
      }
    ).resolveAndCommitForCleanEditorSession;
    expect(resolveAndCommit).toBeTypeOf('function');
    if (!resolveAndCommit) return;

    const cleanState = (): SessionState => ({
      adjustmentLoadContext: { dirty: false, reconciled: true },
      adjustmentSessionGeneration: 4,
      adjustments: { exposure: 0 },
      isSliderDragging: false,
      selectedImage: { isReady: true, path: '/cached.raf' },
    });
    let current = cleanState();
    let resolveMetadata!: (value: { exposure: number }) => void;
    const metadata = new Promise<{ exposure: number }>((resolve) => {
      resolveMetadata = resolve;
    });
    const reload = vi.fn();
    const dirtyOperation = resolveAndCommit(
      '/cached.raf',
      4,
      () => metadata,
      () => current,
      (live, fresh) => live.adjustments.exposure !== fresh.exposure,
      reload,
    );
    current = {
      ...current,
      adjustmentLoadContext: { dirty: true, reconciled: true },
      adjustments: { exposure: 1.25 },
    };
    resolveMetadata({ exposure: 0.5 });
    await expect(dirtyOperation).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();

    current = { ...cleanState(), isSliderDragging: true };
    await expect(
      resolveAndCommit(
        '/cached.raf',
        4,
        () => Promise.resolve({ exposure: 0.5 }),
        () => current,
        (live, fresh) => live.adjustments.exposure !== fresh.exposure,
        reload,
      ),
    ).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('discards a stale lookup after an A to B to A navigation sequence', async () => {
    let currentPath = '/a.raf';
    let currentGeneration = 1;
    let resolveLookup!: (value: boolean) => void;
    const lookup = new Promise<boolean>((resolve) => {
      resolveLookup = resolve;
    });

    const firstRequest = resolveForCurrentNavigation(
      '/a.raf',
      () => currentPath,
      () => lookup,
      1,
      () => currentGeneration,
    );
    currentPath = '/b.raf';
    currentGeneration = 2;
    currentPath = '/a.raf';
    currentGeneration = 3;
    resolveLookup(true);

    await expect(firstRequest).resolves.toBeUndefined();
  });

  it('rejects a stale background completion after returning to the same path', () => {
    const isCurrentNavigation = (
      asyncNavigation as typeof asyncNavigation & {
        isCurrentNavigation?: (
          requestedPath: string,
          currentPath: () => string | null,
          requestGeneration: number,
          currentGeneration: () => number,
        ) => boolean;
      }
    ).isCurrentNavigation;
    expect(isCurrentNavigation).toBeTypeOf('function');
    if (!isCurrentNavigation) return;

    let currentPath = '/a.raf';
    let currentGeneration = 1;
    const firstRequestIsCurrent = () =>
      isCurrentNavigation(
        '/a.raf',
        () => currentPath,
        1,
        () => currentGeneration,
      );

    expect(firstRequestIsCurrent()).toBe(true);
    currentPath = '/b.raf';
    currentGeneration = 2;
    currentPath = '/a.raf';
    currentGeneration = 3;

    expect(firstRequestIsCurrent()).toBe(false);
  });

  it('retains the active generation when the current image is selected again', () => {
    const selectedImagePathRef = { current: '/a.raf' };
    const navigationGenerationRef = { current: 7 };
    const transitions = createEditorNavigationTransitions({
      selectedImagePathRef,
      navigationGenerationRef,
      clearEditorSession: vi.fn(),
    });
    const activeRequestIsCurrent = () =>
      asyncNavigation.isCurrentNavigation(
        '/a.raf',
        () => selectedImagePathRef.current,
        7,
        () => navigationGenerationRef.current,
      );

    expect(transitions.beginImageSelection('/a.raf')).toEqual({ changed: false, generation: 7 });
    expect(activeRequestIsCurrent()).toBe(true);
    expect(selectedImagePathRef.current).toBe('/a.raf');
    expect(navigationGenerationRef.current).toBe(7);
  });

  it('rejects a stale loader continuation even after returning to the same path', () => {
    const isCurrentEditorSession = (
      asyncNavigation as typeof asyncNavigation & {
        isCurrentEditorSession?: (
          requestedPath: string | null,
          requestGeneration: number,
          getCurrent: () => { path: string | null; generation: number },
          isActive: () => boolean,
        ) => boolean;
      }
    ).isCurrentEditorSession;
    expect(isCurrentEditorSession).toBeTypeOf('function');
    if (!isCurrentEditorSession) return;

    let current = { path: '/a.raf' as string | null, generation: 3 };
    let active = true;
    const requestIsCurrent = () =>
      isCurrentEditorSession(
        '/a.raf',
        3,
        () => current,
        () => active,
      );

    expect(requestIsCurrent()).toBe(true);
    current = { path: '/b.raf', generation: 4 };
    expect(requestIsCurrent()).toBe(false);
    current = { path: '/a.raf', generation: 5 };
    expect(requestIsCurrent()).toBe(false);
    active = false;
    expect(requestIsCurrent()).toBe(false);
  });

  it('keeps a preserved editor session current across unrelated intents and rejects an actual session change', () => {
    const isCurrentEditorSession = (
      asyncNavigation as typeof asyncNavigation & {
        isCurrentEditorSession?: (
          requestedPath: string | null,
          requestGeneration: number,
          getCurrent: () => { path: string | null; generation: number },
          isActive: () => boolean,
        ) => boolean;
      }
    ).isCurrentEditorSession;
    expect(isCurrentEditorSession).toBeTypeOf('function');
    if (!isCurrentEditorSession) return;

    const tracker = createNavigationIntentTracker({ current: 6 });
    let currentSession = { path: '/a.raf' as string | null, generation: 3 };
    const preservedSessionIsCurrent = () =>
      isCurrentEditorSession(
        '/a.raf',
        3,
        () => currentSession,
        () => true,
      );

    tracker.begin();
    expect(preservedSessionIsCurrent()).toBe(true);

    currentSession = { path: '/b.raf', generation: 4 };
    expect(preservedSessionIsCurrent()).toBe(false);
  });

  it('lets only the latest folder or album request publish results and clear loading', async () => {
    const tracker = createNavigationIntentTracker({ current: 0 }) as ReturnType<
      typeof createNavigationIntentTracker
    > & {
      commitIfCurrent?: (generation: number, commit: () => void, shouldCommit?: () => boolean) => boolean;
    };
    expect(tracker.commitIfCurrent).toBeTypeOf('function');
    if (!tracker.commitIfCurrent) return;

    let resolveFolder!: (paths: string[]) => void;
    const folderResult = new Promise<string[]>((resolve) => {
      resolveFolder = resolve;
    });
    const published: string[][] = [];
    let isLoading = true;
    const folderGeneration = tracker.begin();
    const folderRequest = folderResult
      .then((paths) => tracker.commitIfCurrent?.(folderGeneration, () => published.push(paths)))
      .finally(() => tracker.commitIfCurrent?.(folderGeneration, () => (isLoading = false)));

    const albumGeneration = tracker.begin();
    isLoading = true;
    resolveFolder(['/stale-folder.raf']);
    await folderRequest;

    expect(published).toEqual([]);
    expect(isLoading).toBe(true);
    expect(tracker.commitIfCurrent(albumGeneration, () => published.push(['/current-album.raf']))).toBe(true);
    expect(
      tracker.commitIfCurrent(
        albumGeneration,
        () => (isLoading = false),
        () => false,
      ),
    ).toBe(false);
    expect(isLoading).toBe(true);
    expect(tracker.commitIfCurrent(albumGeneration, () => (isLoading = false))).toBe(true);
    expect(published).toEqual([['/current-album.raf']]);
    expect(isLoading).toBe(false);
  });

  it.each([
    'clearForBackToLibrary',
    'clearForFolderSelection',
    'clearForAlbumSelection',
    'clearForImageLoadFailure',
  ] as const)('%s invalidates a pending selection before clearing editor state', (route) => {
    const selectedImagePathRef = { current: '/pending.raf' as string | null };
    const navigationGenerationRef = { current: 4 };
    const stateAtClear: Array<{ path: string | null; generation: number }> = [];
    const transitions = createEditorNavigationTransitions({
      selectedImagePathRef,
      navigationGenerationRef,
      clearEditorSession: () => {
        stateAtClear.push({ path: selectedImagePathRef.current, generation: navigationGenerationRef.current });
      },
    });
    const pendingRequestIsCurrent = () =>
      asyncNavigation.isCurrentNavigation(
        '/pending.raf',
        () => selectedImagePathRef.current,
        4,
        () => navigationGenerationRef.current,
      );

    expect(pendingRequestIsCurrent()).toBe(true);
    transitions[route]();

    expect(pendingRequestIsCurrent()).toBe(false);
    expect(stateAtClear).toEqual([{ path: null, generation: 5 }]);
  });

  it('allows only one caller to enter an asynchronous operation at a time', async () => {
    const runExclusiveAsync = (
      asyncNavigation as typeof asyncNavigation & {
        runExclusiveAsync?: <T>(guard: { current: boolean }, operation: () => Promise<T>) => Promise<T | undefined>;
      }
    ).runExclusiveAsync;
    expect(runExclusiveAsync).toBeTypeOf('function');
    if (!runExclusiveAsync) return;

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(() => blocked);
    const guard = { current: false };

    const first = runExclusiveAsync(guard, operation);
    const second = runExclusiveAsync(guard, operation);

    await expect(second).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toBeUndefined();

    await runExclusiveAsync(guard, operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

export type AsyncPathNavigation = (path: string) => Promise<boolean>;

export interface AsyncOperationGuard {
  current: boolean;
}

interface MutableRef<T> {
  current: T;
}

interface EditorNavigationTransitionInput {
  clearEditorSession: () => void;
  navigationGenerationRef: MutableRef<number>;
  releaseEditorPreviews: () => void;
  selectedImagePathRef: MutableRef<string | null>;
}

interface NavigationTarget {
  isReady: boolean;
  path: string;
}

interface EditorSessionTarget {
  generation: number;
  path: string | null;
}

export function invalidatePendingPreviewJobs(
  previewGeneration: MutableRef<number>,
  latestPublishedGeneration: MutableRef<number>,
): void {
  const invalidatedGeneration = Math.max(previewGeneration.current, latestPublishedGeneration.current) + 1;
  previewGeneration.current = invalidatedGeneration;
  latestPublishedGeneration.current = invalidatedGeneration;
}

export interface ExternalEditExportToken {
  readonly exportGeneration: number;
  readonly sessionGeneration: number;
}

export interface ExternalEditSessionStart {
  readonly generation: number;
  readonly invalidatedExport: ExternalEditExportToken | null;
  readonly invalidatedExportDispatchInFlight: boolean;
  readonly invalidatedExportWasDispatched: boolean;
}

export async function cancelInvalidatedExternalEditExport(
  sessionStart: ExternalEditSessionStart,
  waitForDispatch: (token: ExternalEditExportToken) => Promise<boolean>,
  cancel: () => Promise<void>,
): Promise<void> {
  const token = sessionStart.invalidatedExport;
  if (!token) return;
  const shouldCancel = sessionStart.invalidatedExportDispatchInFlight
    ? await waitForDispatch(token)
    : sessionStart.invalidatedExportWasDispatched;
  if (shouldCancel) await cancel();
}

export function createExternalEditOperationTracker() {
  let sessionGeneration = 0;
  let exportGeneration = 0;
  let activeExport: ExternalEditExportToken | null = null;
  let exportDispatchInFlight = false;
  let exportCompletionArmed = false;
  let preparedSessionGeneration: number | null = null;

  const isExportCurrent = (token: ExternalEditExportToken) => activeExport === token;

  return {
    beginSession() {
      const invalidatedExport = activeExport;
      const invalidatedExportDispatchInFlight = invalidatedExport !== null && exportDispatchInFlight;
      const invalidatedExportWasDispatched = invalidatedExport !== null && exportCompletionArmed;
      sessionGeneration += 1;
      activeExport = null;
      exportDispatchInFlight = false;
      exportCompletionArmed = false;
      preparedSessionGeneration = null;
      return {
        generation: sessionGeneration,
        invalidatedExport,
        invalidatedExportDispatchInFlight,
        invalidatedExportWasDispatched,
      } satisfies ExternalEditSessionStart;
    },
    beginExport(generation: number) {
      if (generation !== sessionGeneration || preparedSessionGeneration !== generation || activeExport !== null) {
        return null;
      }
      activeExport = { exportGeneration: ++exportGeneration, sessionGeneration: generation };
      exportDispatchInFlight = false;
      exportCompletionArmed = false;
      return activeExport;
    },
    commitExportIfCurrent(token: ExternalEditExportToken, commit: () => void) {
      if (!isExportCurrent(token)) return false;
      commit();
      return true;
    },
    commitExportCompletionIfCurrent(token: ExternalEditExportToken, commit: () => void) {
      if (!isExportCurrent(token) || !exportCompletionArmed) return false;
      exportCompletionArmed = false;
      commit();
      return true;
    },
    currentExport() {
      return activeExport;
    },
    finishExport(token: ExternalEditExportToken) {
      if (!isExportCurrent(token)) return false;
      activeExport = null;
      exportDispatchInFlight = false;
      exportCompletionArmed = false;
      return true;
    },
    isExportCurrent,
    isSessionCurrent(generation: number) {
      return generation === sessionGeneration;
    },
    isSessionPrepared(generation: number) {
      return generation === sessionGeneration && preparedSessionGeneration === generation;
    },
    markSessionPrepared(generation: number) {
      if (generation !== sessionGeneration || activeExport !== null) return false;
      preparedSessionGeneration = generation;
      return true;
    },
    markExportDispatchStarted(token: ExternalEditExportToken) {
      if (!isExportCurrent(token) || exportDispatchInFlight || exportCompletionArmed) return false;
      exportDispatchInFlight = true;
      return true;
    },
    markExportDispatched(token: ExternalEditExportToken) {
      if (!isExportCurrent(token) || !exportDispatchInFlight) return false;
      exportDispatchInFlight = false;
      exportCompletionArmed = true;
      return true;
    },
  };
}

export function createExternalEditPreparationCoordinator() {
  let cancellationBarrier: Promise<boolean> = Promise.resolve(true);

  return {
    prepare(
      cancelInvalidated: () => Promise<boolean>,
      navigateUntilReady: () => Promise<boolean>,
      isCurrent: () => boolean,
    ): Promise<boolean> {
      const cancellation = cancellationBarrier.then(
        (canContinue) => (canContinue ? cancelInvalidated().catch(() => false) : false),
        () => false,
      );
      cancellationBarrier = cancellation;

      return cancellation.then(async (canContinue) => {
        if (!canContinue || !isCurrent()) return false;
        try {
          const isReady = await navigateUntilReady();
          return isReady && isCurrent();
        } catch {
          return false;
        }
      });
    },
  };
}

export function createNavigationIntentTracker(generationRef: MutableRef<number>) {
  return {
    begin() {
      generationRef.current += 1;
      return generationRef.current;
    },
    isCurrent(generation: number) {
      return generationRef.current === generation;
    },
    commitIfCurrent(generation: number, commit: () => void, shouldCommit: () => boolean = () => true) {
      if (generationRef.current !== generation || !shouldCommit()) return false;
      commit();
      return true;
    },
  };
}

export function isCurrentEditorSession(
  requestedPath: string | null,
  requestGeneration: number,
  getCurrent: () => EditorSessionTarget,
  isActive: () => boolean,
): boolean {
  if (!isActive()) return false;
  const current = getCurrent();
  return current.path === requestedPath && current.generation === requestGeneration;
}

export function createEditorNavigationTransitions({
  clearEditorSession,
  navigationGenerationRef,
  releaseEditorPreviews,
  selectedImagePathRef,
}: EditorNavigationTransitionInput) {
  const invalidateAndClear = () => {
    selectedImagePathRef.current = null;
    navigationGenerationRef.current += 1;
    releaseEditorPreviews();
    clearEditorSession();
  };

  return {
    beginImageSelection(path: string) {
      if (selectedImagePathRef.current === path) {
        return { changed: false, generation: navigationGenerationRef.current };
      }
      selectedImagePathRef.current = path;
      navigationGenerationRef.current += 1;
      return { changed: true, generation: navigationGenerationRef.current };
    },
    clearForBackToLibrary: invalidateAndClear,
    clearForFolderSelection: invalidateAndClear,
    clearForAlbumSelection: invalidateAndClear,
    clearForImageLoadFailure: invalidateAndClear,
  };
}

export function isReadyNavigationTarget<T extends NavigationTarget>(
  requestedPath: string,
  selectedImage: T | null | undefined,
): selectedImage is T {
  return selectedImage?.path === requestedPath && selectedImage.isReady;
}

export async function navigateAndRunOnSuccess(
  path: string,
  navigate: AsyncPathNavigation,
  onSuccess: () => void,
): Promise<boolean> {
  const navigated = await navigate(path);
  if (navigated) onSuccess();
  return navigated;
}

export async function navigateAndWaitForReady(
  path: string,
  navigate: AsyncPathNavigation,
  getTarget: () => NavigationTarget | null | undefined,
  subscribe: (onChange: () => void) => () => void,
  isActive: () => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const navigated = await navigate(path);
  if (!navigated || !isActive() || signal?.aborted) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeWhenReady = false;
    let onAbort: () => void = () => undefined;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (unsubscribe) {
        const unsubscribeNow = unsubscribe;
        unsubscribe = undefined;
        unsubscribeNow();
      } else {
        unsubscribeWhenReady = true;
      }
    };
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const check = () => {
      if (!isActive()) {
        settle(false);
        return;
      }
      const target = getTarget();
      if (target?.path === path && target.isReady) {
        settle(true);
      } else if (target?.path !== path) {
        settle(false);
      }
    };

    onAbort = () => settle(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    const storeUnsubscribe = subscribe(check);
    if (unsubscribeWhenReady) {
      storeUnsubscribe();
    } else {
      unsubscribe = storeUnsubscribe;
    }
    if (!settled) check();
  });
}

export async function navigateExternalEditSource(
  path: string,
  navigate: AsyncPathNavigation,
  isActive: () => boolean,
  abort: (message: string) => void,
): Promise<boolean> {
  const fallbackMessage = 'Could not open the external edit source.';
  try {
    const navigated = await navigate(path);
    if (!navigated && isActive()) abort(fallbackMessage);
    return navigated;
  } catch (error) {
    if (isActive()) abort(typeof error === 'string' ? error : fallbackMessage);
    return false;
  }
}

export function isCurrentNavigation(
  requestedPath: string,
  currentPath: () => string | null,
  requestGeneration: number,
  currentGeneration: () => number,
): boolean {
  return currentPath() === requestedPath && currentGeneration() === requestGeneration;
}

export async function resolveForCurrentNavigation<T>(
  requestedPath: string,
  currentPath: () => string | null,
  resolve: () => Promise<T>,
  requestGeneration: number,
  currentGeneration: () => number,
): Promise<T | undefined> {
  const value = await resolve();
  return isCurrentNavigation(requestedPath, currentPath, requestGeneration, currentGeneration) ? value : undefined;
}

export async function runExclusiveAsync<T>(
  guard: AsyncOperationGuard,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  if (guard.current) return undefined;
  guard.current = true;
  try {
    return await operation();
  } finally {
    guard.current = false;
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effectHarness = vi.hoisted(() => {
  type Cleanup = () => void;
  type Effect = () => Cleanup | void;
  type EffectSlot = { cleanup?: Cleanup; dependencies?: readonly unknown[] };

  const slots: EffectSlot[] = [];
  let cursor = 0;

  const dependenciesChanged = (previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined) =>
    previous === undefined ||
    next === undefined ||
    previous.length !== next.length ||
    next.some((dependency, index) => !Object.is(dependency, previous[index]));

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      for (const slot of slots) slot.cleanup?.();
      slots.length = 0;
      cursor = 0;
    },
    useEffect(effect: Effect, dependencies?: readonly unknown[]) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && !dependenciesChanged(previous.dependencies, dependencies)) return;

      previous?.cleanup?.();
      const cleanup = effect();
      slots[index] = {
        cleanup: typeof cleanup === 'function' ? cleanup : undefined,
        dependencies,
      };
    },
  };
});

const loaderHarness = vi.hoisted(() => {
  const beginAdjustmentLoad = vi.fn();
  const completeAdjustmentLoad = vi.fn(() => true);
  const restoreAdjustmentSession = vi.fn();
  const clearEditorSession = vi.fn();
  const setLibrary = vi.fn();
  const isCurrentChecks: Array<() => boolean> = [];
  const loadDependencies: Array<{
    onComplete: (completed: unknown) => unknown;
  }> = [];
  const selectedImage = {
    exif: null,
    height: 0,
    isRaw: true,
    isReady: false,
    metadata: null,
    path: '/fixtures/coalesced-reset.RAF',
    sourceKind: null,
    thumbnailUrl: 'fixture-thumbnail',
    width: 0,
  };
  const state = {
    adjustmentLoadContext: null,
    adjustmentReloadSnapshot: null,
    adjustmentSessionGeneration: 10,
    adjustments: {},
    beginAdjustmentLoad,
    clearEditorSession,
    completeAdjustmentLoad,
    finalPreviewUrl: null,
    histogram: null,
    originalSize: { width: 0, height: 0 },
    patchesSentToBackend: new Set(),
    restoreAdjustmentSession,
    selectedImage,
    uncroppedAdjustedPreviewUrl: null,
    waveform: null,
    wgpuPhase: 'hidden',
  };

  const coordinateEditorImageLoad = vi.fn(
    (_path: string, dependencies: { isCurrent?: () => boolean; onComplete: (completed: unknown) => unknown }) => {
      if (dependencies.isCurrent) isCurrentChecks.push(dependencies.isCurrent);
      loadDependencies.push(dependencies);
      return new Promise<never>(() => undefined);
    },
  );

  return {
    completeAdjustmentLoad,
    coordinateEditorImageLoad,
    isCurrentChecks,
    loadDependencies,
    setLibrary,
    state,
  };
});

vi.mock('react', () => ({ useEffect: effectHarness.useEffect }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));

vi.mock('../store/useEditorStore', () => {
  const useEditorStore = Object.assign(
    (selector: (state: typeof loaderHarness.state) => unknown) => selector(loaderHarness.state),
    { getState: () => loaderHarness.state },
  );
  return { useEditorStore };
});

vi.mock('../store/useLibraryStore', () => ({
  useLibraryStore: (selector: (state: { setLibrary: typeof loaderHarness.setLibrary }) => unknown) =>
    selector({ setLibrary: loaderHarness.setLibrary }),
}));

vi.mock('../store/useSettingsStore', () => ({
  useSettingsStore: (selector: (state: { appSettings: null }) => unknown) => selector({ appSettings: null }),
}));

vi.mock('../services/editorPersistence', () => ({ flushOrDiscardPendingSave: vi.fn() }));
vi.mock('../services/editorImageLoad', () => ({
  coordinateEditorImageLoad: loaderHarness.coordinateEditorImageLoad,
  EditorImageLoadCancelledError: class EditorImageLoadCancelledError extends Error {},
}));
vi.mock('../components/ui/AppProperties', () => ({
  Invokes: { LoadImage: 'load_image', LoadMetadata: 'load_metadata' },
}));
vi.mock('../utils/ImageLRUCache', () => ({
  createEditorCacheEntry: vi.fn(() => null),
  globalImageCache: { revokeWhenUnprotected: vi.fn() },
}));

import { useImageLoader } from './useImageLoader';

describe('useImageLoader adjustment session generation', () => {
  const cachedEditStateRef = { current: null };

  const renderHook = () => {
    effectHarness.beginRender();
    useImageLoader(cachedEditStateRef);
  };

  beforeEach(() => {
    effectHarness.reset();
    loaderHarness.coordinateEditorImageLoad.mockClear();
    loaderHarness.completeAdjustmentLoad.mockClear();
    loaderHarness.isCurrentChecks.length = 0;
    loaderHarness.loadDependencies.length = 0;
    loaderHarness.state.adjustmentSessionGeneration = 10;
    loaderHarness.state.patchesSentToBackend.clear();
  });

  afterEach(() => {
    effectHarness.reset();
  });

  it('restarts a same-path unready load after coalesced session-generation changes', () => {
    renderHook();

    expect(loaderHarness.isCurrentChecks).toHaveLength(1);
    expect(loaderHarness.isCurrentChecks[0]?.()).toBe(true);

    loaderHarness.state.adjustmentSessionGeneration = 11;
    loaderHarness.state.adjustmentSessionGeneration = 12;
    renderHook();

    expect(loaderHarness.isCurrentChecks).toHaveLength(2);
    expect(loaderHarness.isCurrentChecks[0]?.()).toBe(false);
    expect(loaderHarness.isCurrentChecks[1]?.()).toBe(true);
  });

  it('completes with the authoritative load_image source kind, dimensions, and white balance', () => {
    renderHook();
    const completed = {
      adjustments: { exposure: 0 },
      context: { reconciled: true, sourceKind: 'embedded_preview' },
      image: {
        width: 4000,
        height: 3000,
        metadata: { version: 1, rating: 0, adjustments: null, tags: null },
        exif: { Camera: 'GFX100RF' },
        is_raw: true,
        as_shot_white_balance: { temperature: 5200, tint: 4 },
        source_kind: 'embedded_preview',
      },
    };

    loaderHarness.loadDependencies[0]?.onComplete(completed);

    expect(loaderHarness.completeAdjustmentLoad).toHaveBeenCalledWith(
      completed.adjustments,
      completed.context,
      expect.objectContaining({
        path: '/fixtures/coalesced-reset.RAF',
        width: 4000,
        height: 3000,
        isRaw: true,
        exif: { Camera: 'GFX100RF' },
        asShotWhiteBalance: { temperature: 5200, tint: 4 },
        sourceKind: 'embedded_preview',
      }),
      { originalSize: { width: 4000, height: 3000 } },
    );
    expect(loaderHarness.setLibrary).toHaveBeenCalledWith({ isViewLoading: false });
  });

  it('clears the view loading state in the completion callback, before readiness can retire the effect', () => {
    renderHook();
    loaderHarness.setLibrary.mockClear();
    loaderHarness.completeAdjustmentLoad.mockImplementationOnce(() => {
      expect(loaderHarness.setLibrary).not.toHaveBeenCalled();
      return true;
    });

    loaderHarness.loadDependencies[0]?.onComplete({
      adjustments: {},
      context: { reconciled: true, sourceKind: 'developed_raw' },
      image: {
        width: 10,
        height: 10,
        metadata: { version: 1, rating: 0, adjustments: null, tags: null },
        exif: {},
        is_raw: true,
        as_shot_white_balance: { temperature: 5000, tint: 0 },
        source_kind: 'developed_raw',
      },
    });

    expect(loaderHarness.completeAdjustmentLoad).toHaveBeenCalledOnce();
    expect(loaderHarness.setLibrary).toHaveBeenCalledWith({ isViewLoading: false });
  });

  it('does not clear the view loading state when the store rejects a stale completion', () => {
    renderHook();
    loaderHarness.setLibrary.mockClear();
    loaderHarness.completeAdjustmentLoad.mockImplementationOnce(() => false);

    expect(() =>
      loaderHarness.loadDependencies[0]?.onComplete({
        adjustments: {},
        context: { reconciled: true, sourceKind: 'developed_raw' },
        image: {
          width: 10,
          height: 10,
          metadata: { version: 1, rating: 0, adjustments: null, tags: null },
          exif: {},
          is_raw: true,
          as_shot_white_balance: { temperature: 5000, tint: 0 },
          source_kind: 'developed_raw',
        },
      }),
    ).toThrow(/rejected/);
    expect(loaderHarness.setLibrary).not.toHaveBeenCalled();
  });
});

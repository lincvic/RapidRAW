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
  const completeAdjustmentLoad = vi.fn();
  const restoreAdjustmentSession = vi.fn();
  const setLibrary = vi.fn();
  const isCurrentChecks: Array<() => boolean> = [];
  const selectedImage = {
    exif: null,
    height: 0,
    isRaw: true,
    isReady: false,
    metadata: null,
    originalUrl: null,
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
    completeAdjustmentLoad,
    finalPreviewUrl: null,
    hasRenderedFirstFrame: false,
    histogram: null,
    originalSize: { width: 0, height: 0 },
    patchesSentToBackend: new Set(),
    previewSize: { width: 0, height: 0 },
    restoreAdjustmentSession,
    selectedImage,
    uncroppedAdjustedPreviewUrl: null,
    waveform: null,
  };

  const coordinateEditorImageLoad = vi.fn((_path: string, dependencies: { isCurrent?: () => boolean }) => {
    if (dependencies.isCurrent) isCurrentChecks.push(dependencies.isCurrent);
    return new Promise<never>(() => undefined);
  });

  return {
    coordinateEditorImageLoad,
    isCurrentChecks,
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

vi.mock('../services/editorPersistence', () => ({ flushPendingSave: vi.fn() }));
vi.mock('../services/editorImageLoad', () => ({
  coordinateEditorImageLoad: loaderHarness.coordinateEditorImageLoad,
  EditorImageLoadCancelledError: class EditorImageLoadCancelledError extends Error {},
}));
vi.mock('../components/ui/AppProperties', () => ({
  Invokes: { LoadImage: 'load_image', LoadMetadata: 'load_metadata' },
}));
vi.mock('../utils/ImageLRUCache', () => ({
  globalImageCache: { revokeWhenUnprotected: vi.fn() },
}));

import { useImageLoader } from './useImageLoader';

describe('useImageLoader adjustment session generation', () => {
  const cachedEditStateRef = { current: null };
  const handleImageLoadFailure = vi.fn();

  const renderHook = () => {
    effectHarness.beginRender();
    useImageLoader(cachedEditStateRef, handleImageLoadFailure);
  };

  beforeEach(() => {
    effectHarness.reset();
    loaderHarness.coordinateEditorImageLoad.mockClear();
    loaderHarness.isCurrentChecks.length = 0;
    loaderHarness.state.adjustmentSessionGeneration = 10;
    loaderHarness.state.patchesSentToBackend.clear();
    handleImageLoadFailure.mockClear();
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
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectedImage } from '../components/ui/AppProperties';
import { IMAGE_SOURCE_KINDS, type AdjustmentLoadContext, type LoadMetadataResult } from '../types/imageLoading';
import { INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments, type Adjustments } from '../utils/adjustments';
import { initializeAdjustmentLoad, reconcileAdjustmentLoad } from '../utils/rafCameraDefaults';
import { createEditorPersistence, restorePendingHistory, suspendPendingHistory } from '../services/editorPersistence';
import { useEditorStore } from './useEditorStore';

const persistenceMocks = vi.hoisted(() => ({
  scheduleSave: vi.fn(),
}));

vi.mock('../services/editorPersistence', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/editorPersistence')>();
  return { ...original, scheduleSave: persistenceMocks.scheduleSave };
});

const metadata = (adjustments: LoadMetadataResult['adjustments'] = null): LoadMetadataResult => ({
  version: 1,
  rating: 0,
  adjustments,
  tags: null,
  exif: { Camera: 'GFX100RF' },
  cameraDefaults: {
    crop: { x: 100, y: 200, width: 6500, height: 2400 },
    aspectRatio: 65 / 24,
    canvasWidth: 7000,
    canvasHeight: 3000,
  },
});

const selectedImage = (overrides: Partial<SelectedImage> = {}): SelectedImage => ({
  exif: null,
  height: 3000,
  isRaw: true,
  isReady: false,
  metadata: null,
  path: '/fixtures/GFX100RF.RAF',
  sourceKind: null,
  thumbnailUrl: 'fixture-thumbnail',
  width: 7000,
  ...overrides,
});

const cloneAdjustments = (overrides: Partial<Adjustments> = {}): Adjustments =>
  normalizeLoadedAdjustments({ ...overrides });

const loadDimensions = {
  originalSize: { width: 7000, height: 3000 },
};

const completeDevelopedLoad = () => {
  const initialized = initializeAdjustmentLoad(metadata(null));
  const image = selectedImage({ sourceKind: IMAGE_SOURCE_KINDS.DevelopedRaw });

  useEditorStore.getState().setEditor({ selectedImage: selectedImage() });
  useEditorStore.getState().beginAdjustmentLoad(initialized.adjustments, initialized.context);
  const active = useEditorStore.getState();
  const reconciled = reconcileAdjustmentLoad(
    active.adjustments,
    active.adjustmentLoadContext as AdjustmentLoadContext,
    {
      source_kind: IMAGE_SOURCE_KINDS.DevelopedRaw,
    },
  );

  useEditorStore.getState().completeAdjustmentLoad(reconciled.adjustments, reconciled.context, image, loadDimensions);

  return { ...reconciled, image };
};

describe('editor adjustment session transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    persistenceMocks.scheduleSave.mockReset();
    useEditorStore.setState(useEditorStore.getInitialState(), true);
    (
      useEditorStore.getState() as ReturnType<typeof useEditorStore.getState> & { clearEditorSession?: () => void }
    ).clearEditorSession?.();
  });

  afterEach(() => {
    (
      useEditorStore.getState() as ReturnType<typeof useEditorStore.getState> & {
        clearEditorSession?: () => void;
      }
    ).clearEditorSession?.();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('begins a load with provisional adjustments and one clean unreconciled baseline', () => {
    const initialized = initializeAdjustmentLoad(metadata(null));

    useEditorStore.getState().setEditor({ selectedImage: selectedImage() });
    useEditorStore.getState().beginAdjustmentLoad(initialized.adjustments, initialized.context);

    const state = useEditorStore.getState();
    expect(state.adjustments).toEqual(initialized.adjustments);
    expect(state.history).toEqual([initialized.adjustments]);
    expect(state.historyIndex).toBe(0);
    expect(state.adjustmentLoadContext).toMatchObject({ reconciled: false, dirty: false });
  });

  it('completes dimensions, adjustments, history, context, provenance, and readiness in one observed state', () => {
    const initialized = initializeAdjustmentLoad(metadata(null));
    useEditorStore.getState().setEditor({ selectedImage: selectedImage() });
    useEditorStore.getState().beginAdjustmentLoad(initialized.adjustments, initialized.context);
    const active = useEditorStore.getState();
    const reconciled = reconcileAdjustmentLoad(
      active.adjustments,
      active.adjustmentLoadContext as AdjustmentLoadContext,
      {
        source_kind: IMAGE_SOURCE_KINDS.DevelopedRaw,
      },
    );

    const dimensions = loadDimensions;
    const observed: ReturnType<typeof useEditorStore.getState>[] = [];
    const unsubscribe = useEditorStore.subscribe((state) => observed.push(state));
    useEditorStore
      .getState()
      .completeAdjustmentLoad(reconciled.adjustments, reconciled.context, selectedImage(), dimensions);
    unsubscribe();

    const state = useEditorStore.getState();
    expect(observed).toHaveLength(1);
    expect(observed.some((entry) => entry.selectedImage?.isReady && !entry.adjustmentLoadContext?.reconciled)).toBe(
      false,
    );
    expect(
      observed.some(
        (entry) =>
          entry.originalSize.width === dimensions.originalSize.width &&
          entry.originalSize.height === dimensions.originalSize.height &&
          (!entry.selectedImage?.isReady || !entry.adjustmentLoadContext?.reconciled),
      ),
    ).toBe(false);
    expect(state.originalSize).toEqual(dimensions.originalSize);
    expect(state.adjustments).toEqual(reconciled.adjustments);
    expect(state.history).toEqual([reconciled.adjustments]);
    expect(state.historyIndex).toBe(0);
    expect(state.adjustmentLoadContext).toEqual(reconciled.context);
    expect(state.selectedImage).toMatchObject({
      isReady: true,
      sourceKind: IMAGE_SOURCE_KINDS.DevelopedRaw,
    });
  });

  it('queues and drains the exact explicit edit before an immediate editor transition', async () => {
    const reconciled = completeDevelopedLoad();
    const writes: Array<{ path: string; adjustments: unknown }> = [];
    const persistence = createEditorPersistence(async (_command, args) => {
      writes.push(args as { path: string; adjustments: unknown });
    });
    persistenceMocks.scheduleSave.mockImplementation(persistence.scheduleSave);
    const edited = { ...reconciled.adjustments, exposure: 1.25 };
    const replaceSession = vi.fn();

    useEditorStore.getState().applyExplicitAdjustments(edited);
    await persistence.runEditorTransition(reconciled.image.path, replaceSession);

    expect(writes).toEqual([{ path: reconciled.image.path, adjustments: edited }]);
    expect(replaceSession).toHaveBeenCalledOnce();
  });

  it('queues the reverted transport value before an immediate transition after undo', async () => {
    const reconciled = completeDevelopedLoad();
    const writes: Array<{ path: string; adjustments: unknown }> = [];
    const persistence = createEditorPersistence(async (_command, args) => {
      writes.push(args as { path: string; adjustments: unknown });
    });
    persistenceMocks.scheduleSave.mockImplementation(persistence.scheduleSave);

    useEditorStore.getState().applyExplicitAdjustments({ ...reconciled.adjustments, exposure: 1.25 });
    await vi.advanceTimersByTimeAsync(500);
    await persistence.flushPendingSave(reconciled.image.path);
    writes.length = 0;

    useEditorStore.getState().undo();
    await persistence.runEditorTransition(reconciled.image.path, vi.fn());

    expect(writes).toEqual([{ path: reconciled.image.path, adjustments: null }]);
  });

  it('never leaves an embedded-preview camera crop in adjustments or undo history', () => {
    const initialized = initializeAdjustmentLoad(metadata(null));
    expect(initialized.adjustments.crop).not.toBeNull();
    useEditorStore.getState().setEditor({ selectedImage: selectedImage() });
    useEditorStore.getState().beginAdjustmentLoad(initialized.adjustments, initialized.context);
    const active = useEditorStore.getState();
    const reconciled = reconcileAdjustmentLoad(
      active.adjustments,
      active.adjustmentLoadContext as AdjustmentLoadContext,
      {
        source_kind: IMAGE_SOURCE_KINDS.EmbeddedPreview,
      },
    );

    useEditorStore
      .getState()
      .completeAdjustmentLoad(
        reconciled.adjustments,
        reconciled.context,
        selectedImage({ isRaw: true }),
        loadDimensions,
      );
    useEditorStore.getState().undo();

    const state = useEditorStore.getState();
    expect(state.adjustments.crop).toBeNull();
    expect(state.history).toHaveLength(1);
    expect(state.history[0].crop).toBeNull();
    expect(state.historyIndex).toBe(0);
    expect(state.selectedImage?.sourceKind).toBe(IMAGE_SOURCE_KINDS.EmbeddedPreview);
  });

  it('keeps a tonal edit made while the image was loading on top of the reconciled camera baseline', () => {
    const initialized = initializeAdjustmentLoad(metadata(null));
    useEditorStore.getState().setEditor({ selectedImage: selectedImage() });
    useEditorStore.getState().beginAdjustmentLoad(initialized.adjustments, initialized.context);
    const loading = useEditorStore.getState();
    useEditorStore.getState().applyExplicitAdjustments({ ...loading.adjustments, exposure: 1 });
    expect(persistenceMocks.scheduleSave).not.toHaveBeenCalled();

    const reconciled = reconcileAdjustmentLoad(
      loading.adjustments,
      loading.adjustmentLoadContext as AdjustmentLoadContext,
      { source_kind: IMAGE_SOURCE_KINDS.DevelopedRaw },
    );
    useEditorStore
      .getState()
      .completeAdjustmentLoad(
        reconciled.adjustments,
        reconciled.context,
        selectedImage({ sourceKind: IMAGE_SOURCE_KINDS.DevelopedRaw }),
        loadDimensions,
      );

    const state = useEditorStore.getState();
    expect(state.selectedImage?.isReady).toBe(true);
    expect(state.adjustments.exposure).toBe(1);
    expect(state.adjustments.crop).toEqual(reconciled.adjustments.crop);
    expect(state.history).toEqual([reconciled.adjustments, state.adjustments]);
    expect(state.historyIndex).toBe(1);
    expect(state.adjustmentLoadContext).toMatchObject({ reconciled: true, dirty: true });
    expect(state.adjustmentLoadContext?.effectiveBaseline).toEqual(reconciled.adjustments);
    expect(persistenceMocks.scheduleSave).toHaveBeenCalledWith(
      '/fixtures/GFX100RF.RAF',
      expect.objectContaining({ exposure: 1, crop: reconciled.adjustments.crop }),
    );

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().adjustments).toEqual(reconciled.adjustments);
  });

  it('never carries crop geometry edited against provisional framing into an embedded-preview load', () => {
    const initialized = initializeAdjustmentLoad(metadata(null));
    useEditorStore.getState().setEditor({ selectedImage: selectedImage() });
    useEditorStore.getState().beginAdjustmentLoad(initialized.adjustments, initialized.context);
    const loading = useEditorStore.getState();
    useEditorStore.getState().applyExplicitAdjustments({
      ...loading.adjustments,
      crop: { unit: 'px', x: 150, y: 250, width: 6000, height: 2200 },
      aspectRatio: 1.5,
    });

    const reconciled = reconcileAdjustmentLoad(
      loading.adjustments,
      loading.adjustmentLoadContext as AdjustmentLoadContext,
      { source_kind: IMAGE_SOURCE_KINDS.EmbeddedPreview },
    );
    useEditorStore
      .getState()
      .completeAdjustmentLoad(reconciled.adjustments, reconciled.context, selectedImage(), loadDimensions);

    const state = useEditorStore.getState();
    expect(state.adjustments).toEqual(reconciled.adjustments);
    expect(state.adjustments.crop).toBeNull();
    expect(state.history).toEqual([reconciled.adjustments]);
    expect(state.adjustmentLoadContext?.dirty).toBe(false);
    expect(persistenceMocks.scheduleSave).not.toHaveBeenCalled();
  });

  it('ignores stale completion and derives ready provenance from the reconciled context', () => {
    const initialized = initializeAdjustmentLoad(metadata(null));
    useEditorStore.getState().setEditor({ selectedImage: selectedImage({ path: '/current.raf' }) });
    useEditorStore.getState().beginAdjustmentLoad(initialized.adjustments, initialized.context);
    const active = useEditorStore.getState();
    const reconciled = reconcileAdjustmentLoad(
      active.adjustments,
      active.adjustmentLoadContext as AdjustmentLoadContext,
      {
        source_kind: IMAGE_SOURCE_KINDS.DevelopedRaw,
      },
    );
    const staleDimensions = {
      originalSize: { width: 999, height: 888 },
    };

    useEditorStore
      .getState()
      .completeAdjustmentLoad(
        reconciled.adjustments,
        reconciled.context,
        selectedImage({ path: '/stale.raf', sourceKind: IMAGE_SOURCE_KINDS.EmbeddedPreview }),
        staleDimensions,
      );
    expect(useEditorStore.getState().selectedImage).toMatchObject({ path: '/current.raf', isReady: false });
    expect(useEditorStore.getState().adjustmentLoadContext?.reconciled).toBe(false);
    expect(useEditorStore.getState().originalSize).toEqual({ width: 0, height: 0 });

    useEditorStore
      .getState()
      .completeAdjustmentLoad(
        reconciled.adjustments,
        reconciled.context,
        selectedImage({ path: '/current.raf', sourceKind: IMAGE_SOURCE_KINDS.EmbeddedPreview }),
        loadDimensions,
      );
    expect(useEditorStore.getState().selectedImage).toMatchObject({
      path: '/current.raf',
      isReady: true,
      sourceKind: IMAGE_SOURCE_KINDS.DevelopedRaw,
    });
    expect(useEditorStore.getState().adjustmentLoadContext?.sourceKind).toBe(IMAGE_SOURCE_KINDS.DevelopedRaw);
    expect(useEditorStore.getState().originalSize).toEqual(loadDimensions.originalSize);
  });

  it('ignores an older completion for the same path after the active load has completed and been edited', () => {
    const completed = completeDevelopedLoad();
    const edited = cloneAdjustments({ ...useEditorStore.getState().adjustments, exposure: 2 });
    useEditorStore.getState().applyExplicitAdjustments(edited);
    const historyBefore = useEditorStore.getState().history;

    useEditorStore
      .getState()
      .completeAdjustmentLoad(completed.adjustments, completed.context, completed.image, loadDimensions);

    expect(useEditorStore.getState().adjustments.exposure).toBe(2);
    expect(useEditorStore.getState().adjustmentLoadContext?.dirty).toBe(true);
    expect(useEditorStore.getState().history).toEqual(historyBefore);
    vi.advanceTimersByTime(500);
    expect(useEditorStore.getState().history.at(-1)?.exposure).toBe(2);
  });

  it('does not begin a provisional load over an already-ready image', () => {
    completeDevelopedLoad();
    const before = useEditorStore.getState();
    const initialized = initializeAdjustmentLoad(metadata({ exposure: 3 }));

    useEditorStore.getState().beginAdjustmentLoad(initialized.adjustments, initialized.context);

    expect(useEditorStore.getState().adjustments).toEqual(before.adjustments);
    expect(useEditorStore.getState().history).toEqual(before.history);
    expect(useEditorStore.getState().adjustmentLoadContext).toEqual(before.adjustmentLoadContext);
    expect(useEditorStore.getState().selectedImage).toEqual(before.selectedImage);
  });

  it('applies an explicit edit and dirty flag atomically, then commits one debounced history entry', () => {
    completeDevelopedLoad();
    const edited = cloneAdjustments({ ...useEditorStore.getState().adjustments, exposure: 1 });
    const observed: ReturnType<typeof useEditorStore.getState>[] = [];
    const unsubscribe = useEditorStore.subscribe((state) => observed.push(state));

    useEditorStore.getState().applyExplicitAdjustments(edited);
    unsubscribe();

    expect(observed).toHaveLength(1);
    expect(observed[0].adjustments).toEqual(edited);
    expect(observed[0].adjustmentLoadContext?.dirty).toBe(true);
    expect(useEditorStore.getState().history).toHaveLength(1);

    vi.advanceTimersByTime(499);
    expect(useEditorStore.getState().history).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useEditorStore.getState().history).toEqual([
      expect.objectContaining({ exposure: 0 }),
      expect.objectContaining({ exposure: 1 }),
    ]);
  });

  it('marks undo, redo, and direct history navigation dirty as explicit user actions', () => {
    completeDevelopedLoad();
    useEditorStore.getState().applyExplicitAdjustments(cloneAdjustments({ exposure: 1 }));
    vi.advanceTimersByTime(500);
    useEditorStore.getState().applyExplicitAdjustments(cloneAdjustments({ exposure: 2 }));
    vi.advanceTimersByTime(500);

    const markClean = () => {
      const context = useEditorStore.getState().adjustmentLoadContext as AdjustmentLoadContext;
      useEditorStore.setState({ adjustmentLoadContext: { ...context, dirty: false } });
    };

    markClean();
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().adjustmentLoadContext?.dirty).toBe(true);
    expect(useEditorStore.getState().adjustments.exposure).toBe(1);

    markClean();
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().adjustmentLoadContext?.dirty).toBe(true);
    expect(useEditorStore.getState().adjustments.exposure).toBe(2);

    markClean();
    useEditorStore.getState().goToHistoryIndex(0);
    expect(useEditorStore.getState().adjustmentLoadContext?.dirty).toBe(true);
    expect(useEditorStore.getState().adjustments.exposure).toBe(0);
  });

  it('commits a pending first edit before undoing it back to the committed baseline, keeping it redoable', () => {
    completeDevelopedLoad();
    useEditorStore.getState().applyExplicitAdjustments(cloneAdjustments({ exposure: 1 }));

    useEditorStore.getState().undo();
    vi.advanceTimersByTime(500);

    const state = useEditorStore.getState();
    expect(state.adjustments.exposure).toBe(0);
    expect(state.history.map((entry) => entry.exposure)).toEqual([0, 1]);
    expect(state.historyIndex).toBe(0);

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().adjustments.exposure).toBe(1);
  });

  it('undoes a later pending edit to the latest committed entry without skipping it', () => {
    completeDevelopedLoad();
    useEditorStore.getState().applyExplicitAdjustments(cloneAdjustments({ exposure: 1 }));
    vi.advanceTimersByTime(500);
    useEditorStore.getState().applyExplicitAdjustments(cloneAdjustments({ exposure: 2 }));

    useEditorStore.getState().undo();
    vi.advanceTimersByTime(500);

    const state = useEditorStore.getState();
    expect(state.adjustments.exposure).toBe(1);
    expect(state.history.map((entry) => entry.exposure)).toEqual([0, 1, 2]);
    expect(state.historyIndex).toBe(1);
  });

  it('records a labelled explicit edit as its own history step after the pending slider snapshot', () => {
    const { adjustments: baseline } = completeDevelopedLoad();
    useEditorStore.getState().applyExplicitAdjustments({ ...baseline, exposure: 1 });
    useEditorStore.getState().applyExplicitAdjustments(
      { ...baseline, exposure: 1, contrast: 20 },
      {
        label: 'Auto Adjust',
      },
    );

    const state = useEditorStore.getState();
    expect(state.history.map((entry) => [entry.exposure, entry.contrast])).toEqual([
      [0, 0],
      [1, 0],
      [1, 20],
    ]);
    expect(state.historyLabels).toEqual(['', 'Exposure +1', 'Auto Adjust']);
    expect(state.historyIndex).toBe(2);
  });

  it('leaves show-original mode on an explicit edit but not on load completion', () => {
    completeDevelopedLoad();
    useEditorStore.getState().setEditor({ showOriginal: true, previewOverride: cloneAdjustments() });

    useEditorStore.getState().applyExplicitAdjustments(cloneAdjustments({ exposure: 1 }));

    expect(useEditorStore.getState()).toMatchObject({ showOriginal: false, previewOverride: null });
  });

  it('re-seeds an active crop session from the reconciled baseline instead of the pre-load geometry', () => {
    useEditorStore.getState().setEditor({
      cropSessionSnapshot: { path: '/previous.raf', geometry: { crop: null } as never },
    });
    const { adjustments } = completeDevelopedLoad();

    expect(useEditorStore.getState().cropSessionSnapshot).toEqual({
      path: '/fixtures/GFX100RF.RAF',
      geometry: expect.objectContaining({ crop: adjustments.crop, aspectRatio: adjustments.aspectRatio }),
    });
  });

  it('saves nothing while a slider drag is in progress and schedules the settled value once it ends', () => {
    const { adjustments: baseline } = completeDevelopedLoad();
    useEditorStore.getState().setEditor({ isSliderDragging: true });

    useEditorStore.getState().applyExplicitAdjustments({ ...baseline, exposure: 0.5 });
    useEditorStore.getState().applyExplicitAdjustments({ ...baseline, exposure: 1 });
    expect(persistenceMocks.scheduleSave).not.toHaveBeenCalled();

    useEditorStore.getState().setEditor({ zoom: 2 });
    expect(persistenceMocks.scheduleSave).not.toHaveBeenCalled();

    useEditorStore.getState().setEditor({ isSliderDragging: false });
    expect(persistenceMocks.scheduleSave).toHaveBeenCalledOnce();
    expect(persistenceMocks.scheduleSave).toHaveBeenCalledWith(
      '/fixtures/GFX100RF.RAF',
      expect.objectContaining({ exposure: 1, crop: baseline.crop }),
    );

    useEditorStore.getState().setEditor({ isSliderDragging: false });
    expect(persistenceMocks.scheduleSave).toHaveBeenCalledOnce();
  });

  it('does not save an untouched camera baseline when a drag starts and ends without an edit', () => {
    completeDevelopedLoad();

    useEditorStore.getState().setEditor({ isSliderDragging: true });
    useEditorStore.getState().setEditor({ isSliderDragging: false });

    expect(persistenceMocks.scheduleSave).not.toHaveBeenCalled();
  });

  it('applies an asynchronous backend result for the current image without creating a history step', () => {
    completeDevelopedLoad();
    const before = useEditorStore.getState();

    useEditorStore.getState().applyAsyncAdjustments('/fixtures/GFX100RF.RAF', (current) => ({ ...current }));
    expect(useEditorStore.getState().adjustments).not.toBe(before.adjustments);
    expect(useEditorStore.getState().adjustmentLoadContext?.dirty).toBe(false);
    expect(persistenceMocks.scheduleSave).not.toHaveBeenCalled();

    useEditorStore
      .getState()
      .applyAsyncAdjustments('/other.raf', (current) => ({ ...current, aiDenoiseEnabled: true }));
    expect(useEditorStore.getState().adjustments.aiDenoiseEnabled).toBe(false);

    useEditorStore
      .getState()
      .applyAsyncAdjustments('/fixtures/GFX100RF.RAF', (current) => ({ ...current, aiDenoiseEnabled: true }));
    vi.advanceTimersByTime(500);
    const state = useEditorStore.getState();
    expect(state.adjustments.aiDenoiseEnabled).toBe(true);
    expect(state.adjustmentLoadContext?.dirty).toBe(true);
    expect(state.history).toHaveLength(1);
    expect(persistenceMocks.scheduleSave).toHaveBeenCalledWith(
      '/fixtures/GFX100RF.RAF',
      expect.objectContaining({ aiDenoiseEnabled: true, crop: state.adjustments.crop }),
    );
  });

  it('begins a reload atomically and captures a suspended uncommitted history entry', () => {
    completeDevelopedLoad();
    const edited = cloneAdjustments({ ...useEditorStore.getState().adjustments, exposure: 1 });
    useEditorStore.getState().applyExplicitAdjustments(edited);
    const observed: ReturnType<typeof useEditorStore.getState>[] = [];
    const unsubscribe = useEditorStore.subscribe((state) => observed.push(state));

    const snapshot = useEditorStore.getState().beginAdjustmentReload('/fixtures/GFX100RF.RAF');
    unsubscribe();

    const state = useEditorStore.getState();
    expect(observed).toHaveLength(1);
    expect(state.selectedImage).toMatchObject({ isReady: false, sourceKind: null });
    expect(state.adjustmentLoadContext).toBeNull();
    expect(state.history).toEqual([]);
    expect(state.historyLabels).toEqual([]);
    expect(state.historyIndex).toBe(-1);
    expect(snapshot.adjustments).toEqual(edited);
    expect(snapshot.selectedImage).toMatchObject({
      isReady: true,
      sourceKind: IMAGE_SOURCE_KINDS.DevelopedRaw,
    });
    expect(snapshot.suspendedHistory).not.toBeNull();
  });

  it('rejects wrong-path and nested reloads without replacing the active rollback snapshot', () => {
    completeDevelopedLoad();
    const readyState = useEditorStore.getState();

    useEditorStore.getState().beginAdjustmentReload('/wrong-path.raf');
    expect(useEditorStore.getState().selectedImage).toEqual(readyState.selectedImage);
    expect(useEditorStore.getState().adjustmentReloadSnapshot).toBeNull();

    const first = useEditorStore.getState().beginAdjustmentReload('/fixtures/GFX100RF.RAF');
    const activeRollback = useEditorStore.getState().adjustmentReloadSnapshot;
    const nested = useEditorStore.getState().beginAdjustmentReload('/fixtures/GFX100RF.RAF');
    expect(useEditorStore.getState().adjustmentReloadSnapshot).toBe(activeRollback);
    expect(nested.reloadId).toBe(first.reloadId);

    useEditorStore.getState().restoreAdjustmentSession(nested);
    expect(useEditorStore.getState().selectedImage).toEqual(readyState.selectedImage);
  });

  it('keeps the internal rollback graph isolated from the returned reload snapshot', () => {
    completeDevelopedLoad();
    const before = structuredClone(useEditorStore.getState().adjustments);
    const snapshot = useEditorStore.getState().beginAdjustmentReload('/fixtures/GFX100RF.RAF');
    const internal = useEditorStore.getState().adjustmentReloadSnapshot;

    snapshot.adjustments.exposure = 9;
    snapshot.adjustments.curves.luma[0].x = 99;
    snapshot.history[0].hsl.reds.hue = 99;

    expect(internal).not.toBe(snapshot);
    expect(internal?.adjustments).toEqual(before);
    expect(internal?.history[0].hsl.reds.hue).toBe(0);
    expect(snapshot.adjustments).not.toBe(internal?.adjustments);

    useEditorStore.getState().restoreAdjustmentSession(snapshot);
    expect(useEditorStore.getState().adjustments).toEqual(before);
  });

  it('preserves the newest pending history when a supplied token races a later edit', () => {
    completeDevelopedLoad();
    useEditorStore.getState().applyExplicitAdjustments(cloneAdjustments({ exposure: 1 }));
    const olderToken = suspendPendingHistory();
    useEditorStore.getState().applyExplicitAdjustments(cloneAdjustments({ exposure: 2 }));

    const snapshot = useEditorStore.getState().beginAdjustmentReload('/fixtures/GFX100RF.RAF', olderToken);
    vi.advanceTimersByTime(500);
    expect(useEditorStore.getState().history).toEqual([]);

    useEditorStore.getState().restoreAdjustmentSession(snapshot);
    vi.advanceTimersByTime(500);
    expect(useEditorStore.getState().history.at(-1)?.exposure).toBe(2);
  });

  it('does not restore an old image history token into a replacement image session', () => {
    completeDevelopedLoad();
    useEditorStore.getState().applyExplicitAdjustments(cloneAdjustments({ exposure: 3 }));
    const oldImageToken = suspendPendingHistory();

    useEditorStore.getState().beginImageSelection(selectedImage({ path: '/fixtures/replacement.RAF' }));
    restorePendingHistory(oldImageToken);
    vi.advanceTimersByTime(500);

    expect(useEditorStore.getState().selectedImage?.path).toBe('/fixtures/replacement.RAF');
    expect(useEditorStore.getState().history).toEqual([]);
  });

  it('installs a new unready image while clearing old adjustment provenance atomically', () => {
    completeDevelopedLoad();
    const nextImage = selectedImage({ path: '/fixtures/next.RAF' });
    const observed: ReturnType<typeof useEditorStore.getState>[] = [];
    const unsubscribe = useEditorStore.subscribe((state) => observed.push(state));

    useEditorStore.getState().beginImageSelection(nextImage);
    unsubscribe();

    expect(observed).toHaveLength(1);
    expect(useEditorStore.getState().selectedImage).toMatchObject({
      path: '/fixtures/next.RAF',
      isReady: false,
      sourceKind: null,
    });
    expect(useEditorStore.getState().adjustmentLoadContext).toBeNull();
    expect(useEditorStore.getState().history).toEqual([]);
    expect(useEditorStore.getState().historyIndex).toBe(-1);
  });

  it('clears the editor atomically, cancels pending history, and restores a cloned empty value', () => {
    completeDevelopedLoad();
    useEditorStore.getState().applyExplicitAdjustments(cloneAdjustments({ exposure: 2 }));
    const observed: ReturnType<typeof useEditorStore.getState>[] = [];
    const unsubscribe = useEditorStore.subscribe((state) => observed.push(state));

    useEditorStore.getState().clearEditorSession();
    unsubscribe();
    vi.advanceTimersByTime(500);

    const state = useEditorStore.getState();
    expect(observed).toHaveLength(1);
    expect(state.selectedImage).toBeNull();
    expect(state.adjustmentLoadContext).toBeNull();
    expect(state.history).toEqual([]);
    expect(state.historyIndex).toBe(-1);
    expect(state.adjustments).toEqual(INITIAL_ADJUSTMENTS);
    expect(state.adjustments).not.toBe(INITIAL_ADJUSTMENTS);
    expect(state.adjustments.hsl).not.toBe(INITIAL_ADJUSTMENTS.hsl);
    expect(state.adjustments.curves).not.toBe(INITIAL_ADJUSTMENTS.curves);
    expect(state.patchesSentToBackend).not.toBe(useEditorStore.getInitialState().patchesSentToBackend);
    expect('resetHistory' in state).toBe(false);
  });

  it('restores the exact pre-reload adjustment session and its suspended history in one transition', () => {
    completeDevelopedLoad();
    const edited = cloneAdjustments({ ...useEditorStore.getState().adjustments, exposure: 2 });
    useEditorStore.getState().applyExplicitAdjustments(edited);
    const snapshot = useEditorStore.getState().beginAdjustmentReload('/fixtures/GFX100RF.RAF');
    const observed: ReturnType<typeof useEditorStore.getState>[] = [];
    const unsubscribe = useEditorStore.subscribe((state) => observed.push(state));

    useEditorStore.getState().restoreAdjustmentSession(snapshot);
    unsubscribe();

    expect(observed).toHaveLength(1);
    expect(observed.some((entry) => entry.selectedImage?.isReady && !entry.adjustmentLoadContext?.reconciled)).toBe(
      false,
    );
    expect(useEditorStore.getState()).toMatchObject({
      adjustments: snapshot.adjustments,
      history: snapshot.history,
      historyIndex: snapshot.historyIndex,
      adjustmentLoadContext: snapshot.adjustmentLoadContext,
      selectedImage: snapshot.selectedImage,
    });

    vi.advanceTimersByTime(500);
    expect(useEditorStore.getState().history.at(-1)).toEqual(edited);
    const restoredState = useEditorStore.getState();
    useEditorStore.getState().restoreAdjustmentSession(snapshot);
    vi.advanceTimersByTime(500);
    expect(useEditorStore.getState().adjustments).toEqual(restoredState.adjustments);
    expect(useEditorStore.getState().history).toEqual(restoredState.history);
    expect(useEditorStore.getState().selectedImage).toEqual(restoredState.selectedImage);
  });

  it('keeps reload generations monotonic across restore and retry without duplicating suspended history', () => {
    completeDevelopedLoad();
    const edited = cloneAdjustments({ ...useEditorStore.getState().adjustments, exposure: 3 });
    useEditorStore.getState().applyExplicitAdjustments(edited);

    const first = useEditorStore.getState().beginAdjustmentReload('/fixtures/GFX100RF.RAF');
    const firstGeneration = useEditorStore.getState().adjustmentSessionGeneration;
    useEditorStore.getState().restoreAdjustmentSession(first);
    const restoredGeneration = useEditorStore.getState().adjustmentSessionGeneration;
    const second = useEditorStore.getState().beginAdjustmentReload('/fixtures/GFX100RF.RAF');
    const secondGeneration = useEditorStore.getState().adjustmentSessionGeneration;

    expect(restoredGeneration).toBeGreaterThan(firstGeneration);
    expect(secondGeneration).toBeGreaterThan(restoredGeneration);
    expect(secondGeneration).not.toBe(firstGeneration);

    useEditorStore.getState().restoreAdjustmentSession(second);
    vi.advanceTimersByTime(500);
    expect(useEditorStore.getState().history.filter((entry) => entry.exposure === 3)).toHaveLength(1);
  });

  it('does not allow the generic editor setter to replace protected adjustment state', () => {
    const assertProtectedSetterTypes = () => {
      // @ts-expect-error adjustment replacement must use a focused action
      useEditorStore.getState().setEditor({ adjustments: INITIAL_ADJUSTMENTS });
      const widerPatch: Partial<ReturnType<typeof useEditorStore.getState>> = {
        adjustments: INITIAL_ADJUSTMENTS,
        zoom: 2,
      };
      // @ts-expect-error wider state patches cannot bypass protected keys
      useEditorStore.getState().setEditor(widerPatch);
    };
    void assertProtectedSetterTypes;

    expect(useEditorStore.getState().adjustments).toEqual(INITIAL_ADJUSTMENTS);
  });
});

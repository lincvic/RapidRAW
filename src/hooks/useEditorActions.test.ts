import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelectedImage } from '../components/ui/AppProperties';
import { useEditorStore } from '../store/useEditorStore';
import { IMAGE_SOURCE_KINDS, type AdjustmentLoadContext } from '../types/imageLoading';
import { initializeAdjustmentLoad, reconcileAdjustmentLoad } from '../utils/rafCameraDefaults';
import {
  applyBackendAdjustmentMutation,
  routeAdjustmentMutationForSelection,
  routeResetForSelection,
  runAutoAdjustmentsForCurrentSession,
} from './useEditorActions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('editor auto-adjust session routing', () => {
  const readySession = (path: string, generation: number) => ({
    adjustmentSessionGeneration: generation,
    selectedImage: { isReady: true, path },
  });

  it('does not calculate or apply adjustments for an unready session', async () => {
    const calculate = vi.fn(async () => ({ exposure: 1 }));
    const apply = vi.fn();

    const applied = await runAutoAdjustmentsForCurrentSession(
      () => ({ adjustmentSessionGeneration: 3, selectedImage: { isReady: false, path: '/fixtures/A.RAF' } }),
      calculate,
      apply,
    );

    expect(applied).toBe(false);
    expect(calculate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies calculated adjustments only while the same ready session remains current', async () => {
    const session = readySession('/fixtures/A.RAF', 3);
    const adjustments = { exposure: 1 };
    const apply = vi.fn();

    const applied = await runAutoAdjustmentsForCurrentSession(
      () => session,
      async () => adjustments,
      apply,
    );

    expect(applied).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(adjustments);
  });

  it('discards a delayed result after navigation selects another image', async () => {
    let session = readySession('/fixtures/A.RAF', 3);
    const calculation = deferred<{ exposure: number }>();
    const apply = vi.fn();
    const operation = runAutoAdjustmentsForCurrentSession(
      () => session,
      () => calculation.promise,
      apply,
    );

    session = readySession('/fixtures/B.RAF', 4);
    calculation.resolve({ exposure: 1 });

    await expect(operation).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('discards a delayed result after the same path starts a new editor session', async () => {
    let session = readySession('/fixtures/A.RAF', 3);
    const calculation = deferred<{ exposure: number }>();
    const apply = vi.fn();
    const operation = runAutoAdjustmentsForCurrentSession(
      () => session,
      () => calculation.promise,
      apply,
    );

    session = readySession('/fixtures/A.RAF', 4);
    calculation.resolve({ exposure: 1 });

    await expect(operation).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('discards a delayed result when the target becomes unready', async () => {
    let session = readySession('/fixtures/A.RAF', 3);
    const calculation = deferred<{ exposure: number }>();
    const apply = vi.fn();
    const operation = runAutoAdjustmentsForCurrentSession(
      () => session,
      () => calculation.promise,
      apply,
    );

    session = { ...session, selectedImage: { ...session.selectedImage, isReady: false } };
    calculation.resolve({ exposure: 1 });

    await expect(operation).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('whole-image reset routing', () => {
  it('waits for a loading selected target before routing it through the authoritative reset', async () => {
    let selectedImage = { isReady: false, path: '/fixtures/loading.RAF' };
    const loaded = deferred<void>();
    const waitForChange = vi.fn(() => loaded.promise);
    const resetSelected = vi.fn(async () => undefined);
    const resetWithoutSelected = vi.fn(async () => undefined);

    const operation = routeResetForSelection(
      () => selectedImage,
      ['/fixtures/loading.RAF'],
      resetSelected,
      resetWithoutSelected,
      waitForChange,
    );
    await Promise.resolve();
    expect(waitForChange).toHaveBeenCalledWith('/fixtures/loading.RAF');
    expect(resetSelected).not.toHaveBeenCalled();

    selectedImage = { ...selectedImage, isReady: true };
    loaded.resolve();

    await expect(operation).resolves.toBe(true);
    expect(resetSelected).toHaveBeenCalledWith('/fixtures/loading.RAF');
    expect(resetWithoutSelected).not.toHaveBeenCalled();
  });

  it('resets without the editor barrier when the loading target is deselected first', async () => {
    let selectedImage: { isReady: boolean; path: string } | null = { isReady: false, path: '/fixtures/loading.RAF' };
    const resetSelected = vi.fn(async () => undefined);
    const resetWithoutSelected = vi.fn(async () => undefined);

    const ran = await routeResetForSelection(
      () => selectedImage,
      ['/fixtures/loading.RAF'],
      resetSelected,
      resetWithoutSelected,
      async () => {
        selectedImage = null;
      },
    );

    expect(ran).toBe(false);
    expect(resetSelected).not.toHaveBeenCalled();
    expect(resetWithoutSelected).toHaveBeenCalledOnce();
  });

  it('routes a ready selected target through the authoritative reset callback', async () => {
    const resetSelected = vi.fn(async () => undefined);
    const resetWithoutSelected = vi.fn();
    const waitForChange = vi.fn();

    const ran = await routeResetForSelection(
      () => ({ isReady: true, path: '/fixtures/ready.RAF' }),
      ['/fixtures/ready.RAF', '/fixtures/other.RAF'],
      resetSelected,
      resetWithoutSelected,
      waitForChange,
    );

    expect(ran).toBe(true);
    expect(waitForChange).not.toHaveBeenCalled();
    expect(resetSelected).toHaveBeenCalledWith('/fixtures/ready.RAF');
    expect(resetWithoutSelected).not.toHaveBeenCalled();
  });
});

describe('backend sidecar mutation routing', () => {
  it('waits for a loading editor target instead of racing its metadata-first load', async () => {
    let selectedImage = { isReady: false, path: '/fixtures/loading.RAF' };
    const loaded = deferred<void>();
    const runSelectedMutation = vi.fn(async (_path: string, mutate: () => Promise<void>) => mutate());
    const mutate = vi.fn(async () => undefined);

    const operation = routeAdjustmentMutationForSelection(
      () => selectedImage,
      ['/fixtures/loading.RAF', '/fixtures/other.RAF'],
      runSelectedMutation,
      mutate,
      () => loaded.promise,
    );
    await Promise.resolve();
    expect(runSelectedMutation).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();

    selectedImage = { ...selectedImage, isReady: true };
    loaded.resolve();

    await expect(operation).resolves.toBe(true);
    expect(runSelectedMutation).toHaveBeenCalledWith('/fixtures/loading.RAF', expect.any(Function));
    expect(mutate).toHaveBeenCalledOnce();
  });

  it('runs directly against the backend when the loading target is replaced by an image outside the batch', async () => {
    let selectedImage = { isReady: false, path: '/fixtures/loading.RAF' };
    const runSelectedMutation = vi.fn(async (_path: string, mutate: () => Promise<void>) => mutate());
    const mutate = vi.fn(async () => undefined);

    const selectedTarget = await routeAdjustmentMutationForSelection(
      () => selectedImage,
      ['/fixtures/loading.RAF'],
      runSelectedMutation,
      mutate,
      async () => {
        selectedImage = { isReady: false, path: '/fixtures/unrelated.RAF' };
      },
    );

    expect(selectedTarget).toBe(false);
    expect(runSelectedMutation).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledOnce();
  });

  it('routes a ready editor target through the editor save window', async () => {
    const runSelectedMutation = vi.fn(async (_path: string, mutate: () => Promise<void>) => mutate());
    const mutate = vi.fn(async () => undefined);

    const selectedTarget = await routeAdjustmentMutationForSelection(
      () => ({ isReady: true, path: '/fixtures/ready.RAF' }),
      ['/fixtures/ready.RAF', '/fixtures/other.RAF'],
      runSelectedMutation,
      mutate,
    );

    expect(selectedTarget).toBe(true);
    expect(runSelectedMutation).toHaveBeenCalledOnce();
    expect(runSelectedMutation).toHaveBeenCalledWith('/fixtures/ready.RAF', expect.any(Function));
    expect(mutate).toHaveBeenCalledOnce();
  });

  it('runs a selection excluding the editor image directly against the backend', async () => {
    const runSelectedMutation = vi.fn(async (_path: string, mutate: () => Promise<void>) => mutate());
    const mutate = vi.fn(async () => undefined);
    const waitForChange = vi.fn();

    const selectedTarget = await routeAdjustmentMutationForSelection(
      () => ({ isReady: false, path: '/fixtures/loading.RAF' }),
      ['/fixtures/other.RAF'],
      runSelectedMutation,
      mutate,
      waitForChange,
    );

    expect(selectedTarget).toBe(false);
    expect(waitForChange).not.toHaveBeenCalled();
    expect(runSelectedMutation).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledOnce();
  });

  it('rechecks readiness after a selected mutation waits and before invoking the backend', async () => {
    let selectedImage = { isReady: true, path: '/fixtures/ready.RAF' };
    const mutate = vi.fn(async () => undefined);
    const runSelectedMutation = vi.fn(async (_path: string, mutate: () => Promise<void>) => {
      selectedImage = { ...selectedImage, isReady: false };
      await mutate();
    });

    await expect(
      routeAdjustmentMutationForSelection(() => selectedImage, ['/fixtures/ready.RAF'], runSelectedMutation, mutate),
    ).rejects.toMatchObject({ name: 'AdjustmentTargetLoadingError' });

    expect(runSelectedMutation).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('rechecks the selected path after a mutation waits and before invoking the backend', async () => {
    let selectedImage = { isReady: true, path: '/fixtures/ready.RAF' };
    const mutate = vi.fn(async () => undefined);
    const runSelectedMutation = vi.fn(async (_path: string, mutate: () => Promise<void>) => {
      selectedImage = { isReady: true, path: '/fixtures/replacement.RAF' };
      await mutate();
    });

    await expect(
      routeAdjustmentMutationForSelection(() => selectedImage, ['/fixtures/ready.RAF'], runSelectedMutation, mutate),
    ).rejects.toMatchObject({ name: 'AdjustmentTargetLoadingError' });

    expect(runSelectedMutation).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('default editor readiness waiter', () => {
  const loadingImage = (path: string): SelectedImage => ({
    exif: null,
    height: 0,
    isRaw: true,
    isReady: false,
    metadata: null,
    path,
    sourceKind: null,
    thumbnailUrl: '',
    width: 0,
  });

  afterEach(() => {
    useEditorStore.setState(useEditorStore.getInitialState(), true);
  });

  it('routes a reset once the store reports the loading target ready', async () => {
    useEditorStore.getState().beginImageSelection(loadingImage('/fixtures/waiting.RAF'));
    const resetSelected = vi.fn(async () => undefined);
    const resetWithoutSelected = vi.fn(async () => undefined);

    const operation = routeResetForSelection(
      () => useEditorStore.getState().selectedImage,
      ['/fixtures/waiting.RAF'],
      resetSelected,
      resetWithoutSelected,
    );
    await Promise.resolve();
    expect(resetSelected).not.toHaveBeenCalled();

    useEditorStore.getState().setEditor((state) => ({ selectedImage: { ...state.selectedImage!, isReady: true } }));

    await expect(operation).resolves.toBe(true);
    expect(resetSelected).toHaveBeenCalledWith('/fixtures/waiting.RAF');
    expect(resetWithoutSelected).not.toHaveBeenCalled();
  });

  it('stops waiting as soon as the editor session is cleared', async () => {
    useEditorStore.getState().beginImageSelection(loadingImage('/fixtures/abandoned.RAF'));
    const runSelectedMutation = vi.fn();
    const mutate = vi.fn(async () => undefined);

    const operation = routeAdjustmentMutationForSelection(
      () => useEditorStore.getState().selectedImage,
      ['/fixtures/abandoned.RAF'],
      runSelectedMutation,
      mutate,
    );
    await Promise.resolve();
    useEditorStore.getState().clearEditorSession();

    await expect(operation).resolves.toBe(false);
    expect(runSelectedMutation).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledOnce();
  });
});

describe('backend sidecar mutation of the open image', () => {
  const openReadyImage = (path: string) => {
    const initialized = initializeAdjustmentLoad({
      version: 1,
      rating: 0,
      adjustments: { exposure: 0.5 },
      tags: null,
      cameraDefaults: { crop: null, aspectRatio: null, canvasWidth: null, canvasHeight: null },
    });
    useEditorStore.getState().beginImageSelection({
      exif: null,
      height: 3000,
      isRaw: true,
      isReady: false,
      metadata: null,
      path,
      sourceKind: null,
      thumbnailUrl: '',
      width: 4000,
    });
    useEditorStore.getState().beginAdjustmentLoad(initialized.adjustments, initialized.context);
    const loading = useEditorStore.getState();
    const reconciled = reconcileAdjustmentLoad(
      loading.adjustments,
      loading.adjustmentLoadContext as AdjustmentLoadContext,
      { source_kind: IMAGE_SOURCE_KINDS.DevelopedRaw },
    );
    useEditorStore
      .getState()
      .completeAdjustmentLoad(reconciled.adjustments, reconciled.context, loading.selectedImage as SelectedImage, {
        originalSize: { width: 4000, height: 3000 },
      });
    return useEditorStore.getState();
  };

  afterEach(() => {
    useEditorStore.setState(useEditorStore.getInitialState(), true);
  });

  it('makes the open image unready before the backend runs and leaves it reloading afterwards', async () => {
    const path = '/fixtures/batch.RAF';
    openReadyImage(path);
    const backend = deferred<void>();
    const readinessWhenBackendStarted: boolean[] = [];

    const operation = applyBackendAdjustmentMutation([path], async () => {
      readinessWhenBackendStarted.push(Boolean(useEditorStore.getState().selectedImage?.isReady));
      await backend.promise;
    });
    await vi.waitFor(() => expect(readinessWhenBackendStarted).toEqual([false]));

    backend.resolve();
    await operation;

    const state = useEditorStore.getState();
    expect(state.selectedImage).toMatchObject({ path, isReady: false, sourceKind: null });
    expect(state.adjustmentReloadSnapshot?.adjustments.exposure).toBe(0.5);
  });

  it('restores the open session when the backend command fails', async () => {
    const path = '/fixtures/failed-batch.RAF';
    const before = openReadyImage(path);

    await expect(
      applyBackendAdjustmentMutation([path], async () => {
        throw new Error('backend failed');
      }),
    ).rejects.toThrow('backend failed');

    const state = useEditorStore.getState();
    expect(state.selectedImage).toMatchObject({ path, isReady: true });
    expect(state.adjustments).toEqual(before.adjustments);
    expect(state.adjustmentReloadSnapshot).toBeNull();
  });
});

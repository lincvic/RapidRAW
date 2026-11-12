import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelectedImage } from '../components/ui/AppProperties';
import { useEditorStore } from '../store/useEditorStore';
import {
  IMAGE_SOURCE_KINDS,
  type AdjustmentLoadContext,
  type ImageSourceKind,
  type LoadImageResult,
  type LoadMetadataResult,
  type PersistedAdjustments,
} from '../types/imageLoading';
import type { Adjustments } from '../utils/adjustments';
import { ORIGINAL_RATIO, resolveAspectRatio } from '../utils/cropUtils';
import {
  createCachedEditorPlaceholder,
  createEditorCacheEntry,
  ImageLRUCache,
  type ImageCacheEntry,
} from '../utils/ImageLRUCache';
import { adjustmentsForPersistence } from '../utils/rafCameraDefaults';
import { createEditorPersistence } from './editorPersistence';
import { coordinateEditorImageLoad } from './editorImageLoad';

const cameraDefaults: LoadMetadataResult['cameraDefaults'] = {
  crop: { x: 100, y: 200, width: 6500, height: 2400 },
  aspectRatio: 65 / 24,
  canvasWidth: 7000,
  canvasHeight: 3000,
};

const metadataWith = (
  adjustments: PersistedAdjustments,
  defaults: LoadMetadataResult['cameraDefaults'] = cameraDefaults,
): LoadMetadataResult => ({
  version: 1,
  rating: 0,
  adjustments,
  tags: ['fixture'],
  exif: { Camera: 'GFX100RF' },
  cameraDefaults: defaults,
});

const imageWith = (
  source_kind: ImageSourceKind,
  adjustments: PersistedAdjustments,
  width = 7000,
  height = 3000,
): LoadImageResult => ({
  width,
  height,
  metadata: {
    version: 1,
    rating: 0,
    adjustments,
    tags: ['fixture'],
    exif: { Camera: 'GFX100RF' },
  },
  exif: { Camera: 'GFX100RF' },
  is_raw: source_kind !== IMAGE_SOURCE_KINDS.NonRaw,
  as_shot_white_balance: { temperature: 5200, tint: 4 },
  source_kind,
});

const selectedImage = (overrides: Partial<SelectedImage> = {}): SelectedImage => ({
  exif: null,
  height: 0,
  isRaw: false,
  isReady: false,
  metadata: null,
  path: '/fixtures/GFX100RF.RAF',
  sourceKind: null,
  thumbnailUrl: 'fixture-thumbnail',
  width: 0,
  ...overrides,
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const coordinateStoreLoad = async (
  path: string,
  adjustments: PersistedAdjustments,
  sourceKind: ImageSourceKind,
  flushPendingSave: () => Promise<void> = async () => undefined,
  beforeMetadata: () => void = () => undefined,
  width = 7000,
  height = 3000,
) =>
  coordinateEditorImageLoad(path, {
    flushPendingSave: async () => flushPendingSave(),
    loadMetadata: async () => {
      beforeMetadata();
      return metadataWith(adjustments);
    },
    loadImage: async () => imageWith(sourceKind, adjustments, width, height),
    onMetadata: (initialized) => {
      const store = useEditorStore.getState();
      store.beginAdjustmentLoad(initialized.adjustments, initialized.context);
      const active = useEditorStore.getState();
      return {
        adjustments: active.adjustments,
        context: active.adjustmentLoadContext as AdjustmentLoadContext,
      };
    },
    onComplete: (completed) => {
      const store = useEditorStore.getState();
      store.completeAdjustmentLoad(
        completed.adjustments,
        completed.context,
        {
          ...(store.selectedImage as SelectedImage),
          exif: completed.image.exif,
          height: completed.image.height,
          isRaw: completed.image.is_raw,
          metadata: completed.image.metadata,
          sourceKind: completed.image.source_kind,
          width: completed.image.width,
        },
        { originalSize: { width: completed.image.width, height: completed.image.height } },
      );
    },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  useEditorStore.setState(useEditorStore.getInitialState(), true);
});

describe('editor image load coordinator', () => {
  it.each([
    [IMAGE_SOURCE_KINDS.DevelopedRaw, true],
    [IMAGE_SOURCE_KINDS.EmbeddedPreview, false],
    [IMAGE_SOURCE_KINDS.NonRaw, false],
  ] as const)('loads metadata before a %s image and reconciles its camera framing', async (sourceKind, keepsCrop) => {
    const events: string[] = [];
    const metadata = metadataWith(null);
    const image = imageWith(sourceKind, null);
    let provisionalCrop: Adjustments['crop'] | undefined;
    let completion: Awaited<ReturnType<typeof coordinateEditorImageLoad>> | undefined;

    await coordinateEditorImageLoad('/fixtures/GFX100RF.RAF', {
      flushPendingSave: async () => {
        events.push('flush_save:start');
        await Promise.resolve();
        events.push('flush_save:end');
      },
      loadMetadata: async () => {
        events.push('load_metadata:start');
        await Promise.resolve();
        events.push('load_metadata:end');
        return metadata;
      },
      loadImage: async () => {
        events.push('load_image:start');
        await Promise.resolve();
        events.push('load_image:end');
        return image;
      },
      onMetadata: (initialized) => {
        events.push('begin_adjustments');
        provisionalCrop = initialized.adjustments.crop;
        return initialized;
      },
      onComplete: (completed) => {
        events.push('complete_atomic');
        completion = completed;
      },
    });

    expect(events).toEqual([
      'flush_save:start',
      'flush_save:end',
      'load_metadata:start',
      'load_metadata:end',
      'begin_adjustments',
      'load_image:start',
      'load_image:end',
      'complete_atomic',
    ]);
    expect(provisionalCrop).toEqual({ unit: 'px', x: 100, y: 200, width: 6500, height: 2400 });
    expect(completion?.image.source_kind).toBe(sourceKind);
    expect(completion?.context.sourceKind).toBe(sourceKind);
    expect(completion?.context.reconciled).toBe(true);
    expect(completion?.adjustments.crop !== null).toBe(keepsCrop);
    expect(completion?.history).toEqual([completion?.adjustments]);
    expect(completion?.historyIndex).toBe(0);
  });

  it('never exposes a provisional RAF crop through embedded-preview completion or history', async () => {
    let completion: Awaited<ReturnType<typeof coordinateEditorImageLoad>> | undefined;

    await coordinateEditorImageLoad('/fixtures/fallback.RAF', {
      flushPendingSave: async () => undefined,
      loadMetadata: async () => metadataWith(null),
      loadImage: async () => imageWith(IMAGE_SOURCE_KINDS.EmbeddedPreview, null, 4000, 3000),
      onMetadata: (initialized) => {
        expect(initialized.adjustments.crop).not.toBeNull();
        return initialized;
      },
      onComplete: (completed) => {
        completion = completed;
      },
    });

    expect(completion?.adjustments.crop).toBeNull();
    expect(completion?.adjustments.aspectRatio).toBe(ORIGINAL_RATIO);
    expect(resolveAspectRatio(completion!.adjustments.aspectRatio, completion!.image, 0)).toBe(4 / 3);
    expect(completion?.history[0].crop).toBeNull();
    expect(completion?.context.effectiveBaseline.crop).toBeNull();
  });

  it('waits for the pending save to resolve before the first metadata read', async () => {
    const save = deferred<void>();
    const loadMetadata = vi.fn(async () => metadataWith(null));
    const operation = coordinateEditorImageLoad('/fixtures/gated.RAF', {
      flushPendingSave: () => save.promise,
      loadMetadata,
      loadImage: async () => imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, null),
      onMetadata: (initialized) => initialized,
      onComplete: () => undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(loadMetadata).not.toHaveBeenCalled();

    save.resolve();
    await operation;
    expect(loadMetadata).toHaveBeenCalledOnce();
  });

  it('cancels a stale load after metadata without invoking image, retry, or completion', async () => {
    const firstMetadata = deferred<LoadMetadataResult>();
    let firstIsCurrent = true;
    const firstLoadMetadata = vi.fn(() => firstMetadata.promise);
    const firstLoadImage = vi.fn(async () => imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, null));
    const firstOnMetadata = vi.fn((initialized) => initialized);
    const firstOnComplete = vi.fn();
    const first = coordinateEditorImageLoad('/fixtures/A.RAF', {
      flushPendingSave: async () => undefined,
      isCurrent: () => firstIsCurrent,
      loadMetadata: firstLoadMetadata,
      loadImage: firstLoadImage,
      onMetadata: firstOnMetadata,
      onComplete: firstOnComplete,
    });

    await vi.waitFor(() => expect(firstLoadMetadata).toHaveBeenCalledOnce());
    firstIsCurrent = false;

    const secondLoadImage = vi.fn(async () => imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, null));
    const second = coordinateEditorImageLoad('/fixtures/B.RAF', {
      flushPendingSave: async () => undefined,
      isCurrent: () => true,
      loadMetadata: async () => metadataWith(null),
      loadImage: secondLoadImage,
      onMetadata: (initialized) => initialized,
      onComplete: () => undefined,
    });

    await second;
    firstMetadata.resolve(metadataWith(null));

    await expect(first).rejects.toThrow(/cancelled/i);
    expect(secondLoadImage).toHaveBeenCalledOnce();
    expect(firstOnMetadata).not.toHaveBeenCalled();
    expect(firstLoadImage).not.toHaveBeenCalled();
    expect(firstOnComplete).not.toHaveBeenCalled();
  });

  it('keeps a fast cache hit metadata-first and trusts its current authoritative source kind', async () => {
    const events: string[] = [];
    const priorCachedSourceKind = IMAGE_SOURCE_KINDS.DevelopedRaw;
    let completedSourceKind: ImageSourceKind | null = priorCachedSourceKind;

    await coordinateEditorImageLoad('/fixtures/cached.RAF', {
      flushPendingSave: async () => {
        events.push('flush');
      },
      loadMetadata: async () => {
        events.push('metadata');
        return metadataWith(null);
      },
      loadImage: async () => {
        events.push('image');
        return imageWith(IMAGE_SOURCE_KINDS.EmbeddedPreview, null);
      },
      onMetadata: (initialized) => {
        events.push('begin');
        return initialized;
      },
      onComplete: (completed) => {
        events.push('complete');
        completedSourceKind = completed.context.sourceKind;
      },
    });

    expect(events).toEqual(['flush', 'metadata', 'begin', 'image', 'complete']);
    expect(completedSourceKind).toBe(IMAGE_SOURCE_KINDS.EmbeddedPreview);
    expect(completedSourceKind).not.toBe(priorCachedSourceKind);
  });

  it('uses a null/default metadata result for one failed command attempt, then retries the complete pair', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const authoritative = metadataWith({ exposure: 1.25 });
    const metadataAttempts: LoadMetadataResult[] = [];
    const provisionalExposure: number[] = [];
    let attempt = 0;
    let completion: Awaited<ReturnType<typeof coordinateEditorImageLoad>> | undefined;

    await coordinateEditorImageLoad('/fixtures/transient.RAF', {
      flushPendingSave: async () => undefined,
      loadMetadata: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('transient metadata failure');
        return authoritative;
      },
      loadImage: async () => imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, { exposure: 1.25 }),
      onMetadata: (initialized, metadata) => {
        metadataAttempts.push(metadata);
        provisionalExposure.push(initialized.adjustments.exposure);
        return initialized;
      },
      onComplete: (completed) => {
        completion = completed;
      },
    });

    expect(attempt).toBe(2);
    expect(metadataAttempts[0]).toEqual({
      version: 1,
      rating: 0,
      adjustments: null,
      tags: null,
      exif: null,
      cameraDefaults: {
        crop: null,
        aspectRatio: null,
        canvasWidth: null,
        canvasHeight: null,
      },
    });
    expect(metadataAttempts[1]).toBe(authoritative);
    expect(provisionalExposure).toEqual([0, 1.25]);
    expect(completion?.metadata).toBe(authoritative);
    expect(completion?.adjustments.exposure).toBe(1.25);
  });

  it('allows a failed metadata command to complete only when that attempt image metadata is also null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onComplete = vi.fn();

    await coordinateEditorImageLoad('/fixtures/no-sidecar.RAF', {
      flushPendingSave: async () => undefined,
      loadMetadata: async () => {
        throw new Error('metadata unavailable');
      },
      loadImage: async () => imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, null),
      onMetadata: (initialized) => initialized,
      onComplete,
    });

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0][0].metadata.adjustments).toBeNull();
  });

  it('discards a pair that disagrees on null precedence and completes using only the second pair', async () => {
    const metadataPairs = [metadataWith(null), metadataWith({ exposure: 2 })];
    const imagePairs = [
      imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, { exposure: 1 }),
      imageWith(IMAGE_SOURCE_KINDS.EmbeddedPreview, { exposure: 2 }),
    ];
    const initializedExposures: number[] = [];
    let metadataAttempt = 0;
    let imageAttempt = 0;
    let completion: Awaited<ReturnType<typeof coordinateEditorImageLoad>> | undefined;

    await coordinateEditorImageLoad('/fixtures/replaced.RAF', {
      flushPendingSave: async () => undefined,
      loadMetadata: async () => metadataPairs[metadataAttempt++],
      loadImage: async () => imagePairs[imageAttempt++],
      onMetadata: (initialized) => {
        initializedExposures.push(initialized.adjustments.exposure);
        return initialized;
      },
      onComplete: (completed) => {
        completion = completed;
      },
    });

    expect(metadataAttempt).toBe(2);
    expect(imageAttempt).toBe(2);
    expect(initializedExposures).toEqual([0, 2]);
    expect(completion?.metadata).toBe(metadataPairs[1]);
    expect(completion?.image).toBe(imagePairs[1]);
    expect(completion?.adjustments.exposure).toBe(2);
    expect(completion?.context.sourceKind).toBe(IMAGE_SOURCE_KINDS.EmbeddedPreview);
  });

  it('rejects after three consecutive precedence mismatches without calling atomic completion', async () => {
    const onMetadata = vi.fn((initialized) => initialized);
    const onComplete = vi.fn();
    let metadataAttempt = 0;
    let imageAttempt = 0;

    const operation = coordinateEditorImageLoad('/fixtures/unstable.RAF', {
      flushPendingSave: async () => undefined,
      loadMetadata: async () => metadataWith(++metadataAttempt % 2 === 0 ? { exposure: metadataAttempt } : null),
      loadImage: async () =>
        imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, ++imageAttempt % 2 === 0 ? null : { exposure: imageAttempt }),
      onMetadata,
      onComplete,
    });

    await expect(operation).rejects.toThrow(/metadata.*image.*three attempts/i);
    expect(metadataAttempt).toBe(3);
    expect(imageAttempt).toBe(3);
    expect(onMetadata).toHaveBeenCalledTimes(3);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('treats an empty adjustments object and literal null as a mismatch', async () => {
    const loadMetadata = vi.fn(async () => metadataWith({}));
    const loadImage = vi.fn(async () => imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, null));

    await expect(
      coordinateEditorImageLoad('/fixtures/null-transition.RAF', {
        flushPendingSave: async () => undefined,
        loadMetadata,
        loadImage,
        onMetadata: (initialized) => initialized,
        onComplete: () => undefined,
      }),
    ).rejects.toThrow(/metadata.*image.*three attempts/i);

    expect(loadMetadata).toHaveBeenCalledTimes(3);
    expect(loadImage).toHaveBeenCalledTimes(3);
  });

  it('completes with the AI-reconciled load_metadata object when load_image returns the raw sidecar', async () => {
    const aiSubMask = (parameters: Record<string, unknown>) => ({
      id: 'sub-1',
      type: 'ai-subject',
      visible: true,
      mode: 'additive',
      invert: false,
      opacity: 100,
      parameters,
    });
    const rawSidecar = {
      exposure: 0.25,
      masks: [{ id: 'mask-1', name: 'Subject', subMasks: [aiSubMask({ startX: 1, maskDataBase64: 'stale' })] }],
      lensBlurDepthMap: 'stale-depth-map',
    } as unknown as PersistedAdjustments;
    const reconciled = {
      exposure: 0.25,
      masks: [{ id: 'mask-1', name: 'Subject', subMasks: [aiSubMask({ startX: 1, aiSource: 'source-id' })] }],
      lensBlurDepthMap: null,
    } as unknown as PersistedAdjustments;
    const loadMetadata = vi.fn(async () => metadataWith(reconciled));
    const loadImage = vi.fn(async () => imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, rawSidecar));

    const result = await coordinateEditorImageLoad('/fixtures/ai-results.RAF', {
      flushPendingSave: async () => undefined,
      loadMetadata,
      loadImage,
      onMetadata: (initialized) => initialized,
      onComplete: () => undefined,
    });

    expect(loadMetadata).toHaveBeenCalledOnce();
    expect(loadImage).toHaveBeenCalledOnce();
    expect(result.context.persistedAdjustments).toEqual(reconciled);
    expect(result.adjustments.lensBlurDepthMap).toBeNull();
    expect(result.adjustments.masks[0].subMasks[0].parameters).toEqual({ startX: 1, aiSource: 'source-id' });
  });

  it('accepts nested adjustments with reordered object keys as the same revision', async () => {
    const metadataAdjustments = {
      curves: {
        luma: [
          { x: 0, y: 0 },
          { x: 255, y: 255 },
        ],
      },
      colorGrading: { global: { hue: 10, saturation: 20, luminance: 30 } },
    } as PersistedAdjustments;
    const imageAdjustments = {
      colorGrading: { global: { luminance: 30, saturation: 20, hue: 10 } },
      curves: {
        luma: [
          { y: 0, x: 0 },
          { y: 255, x: 255 },
        ],
      },
    } as PersistedAdjustments;
    const loadMetadata = vi.fn(async () => metadataWith(metadataAdjustments));
    const loadImage = vi.fn(async () => imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, imageAdjustments));

    const result = await coordinateEditorImageLoad('/fixtures/reordered.RAF', {
      flushPendingSave: async () => undefined,
      loadMetadata,
      loadImage,
      onMetadata: (initialized) => initialized,
      onComplete: () => undefined,
    });

    expect(loadMetadata).toHaveBeenCalledOnce();
    expect(loadImage).toHaveBeenCalledOnce();
    expect(result.adjustments.colorGrading.global).toEqual({ hue: 10, saturation: 20, luminance: 30 });
  });

  it('surfaces persistent metadata command failures when image metadata is non-null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const metadataErrors = [
      new Error('first sidecar read failed'),
      new Error('second sidecar read failed'),
      new Error('third sidecar read failed'),
    ];
    let metadataAttempt = 0;
    const loadMetadata = vi.fn(async (): Promise<LoadMetadataResult> => {
      throw metadataErrors[metadataAttempt++];
    });
    const onComplete = vi.fn();

    await expect(
      coordinateEditorImageLoad('/fixtures/broken-sidecar.RAF', {
        flushPendingSave: async () => undefined,
        loadMetadata,
        loadImage: async () => imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, { exposure: 1 }),
        onMetadata: (initialized) => initialized,
        onComplete,
      }),
    ).rejects.toMatchObject({ cause: metadataErrors[0] });

    expect(loadMetadata).toHaveBeenCalledTimes(3);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('cancels when the session becomes stale during an asynchronous completion callback', async () => {
    let isCurrent = true;

    await expect(
      coordinateEditorImageLoad('/fixtures/stale-completion.RAF', {
        flushPendingSave: async () => undefined,
        isCurrent: () => isCurrent,
        loadMetadata: async () => metadataWith(null),
        loadImage: async () => imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, null),
        onMetadata: (initialized) => initialized,
        onComplete: async () => {
          isCurrent = false;
        },
      }),
    ).rejects.toThrow(/cancelled/i);
  });

  it('reconciles the store-installed generation context and makes readiness atomic', async () => {
    const path = '/fixtures/store-integration.RAF';
    useEditorStore.getState().beginImageSelection(selectedImage({ path }));
    const observed: ReturnType<typeof useEditorStore.getState>[] = [];
    const unsubscribe = useEditorStore.subscribe((state) => observed.push(state));

    await coordinateEditorImageLoad(path, {
      flushPendingSave: async () => undefined,
      loadMetadata: async () => metadataWith(null),
      loadImage: async () => imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, null),
      onMetadata: (initialized) => {
        const store = useEditorStore.getState();
        store.beginAdjustmentLoad(initialized.adjustments, initialized.context);
        const active = useEditorStore.getState();
        return {
          adjustments: active.adjustments,
          context: active.adjustmentLoadContext as AdjustmentLoadContext,
        };
      },
      onComplete: (completed) => {
        const store = useEditorStore.getState();
        store.completeAdjustmentLoad(
          completed.adjustments,
          completed.context,
          {
            ...(store.selectedImage as SelectedImage),
            exif: completed.image.exif,
            height: completed.image.height,
            isRaw: completed.image.is_raw,
            metadata: completed.image.metadata,
            sourceKind: completed.image.source_kind,
            width: completed.image.width,
          },
          { originalSize: { width: completed.image.width, height: completed.image.height } },
        );
      },
    });
    unsubscribe();

    const state = useEditorStore.getState();
    expect(state.selectedImage).toMatchObject({
      path,
      isReady: true,
      sourceKind: IMAGE_SOURCE_KINDS.DevelopedRaw,
    });
    expect(state.adjustmentLoadContext).toMatchObject({
      reconciled: true,
      sourceKind: IMAGE_SOURCE_KINDS.DevelopedRaw,
    });
    expect(state.history).toEqual([state.adjustments]);
    expect(state.originalSize).toEqual({ width: 7000, height: 3000 });
    expect(
      observed.some(
        (entry) =>
          entry.originalSize.width === 7000 &&
          entry.originalSize.height === 3000 &&
          (!entry.selectedImage?.isReady || !entry.adjustmentLoadContext?.reconciled),
      ),
    ).toBe(false);
    expect(observed.some((entry) => entry.selectedImage?.isReady && !entry.adjustmentLoadContext?.reconciled)).toBe(
      false,
    );
  });

  it('waits for authoritative reset before reloading a null sidecar into one clean camera baseline', async () => {
    const path = '/fixtures/reset-camera-defaults.RAF';
    const saved: PersistedAdjustments = {
      exposure: 1.25,
      aspectRatio: 4 / 3,
      crop: { unit: 'px', x: 300, y: 250, width: 6000, height: 2200 },
    };
    useEditorStore.getState().beginImageSelection(selectedImage({ path }));
    await coordinateStoreLoad(path, saved, IMAGE_SOURCE_KINDS.DevelopedRaw);
    const persistence = createEditorPersistence(vi.fn().mockResolvedValue(undefined));
    const reset = deferred<void>();
    const events: string[] = [];

    const resetOperation = persistence.runAuthoritativeReset({
      path,
      rollbackValue: adjustmentsForPersistence(
        useEditorStore.getState().adjustmentLoadContext,
        useEditorStore.getState().adjustments,
      ),
      beginReload: (historyToken) => useEditorStore.getState().beginAdjustmentReload(path, historyToken),
      restoreReload: (snapshot) => useEditorStore.getState().restoreAdjustmentSession(snapshot),
      invokeReset: async () => {
        events.push('reset:start');
        await reset.promise;
        events.push('reset:resolved');
      },
      onSuccess: () => events.push('cache:deleted'),
      beginRecoveryReload: () => useEditorStore.getState().beginAdjustmentReload(path),
    });
    await Promise.resolve();
    const reload = coordinateStoreLoad(
      path,
      null,
      IMAGE_SOURCE_KINDS.DevelopedRaw,
      () => persistence.flushPendingSave(path),
      () => events.push('load_metadata'),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['reset:start']);

    reset.resolve();
    await Promise.all([resetOperation, reload]);

    const state = useEditorStore.getState();
    expect(events).toEqual(['reset:start', 'reset:resolved', 'cache:deleted', 'load_metadata']);
    expect(state.adjustments.crop).toEqual({ unit: 'px', x: 100, y: 200, width: 6500, height: 2400 });
    expect(state.adjustments.aspectRatio).toBe(65 / 24);
    expect(state.adjustmentLoadContext).toMatchObject({ reconciled: true, dirty: false });
    expect(state.history).toEqual([state.adjustments]);
    expect(state.historyIndex).toBe(0);
    expect(adjustmentsForPersistence(state.adjustmentLoadContext, state.adjustments)).toBeUndefined();
  });

  it('reloads null metadata through embedded preview as a full-frame fallback, never the RAF crop', async () => {
    const path = '/fixtures/reset-embedded-fallback.RAF';
    useEditorStore.getState().beginImageSelection(selectedImage({ path }));
    await coordinateStoreLoad(path, { exposure: 1 }, IMAGE_SOURCE_KINDS.DevelopedRaw);
    const persistence = createEditorPersistence(vi.fn().mockResolvedValue(undefined));

    await persistence.runAuthoritativeReset({
      path,
      rollbackValue: undefined,
      beginReload: (historyToken) => useEditorStore.getState().beginAdjustmentReload(path, historyToken),
      restoreReload: (snapshot) => useEditorStore.getState().restoreAdjustmentSession(snapshot),
      invokeReset: async () => undefined,
      onSuccess: () => undefined,
      beginRecoveryReload: () => useEditorStore.getState().beginAdjustmentReload(path),
    });
    await coordinateStoreLoad(
      path,
      null,
      IMAGE_SOURCE_KINDS.EmbeddedPreview,
      () => persistence.flushPendingSave(path),
      () => undefined,
      4000,
      3000,
    );

    const state = useEditorStore.getState();
    expect(state.adjustments.crop).toBeNull();
    expect(state.adjustments.aspectRatio).toBe(ORIGINAL_RATIO);
    expect(resolveAspectRatio(state.adjustments.aspectRatio, state.selectedImage, 0)).toBe(4 / 3);
    expect(state.history).toEqual([state.adjustments]);
    expect(state.adjustmentLoadContext).toMatchObject({
      reconciled: true,
      dirty: false,
      sourceKind: IMAGE_SOURCE_KINDS.EmbeddedPreview,
    });
    expect(adjustmentsForPersistence(state.adjustmentLoadContext, state.adjustments)).toBeUndefined();
  });

  it('keeps provisional cached pixels on screen but reports only the authoritative reconciled provenance', async () => {
    const path = '/fixtures/cached-transition.RAF';
    const provisionalEntry = {
      effectiveAdjustments: { exposure: 0 },
      adjustmentLoadContext: {
        persistedAdjustments: { exposure: 0 },
        reconciled: true,
        sourceKind: IMAGE_SOURCE_KINDS.EmbeddedPreview,
      },
      selectedImage: selectedImage({
        path,
        isReady: true,
        sourceKind: IMAGE_SOURCE_KINDS.EmbeddedPreview,
      }),
      histogram: { luma: { color: 'white', data: [1, 2, 3] } },
      waveform: { width: 1, height: 1, data: [4, 5, 6] },
      finalPreviewUrl: 'blob:provisional-final',
      uncroppedPreviewUrl: 'blob:provisional-uncropped',
      originalSize: { width: 1920, height: 1080 },
    } as unknown as ImageCacheEntry;

    useEditorStore.getState().beginImageSelection(selectedImage({ path }));
    useEditorStore.getState().setEditor(createCachedEditorPlaceholder(provisionalEntry));
    const provisional = useEditorStore.getState();
    expect(provisional.selectedImage).toMatchObject({ isReady: false, sourceKind: null });
    expect(
      createEditorCacheEntry({
        ...provisional,
        isWgpuActive: false,
      }),
    ).toBeNull();

    await coordinateStoreLoad(path, { exposure: 1.5 }, IMAGE_SOURCE_KINDS.DevelopedRaw);

    const state = useEditorStore.getState();
    expect(state.adjustments.exposure).toBe(1.5);
    expect(state.history).toEqual([state.adjustments]);
    expect(state.selectedImage).toMatchObject({ isReady: true, sourceKind: IMAGE_SOURCE_KINDS.DevelopedRaw });
    expect(state.finalPreviewUrl).toBe('blob:provisional-final');
    expect(state.uncroppedAdjustedPreviewUrl).toBe('blob:provisional-uncropped');

    const entry = createEditorCacheEntry({ ...state, isWgpuActive: false });
    expect(entry?.adjustmentLoadContext.sourceKind).toBe(IMAGE_SOURCE_KINDS.DevelopedRaw);
    expect(entry?.selectedImage.sourceKind).toBe(IMAGE_SOURCE_KINDS.DevelopedRaw);
    expect(entry?.effectiveAdjustments.exposure).toBe(1.5);
  });

  it('never caches a session whose reconciled source kind disagrees with the selected image', () => {
    const base = {
      adjustments: {} as Adjustments,
      histogram: null,
      waveform: null,
      finalPreviewUrl: 'blob:final',
      uncroppedAdjustedPreviewUrl: null,
      originalSize: { width: 1, height: 1 },
      isWgpuActive: false,
    };
    const context = {
      reconciled: true,
      sourceKind: IMAGE_SOURCE_KINDS.EmbeddedPreview,
    } as unknown as AdjustmentLoadContext;
    const ready = selectedImage({ isReady: true, sourceKind: IMAGE_SOURCE_KINDS.DevelopedRaw });

    expect(createEditorCacheEntry({ ...base, selectedImage: ready, adjustmentLoadContext: context })).toBeNull();
    expect(
      createEditorCacheEntry({
        ...base,
        selectedImage: { ...ready, sourceKind: IMAGE_SOURCE_KINDS.EmbeddedPreview },
        adjustmentLoadContext: context,
        finalPreviewUrl: null,
      }),
    ).toBeNull();
    expect(
      createEditorCacheEntry({
        ...base,
        selectedImage: { ...ready, sourceKind: IMAGE_SOURCE_KINDS.EmbeddedPreview },
        adjustmentLoadContext: context,
        finalPreviewUrl: null,
        isWgpuActive: true,
      }),
    ).not.toBeNull();
  });
});

describe('cached editor placeholder', () => {
  const entryWithUrls = (finalPreviewUrl: string, uncroppedPreviewUrl: string) =>
    ({
      effectiveAdjustments: { exposure: 4 },
      adjustmentLoadContext: {
        persistedAdjustments: null,
        sourceKind: IMAGE_SOURCE_KINDS.DevelopedRaw,
        reconciled: true,
      },
      selectedImage: selectedImage({
        isReady: true,
        sourceKind: IMAGE_SOURCE_KINDS.DevelopedRaw,
      }),
      histogram: { luma: { color: 'white', data: [1, 2, 3] } },
      waveform: { width: 1, height: 1, data: [1] },
      finalPreviewUrl,
      uncroppedPreviewUrl,
      originalSize: { width: 7000, height: 3000 },
    }) as unknown as ImageCacheEntry;

  it('publishes only cached display data and keeps adjustments and provenance internal', () => {
    const entry = entryWithUrls('blob:cached-preview', 'blob:cached-uncropped');

    const placeholder = createCachedEditorPlaceholder(entry);

    expect(placeholder).toEqual({
      histogram: entry.histogram,
      waveform: entry.waveform,
      finalPreviewUrl: 'blob:cached-preview',
      uncroppedAdjustedPreviewUrl: 'blob:cached-uncropped',
      originalSize: { width: 7000, height: 3000 },
    });
    expect(placeholder).not.toHaveProperty('effectiveAdjustments');
    expect(placeholder).not.toHaveProperty('adjustmentLoadContext');
    expect(placeholder).not.toHaveProperty('selectedImage');
    expect(placeholder).not.toHaveProperty('sourceKind');
    expect(placeholder).not.toHaveProperty('isReady');
  });

  it('keeps read-only cache hits protected and supports synchronous metadata get/set updates', () => {
    const cache = new ImageLRUCache(2);
    const entry = entryWithUrls('blob:read-final', 'blob:read-uncropped');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    cache.set('/fixtures/read.RAF', entry);

    const read = cache.get('/fixtures/read.RAF');

    expect(read).toBe(entry);
    expect(cache.isProtected('blob:read-final')).toBe(true);
    expect(cache.isProtected('blob:read-uncropped')).toBe(true);
    cache.set('/fixtures/read.RAF', {
      ...(read as ImageCacheEntry),
      selectedImage: {
        ...(read as ImageCacheEntry).selectedImage,
        exif: { Camera: 'updated' },
      },
    });
    expect(cache.get('/fixtures/read.RAF')?.selectedImage.exif).toEqual({ Camera: 'updated' });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('transfers both URL owners on take so an abandoned provisional hit cannot be reentered', () => {
    vi.useFakeTimers();
    const cache = new ImageLRUCache(2);
    const entry = entryWithUrls('blob:taken-final', 'blob:taken-uncropped');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    cache.set('/fixtures/taken.RAF', entry);

    const acquired = cache.take('/fixtures/taken.RAF');

    expect(acquired).toBe(entry);
    expect(cache.isProtected('blob:taken-final')).toBe(false);
    expect(cache.isProtected('blob:taken-uncropped')).toBe(false);
    expect(cache.take('/fixtures/taken.RAF')).toBeUndefined();
    cache.revokeWhenUnprotected(acquired?.finalPreviewUrl ?? null);
    cache.revokeWhenUnprotected(acquired?.uncroppedPreviewUrl ?? null);

    vi.advanceTimersByTime(250);
    expect(revoke.mock.calls).toEqual([['blob:taken-final'], ['blob:taken-uncropped']]);
  });

  it('does not revoke a taken URL after a completed image returns cache ownership before the timer', () => {
    vi.useFakeTimers();
    const cache = new ImageLRUCache(2);
    const entry = entryWithUrls('blob:active-final', 'blob:active-uncropped');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    cache.set('/fixtures/active.RAF', entry);
    const acquired = cache.take('/fixtures/active.RAF') as ImageCacheEntry;
    cache.revokeWhenUnprotected(acquired.finalPreviewUrl);
    cache.revokeWhenUnprotected(acquired.uncroppedPreviewUrl);

    cache.set('/fixtures/active.RAF', acquired);
    vi.advanceTimersByTime(250);

    expect(cache.isProtected('blob:active-final')).toBe(true);
    expect(cache.isProtected('blob:active-uncropped')).toBe(true);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('takes the requested LRU entry before storing the outgoing image at full capacity', () => {
    const cache = new ImageLRUCache(2);
    const target = entryWithUrls('blob:target-final', 'blob:target-uncropped');
    const other = entryWithUrls('blob:other-final', 'blob:other-uncropped');
    const outgoing = entryWithUrls('blob:outgoing-final', 'blob:outgoing-uncropped');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    cache.set('/fixtures/target.RAF', target);
    cache.set('/fixtures/other.RAF', other);
    const acquired = cache.takeForNavigation('/fixtures/target.RAF', {
      key: '/fixtures/outgoing.RAF',
      entry: outgoing,
    });

    expect(acquired).toBe(target);
    expect(cache.get('/fixtures/outgoing.RAF')).toBe(outgoing);
    expect(revoke).not.toHaveBeenCalledWith('blob:target-final');
    expect(revoke).not.toHaveBeenCalledWith('blob:target-uncropped');
  });
});

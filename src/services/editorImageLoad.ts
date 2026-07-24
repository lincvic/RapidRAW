import type { AdjustmentLoadContext, LoadImageResult, LoadMetadataResult } from '../types/imageLoading';
import type { Adjustments } from '../utils/adjustments';
import { initializeAdjustmentLoad, reconcileAdjustmentLoad, structurallyEqual } from '../utils/rafCameraDefaults';

const MAX_LOAD_ATTEMPTS = 3;

export interface InitializedEditorAdjustmentLoad {
  adjustments: Adjustments;
  context: AdjustmentLoadContext;
}

export interface CompletedEditorImageLoad extends InitializedEditorAdjustmentLoad {
  metadata: LoadMetadataResult;
  image: LoadImageResult;
  history: Adjustments[];
  historyIndex: 0;
}

type MaybePromise<T> = Promise<T> | T;

export interface EditorImageLoadDependencies {
  flushPendingSave(path: string): Promise<void>;
  isCurrent?(): boolean;
  loadMetadata(path: string): Promise<LoadMetadataResult>;
  loadImage(path: string): Promise<LoadImageResult>;
  onMetadata(
    initialized: InitializedEditorAdjustmentLoad,
    metadata: LoadMetadataResult,
  ): MaybePromise<InitializedEditorAdjustmentLoad>;
  onComplete(completed: CompletedEditorImageLoad): MaybePromise<void>;
}

export class EditorImageLoadCancelledError extends Error {
  constructor() {
    super('Editor image load was cancelled');
    this.name = 'EditorImageLoadCancelledError';
  }
}

const emptyMetadataResult = (): LoadMetadataResult => ({
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

const consistencyError = (cause: unknown): Error => {
  const message = 'load_metadata adjustments did not match load_image metadata after three attempts';
  return cause === undefined ? new Error(message) : new Error(message, { cause });
};

export async function coordinateEditorImageLoad(
  path: string,
  dependencies: EditorImageLoadDependencies,
): Promise<CompletedEditorImageLoad> {
  const assertCurrent = () => {
    if (dependencies.isCurrent?.() === false) {
      throw new EditorImageLoadCancelledError();
    }
  };

  assertCurrent();
  await dependencies.flushPendingSave(path);
  assertCurrent();

  let firstMetadataError: unknown;
  let hasMetadataError = false;
  let hasMetadataSuccess = false;

  for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt += 1) {
    assertCurrent();

    let metadata: LoadMetadataResult;
    try {
      metadata = await dependencies.loadMetadata(path);
      hasMetadataSuccess = true;
    } catch (error) {
      if (!hasMetadataError) firstMetadataError = error;
      hasMetadataError = true;
      console.warn('Failed to load image metadata; using empty camera defaults for this attempt:', error);
      metadata = emptyMetadataResult();
    }

    assertCurrent();
    const initialized = initializeAdjustmentLoad(metadata);
    const activeLoad = await dependencies.onMetadata(initialized, metadata);
    assertCurrent();

    const image = await dependencies.loadImage(path);
    assertCurrent();

    if (!structurallyEqual(metadata.adjustments, image.metadata.adjustments)) {
      continue;
    }

    const reconciled = reconcileAdjustmentLoad(activeLoad.adjustments, activeLoad.context, image);
    const completed: CompletedEditorImageLoad = {
      ...reconciled,
      metadata,
      image,
      history: [reconciled.adjustments],
      historyIndex: 0,
    };

    assertCurrent();
    await dependencies.onComplete(completed);
    assertCurrent();
    return completed;
  }

  throw consistencyError(hasMetadataError && !hasMetadataSuccess ? firstMetadataError : undefined);
}

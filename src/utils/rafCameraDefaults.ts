import type {
  AdjustmentLoadContext,
  CameraDefaults,
  CameraPixelCrop,
  LoadImageResult,
  LoadMetadataResult,
  PersistedAdjustments,
} from '../types/imageLoading';
import { IMAGE_SOURCE_KINDS } from '../types/imageLoading';
import { normalizeLoadedAdjustments, type Adjustments } from './adjustments';

const deepClone = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepClone(item)])) as T;
  }

  return value;
};

interface ValidCameraFraming {
  crop: CameraPixelCrop;
  aspectRatio: number;
}

const validCameraFraming = (cameraDefaults: unknown): ValidCameraFraming | null => {
  if (cameraDefaults === null || typeof cameraDefaults !== 'object') {
    return null;
  }

  const { crop, aspectRatio } = cameraDefaults as Partial<CameraDefaults>;

  if (
    crop === null ||
    typeof crop !== 'object' ||
    !Number.isFinite(crop.x) ||
    crop.x < 0 ||
    !Number.isFinite(crop.y) ||
    crop.y < 0 ||
    !Number.isFinite(crop.width) ||
    crop.width <= 0 ||
    !Number.isFinite(crop.height) ||
    crop.height <= 0 ||
    typeof aspectRatio !== 'number' ||
    !Number.isFinite(aspectRatio) ||
    aspectRatio <= 0
  ) {
    return null;
  }

  return { crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, aspectRatio };
};

export function initializeAdjustmentLoad(metadata: LoadMetadataResult): {
  adjustments: Adjustments;
  context: AdjustmentLoadContext;
} {
  const persistedAdjustments: PersistedAdjustments = deepClone(metadata.adjustments);
  const noCameraBaseline = normalizeLoadedAdjustments(metadata.adjustments);
  const adjustments = deepClone(noCameraBaseline);
  const cameraFraming = metadata.adjustments === null ? validCameraFraming(metadata.cameraDefaults) : null;

  if (cameraFraming !== null) {
    const { crop, aspectRatio } = cameraFraming;
    adjustments.crop = { unit: 'px', x: crop.x, y: crop.y, width: crop.width, height: crop.height };
    adjustments.aspectRatio = aspectRatio;
  }

  return {
    adjustments,
    context: {
      persistedAdjustments,
      noCameraBaseline: deepClone(noCameraBaseline),
      effectiveBaseline: deepClone(adjustments),
      injectedCrop: cameraFraming !== null,
      injectedAspectRatio: cameraFraming !== null,
      sourceKind: null,
      reconciled: false,
      dirty: false,
    },
  };
}

const hasValidImageDimensions = (image: Pick<LoadImageResult, 'width' | 'height'>): boolean =>
  Number.isFinite(image.width) && image.width > 0 && Number.isFinite(image.height) && image.height > 0;

export function reconcileAdjustmentLoad(
  provisional: Adjustments,
  context: AdjustmentLoadContext,
  image: Pick<LoadImageResult, 'width' | 'height' | 'source_kind'>,
): { adjustments: Adjustments; context: AdjustmentLoadContext } {
  const noCameraBaseline = deepClone(context.noCameraBaseline);
  const isLiteralNullLoad = context.persistedAdjustments === null;

  if (isLiteralNullLoad && hasValidImageDimensions(image)) {
    noCameraBaseline.aspectRatio = image.width / image.height;
  }

  const adjustments = deepClone(provisional);
  const hasCompleteInjection = context.injectedCrop && context.injectedAspectRatio;
  const keepCameraFraming = image.source_kind === IMAGE_SOURCE_KINDS.DevelopedRaw && hasCompleteInjection;

  if (isLiteralNullLoad && !keepCameraFraming) {
    adjustments.crop = deepClone(noCameraBaseline.crop);
    adjustments.aspectRatio = noCameraBaseline.aspectRatio;
  }

  return {
    adjustments,
    context: {
      ...deepClone(context),
      persistedAdjustments: deepClone(context.persistedAdjustments),
      noCameraBaseline,
      effectiveBaseline: deepClone(adjustments),
      sourceKind: image.source_kind,
      reconciled: true,
      dirty: false,
    },
  };
}

export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray || rightIsArray) {
    if (!leftIsArray || !rightIsArray || left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      const leftHasIndex = Object.prototype.hasOwnProperty.call(left, index);
      const rightHasIndex = Object.prototype.hasOwnProperty.call(right, index);

      if (leftHasIndex !== rightHasIndex || (leftHasIndex && !structurallyEqual(left[index], right[index]))) {
        return false;
      }
    }

    return true;
  }

  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key, index) => key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key]),
  );
}

export function markAdjustmentLoadDirty(context: AdjustmentLoadContext): AdjustmentLoadContext {
  return {
    ...deepClone(context),
    dirty: true,
  };
}

export function adjustmentsForPersistence(
  context: AdjustmentLoadContext | null,
  current: Adjustments,
): PersistedAdjustments | undefined {
  if (context === null || !context.reconciled || !context.dirty) {
    return undefined;
  }

  if (structurallyEqual(current, context.effectiveBaseline)) {
    return deepClone(context.persistedAdjustments);
  }

  return deepClone(current);
}

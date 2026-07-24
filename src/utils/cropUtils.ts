import type { Crop, PercentCrop } from 'react-image-crop';
import { INITIAL_ADJUSTMENTS, type Adjustments } from './adjustments';

export interface CropSynchronizationParams {
  imagePath: string;
  rotation: number;
  aspectRatio: number | null;
  orientationSteps: number;
}

interface CropSynchronizationSeed {
  params: CropSynchronizationParams;
  overlay: PercentCrop | null;
}

export function resetCropAdjustments(adjustments: Adjustments, imageWidth: number, imageHeight: number): Adjustments {
  return {
    ...adjustments,
    aspectRatio: imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : null,
    crop: null,
    flipHorizontal: INITIAL_ADJUSTMENTS.flipHorizontal,
    flipVertical: INITIAL_ADJUSTMENTS.flipVertical,
    orientationSteps: INITIAL_ADJUSTMENTS.orientationSteps,
    rotation: INITIAL_ADJUSTMENTS.rotation,
    transformDistortion: INITIAL_ADJUSTMENTS.transformDistortion,
    transformVertical: INITIAL_ADJUSTMENTS.transformVertical,
    transformHorizontal: INITIAL_ADJUSTMENTS.transformHorizontal,
    transformRotate: INITIAL_ADJUSTMENTS.transformRotate,
    transformAspect: INITIAL_ADJUSTMENTS.transformAspect,
    transformScale: INITIAL_ADJUSTMENTS.transformScale,
    transformXOffset: INITIAL_ADJUSTMENTS.transformXOffset,
    transformYOffset: INITIAL_ADJUSTMENTS.transformYOffset,
    lensMaker: INITIAL_ADJUSTMENTS.lensMaker,
    lensModel: INITIAL_ADJUSTMENTS.lensModel,
    lensDistortionAmount: INITIAL_ADJUSTMENTS.lensDistortionAmount,
    lensVignetteAmount: INITIAL_ADJUSTMENTS.lensVignetteAmount,
    lensTcaAmount: INITIAL_ADJUSTMENTS.lensTcaAmount,
    lensDistortionEnabled: INITIAL_ADJUSTMENTS.lensDistortionEnabled,
    lensTcaEnabled: INITIAL_ADJUSTMENTS.lensTcaEnabled,
    lensVignetteEnabled: INITIAL_ADJUSTMENTS.lensVignetteEnabled,
    lensDistortionParams: INITIAL_ADJUSTMENTS.lensDistortionParams,
  };
}

export function localCropOverlay(crop: Crop | null, canvasWidth: number, canvasHeight: number): PercentCrop | null {
  if (!Number.isFinite(canvasWidth) || canvasWidth <= 0 || !Number.isFinite(canvasHeight) || canvasHeight <= 0) {
    return null;
  }

  if (crop === null) {
    return { unit: '%', x: 0, y: 0, width: 100, height: 100 };
  }

  return {
    unit: '%',
    x: (crop.x / canvasWidth) * 100,
    y: (crop.y / canvasHeight) * 100,
    width: (crop.width / canvasWidth) * 100,
    height: (crop.height / canvasHeight) * 100,
  };
}

export function getCropSynchronizationSeed(
  previous: CropSynchronizationParams | null,
  current: CropSynchronizationParams,
  crop: Crop | null,
  canvasWidth: number,
  canvasHeight: number,
): CropSynchronizationSeed | null {
  if (crop !== null && previous?.imagePath === current.imagePath) {
    return null;
  }

  return {
    params: current,
    overlay: localCropOverlay(crop, canvasWidth, canvasHeight),
  };
}

export function getOrientedDimensions(
  imageWidth: number,
  imageHeight: number,
  orientationSteps: number,
): { width: number; height: number } {
  const isSwapped = orientationSteps === 1 || orientationSteps === 3;
  return {
    width: isSwapped ? imageHeight : imageWidth,
    height: isSwapped ? imageWidth : imageHeight,
  };
}

export function calculateCenteredCrop(
  imageWidth: number,
  imageHeight: number,
  orientationSteps: number,
  aspectRatio: number | null,
  rotation: number = 0,
): Crop | null {
  if (!aspectRatio || aspectRatio <= 0) return null;

  const { width: W, height: H } = getOrientedDimensions(imageWidth, imageHeight, orientationSteps);

  const angle = Math.abs(rotation);
  const rad = ((angle % 180) * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);

  const h_c = Math.min(H / (aspectRatio * sin + cos), W / (aspectRatio * cos + sin));
  const w_c = aspectRatio * h_c;

  return {
    unit: 'px',
    x: Math.round((W - w_c) / 2),
    y: Math.round((H - h_c) / 2),
    width: Math.round(w_c),
    height: Math.round(h_c),
  };
}

function isCropWithinBounds(crop: Crop, imageW: number, imageH: number, rotation: number): boolean {
  const cx = imageW / 2;
  const cy = imageH / 2;
  const rad = (-rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const pts = [
    { x: crop.x, y: crop.y },
    { x: crop.x + crop.width, y: crop.y },
    { x: crop.x, y: crop.y + crop.height },
    { x: crop.x + crop.width, y: crop.y + crop.height },
  ];
  for (let i = 0; i < 4; i++) {
    const nx = cos * (pts[i].x - cx) - sin * (pts[i].y - cy) + cx;
    const ny = sin * (pts[i].x - cx) + cos * (pts[i].y - cy) + cy;
    if (nx < -1 || nx > imageW + 1 || ny < -1 || ny > imageH + 1) return false;
  }
  return true;
}

export function calculateAreaPreservingCrop(
  imageWidth: number,
  imageHeight: number,
  orientationSteps: number,
  aspectRatio: number | null,
  rotation: number,
  currentCrop: Crop | null | undefined,
): Crop | null {
  if (!aspectRatio || aspectRatio <= 0 || !currentCrop || !currentCrop.width || !currentCrop.height) return null;

  const { width: W, height: H } = getOrientedDimensions(imageWidth, imageHeight, orientationSteps);

  const area = currentCrop.width * currentCrop.height;
  const newH = Math.sqrt(area / aspectRatio);
  const newW = aspectRatio * newH;
  const centerX = currentCrop.x + currentCrop.width / 2;
  const centerY = currentCrop.y + currentCrop.height / 2;

  const candidate: Crop = {
    unit: 'px',
    x: Math.round(centerX - newW / 2),
    y: Math.round(centerY - newH / 2),
    width: Math.round(newW),
    height: Math.round(newH),
  };

  return isCropWithinBounds(candidate, W, H, rotation) ? candidate : null;
}

export function rotateCropCenter(
  crop: Crop,
  orientedWidth: number,
  orientedHeight: number,
  deltaDegrees: number,
): Crop {
  const rad = (deltaDegrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = orientedWidth / 2;
  const cy = orientedHeight / 2;
  const px = crop.x + crop.width / 2 - cx;
  const py = crop.y + crop.height / 2 - cy;
  const rx = px * cos - py * sin;
  const ry = px * sin + py * cos;
  return {
    unit: 'px',
    x: Math.round(cx + rx - crop.width / 2),
    y: Math.round(cy + ry - crop.height / 2),
    width: crop.width,
    height: crop.height,
  };
}

import { describe, expect, it } from 'vitest';
import { INITIAL_ADJUSTMENTS, type Adjustments } from './adjustments';
import { IMAGE_SOURCE_KINDS, type PersistedAdjustments } from '../types/imageLoading';
import {
  getCropSynchronizationSeed,
  localCropOverlay,
  normalizeCropChange,
  ORIGINAL_RATIO,
  resetCropAdjustments,
  resolveAspectRatio,
  type CropSynchronizationParams,
} from './cropUtils';
import {
  adjustmentsForPersistence,
  initializeAdjustmentLoad,
  markAdjustmentLoadDirty,
  reconcileAdjustmentLoad,
} from './rafCameraDefaults';

const RESET_FIELDS = [
  'crop',
  'flipHorizontal',
  'flipVertical',
  'orientationSteps',
  'rotation',
  'transformDistortion',
  'transformVertical',
  'transformHorizontal',
  'transformRotate',
  'transformAspect',
  'transformScale',
  'transformXOffset',
  'transformYOffset',
  'lensMaker',
  'lensModel',
  'lensDistortionAmount',
  'lensVignetteAmount',
  'lensTcaAmount',
  'lensDistortionEnabled',
  'lensTcaEnabled',
  'lensVignetteEnabled',
  'lensCorrectionMode',
  'guidedPerspective',
] as const satisfies ReadonlyArray<keyof Adjustments>;

const editedAdjustments = (): Adjustments => {
  const edited = structuredClone(INITIAL_ADJUSTMENTS);

  Object.assign(edited, {
    aspectRatio: 65 / 24,
    crop: { unit: 'px', x: 432, y: 987, width: 6500, height: 2400 },
    flipHorizontal: true,
    flipVertical: true,
    orientationSteps: 3,
    rotation: 1.75,
    transformDistortion: 12,
    transformVertical: 13,
    transformHorizontal: 14,
    transformRotate: 15,
    transformAspect: 16,
    transformScale: 117,
    transformXOffset: 18,
    transformYOffset: 19,
    lensMaker: 'FUJIFILM',
    lensModel: 'FUJINON GF35mmF4 R WR',
    lensDistortionAmount: 21,
    lensVignetteAmount: 22,
    lensTcaAmount: 23,
    lensDistortionEnabled: false,
    lensTcaEnabled: false,
    lensVignetteEnabled: false,
    lensDistortionParams: {
      k1: 1,
      k2: 2,
      k3: 3,
      model: 4,
      tca_vr: 5,
      tca_vb: 6,
      vig_k1: 7,
      vig_k2: 8,
      vig_k3: 9,
    },
    lensCorrectionMode: 'auto',
    guidedPerspective: {
      enabled: true,
      lines: [{ id: 'line-1', type: 'vertical', p1: { x: 0.1, y: 0.1 }, p2: { x: 0.1, y: 0.9 } }],
      autoCrop: false,
    },
    exposure: 1.25,
    temperature: 875,
  });
  edited.curves.luma = [
    { x: 0, y: 12 },
    { x: 255, y: 243 },
  ];
  edited.hsl.reds = { hue: 7, saturation: 8, luminance: 9 };

  return edited;
};

describe('crop reset adjustments', () => {
  it.each([
    { label: 'landscape', width: 11648, height: 8736 },
    { label: 'post-EXIF portrait', width: 8736, height: 11648 },
  ])('resets crop geometry for a $label canvas without changing other edits', ({ width, height }) => {
    const edited = editedAdjustments();
    const inputSnapshot = structuredClone(edited);

    const reset = resetCropAdjustments(edited);

    expect(reset).not.toBe(edited);
    expect(edited).toEqual(inputSnapshot);
    expect(reset.crop).toBeNull();
    expect(reset.aspectRatio).toBe(ORIGINAL_RATIO);
    expect(reset.aspectRatio).not.toBeNull();
    expect(resolveAspectRatio(reset.aspectRatio, { width, height }, reset.orientationSteps)).toBeCloseTo(
      width / height,
    );
    expect(reset.orientationSteps).toBe(0);
    for (const field of RESET_FIELDS) {
      expect(reset[field], field).toEqual(INITIAL_ADJUSTMENTS[field]);
    }
    expect(reset.exposure).toBe(edited.exposure);
    expect(reset.temperature).toBe(edited.temperature);
    expect(reset.curves).toEqual(edited.curves);
    expect(reset.hsl).toEqual(edited.hsl);
    expect(reset.lensDistortionParams).toEqual(edited.lensDistortionParams);
  });
});

describe('local crop overlays', () => {
  it.each([
    { label: 'landscape', width: 11648, height: 8736 },
    { label: 'post-EXIF portrait', width: 8736, height: 11648 },
  ])('represents a null adjustment as only a full local $label overlay', ({ width, height }) => {
    expect(localCropOverlay(null, width, height)).toEqual({
      unit: '%',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it('converts a camera pixel crop against the supplied oriented canvas', () => {
    const cameraCrop = { unit: 'px' as const, x: 1164.8, y: 873.6, width: 5824, height: 4368 };
    const cameraSnapshot = { ...cameraCrop };

    const overlay = localCropOverlay(cameraCrop, 11648, 8736);

    expect(overlay).toEqual({ unit: '%', x: 10, y: 10, width: 50, height: 50 });
    expect(cameraCrop).toEqual(cameraSnapshot);
    expect(overlay).not.toHaveProperty('crop');
  });

  it.each([
    { label: 'zero width', width: 0, height: 8736 },
    { label: 'zero height', width: 11648, height: 0 },
    { label: 'negative width', width: -1, height: 8736 },
    { label: 'negative height', width: 11648, height: -1 },
    { label: 'NaN width', width: Number.NaN, height: 8736 },
    { label: 'NaN height', width: 11648, height: Number.NaN },
    { label: 'infinite width', width: Number.POSITIVE_INFINITY, height: 8736 },
    { label: 'infinite height', width: 11648, height: Number.POSITIVE_INFINITY },
  ])('returns no overlay for a canvas with $label', ({ width, height }) => {
    const cameraCrop = { unit: 'px' as const, x: 100, y: 200, width: 6500, height: 2400 };

    expect(localCropOverlay(cameraCrop, width, height)).toBeNull();
  });
});

describe('initial crop synchronization', () => {
  const params = (session: number): CropSynchronizationParams => ({
    session,
    rotation: 0,
    aspectRatio: 65 / 24,
    orientationSteps: 0,
  });

  it('seeds a reduced same-ratio camera crop unchanged instead of treating first open as an orientation change', () => {
    const cameraCrop = { unit: 'px' as const, x: 574, y: 3168, width: 10500, height: 3877 };
    const cameraSnapshot = { ...cameraCrop };

    const seed = getCropSynchronizationSeed(null, params(1), cameraCrop, 11648, 8736);

    expect(seed).toEqual({
      params: params(1),
      overlay: {
        unit: '%',
        x: (574 / 11648) * 100,
        y: (3168 / 8736) * 100,
        width: (10500 / 11648) * 100,
        height: (3877 / 8736) * 100,
      },
    });
    expect(cameraCrop).toEqual(cameraSnapshot);
  });

  it('seeds a newly loaded or reloaded session even when its geometry matches the previous one', () => {
    const cameraCrop = { unit: 'px' as const, x: 100, y: 200, width: 6500, height: 2400 };

    expect(getCropSynchronizationSeed(params(1), params(2), cameraCrop, 11648, 8736)).toEqual({
      params: params(2),
      overlay: localCropOverlay(cameraCrop, 11648, 8736),
    });
  });

  it('leaves later same-session geometry changes to the regular crop synchronization', () => {
    expect(
      getCropSynchronizationSeed(
        params(3),
        { ...params(3), orientationSteps: 1 },
        { unit: 'px', x: 100, y: 200, width: 6500, height: 2400 },
        11648,
        8736,
      ),
    ).toBeNull();
  });

  it('never seeds a null crop, which the regular synchronization fits without materializing it', () => {
    expect(getCropSynchronizationSeed(null, params(4), null, 11648, 8736)).toBeNull();
    expect(getCropSynchronizationSeed(params(3), params(4), null, 11648, 8736)).toBeNull();
  });
});

describe('Reset Crop on camera-default RAF framing', () => {
  it('persists an explicit null crop that wins over the camera crop on reopen', () => {
    const metadata = {
      version: 1,
      rating: 0,
      adjustments: null,
      tags: null,
      cameraDefaults: {
        crop: { x: 0, y: 2216, width: 11648, height: 4304 },
        aspectRatio: 11648 / 4304,
        canvasWidth: 11648,
        canvasHeight: 8736,
      },
    };
    const initialized = initializeAdjustmentLoad(metadata);
    const opened = reconcileAdjustmentLoad(initialized.adjustments, initialized.context, {
      source_kind: IMAGE_SOURCE_KINDS.DevelopedRaw,
      width: 11648,
      height: 8736,
    });
    expect(localCropOverlay(opened.adjustments.crop, 11648, 8736)).not.toEqual(localCropOverlay(null, 11648, 8736));

    const reset = resetCropAdjustments(opened.adjustments);
    const persisted = adjustmentsForPersistence(markAdjustmentLoadDirty(opened.context), reset);

    expect(persisted).toEqual(reset);
    expect(persisted).toMatchObject({ crop: null, aspectRatio: ORIGINAL_RATIO });
    expect(normalizeCropChange(null, { unit: 'px', x: 0, y: 0, width: 11648, height: 8736 }, 11648, 8736)).toBeNull();

    const reopened = initializeAdjustmentLoad({ ...metadata, adjustments: persisted as PersistedAdjustments });
    expect(reopened.context.injectedCrop).toBe(false);
    expect(reopened.adjustments.crop).toBeNull();
    expect(reopened.adjustments.aspectRatio).toBe(ORIGINAL_RATIO);
  });
});

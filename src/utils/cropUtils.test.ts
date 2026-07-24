import { describe, expect, it } from 'vitest';
import { INITIAL_ADJUSTMENTS, type Adjustments } from './adjustments';
import {
  getCropSynchronizationSeed,
  localCropOverlay,
  resetCropAdjustments,
  type CropSynchronizationParams,
} from './cropUtils';

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
  'lensDistortionParams',
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

    const reset = resetCropAdjustments(edited, width, height);

    expect(reset).not.toBe(edited);
    expect(edited).toEqual(inputSnapshot);
    expect(reset.crop).toBeNull();
    expect(reset.aspectRatio).toBeCloseTo(width / height);
    expect(reset.orientationSteps).toBe(0);
    for (const field of RESET_FIELDS) {
      expect(reset[field], field).toEqual(INITIAL_ADJUSTMENTS[field]);
    }
    expect(reset.exposure).toBe(edited.exposure);
    expect(reset.temperature).toBe(edited.temperature);
    expect(reset.curves).toEqual(edited.curves);
    expect(reset.hsl).toEqual(edited.hsl);
    expect(reset.lensCorrectionMode).toBe('auto');
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
  const params = (imagePath: string): CropSynchronizationParams => ({
    imagePath,
    rotation: 0,
    aspectRatio: 65 / 24,
    orientationSteps: 0,
  });

  it('seeds a reduced same-ratio camera crop unchanged instead of treating first open as an orientation change', () => {
    const cameraCrop = { unit: 'px' as const, x: 574, y: 3168, width: 10500, height: 3877 };
    const cameraSnapshot = { ...cameraCrop };

    const seed = getCropSynchronizationSeed(null, params('/photos/reduced.RAF'), cameraCrop, 11648, 8736);

    expect(seed).toEqual({
      params: params('/photos/reduced.RAF'),
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

  it('seeds a new image even when its geometry matches the previous image', () => {
    const cameraCrop = { unit: 'px' as const, x: 100, y: 200, width: 6500, height: 2400 };

    expect(
      getCropSynchronizationSeed(params('/photos/first.RAF'), params('/photos/second.RAF'), cameraCrop, 11648, 8736),
    ).toEqual({
      params: params('/photos/second.RAF'),
      overlay: localCropOverlay(cameraCrop, 11648, 8736),
    });
  });

  it('leaves later same-image non-null geometry changes to the regular crop synchronization', () => {
    const current = params('/photos/current.RAF');

    expect(
      getCropSynchronizationSeed(
        current,
        current,
        { unit: 'px', x: 100, y: 200, width: 6500, height: 2400 },
        11648,
        8736,
      ),
    ).toBeNull();
  });

  it('seeds a full local overlay whenever the adjustment crop is reset to null', () => {
    const current = params('/photos/current.RAF');

    expect(getCropSynchronizationSeed(current, current, null, 11648, 8736)).toEqual({
      params: current,
      overlay: { unit: '%', x: 0, y: 0, width: 100, height: 100 },
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  IMAGE_SOURCE_KINDS,
  type LoadImageResult,
  type LoadMetadataResult,
  type PersistedAdjustments,
} from '../types/imageLoading';
import { INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments, type Adjustments } from './adjustments';
import {
  adjustmentsForPersistence,
  initializeAdjustmentLoad,
  markAdjustmentLoadDirty,
  reconcileAdjustmentLoad,
  structurallyEqual,
} from './rafCameraDefaults';

const metadataWith = (
  adjustments: PersistedAdjustments,
  cameraDefaults: LoadMetadataResult['cameraDefaults'] = {
    crop: { x: 100, y: 200, width: 6500, height: 2400 },
    aspectRatio: 65 / 24,
    canvasWidth: 7000,
    canvasHeight: 3000,
  },
): LoadMetadataResult => ({
  version: 1,
  rating: 0,
  adjustments,
  tags: ['fixture'],
  exif: { Camera: 'GFX100RF' },
  cameraDefaults,
});

describe('RAF camera-default initialization', () => {
  it.each([
    [{}, 'empty object'],
    [{ crop: null }, 'explicit null crop'],
    [{ crop: { unit: 'px', x: 10, y: 20, width: 30, height: 40 } }, 'saved crop'],
  ] as const)('does not inject camera defaults into an adjustments object: %s (%s)', (persisted, _label) => {
    const result = initializeAdjustmentLoad(metadataWith(persisted as PersistedAdjustments));

    expect(result.context.injectedCrop).toBe(false);
    expect(result.context.injectedAspectRatio).toBe(false);
    expect(result.adjustments.crop).toEqual(normalizeLoadedAdjustments(persisted).crop);
    expect(result.adjustments.aspectRatio).toBe(normalizeLoadedAdjustments(persisted).aspectRatio);
    expect(result.context.sourceKind).toBeNull();
    expect(result.context.reconciled).toBe(false);
    expect(result.context.dirty).toBe(false);
  });

  it('injects a cloned pixel crop and aspect ratio only for literal null', () => {
    const metadata = metadataWith(null);
    const cameraCrop = metadata.cameraDefaults.crop;
    const result = initializeAdjustmentLoad(metadata);

    expect(result.adjustments.crop).toEqual({ unit: 'px', x: 100, y: 200, width: 6500, height: 2400 });
    expect(result.adjustments.crop).not.toBe(cameraCrop);
    expect(result.adjustments.aspectRatio).toBeCloseTo(65 / 24);
    expect(result.adjustments.exposure).toBe(0);
    expect(result.context.injectedCrop).toBe(true);
    expect(result.context.injectedAspectRatio).toBe(true);
    expect(result.context.persistedAdjustments).toBeNull();
  });

  it.each([
    ['missing fields', {}],
    ['null object', null],
    ['missing crop', { crop: null, aspectRatio: 65 / 24, canvasWidth: 7000, canvasHeight: 3000 }],
    [
      'missing ratio',
      {
        crop: { x: 100, y: 200, width: 6500, height: 2400 },
        aspectRatio: null,
        canvasWidth: 7000,
        canvasHeight: 3000,
      },
    ],
    [
      'zero-width crop',
      {
        crop: { x: 100, y: 200, width: 0, height: 2400 },
        aspectRatio: 65 / 24,
        canvasWidth: 7000,
        canvasHeight: 3000,
      },
    ],
    [
      'non-finite ratio',
      {
        crop: { x: 100, y: 200, width: 6500, height: 2400 },
        aspectRatio: Number.NaN,
        canvasWidth: 7000,
        canvasHeight: 3000,
      },
    ],
    [
      'malformed crop',
      {
        crop: { x: 100, y: 200, width: 6500 },
        aspectRatio: 65 / 24,
        canvasWidth: 7000,
        canvasHeight: 3000,
      },
    ],
  ])('keeps camera crop and aspect injection atomic for %s defaults', (_label, cameraDefaults) => {
    const result = initializeAdjustmentLoad(metadataWith(null, cameraDefaults as LoadMetadataResult['cameraDefaults']));

    expect(result.adjustments.crop).toBeNull();
    expect(result.adjustments.aspectRatio).toBeNull();
    expect(result.context.injectedCrop).toBe(false);
    expect(result.context.injectedAspectRatio).toBe(false);
  });

  it('deep-clones the initial baseline, context values, and camera defaults without changing exposure', () => {
    const metadata = metadataWith(null);
    const initialSnapshot = structuredClone(INITIAL_ADJUSTMENTS);
    const cameraSnapshot = structuredClone(metadata.cameraDefaults);
    const result = initializeAdjustmentLoad(metadata);

    expect(INITIAL_ADJUSTMENTS).toEqual(initialSnapshot);
    expect(metadata.cameraDefaults).toEqual(cameraSnapshot);
    expect(result.adjustments).not.toBe(INITIAL_ADJUSTMENTS);
    expect(result.context.noCameraBaseline).not.toBe(INITIAL_ADJUSTMENTS);
    expect(result.context.noCameraBaseline.curves).not.toBe(INITIAL_ADJUSTMENTS.curves);
    expect(result.context.noCameraBaseline.curves.luma).not.toBe(INITIAL_ADJUSTMENTS.curves.luma);
    expect(result.context.noCameraBaseline.curves.luma[0]).not.toBe(INITIAL_ADJUSTMENTS.curves.luma[0]);
    expect(result.context.noCameraBaseline.colorGrading.global).not.toBe(INITIAL_ADJUSTMENTS.colorGrading.global);
    expect(result.context.noCameraBaseline.hsl.reds).not.toBe(INITIAL_ADJUSTMENTS.hsl.reds);
    expect(result.context.effectiveBaseline).not.toBe(result.adjustments);
    expect(result.context.noCameraBaseline).not.toBe(result.context.effectiveBaseline);

    (result.adjustments.curves.luma[0] as { x: number }).x = 99;
    expect(result.context.effectiveBaseline.curves.luma[0].x).toBe(0);
    expect(result.context.noCameraBaseline.curves.luma[0].x).toBe(0);
    expect(INITIAL_ADJUSTMENTS.curves.luma[0].x).toBe(0);
    expect(result.adjustments.exposure).toBe(0);
  });

  it('returns equal but fully independent trees for repeated null normalization', () => {
    const first = normalizeLoadedAdjustments(null);
    const second = normalizeLoadedAdjustments(null);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.curves.luma).not.toBe(second.curves.luma);
    expect(first.colorGrading.global).not.toBe(second.colorGrading.global);
    expect(first.hsl.reds).not.toBe(second.hsl.reds);

    first.curves.luma[0].x = 90;
    first.colorGrading.global.hue = 90;
    first.hsl.reds.hue = 90;
    expect(second.curves.luma[0].x).toBe(0);
    expect(second.colorGrading.global.hue).toBe(0);
    expect(second.hsl.reds.hue).toBe(0);
    expect(INITIAL_ADJUSTMENTS.curves.luma[0].x).toBe(0);
  });

  it('normalizes a partial persisted object while isolating every nested transport value', () => {
    const persisted = {
      exposure: 1.25,
      curves: { luma: [{ x: 12, y: 34 }] },
      colorGrading: { global: { hue: 10, saturation: 20, luminance: 30 } },
      hsl: { reds: { hue: 5, saturation: 6, luminance: 7 } },
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
      masks: [
        {
          id: 'mask-1',
          invert: false,
          name: 'Mask',
          opacity: 100,
          visible: true,
          adjustments: {
            curves: { luma: [{ x: 40, y: 50 }] },
            colorGrading: { shadows: { hue: 1, saturation: 2, luminance: 3 } },
            hsl: { blues: { hue: 4, saturation: 5, luminance: 6 } },
          },
          subMasks: [{ id: 'sub-1', points: [{ x: 1, y: 2 }] }],
        },
      ],
    } as unknown as PersistedAdjustments;
    const metadata = metadataWith(persisted);
    const persistedSnapshot = structuredClone(persisted);
    const result = initializeAdjustmentLoad(metadata);

    expect(result.adjustments.exposure).toBe(1.25);
    expect(result.adjustments.curves.luma).toEqual([{ x: 12, y: 34 }]);
    expect(result.adjustments.colorGrading.global).toEqual({ hue: 10, saturation: 20, luminance: 30 });
    expect(result.adjustments.hsl.reds).toEqual({ hue: 5, saturation: 6, luminance: 7 });
    expect(metadata.adjustments).toEqual(persistedSnapshot);
    expect(result.context.persistedAdjustments).toEqual(persistedSnapshot);
    expect(result.context.persistedAdjustments).not.toBe(metadata.adjustments);
    expect(result.adjustments.curves.luma).not.toBe((persisted as Partial<Adjustments>).curves?.luma);
    expect(result.adjustments.colorGrading.global).not.toBe((persisted as Partial<Adjustments>).colorGrading?.global);
    expect(result.adjustments.hsl.reds).not.toBe((persisted as Partial<Adjustments>).hsl?.reds);
    expect(result.adjustments.lensDistortionParams).not.toBe((persisted as Partial<Adjustments>).lensDistortionParams);
    expect(result.adjustments.masks[0]).not.toBe((persisted as Partial<Adjustments>).masks?.[0]);
    expect(result.adjustments.masks[0].adjustments.colorGrading.shadows).not.toBe(
      (persisted as Partial<Adjustments>).masks?.[0]?.adjustments.colorGrading.shadows,
    );
    expect(result.adjustments.masks[0].subMasks[0]).not.toBe(
      (persisted as Partial<Adjustments>).masks?.[0]?.subMasks[0],
    );

    (persisted as Partial<Adjustments>).exposure = 9;
    (persisted as Partial<Adjustments>).curves!.luma[0].x = 90;
    expect(result.context.persistedAdjustments).toEqual(persistedSnapshot);
    expect(result.adjustments.exposure).toBe(1.25);
    expect(result.adjustments.curves.luma[0].x).toBe(12);

    (result.context.persistedAdjustments as Partial<Adjustments>).hsl!.reds.hue = 90;
    expect((metadata.adjustments as Partial<Adjustments>).hsl!.reds.hue).toBe(5);
  });
});

const imageWith = (
  source_kind: LoadImageResult['source_kind'],
  width = 4000,
  height = 3000,
): Pick<LoadImageResult, 'width' | 'height' | 'source_kind'> => ({ width, height, source_kind });

describe('authoritative-source reconciliation', () => {
  it('retains injected camera framing for developed RAW and completes the independent canvas baseline', () => {
    const initialized = initializeAdjustmentLoad(metadataWith(null));
    const provisionalSnapshot = structuredClone(initialized.adjustments);
    const contextSnapshot = structuredClone(initialized.context);
    const result = reconcileAdjustmentLoad(
      initialized.adjustments,
      initialized.context,
      imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, 6000, 4000),
    );

    expect(result.adjustments.crop).toEqual({ unit: 'px', x: 100, y: 200, width: 6500, height: 2400 });
    expect(result.adjustments.aspectRatio).toBeCloseTo(65 / 24);
    expect(result.adjustments.exposure).toBe(0);
    expect(result.context.noCameraBaseline.crop).toBeNull();
    expect(result.context.noCameraBaseline.aspectRatio).toBe(1.5);
    expect(result.context.sourceKind).toBe(IMAGE_SOURCE_KINDS.DevelopedRaw);
    expect(result.context.reconciled).toBe(true);
    expect(result.context.dirty).toBe(false);
    expect(result.context.effectiveBaseline).toEqual(result.adjustments);
    expect(result.context.effectiveBaseline).not.toBe(result.adjustments);
    expect(initialized.adjustments).toEqual(provisionalSnapshot);
    expect(initialized.context).toEqual(contextSnapshot);

    result.adjustments.curves.luma[0].x = 90;
    expect(result.context.effectiveBaseline.curves.luma[0].x).toBe(0);
    expect(result.context.noCameraBaseline.curves.luma[0].x).toBe(0);
    expect(initialized.adjustments.curves.luma[0].x).toBe(0);
    result.context.effectiveBaseline.hsl.reds.hue = 90;
    expect(result.adjustments.hsl.reds.hue).toBe(0);
    expect(result.context.noCameraBaseline.hsl.reds.hue).toBe(0);
  });

  it.each([IMAGE_SOURCE_KINDS.EmbeddedPreview, IMAGE_SOURCE_KINDS.NonRaw])(
    'atomically restores crop and ratio for %s using authoritative dimensions',
    (sourceKind) => {
      const metadata = metadataWith(null, {
        crop: { x: 100, y: 200, width: 6500, height: 2400 },
        aspectRatio: 65 / 24,
        canvasWidth: 11648,
        canvasHeight: 8736,
      });
      const initialized = initializeAdjustmentLoad(metadata);
      const result = reconcileAdjustmentLoad(
        initialized.adjustments,
        initialized.context,
        imageWith(sourceKind, 2400, 1600),
      );

      expect(result.adjustments.crop).toBeNull();
      expect(result.adjustments.aspectRatio).toBe(1.5);
      expect(result.adjustments.aspectRatio).not.toBe(
        metadata.cameraDefaults.canvasWidth! / metadata.cameraDefaults.canvasHeight!,
      );
      expect(result.context.noCameraBaseline.crop).toBeNull();
      expect(result.context.noCameraBaseline.aspectRatio).toBe(1.5);
      expect(result.context.effectiveBaseline).toEqual(result.adjustments);
      expect(result.context.sourceKind).toBe(sourceKind);
      expect(result.context.reconciled).toBe(true);
      expect(result.context.dirty).toBe(false);
    },
  );

  it.each([IMAGE_SOURCE_KINDS.DevelopedRaw, IMAGE_SOURCE_KINDS.EmbeddedPreview, IMAGE_SOURCE_KINDS.NonRaw])(
    'preserves persisted adjustment objects for %s',
    (sourceKind) => {
      const persisted = {
        crop: { unit: 'px', x: 10, y: 20, width: 300, height: 200 },
        aspectRatio: 1.25,
        exposure: 0.75,
        curves: { luma: [{ x: 9, y: 10 }] },
      } as unknown as PersistedAdjustments;
      const persistedSnapshot = structuredClone(persisted);
      const initialized = initializeAdjustmentLoad(metadataWith(persisted));
      const provisionalSnapshot = structuredClone(initialized.adjustments);
      const result = reconcileAdjustmentLoad(
        initialized.adjustments,
        initialized.context,
        imageWith(sourceKind, 2400, 1600),
      );

      expect(result.adjustments).toEqual(provisionalSnapshot);
      expect(result.adjustments.crop).toEqual((persisted as Partial<Adjustments>).crop);
      expect(result.adjustments.aspectRatio).toBe(1.25);
      expect(result.adjustments.exposure).toBe(0.75);
      expect(result.context.persistedAdjustments).toEqual(persistedSnapshot);
      expect(persisted).toEqual(persistedSnapshot);
    },
  );

  it('adds a full-canvas ratio only after authoritative dimensions exist when no camera crop is available', () => {
    const initialized = initializeAdjustmentLoad(
      metadataWith(null, { crop: null, aspectRatio: null, canvasWidth: 11648, canvasHeight: 8736 }),
    );

    expect(initialized.adjustments.crop).toBeNull();
    expect(initialized.adjustments.aspectRatio).toBeNull();
    expect(initialized.context.injectedCrop).toBe(false);
    expect(initialized.context.injectedAspectRatio).toBe(false);

    const result = reconcileAdjustmentLoad(
      initialized.adjustments,
      initialized.context,
      imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, 3000, 2000),
    );

    expect(result.adjustments.crop).toBeNull();
    expect(result.adjustments.aspectRatio).toBe(1.5);
    expect(result.context.noCameraBaseline.aspectRatio).toBe(1.5);
    expect(result.context.effectiveBaseline).toEqual(result.adjustments);
  });

  it('never translates dynamic-range camera metadata into exposure', () => {
    const cameraDefaultsWithDynamicRange = {
      crop: { x: 100, y: 200, width: 6500, height: 2400 },
      aspectRatio: 65 / 24,
      canvasWidth: 7000,
      canvasHeight: 3000,
      exposure: 2,
      dynamicRange: 400,
    } as LoadMetadataResult['cameraDefaults'];
    const initialized = initializeAdjustmentLoad(metadataWith(null, cameraDefaultsWithDynamicRange));
    const result = reconcileAdjustmentLoad(
      initialized.adjustments,
      initialized.context,
      imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw),
    );

    expect(initialized.adjustments.exposure).toBe(0);
    expect(result.adjustments.exposure).toBe(0);
    expect(result.context.noCameraBaseline.exposure).toBe(0);
    expect(result.context.effectiveBaseline.exposure).toBe(0);
  });

  it.each([
    [0, 3000],
    [4000, 0],
    [-1, 3000],
    [4000, Number.NaN],
  ])('leaves a literal-null full-canvas ratio unset for invalid dimensions %s x %s', (width, height) => {
    const initialized = initializeAdjustmentLoad(
      metadataWith(null, { crop: null, aspectRatio: null, canvasWidth: null, canvasHeight: null }),
    );
    const result = reconcileAdjustmentLoad(
      initialized.adjustments,
      initialized.context,
      imageWith(IMAGE_SOURCE_KINDS.NonRaw, width, height),
    );

    expect(result.adjustments.crop).toBeNull();
    expect(result.adjustments.aspectRatio).toBeNull();
    expect(result.context.noCameraBaseline.aspectRatio).toBeNull();
  });

  it('drops both camera fields when an inconsistent injection context reaches developed RAW reconciliation', () => {
    const initialized = initializeAdjustmentLoad(metadataWith(null));
    const inconsistentContext = { ...initialized.context, injectedAspectRatio: false };
    const result = reconcileAdjustmentLoad(
      initialized.adjustments,
      inconsistentContext,
      imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw, 3000, 2000),
    );

    expect(result.adjustments.crop).toBeNull();
    expect(result.adjustments.aspectRatio).toBe(1.5);
  });
});

const reconciledLoad = (
  persisted: PersistedAdjustments,
  sourceKind: LoadImageResult['source_kind'] = IMAGE_SOURCE_KINDS.DevelopedRaw,
) => {
  const initialized = initializeAdjustmentLoad(metadataWith(persisted));
  return reconcileAdjustmentLoad(initialized.adjustments, initialized.context, imageWith(sourceKind));
};

describe('adjustment persistence', () => {
  it('does not serialize without a reconciled dirty context', () => {
    const initialized = initializeAdjustmentLoad(metadataWith(null));
    const unreconciledDirty = { ...initialized.context, dirty: true };
    const reconciled = reconcileAdjustmentLoad(
      initialized.adjustments,
      initialized.context,
      imageWith(IMAGE_SOURCE_KINDS.DevelopedRaw),
    );

    expect(adjustmentsForPersistence(null, initialized.adjustments)).toBeUndefined();
    expect(adjustmentsForPersistence(initialized.context, initialized.adjustments)).toBeUndefined();
    expect(adjustmentsForPersistence(unreconciledDirty, initialized.adjustments)).toBeUndefined();
    expect(adjustmentsForPersistence(reconciled.context, reconciled.adjustments)).toBeUndefined();
  });

  it('marks a load dirty immutably', () => {
    const reconciled = reconciledLoad(null);
    const snapshot = structuredClone(reconciled.context);
    const dirty = markAdjustmentLoadDirty(reconciled.context);

    expect(dirty).not.toBe(reconciled.context);
    expect(dirty.dirty).toBe(true);
    expect(reconciled.context).toEqual(snapshot);
    expect(dirty.effectiveBaseline).toEqual(reconciled.context.effectiveBaseline);
    expect(dirty.effectiveBaseline).not.toBe(reconciled.context.effectiveBaseline);
    expect(dirty.effectiveBaseline.curves.luma).not.toBe(reconciled.context.effectiveBaseline.curves.luma);
  });

  it('returns literal null when a dirty adjustment returns to its effective baseline', () => {
    const reconciled = reconciledLoad(null);
    const dirty = markAdjustmentLoadDirty(reconciled.context);

    expect(adjustmentsForPersistence(dirty, reconciled.context.effectiveBaseline)).toBeNull();
  });

  it('returns an exact cloned empty object when a dirty partial load returns to baseline', () => {
    const reconciled = reconciledLoad({});
    const dirty = markAdjustmentLoadDirty(reconciled.context);
    const persisted = adjustmentsForPersistence(dirty, reconciled.context.effectiveBaseline);

    expect(persisted).toEqual({});
    expect(persisted).not.toBe(dirty.persistedAdjustments);
    expect(Object.keys(persisted as object)).toHaveLength(0);
  });

  it('returns the exact saved partial transport object at baseline without normalized expansion', () => {
    const saved = {
      exposure: 1,
      crop: { unit: 'px', x: 1, y: 2, width: 3, height: 4 },
      masks: [
        {
          invert: false,
          name: 'No UUID',
          opacity: 50,
          visible: true,
          adjustments: { exposure: 0.5 },
          subMasks: [],
        },
      ],
    } as unknown as PersistedAdjustments;
    const savedSnapshot = structuredClone(saved);
    const reconciled = reconciledLoad(saved);
    const dirty = markAdjustmentLoadDirty(reconciled.context);
    const persisted = adjustmentsForPersistence(dirty, reconciled.context.effectiveBaseline);

    expect(persisted).toEqual(savedSnapshot);
    expect(persisted).not.toBe(saved);
    expect(Object.keys(persisted as object).sort()).toEqual(['crop', 'exposure', 'masks']);
    expect((persisted as Partial<Adjustments>).masks?.[0].id).toBeUndefined();
    expect(reconciled.context.effectiveBaseline.masks[0].id).toEqual(expect.any(String));
    expect(saved).toEqual(savedSnapshot);

    ((persisted as Partial<Adjustments>).masks?.[0].adjustments as { exposure: number }).exposure = 9;
    expect((saved as Partial<Adjustments>).masks?.[0].adjustments.exposure).toBe(0.5);
    expect((dirty.persistedAdjustments as Partial<Adjustments>).masks?.[0].adjustments.exposure).toBe(0.5);
  });

  it('serializes a complete cloned effective adjustment after a real edit, including explicit crop reset', () => {
    const reconciled = reconciledLoad(null);
    const dirty = markAdjustmentLoadDirty(reconciled.context);
    const resetCrop: Adjustments = {
      ...reconciled.adjustments,
      crop: null,
      aspectRatio: 4 / 3,
    };
    const persisted = adjustmentsForPersistence(dirty, resetCrop);

    expect(persisted).toEqual(resetCrop);
    expect(persisted).not.toBe(resetCrop);
    expect(Object.keys(persisted as object)).toEqual(expect.arrayContaining(Object.keys(INITIAL_ADJUSTMENTS)));
    expect((persisted as Adjustments).crop).toBeNull();
    expect((persisted as Adjustments).aspectRatio).toBe(4 / 3);

    (persisted as Adjustments).curves.luma[0].x = 200;
    expect(resetCrop.curves.luma[0].x).toBe(0);
    expect(dirty.effectiveBaseline.curves.luma[0].x).toBe(0);
  });

  it('compares reordered object keys recursively without ignoring array order', () => {
    const left = {
      exposure: 1,
      nested: {
        colors: [{ hue: 1, values: [2, { x: 3, y: null }] }],
        enabled: true,
      },
    };
    const reordered = {
      nested: {
        enabled: true,
        colors: [{ values: [2, { y: null, x: 3 }], hue: 1 }],
      },
      exposure: 1,
    };
    const reorderedArray = {
      nested: {
        enabled: true,
        colors: [{ values: [{ y: null, x: 3 }, 2], hue: 1 }],
      },
      exposure: 1,
    };

    expect(structurallyEqual(left, reordered)).toBe(true);
    expect(structurallyEqual(left, reorderedArray)).toBe(false);
    expect(structurallyEqual([1], [1, undefined])).toBe(false);
    expect(structurallyEqual(left, { ...reordered, exposure: 2 })).toBe(false);
    expect(structurallyEqual(left, { ...reordered, extra: undefined })).toBe(false);
    expect(structurallyEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(structurallyEqual(null, {})).toBe(false);
  });

  it('distinguishes sparse array slots from present values while matching equal sparse layouts', () => {
    const sparse = Array<number | undefined>(2);
    sparse[1] = 2;
    const matchingSparse = Array<number | undefined>(2);
    matchingSparse[1] = 2;

    expect(structurallyEqual(sparse, [1, 2])).toBe(false);
    expect(structurallyEqual(sparse, [undefined, 2])).toBe(false);
    expect(structurallyEqual([undefined, 2], sparse)).toBe(false);
    expect(structurallyEqual(sparse, matchingSparse)).toBe(true);
  });

  it('uses structural rather than insertion-order equality when recognizing the effective baseline', () => {
    const reconciled = reconciledLoad({ exposure: 1 });
    const dirty = markAdjustmentLoadDirty(reconciled.context);
    const reorderedBaseline = Object.fromEntries(
      Object.entries(reconciled.context.effectiveBaseline).reverse(),
    ) as Adjustments;

    expect(adjustmentsForPersistence(dirty, reorderedBaseline)).toEqual({ exposure: 1 });
  });

  it('keeps original and returned persisted values isolated across repeated serialization', () => {
    const saved = {
      hsl: { reds: { hue: 5, saturation: 6, luminance: 7 } },
      curves: { luma: [{ x: 1, y: 2 }] },
    } as unknown as PersistedAdjustments;
    const reconciled = reconciledLoad(saved);
    const dirty = markAdjustmentLoadDirty(reconciled.context);
    const first = adjustmentsForPersistence(dirty, reconciled.context.effectiveBaseline) as Partial<Adjustments>;
    const second = adjustmentsForPersistence(dirty, reconciled.context.effectiveBaseline) as Partial<Adjustments>;

    expect(first).toEqual(saved);
    expect(second).toEqual(saved);
    expect(first).not.toBe(second);
    expect(first.hsl?.reds).not.toBe(second.hsl?.reds);
    first.hsl!.reds.hue = 99;
    first.curves!.luma[0].x = 99;
    expect(second.hsl!.reds.hue).toBe(5);
    expect(second.curves!.luma[0].x).toBe(1);
    expect((saved as Partial<Adjustments>).hsl!.reds.hue).toBe(5);
  });
});

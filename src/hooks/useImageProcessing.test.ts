import { describe, expect, it } from 'vitest';
import { IMAGE_SOURCE_KINDS, type LoadMetadataResult } from '../types/imageLoading';
import { COPYABLE_ADJUSTMENT_KEYS } from '../utils/adjustments';
import { initializeAdjustmentLoad, markAdjustmentLoadDirty, reconcileAdjustmentLoad } from '../utils/rafCameraDefaults';
import { decideImageProcessingPersistence } from './useImageProcessing';

const metadata = (): LoadMetadataResult => ({
  version: 1,
  rating: 0,
  adjustments: null,
  tags: null,
  exif: null,
  cameraDefaults: {
    crop: { x: 100, y: 200, width: 6500, height: 2400 },
    aspectRatio: 65 / 24,
    canvasWidth: 7000,
    canvasHeight: 3000,
  },
});

const autoSync = {
  enabled: true,
  includedAdjustments: COPYABLE_ADJUSTMENT_KEYS,
  selectedPaths: ['/image.raf', '/peer.raf'],
};

describe('image processing persistence decisions', () => {
  it('gates null, unreconciled, and clean sessions while seeding a clean reconciled baseline', () => {
    const initialized = initializeAdjustmentLoad(metadata());
    const reconciled = reconcileAdjustmentLoad(initialized.adjustments, initialized.context, {
      width: 7000,
      height: 3000,
      source_kind: IMAGE_SOURCE_KINDS.DevelopedRaw,
    });
    const baseInput = {
      selectedImage: { path: '/image.raf', isReady: true },
      adjustments: reconciled.adjustments,
      previousBaseline: null,
      autoSync,
    };

    const missing = decideImageProcessingPersistence({ ...baseInput, adjustmentLoadContext: null });
    const unreconciled = decideImageProcessingPersistence({ ...baseInput, adjustmentLoadContext: initialized.context });
    const clean = decideImageProcessingPersistence({ ...baseInput, adjustmentLoadContext: reconciled.context });

    expect(missing).toMatchObject({ persisted: undefined, autoSync: null, nextBaseline: null });
    expect(unreconciled).toMatchObject({ persisted: undefined, autoSync: null, nextBaseline: null });
    expect(clean.persisted).toBeUndefined();
    expect(clean.autoSync).toBeNull();
    expect(clean.nextBaseline).toEqual({ path: '/image.raf', adjustments: reconciled.adjustments });
    expect(clean.nextBaseline?.adjustments).not.toBe(reconciled.adjustments);
  });

  it('persists the first dirty edit and auto-syncs only its explicit delta from the clean baseline', () => {
    const initialized = initializeAdjustmentLoad(metadata());
    const reconciled = reconcileAdjustmentLoad(initialized.adjustments, initialized.context, {
      width: 7000,
      height: 3000,
      source_kind: IMAGE_SOURCE_KINDS.DevelopedRaw,
    });
    const clean = decideImageProcessingPersistence({
      selectedImage: { path: '/image.raf', isReady: true },
      adjustments: reconciled.adjustments,
      adjustmentLoadContext: reconciled.context,
      previousBaseline: null,
      autoSync,
    });
    const edited = { ...reconciled.adjustments, exposure: 1.25 };

    const dirty = decideImageProcessingPersistence({
      selectedImage: { path: '/image.raf', isReady: true },
      adjustments: edited,
      adjustmentLoadContext: markAdjustmentLoadDirty(reconciled.context),
      previousBaseline: clean.nextBaseline,
      autoSync,
    });

    expect(dirty.persisted).toEqual(edited);
    expect(dirty.autoSync).toEqual({ paths: ['/peer.raf'], adjustments: { exposure: 1.25 } });
    expect(dirty.nextBaseline).toEqual({ path: '/image.raf', adjustments: edited });
    expect(dirty.nextBaseline?.adjustments).not.toBe(edited);
  });
});

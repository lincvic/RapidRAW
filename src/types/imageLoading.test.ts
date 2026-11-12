import { describe, expect, it } from 'vitest';
import {
  IMAGE_SOURCE_KINDS,
  type ImageSourceKind,
  type LoadImageResult,
  type LoadMetadataResult,
} from './imageLoading';

describe('image loading transport contract', () => {
  it('uses the exact serialized snake_case source kinds reported by load_image', () => {
    expect(Object.values(IMAGE_SOURCE_KINDS).sort()).toEqual(['developed_raw', 'embedded_preview', 'non_raw']);
  });

  it('keeps camera defaults beside, not inside, the persisted adjustments', () => {
    const metadata: LoadMetadataResult = {
      version: 1,
      rating: 0,
      adjustments: null,
      tags: null,
      cameraDefaults: { crop: null, aspectRatio: null, canvasWidth: null, canvasHeight: null },
    };
    const sourceKind: ImageSourceKind = IMAGE_SOURCE_KINDS.EmbeddedPreview;
    const image: LoadImageResult = {
      width: 4000,
      height: 3000,
      metadata: { version: 1, rating: 0, adjustments: null, tags: null },
      exif: {},
      is_raw: true,
      as_shot_white_balance: { temperature: 5000, tint: 0 },
      source_kind: sourceKind,
    };

    expect(metadata.adjustments).toBeNull();
    expect(metadata).toHaveProperty('cameraDefaults');
    expect(image.metadata).not.toHaveProperty('cameraDefaults');
    expect(JSON.parse(JSON.stringify(image))).toMatchObject({ source_kind: 'embedded_preview' });
  });
});

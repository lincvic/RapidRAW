import type { Adjustments } from '../utils/adjustments';

export const IMAGE_SOURCE_KINDS = {
  DevelopedRaw: 'developed_raw',
  EmbeddedPreview: 'embedded_preview',
  NonRaw: 'non_raw',
} as const;

export type ImageSourceKind = (typeof IMAGE_SOURCE_KINDS)[keyof typeof IMAGE_SOURCE_KINDS];
export type PersistedAdjustments = Partial<Adjustments> | null;

export interface CameraPixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CameraDefaults {
  crop: CameraPixelCrop | null;
  aspectRatio: number | null;
  canvasWidth: number | null;
  canvasHeight: number | null;
}

export interface PersistedImageMetadata {
  version: number;
  rating: number;
  adjustments: PersistedAdjustments;
  tags: string[] | null;
  exif?: Record<string, string> | null;
}

export interface LoadMetadataResult extends PersistedImageMetadata {
  cameraDefaults: CameraDefaults;
}

export interface LoadImageResult {
  width: number;
  height: number;
  metadata: PersistedImageMetadata;
  exif: Record<string, string>;
  is_raw: boolean;
  source_kind: ImageSourceKind;
}

export interface AdjustmentLoadContext {
  persistedAdjustments: PersistedAdjustments;
  noCameraBaseline: Adjustments;
  effectiveBaseline: Adjustments;
  injectedCrop: boolean;
  injectedAspectRatio: boolean;
  sourceKind: ImageSourceKind | null;
  reconciled: boolean;
  dirty: boolean;
}

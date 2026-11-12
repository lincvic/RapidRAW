import type { ChannelConfig } from '../components/adjustments/Curves';
import type { SelectedImage, WaveformData } from '../components/ui/AppProperties';
import type { ImageDimensions } from '../hooks/useImageRenderSize';
import type { AdjustmentLoadContext, ImageSourceKind } from '../types/imageLoading';
import type { Adjustments } from './adjustments';

export type ReconciledLoadContext = Omit<AdjustmentLoadContext, 'reconciled' | 'sourceKind'> & {
  reconciled: true;
  sourceKind: ImageSourceKind;
};

export type ReadySelectedImage = Omit<SelectedImage, 'isReady' | 'sourceKind'> & {
  isReady: true;
  sourceKind: ImageSourceKind;
};

/**
 * A previously opened editor image. Its adjustments are the effective (possibly camera-default) state, never the
 * persisted sidecar value; a cache hit only provides provisional display data until the loader reconciles again.
 */
export interface ImageCacheEntry {
  effectiveAdjustments: Adjustments;
  adjustmentLoadContext: ReconciledLoadContext;
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  finalPreviewUrl: string | null;
  uncroppedPreviewUrl: string | null;
  selectedImage: ReadySelectedImage;
  originalSize: ImageDimensions;
}

export interface CachedEditorPlaceholder {
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  finalPreviewUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  originalSize: ImageDimensions;
}

export function createCachedEditorPlaceholder(entry: ImageCacheEntry): CachedEditorPlaceholder {
  return {
    histogram: entry.histogram,
    waveform: entry.waveform,
    finalPreviewUrl: entry.finalPreviewUrl,
    uncroppedAdjustedPreviewUrl: entry.uncroppedPreviewUrl,
    originalSize: entry.originalSize,
  };
}

export interface EditorCacheSource {
  selectedImage: SelectedImage | null;
  adjustments: Adjustments;
  adjustmentLoadContext: AdjustmentLoadContext | null;
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  finalPreviewUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  originalSize: ImageDimensions;
  isWgpuActive: boolean;
}

/**
 * Builds the cache entry for the open editor image, or null while it may not be cached: only a ready session whose
 * reconciled source kind matches the image, with a rendered preview, is reusable as a later placeholder.
 */
export function createEditorCacheEntry(source: EditorCacheSource): ImageCacheEntry | null {
  const { selectedImage, adjustmentLoadContext } = source;
  if (
    !selectedImage?.path ||
    !selectedImage.isReady ||
    selectedImage.sourceKind === null ||
    !adjustmentLoadContext?.reconciled ||
    adjustmentLoadContext.sourceKind !== selectedImage.sourceKind ||
    (!source.finalPreviewUrl && !source.isWgpuActive)
  ) {
    return null;
  }

  return {
    effectiveAdjustments: source.adjustments,
    adjustmentLoadContext: { ...adjustmentLoadContext, reconciled: true, sourceKind: selectedImage.sourceKind },
    histogram: source.histogram,
    waveform: source.waveform,
    finalPreviewUrl: source.finalPreviewUrl,
    uncroppedPreviewUrl: source.uncroppedAdjustedPreviewUrl,
    selectedImage: { ...selectedImage, isReady: true, sourceKind: selectedImage.sourceKind },
    originalSize: source.originalSize,
  };
}

export class ImageLRUCache {
  private maxSize: number;
  private cache = new Map<string, ImageCacheEntry>();
  private protectedBlobUrls = new Set<string>();
  private pendingRevocations = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(maxSize = 20) {
    this.maxSize = maxSize;
  }

  /** Reads an entry without taking ownership of its preview URLs, which stay protected. */
  get(key: string): ImageCacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry;
  }

  /** Removes an entry and transfers ownership of its preview URLs to the caller. */
  take(key: string): ImageCacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    this.cache.delete(key);
    if (entry.finalPreviewUrl) this.protectedBlobUrls.delete(entry.finalPreviewUrl);
    if (entry.uncroppedPreviewUrl) this.protectedBlobUrls.delete(entry.uncroppedPreviewUrl);
    return entry;
  }

  /** Takes the navigation target before storing the outgoing image, so a full cache never evicts the target. */
  takeForNavigation(
    targetKey: string,
    outgoing?: { key: string; entry: ImageCacheEntry },
  ): ImageCacheEntry | undefined {
    const target = this.take(targetKey);
    if (outgoing) this.set(outgoing.key, outgoing.entry);
    return target;
  }

  set(key: string, entry: ImageCacheEntry): void {
    if (this.cache.has(key)) {
      this.cleanupEntry(this.cache.get(key)!, entry);
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) {
        this.cleanupEntry(this.cache.get(lruKey)!);
        this.cache.delete(lruKey);
      }
    }

    this.protect(entry.finalPreviewUrl);
    this.protect(entry.uncroppedPreviewUrl);

    this.cache.set(key, entry);
  }

  isProtected(url: string): boolean {
    return this.protectedBlobUrls.has(url);
  }

  /** Revokes a blob URL after a short delay unless a cache entry protects it before then. */
  revokeWhenUnprotected(url: string | null | undefined, delayMs = 250): void {
    if (!url?.startsWith('blob:') || this.isProtected(url) || this.pendingRevocations.has(url)) return;

    const timer = setTimeout(() => {
      this.pendingRevocations.delete(url);
      if (!this.isProtected(url)) URL.revokeObjectURL(url);
    }, delayMs);
    this.pendingRevocations.set(url, timer);
  }

  delete(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      this.cleanupEntry(entry);
      this.cache.delete(key);
    }
  }

  deleteByPrefix(prefix: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key === prefix || key.startsWith(prefix + '?vc=')) {
        this.delete(key);
      }
    }
  }

  clear(): void {
    for (const entry of this.cache.values()) {
      this.cleanupEntry(entry);
    }
    this.cache.clear();
    this.protectedBlobUrls.clear();
  }

  private cleanupEntry(old: ImageCacheEntry, replacement?: ImageCacheEntry): void {
    const revokeIfUnused = (url: string | null) => {
      if (!url?.startsWith('blob:')) return;
      const reused = replacement && (replacement.finalPreviewUrl === url || replacement.uncroppedPreviewUrl === url);
      if (!reused) {
        const pending = this.pendingRevocations.get(url);
        if (pending !== undefined) {
          clearTimeout(pending);
          this.pendingRevocations.delete(url);
        }
        this.protectedBlobUrls.delete(url);
        URL.revokeObjectURL(url);
      }
    };
    revokeIfUnused(old.finalPreviewUrl);
    revokeIfUnused(old.uncroppedPreviewUrl);
  }

  private protect(url: string | null): void {
    if (!url?.startsWith('blob:')) return;
    const pending = this.pendingRevocations.get(url);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingRevocations.delete(url);
    }
    this.protectedBlobUrls.add(url);
  }
}

export const globalImageCache = new ImageLRUCache(20);

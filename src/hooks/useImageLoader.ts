import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Invokes } from '../components/ui/AppProperties';
import type { LoadImageResult, LoadMetadataResult } from '../types/imageLoading';
import { isCurrentEditorSession } from '../utils/asyncNavigation';
import { flushOrDiscardPendingSave } from '../services/editorPersistence';
import { coordinateEditorImageLoad, EditorImageLoadCancelledError } from '../services/editorImageLoad';
import { createEditorCacheEntry, globalImageCache, type ImageCacheEntry } from '../utils/ImageLRUCache';

/**
 * Loads the selected unready image, whether it is new, a provisional cache hit, or reloading after a backend
 * sidecar change. The image only becomes ready once load_metadata and load_image agree on its baseline.
 */
export function useImageLoader(cachedEditStateRef: React.RefObject<ImageCacheEntry | null>) {
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const adjustments = useEditorStore((s) => s.adjustments);
  const adjustmentLoadContext = useEditorStore((s) => s.adjustmentLoadContext);
  const histogram = useEditorStore((s) => s.histogram);
  const waveform = useEditorStore((s) => s.waveform);
  const finalPreviewUrl = useEditorStore((s) => s.finalPreviewUrl);
  const uncroppedAdjustedPreviewUrl = useEditorStore((s) => s.uncroppedAdjustedPreviewUrl);
  const originalSize = useEditorStore((s) => s.originalSize);
  const wgpuPhase = useEditorStore((s) => s.wgpuPhase);
  const adjustmentSessionGeneration = useEditorStore((s) => s.adjustmentSessionGeneration);

  const beginAdjustmentLoad = useEditorStore((s) => s.beginAdjustmentLoad);
  const completeAdjustmentLoad = useEditorStore((s) => s.completeAdjustmentLoad);
  const restoreAdjustmentSession = useEditorStore((s) => s.restoreAdjustmentSession);
  const clearEditorSession = useEditorStore((s) => s.clearEditorSession);
  const setLibrary = useLibraryStore((s) => s.setLibrary);
  const appSettings = useSettingsStore((s) => s.appSettings);

  const isWgpuActive = appSettings?.useWgpuRenderer !== false && selectedImage?.isReady && wgpuPhase === 'live';

  useEffect(() => {
    if (selectedImage && !selectedImage.isReady && selectedImage.path) {
      let isEffectActive = true;
      const path = selectedImage.path;
      const requestGeneration = adjustmentSessionGeneration;
      const isCurrentLoad = () =>
        isCurrentEditorSession(
          path,
          requestGeneration,
          () => {
            const state = useEditorStore.getState();
            return { generation: state.adjustmentSessionGeneration, path: state.selectedImage?.path ?? null };
          },
          () => isEffectActive,
        );

      const loadAll = async () => {
        try {
          if (!isCurrentLoad()) return;
          useEditorStore.getState().patchesSentToBackend.clear();

          await coordinateEditorImageLoad(path, {
            flushPendingSave: flushOrDiscardPendingSave,
            isCurrent: isCurrentLoad,
            loadMetadata: (target) => invoke<LoadMetadataResult>(Invokes.LoadMetadata, { path: target }),
            loadImage: (target) => invoke<LoadImageResult>(Invokes.LoadImage, { path: target }),
            onMetadata: (initialized) => {
              if (!isCurrentLoad()) throw new EditorImageLoadCancelledError();
              beginAdjustmentLoad(initialized.adjustments, initialized.context);

              const activeLoad = useEditorStore.getState();
              if (!isCurrentLoad() || !activeLoad.adjustmentLoadContext) {
                throw new EditorImageLoadCancelledError();
              }
              return { adjustments: activeLoad.adjustments, context: activeLoad.adjustmentLoadContext };
            },
            onComplete: (completed) => {
              const currentImage = useEditorStore.getState().selectedImage;
              if (!isCurrentLoad() || !currentImage) throw new EditorImageLoadCancelledError();
              const { image } = completed;

              const didComplete = completeAdjustmentLoad(
                completed.adjustments,
                completed.context,
                {
                  ...currentImage,
                  asShotWhiteBalance: image.as_shot_white_balance,
                  exif: image.exif,
                  height: image.height,
                  isRaw: image.is_raw,
                  metadata: image.metadata,
                  sourceKind: image.source_kind,
                  width: image.width,
                },
                { originalSize: { width: image.width, height: image.height } },
              );
              if (!didComplete) throw new Error('Editor image load completion was rejected');
              // Readiness re-renders and retires this effect before the coordinator resumes, so the view
              // loading state is cleared in the same tick as the completion.
              setLibrary({ isViewLoading: false });
            },
          });
        } catch (err) {
          if (err instanceof EditorImageLoadCancelledError || !isCurrentLoad()) return;
          console.error('Failed to load image:', err);
          toast.error(`Failed to load image: ${err}`);
          setLibrary({ isViewLoading: false });
          const { adjustmentReloadSnapshot, finalPreviewUrl, uncroppedAdjustedPreviewUrl } = useEditorStore.getState();
          if (adjustmentReloadSnapshot) {
            restoreAdjustmentSession(adjustmentReloadSnapshot);
          } else {
            clearEditorSession();
            globalImageCache.revokeWhenUnprotected(finalPreviewUrl);
            globalImageCache.revokeWhenUnprotected(uncroppedAdjustedPreviewUrl);
          }
        }
      };

      void loadAll();

      return () => {
        isEffectActive = false;
      };
    }
  }, [
    selectedImage?.path,
    selectedImage?.isReady,
    adjustmentSessionGeneration,
    beginAdjustmentLoad,
    completeAdjustmentLoad,
    restoreAdjustmentSession,
    clearEditorSession,
    setLibrary,
  ]);

  useEffect(() => {
    // Only a reconciled session is cached; a provisional hit never re-enters the cache under its old source kind.
    cachedEditStateRef.current = createEditorCacheEntry({
      selectedImage,
      adjustments,
      adjustmentLoadContext,
      histogram,
      waveform,
      finalPreviewUrl,
      uncroppedAdjustedPreviewUrl,
      originalSize,
      isWgpuActive: Boolean(isWgpuActive),
    });
  }, [
    selectedImage,
    adjustments,
    adjustmentLoadContext,
    histogram,
    waveform,
    finalPreviewUrl,
    uncroppedAdjustedPreviewUrl,
    originalSize,
    isWgpuActive,
    cachedEditStateRef,
  ]);
}

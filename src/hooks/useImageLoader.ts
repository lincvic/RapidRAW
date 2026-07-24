import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Invokes } from '../components/ui/AppProperties';
import type { LoadImageResult, LoadMetadataResult } from '../types/imageLoading';
import { isCurrentEditorSession } from '../utils/asyncNavigation';
import { flushPendingSave } from '../services/editorPersistence';
import { coordinateEditorImageLoad, EditorImageLoadCancelledError } from '../services/editorImageLoad';
import { globalImageCache, type ImageCacheEntry } from '../utils/ImageLRUCache';

export function useImageLoader(
  cachedEditStateRef: React.RefObject<ImageCacheEntry | null>,
  handleImageLoadFailure: () => void,
) {
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const adjustments = useEditorStore((s) => s.adjustments);
  const adjustmentLoadContext = useEditorStore((s) => s.adjustmentLoadContext);
  const histogram = useEditorStore((s) => s.histogram);
  const waveform = useEditorStore((s) => s.waveform);
  const finalPreviewUrl = useEditorStore((s) => s.finalPreviewUrl);
  const uncroppedAdjustedPreviewUrl = useEditorStore((s) => s.uncroppedAdjustedPreviewUrl);
  const originalSize = useEditorStore((s) => s.originalSize);
  const previewSize = useEditorStore((s) => s.previewSize);
  const hasRenderedFirstFrame = useEditorStore((s) => s.hasRenderedFirstFrame);

  const beginAdjustmentLoad = useEditorStore((s) => s.beginAdjustmentLoad);
  const completeAdjustmentLoad = useEditorStore((s) => s.completeAdjustmentLoad);
  const restoreAdjustmentSession = useEditorStore((s) => s.restoreAdjustmentSession);
  const setLibrary = useLibraryStore((s) => s.setLibrary);
  const appSettings = useSettingsStore((s) => s.appSettings);

  const isWgpuActive = appSettings?.useWgpuRenderer !== false && selectedImage?.isReady && hasRenderedFirstFrame;

  useEffect(() => {
    if (selectedImage && !selectedImage.isReady && selectedImage.path) {
      let isEffectActive = true;
      const requestGeneration = useEditorStore.getState().adjustmentSessionGeneration;
      const isCurrentLoad = () =>
        isCurrentEditorSession(
          selectedImage.path,
          requestGeneration,
          () => {
            const state = useEditorStore.getState();
            return {
              generation: state.adjustmentSessionGeneration,
              path: state.selectedImage?.path ?? null,
            };
          },
          () => isEffectActive,
        );

      const loadAll = async () => {
        try {
          if (!isCurrentLoad()) return;
          useEditorStore.getState().patchesSentToBackend.clear();

          await coordinateEditorImageLoad(selectedImage.path, {
            flushPendingSave,
            isCurrent: isCurrentLoad,
            loadMetadata: (path) => invoke<LoadMetadataResult>(Invokes.LoadMetadata, { path }),
            loadImage: (path) => invoke<LoadImageResult>(Invokes.LoadImage, { path }),
            onMetadata: (initialized) => {
              if (!isCurrentLoad()) throw new EditorImageLoadCancelledError();
              beginAdjustmentLoad(initialized.adjustments, initialized.context);

              const activeLoad = useEditorStore.getState();
              if (!isCurrentLoad() || !activeLoad.adjustmentLoadContext) {
                throw new EditorImageLoadCancelledError();
              }

              return {
                adjustments: activeLoad.adjustments,
                context: activeLoad.adjustmentLoadContext,
              };
            },
            onComplete: (completed) => {
              if (!isCurrentLoad()) throw new EditorImageLoadCancelledError();

              const { width, height } = completed.image;
              let nextPreviewSize = { width: 0, height: 0 };

              if (appSettings?.editorPreviewResolution) {
                const maxSize = appSettings.editorPreviewResolution;
                const aspectRatio = width / height;

                if (width > height) {
                  const pWidth = Math.min(width, maxSize);
                  const pHeight = Math.round(pWidth / aspectRatio);
                  nextPreviewSize = { width: pWidth, height: pHeight };
                } else {
                  const pHeight = Math.min(height, maxSize);
                  const pWidth = Math.round(pHeight * aspectRatio);
                  nextPreviewSize = { width: pWidth, height: pHeight };
                }
              }

              const currentImage = useEditorStore.getState().selectedImage;
              if (!isCurrentLoad() || !currentImage) throw new EditorImageLoadCancelledError();
              const retiredPreviews = completeAdjustmentLoad(
                completed.adjustments,
                completed.context,
                {
                  ...currentImage,
                  exif: completed.image.exif,
                  height: completed.image.height,
                  isRaw: completed.image.is_raw,
                  metadata: completed.image.metadata,
                  originalUrl: null,
                  sourceKind: completed.image.source_kind,
                  width: completed.image.width,
                },
                {
                  originalSize: { width, height },
                  previewSize: nextPreviewSize,
                },
              );

              const completedImage = useEditorStore.getState().selectedImage;
              if (!retiredPreviews || !completedImage?.isReady || completedImage.path !== selectedImage.path) {
                throw new Error('Editor image load completion was rejected');
              }
              globalImageCache.revokeWhenUnprotected(retiredPreviews.finalPreviewUrl);
              globalImageCache.revokeWhenUnprotected(retiredPreviews.uncroppedPreviewUrl);
            },
          });

          if (isCurrentLoad()) setLibrary({ isViewLoading: false });
        } catch (err) {
          if (err instanceof EditorImageLoadCancelledError || !isCurrentLoad()) return;
          console.error('Failed to load image:', err);
          toast.error(`Failed to load image: ${err}`);
          setLibrary({ isViewLoading: false });
          const reloadSnapshot = useEditorStore.getState().adjustmentReloadSnapshot;
          if (reloadSnapshot) restoreAdjustmentSession(reloadSnapshot);
          else handleImageLoadFailure();
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
    appSettings?.editorPreviewResolution,
    beginAdjustmentLoad,
    completeAdjustmentLoad,
    handleImageLoadFailure,
    restoreAdjustmentSession,
    setLibrary,
  ]);

  useEffect(() => {
    if (
      selectedImage?.path &&
      selectedImage.isReady &&
      selectedImage.sourceKind !== null &&
      adjustmentLoadContext?.reconciled &&
      adjustmentLoadContext.sourceKind === selectedImage.sourceKind &&
      (finalPreviewUrl || isWgpuActive)
    ) {
      cachedEditStateRef.current = {
        effectiveAdjustments: adjustments,
        adjustmentLoadContext: {
          ...adjustmentLoadContext,
          reconciled: true,
          sourceKind: selectedImage.sourceKind,
        },
        histogram,
        waveform,
        finalPreviewUrl,
        uncroppedPreviewUrl: uncroppedAdjustedPreviewUrl,
        selectedImage: {
          ...selectedImage,
          isReady: true,
          sourceKind: selectedImage.sourceKind,
        },
        originalSize,
        previewSize,
      };
    } else {
      cachedEditStateRef.current = null;
    }
  }, [
    selectedImage,
    adjustments,
    adjustmentLoadContext,
    histogram,
    waveform,
    finalPreviewUrl,
    uncroppedAdjustedPreviewUrl,
    originalSize,
    previewSize,
    isWgpuActive,
    cachedEditStateRef,
  ]);
}

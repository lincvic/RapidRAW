import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Invokes } from '../components/ui/AppProperties';
import type { LoadImageResult, LoadMetadataResult } from '../types/imageLoading';
import { initializeAdjustmentLoad, reconcileAdjustmentLoad } from '../utils/rafCameraDefaults';
import { isCurrentEditorSession } from '../utils/asyncNavigation';

export function useImageLoader(cachedEditStateRef: React.RefObject<any>, handleImageLoadFailure: () => void) {
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

  const setEditor = useEditorStore((s) => s.setEditor);
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
          useEditorStore.getState().patchesSentToBackend.clear();
          await invoke('clear_session_caches').catch((e) => console.warn('Cache clear failed:', e));
          if (!isCurrentLoad()) return;

          const metadata = await invoke<LoadMetadataResult>(Invokes.LoadMetadata, { path: selectedImage.path });
          if (!isCurrentLoad()) return;
          const initialized = initializeAdjustmentLoad(metadata);
          beginAdjustmentLoad(initialized.adjustments, initialized.context);
          const activeLoad = useEditorStore.getState();
          if (!isCurrentLoad() || !activeLoad.adjustmentLoadContext) return;

          const loadImageResult = await invoke<LoadImageResult>(Invokes.LoadImage, { path: selectedImage.path });
          if (!isCurrentLoad()) return;

          const { width, height } = loadImageResult;
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
          setEditor({ originalSize: { width, height }, previewSize: nextPreviewSize });

          const reconciled = reconcileAdjustmentLoad(activeLoad.adjustments, activeLoad.adjustmentLoadContext, {
            width: loadImageResult.width,
            height: loadImageResult.height,
            source_kind: loadImageResult.source_kind,
          });
          const currentImage = useEditorStore.getState().selectedImage;
          if (!isCurrentLoad() || !currentImage) return;
          completeAdjustmentLoad(reconciled.adjustments, reconciled.context, {
            ...currentImage,
            exif: loadImageResult.exif,
            height: loadImageResult.height,
            isRaw: loadImageResult.is_raw,
            metadata: loadImageResult.metadata,
            originalUrl: null,
            sourceKind: loadImageResult.source_kind,
            width: loadImageResult.width,
          });
          if (isCurrentLoad()) setLibrary({ isViewLoading: false });
        } catch (err) {
          if (!isCurrentLoad()) return;
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
    setEditor,
    setLibrary,
  ]);

  useEffect(() => {
    if (selectedImage?.path && selectedImage.isReady && (finalPreviewUrl || isWgpuActive)) {
      cachedEditStateRef.current = {
        adjustments,
        adjustmentLoadContext,
        histogram,
        waveform,
        finalPreviewUrl,
        uncroppedPreviewUrl: uncroppedAdjustedPreviewUrl,
        selectedImage,
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

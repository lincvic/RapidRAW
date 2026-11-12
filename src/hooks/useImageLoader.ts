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
import { flushOrDiscardPendingSave } from '../services/editorPersistence';
import { EditorImageLoadCancelledError } from '../services/editorImageLoad';

export function useImageLoader(cachedEditStateRef: React.RefObject<any>) {
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const adjustments = useEditorStore((s) => s.adjustments);
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

      // Metadata first: the camera-default baseline is installed before pixels load, and the image only becomes
      // ready once load_image reports the authoritative source kind.
      const loadAll = async () => {
        try {
          useEditorStore.getState().patchesSentToBackend.clear();
          // A queued, in-flight, or reset-held save for this image lands before its sidecar is read.
          await flushOrDiscardPendingSave(path);
          if (!isCurrentLoad()) return;

          const metadata = await invoke<LoadMetadataResult>(Invokes.LoadMetadata, { path });
          if (!isCurrentLoad()) return;
          const initialized = initializeAdjustmentLoad(metadata);
          beginAdjustmentLoad(initialized.adjustments, initialized.context);
          const active = useEditorStore.getState();
          if (!isCurrentLoad() || !active.adjustmentLoadContext) return;

          const image = await invoke<LoadImageResult>(Invokes.LoadImage, { path });
          if (!isCurrentLoad()) return;
          const reconciled = reconcileAdjustmentLoad(active.adjustments, active.adjustmentLoadContext, image);
          const currentImage = useEditorStore.getState().selectedImage;
          if (!isCurrentLoad() || !currentImage) return;

          completeAdjustmentLoad(
            reconciled.adjustments,
            reconciled.context,
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
          if (isCurrentLoad()) setLibrary({ isViewLoading: false });
        } catch (err) {
          if (err instanceof EditorImageLoadCancelledError || !isCurrentLoad()) return;
          console.error('Failed to load image:', err);
          toast.error(`Failed to load image: ${err}`);
          setLibrary({ isViewLoading: false });
          const reloadSnapshot = useEditorStore.getState().adjustmentReloadSnapshot;
          if (reloadSnapshot) restoreAdjustmentSession(reloadSnapshot);
          else clearEditorSession();
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
    if (selectedImage?.path && selectedImage.isReady && (finalPreviewUrl || isWgpuActive)) {
      cachedEditStateRef.current = {
        adjustments,
        histogram,
        waveform,
        finalPreviewUrl,
        uncroppedPreviewUrl: uncroppedAdjustedPreviewUrl,
        selectedImage,
        originalSize,
      };
    } else {
      cachedEditStateRef.current = null;
    }
  }, [
    selectedImage,
    adjustments,
    histogram,
    waveform,
    finalPreviewUrl,
    uncroppedAdjustedPreviewUrl,
    originalSize,
    isWgpuActive,
    cachedEditStateRef,
  ]);
}

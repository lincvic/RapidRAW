import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useProcessStore } from '../store/useProcessStore';
import {
  Adjustments,
  INITIAL_ADJUSTMENTS,
  COPYABLE_ADJUSTMENT_KEYS,
  PasteMode,
  LensAdjustment,
  normalizeLoadedAdjustments,
} from '../utils/adjustments';
import { calculateCenteredCrop } from '../utils/cropUtils';
import { Invokes, type SelectedImage } from '../components/ui/AppProperties';
import { globalImageCache } from '../utils/ImageLRUCache';
import { resetAdjustmentsErrorMessage, runAuthoritativeReset } from '../services/editorPersistence';
import { adjustmentsForPersistence } from '../utils/rafCameraDefaults';

export class ResetTargetLoadingError extends Error {
  constructor(path: string) {
    super(`Cannot reset adjustments while the selected image is loading: ${path}`);
    this.name = 'ResetTargetLoadingError';
  }
}

interface AutoAdjustmentEditorSession {
  adjustmentSessionGeneration: number;
  selectedImage: Pick<SelectedImage, 'isReady' | 'path'> | null;
}

export async function runAutoAdjustmentsForCurrentSession<T>(
  getSession: () => AutoAdjustmentEditorSession,
  calculate: () => Promise<T>,
  apply: (adjustments: T) => void,
): Promise<boolean> {
  const requestedSession = getSession();
  const requestedImage = requestedSession.selectedImage;
  if (!requestedImage?.isReady) return false;

  const adjustments = await calculate();
  const currentSession = getSession();
  if (
    !currentSession.selectedImage?.isReady ||
    currentSession.selectedImage.path !== requestedImage.path ||
    currentSession.adjustmentSessionGeneration !== requestedSession.adjustmentSessionGeneration
  ) {
    return false;
  }

  apply(adjustments);
  return true;
}

export async function routeResetForSelection(
  selectedImage: Pick<SelectedImage, 'isReady' | 'path'> | null,
  paths: readonly string[],
  resetSelected: (path: string) => Promise<void>,
  resetWithoutSelected: () => Promise<void>,
): Promise<boolean> {
  const selectedPath = selectedImage && paths.includes(selectedImage.path) ? selectedImage.path : null;
  if (selectedPath && !selectedImage?.isReady) throw new ResetTargetLoadingError(selectedPath);
  if (selectedPath) {
    await resetSelected(selectedPath);
  } else {
    await resetWithoutSelected();
  }
  return true;
}

export function useEditorActions() {
  const setEditor = useEditorStore((s) => s.setEditor);
  const applyExplicitAdjustments = useEditorStore((s) => s.applyExplicitAdjustments);

  const setAdjustments = useCallback(
    (value: Partial<Adjustments> | ((prev: Adjustments) => Adjustments)) => {
      const previous = useEditorStore.getState().adjustments;
      const next = typeof value === 'function' ? value(previous) : { ...previous, ...value };
      applyExplicitAdjustments(next);
    },
    [applyExplicitAdjustments],
  );

  const handleRotate = useCallback(
    (degrees: number) => {
      const { selectedImage, adjustments } = useEditorStore.getState();
      const increment = degrees > 0 ? 1 : 3;
      const newAspectRatio =
        adjustments.aspectRatio && adjustments.aspectRatio !== 0 ? 1 / adjustments.aspectRatio : null;
      const newOrientationSteps = ((adjustments.orientationSteps || 0) + increment) % 4;
      const newCrop =
        selectedImage?.width && selectedImage?.height
          ? calculateCenteredCrop(selectedImage.width, selectedImage.height, newOrientationSteps, newAspectRatio)
          : null;

      setAdjustments((prev) => ({
        ...prev,
        aspectRatio: newAspectRatio,
        orientationSteps: newOrientationSteps,
        rotation: 0,
        crop: newCrop,
      }));
    },
    [setAdjustments],
  );

  const handleAutoAdjustments = useCallback(async () => {
    try {
      await runAutoAdjustmentsForCurrentSession(
        () => {
          const editor = useEditorStore.getState();
          return {
            adjustmentSessionGeneration: editor.adjustmentSessionGeneration,
            selectedImage: editor.selectedImage,
          };
        },
        () => invoke<Adjustments>(Invokes.CalculateAutoAdjustments),
        (autoAdjustments) => {
          setAdjustments((prev: Adjustments) => ({
            ...prev,
            ...autoAdjustments,
            sectionVisibility: { ...prev.sectionVisibility, ...autoAdjustments.sectionVisibility },
          }));
        },
      );
    } catch (err) {
      toast.error(`Failed to apply auto adjustments: ${err}`);
    }
  }, [setAdjustments]);

  const handleLutSelect = useCallback(
    async (path: string) => {
      const isAndroid = useSettingsStore.getState().osPlatform === 'android';
      try {
        const result: { size: number } = await invoke('load_and_parse_lut', { path });
        let name =
          isAndroid && path.startsWith('content://')
            ? await invoke<string>('resolve_android_content_uri_name', { uriStr: path })
            : path.split(/[\\/]/).pop() || 'LUT';
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          lutPath: path,
          lutName: name,
          lutSize: result.size,
          lutIntensity: 100,
          sectionVisibility: { ...(prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility), effects: true },
        }));
      } catch (err) {
        toast.error(`Failed to load LUT: ${err}`);
      }
    },
    [setAdjustments],
  );

  const setLutPreviewOverride = useCallback(
    (path: string | null) => {
      setEditor((state) => {
        if (!path) return { previewOverride: null };
        const name = path.split(/[\\/]/).pop() || 'LUT';
        return {
          previewOverride: {
            ...state.adjustments,
            lutPath: path,
            lutName: name,
            lutIntensity: state.adjustments.lutIntensity,
          },
        };
      });
    },
    [setEditor],
  );

  const handleResetAdjustments = useCallback(async (paths?: string[]) => {
    const { multiSelectedPaths, libraryActivePath, setLibrary } = useLibraryStore.getState();
    const editor = useEditorStore.getState();
    const { selectedImage } = editor;
    const pathsToReset = paths || multiSelectedPaths;
    if (pathsToReset.length === 0) return;

    const finishReset = () => {
      pathsToReset.forEach((path) => globalImageCache.delete(path));
      if (libraryActivePath && pathsToReset.includes(libraryActivePath)) {
        setLibrary({ libraryActiveAdjustments: { ...INITIAL_ADJUSTMENTS } });
      }
    };

    try {
      const reset = () => invoke(Invokes.ResetAdjustmentsForPaths, { paths: pathsToReset });
      await routeResetForSelection(
        selectedImage,
        pathsToReset,
        async (selectedPath) => {
          const rollbackValue = adjustmentsForPersistence(editor.adjustmentLoadContext, editor.adjustments);
          await runAuthoritativeReset({
            path: selectedPath,
            rollbackValue,
            beginReload: (historyToken) => useEditorStore.getState().beginAdjustmentReload(selectedPath, historyToken),
            restoreReload: (snapshot) => useEditorStore.getState().restoreAdjustmentSession(snapshot),
            invokeReset: reset,
            onSuccess: finishReset,
            beginRecoveryReload: () => {
              globalImageCache.delete(selectedPath);
              useEditorStore.getState().beginAdjustmentReload(selectedPath);
            },
          });
        },
        async () => {
          await reset();
          finishReset();
        },
      );
    } catch (err) {
      toast.error(`Failed to reset adjustments: ${resetAdjustmentsErrorMessage(err)}`);
    }
  }, []);

  const handleCopyAdjustments = useCallback(async (pathOrEvent?: string | any) => {
    const pathOverride = typeof pathOrEvent === 'string' ? pathOrEvent : undefined;
    const { selectedImage, adjustments } = useEditorStore.getState();
    const { libraryActivePath, multiSelectedPaths } = useLibraryStore.getState();
    let sourceAdjustments: any = null;

    const pathToCopyFrom =
      pathOverride || (selectedImage ? selectedImage.path : libraryActivePath || multiSelectedPaths[0]);

    if (selectedImage && pathToCopyFrom === selectedImage.path) {
      sourceAdjustments = adjustments;
    } else if (pathToCopyFrom) {
      try {
        const meta: any = await invoke(Invokes.LoadMetadata, { path: pathToCopyFrom });
        if (meta?.adjustments && !meta.adjustments.is_null) {
          sourceAdjustments = normalizeLoadedAdjustments(meta.adjustments);
        } else {
          sourceAdjustments = INITIAL_ADJUSTMENTS;
        }
      } catch (err) {
        toast.error(`Failed to load metadata for copying: ${err}`);
        return;
      }
    }

    if (!sourceAdjustments) return;

    const adjustmentsToCopy: any = {};

    for (const key of COPYABLE_ADJUSTMENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(sourceAdjustments, key)) {
        adjustmentsToCopy[key] = structuredClone(sourceAdjustments[key]);
      }
    }
    useEditorStore.getState().setEditor({ copiedAdjustments: adjustmentsToCopy });
    useProcessStore.getState().setProcess({ isCopied: true });
  }, []);

  const handlePasteAdjustments = useCallback(
    (paths?: string[]) => {
      const { copiedAdjustments, selectedImage, adjustments } = useEditorStore.getState();
      const { multiSelectedPaths } = useLibraryStore.getState();
      const { appSettings } = useSettingsStore.getState();
      const { setProcess } = useProcessStore.getState();

      const copyPasteSettings = appSettings?.copyPasteSettings;
      if (!copiedAdjustments || !copyPasteSettings) return;

      const { mode, includedAdjustments } = copyPasteSettings;
      const adjustmentsToApply: Partial<Adjustments> = {};

      for (const key of includedAdjustments) {
        if (Object.prototype.hasOwnProperty.call(copiedAdjustments, key)) {
          const value = copiedAdjustments[key as keyof Adjustments];
          if (mode === PasteMode.Merge) {
            const defaultValue = INITIAL_ADJUSTMENTS[key as keyof Adjustments];
            if (JSON.stringify(value) !== JSON.stringify(defaultValue))
              adjustmentsToApply[key as keyof Adjustments] = value;
          } else {
            adjustmentsToApply[key as keyof Adjustments] = value;
          }
        }
      }

      if (includedAdjustments.includes(LensAdjustment.LensMaker)) {
        if (!adjustmentsToApply.lensMaker) {
          adjustmentsToApply.lensDistortionParams = null;
        }
      }

      if (Object.keys(adjustmentsToApply).length === 0) {
        setProcess({ isPasted: true });
        return;
      }

      const pathsToUpdate =
        paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
      if (pathsToUpdate.length === 0) return;

      pathsToUpdate.forEach((p) => globalImageCache.delete(p));

      if (selectedImage && pathsToUpdate.includes(selectedImage.path)) {
        setAdjustments({ ...adjustments, ...adjustmentsToApply });
      }

      invoke(Invokes.ApplyAdjustmentsToPaths, { paths: pathsToUpdate, adjustments: adjustmentsToApply })
        .then(() => {
          if (selectedImage && pathsToUpdate.includes(selectedImage.path)) {
            invoke('load_metadata', { path: selectedImage.path }).then((meta: any) => {
              if (meta.adjustments) {
                setAdjustments((prev: any) => ({
                  ...prev,
                  lensMaker: meta.adjustments.lensMaker,
                  lensModel: meta.adjustments.lensModel,
                  lensDistortionParams: meta.adjustments.lensDistortionParams,
                }));
              }
            });
          }
        })
        .catch((err) => toast.error(`Failed to paste adjustments: ${err}`));

      setProcess({ isPasted: true });
    },
    [setAdjustments],
  );

  const handleZoomChange = useCallback((zoomValue: number, fitToWindow: boolean = false) => {
    const { originalSize, baseRenderSize, adjustments } = useEditorStore.getState();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    let targetZoomPercent: number;

    const orientationSteps = adjustments.orientationSteps || 0;
    const isSwapped = orientationSteps === 1 || orientationSteps === 3;
    const effectiveOriginalWidth = isSwapped ? originalSize.height : originalSize.width;
    const effectiveOriginalHeight = isSwapped ? originalSize.width : originalSize.height;

    if (fitToWindow) {
      if (
        effectiveOriginalWidth > 0 &&
        effectiveOriginalHeight > 0 &&
        baseRenderSize.width > 0 &&
        baseRenderSize.height > 0
      ) {
        const originalAspect = effectiveOriginalWidth / effectiveOriginalHeight;
        const baseAspect = baseRenderSize.width / baseRenderSize.height;
        targetZoomPercent =
          originalAspect > baseAspect
            ? baseRenderSize.width / effectiveOriginalWidth
            : baseRenderSize.height / effectiveOriginalHeight;
      } else {
        targetZoomPercent = 1.0;
      }
    } else {
      targetZoomPercent = zoomValue / dpr;
    }

    targetZoomPercent = Math.max(0.1 / dpr, Math.min(2.0, targetZoomPercent));

    let transformZoom = 1.0;
    if (
      effectiveOriginalWidth > 0 &&
      effectiveOriginalHeight > 0 &&
      baseRenderSize.width > 0 &&
      baseRenderSize.height > 0
    ) {
      const originalAspect = effectiveOriginalWidth / effectiveOriginalHeight;
      const baseAspect = baseRenderSize.width / baseRenderSize.height;
      if (originalAspect > baseAspect) {
        transformZoom = (targetZoomPercent * effectiveOriginalWidth) / baseRenderSize.width;
      } else {
        transformZoom = (targetZoomPercent * effectiveOriginalHeight) / baseRenderSize.height;
      }
    }
    useEditorStore.getState().setEditor({ zoom: transformZoom });
  }, []);

  return {
    setAdjustments,
    handleRotate,
    handleAutoAdjustments,
    handleLutSelect,
    setLutPreviewOverride,
    handleResetAdjustments,
    handleCopyAdjustments,
    handlePasteAdjustments,
    handleZoomChange,
  };
}

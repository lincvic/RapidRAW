import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { TFunction } from 'i18next';
import { SignalHigh, SignalLow, SignalMedium } from 'lucide-react';
import { useEditorStore, type AdjustmentSessionSnapshot } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useProcessStore } from '../store/useProcessStore';
import { useUIStore } from '../store/useUIStore';
import {
  Adjustments,
  AutoAdjustMode,
  CROP_GEOMETRY_KEYS,
  INITIAL_ADJUSTMENTS,
  COPYABLE_ADJUSTMENT_KEYS,
  PasteMode,
  getActiveTools,
  mergeActiveTools,
  normalizeLoadedAdjustments,
  setToolActive,
} from '../utils/adjustments';
import { calculateAutoCropForRotation, calculateCenteredCrop } from '../utils/cropUtils';
import originalAdjustmentKeys from '../utils/originalAdjustmentKeys.json';
import { CompareMode, Invokes, Option, Panel, SelectedImage } from '../components/ui/AppProperties';
import { globalImageCache } from '../utils/ImageLRUCache';
import { getDevicePixelRatio } from '../utils/displayScale';
import type { LoadMetadataResult } from '../types/imageLoading';
import {
  flushPendingSave,
  resetAdjustmentsErrorMessage,
  runAuthoritativeReset,
  runEditorMutation,
} from '../services/editorPersistence';
import { adjustmentsForPersistence } from '../utils/rafCameraDefaults';

export class AdjustmentTargetLoadingError extends Error {
  constructor(path: string) {
    super(`Cannot change adjustments while the selected image is loading: ${path}`);
    this.name = 'AdjustmentTargetLoadingError';
  }
}

type SelectionTarget = Pick<SelectedImage, 'isReady' | 'path'> | null;

/**
 * Resolves with the selected image once it is no longer a loading target in `paths`: it became ready, or another
 * image (or none) is selected. A sidecar command must never race the metadata-first load of its own target.
 */
export async function waitForSettledSelection(
  getSelectedImage: () => SelectionTarget,
  paths: readonly string[],
  waitForChange: (path: string) => Promise<unknown>,
): Promise<SelectionTarget> {
  let selectedImage = getSelectedImage();
  while (selectedImage && paths.includes(selectedImage.path) && !selectedImage.isReady) {
    await waitForChange(selectedImage.path);
    selectedImage = getSelectedImage();
  }
  return selectedImage;
}

interface AutoAdjustmentEditorSession {
  adjustmentSessionGeneration: number;
  selectedImage: Pick<SelectedImage, 'isReady' | 'path'> | null;
}

/** Applies a calculated result only while the same ready editor session that requested it is still current. */
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

/** Routes a whole-image reset through the authoritative reset when it includes the ready editor image. */
export async function routeResetForSelection(
  getSelectedImage: () => SelectionTarget,
  paths: readonly string[],
  resetSelected: (path: string) => Promise<void>,
  resetWithoutSelected: () => Promise<void>,
  waitForChange: (path: string) => Promise<unknown> = waitForImageReady,
): Promise<boolean> {
  const selectedImage = await waitForSettledSelection(getSelectedImage, paths, waitForChange);
  if (selectedImage && paths.includes(selectedImage.path)) {
    await resetSelected(selectedImage.path);
    return true;
  }
  await resetWithoutSelected();
  return false;
}

/**
 * Routes a backend sidecar mutation through the open editor image's save window when it is a target, so its
 * pending edits land first and the editor reloads the backend-persisted result instead of overwriting it.
 * Returns whether the editor image was a target.
 */
export async function routeAdjustmentMutationForSelection(
  getSelectedImage: () => SelectionTarget,
  paths: readonly string[],
  runSelectedMutation: (path: string, mutate: (beforeBackend?: () => void) => Promise<void>) => Promise<void>,
  mutate: () => Promise<unknown>,
  waitForChange: (path: string) => Promise<unknown> = waitForImageReady,
): Promise<boolean> {
  const selectedImage = await waitForSettledSelection(getSelectedImage, paths, waitForChange);
  if (selectedImage && paths.includes(selectedImage.path)) {
    const selectedPath = selectedImage.path;
    await runSelectedMutation(selectedPath, async (beforeBackend) => {
      const currentImage = getSelectedImage();
      if (!currentImage?.isReady || currentImage.path !== selectedPath) {
        throw new AdjustmentTargetLoadingError(selectedPath);
      }
      beforeBackend?.();
      await mutate();
    });
    return true;
  }
  await mutate();
  return false;
}

const AUTO_ADJUST_MODE_ICONS: Record<AutoAdjustMode, any> = {
  [AutoAdjustMode.Subtle]: SignalLow,
  [AutoAdjustMode.Normal]: SignalMedium,
  [AutoAdjustMode.Strong]: SignalHigh,
};

export const buildAutoAdjustModeOptions = (t: TFunction, onSelect: (mode: AutoAdjustMode) => void): Option[] =>
  Object.values(AutoAdjustMode).map((mode) => ({
    label: t(`contextMenus.autoAdjustModes.${mode}`),
    icon: AUTO_ADJUST_MODE_ICONS[mode],
    onClick: () => onSelect(mode),
  }));

/** Resolves true once `path` is the ready editor image, or false as soon as another image (or none) is selected. */
function waitForImageReady(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const settle = (state: ReturnType<typeof useEditorStore.getState>) => {
      if (settled) return;
      if (state.selectedImage?.path === path && !state.selectedImage.isReady) return;
      settled = true;
      unsubscribe?.();
      resolve(state.selectedImage?.path === path);
    };
    unsubscribe = useEditorStore.subscribe(settle);
    settle(useEditorStore.getState());
  });
}

export const withRotation = (adjustments: Adjustments, image: SelectedImage | null, rotation: number): Adjustments => ({
  ...adjustments,
  rotation,
  crop:
    image?.width && image?.height
      ? calculateAutoCropForRotation(
          image.width,
          image.height,
          adjustments.orientationSteps || 0,
          adjustments.aspectRatio,
          rotation,
          adjustments.crop,
          rotation - (adjustments.rotation || 0),
        )
      : adjustments.crop,
});

const ORIGINAL_PRESERVED_KEYS = [...originalAdjustmentKeys.preserved, ...originalAdjustmentKeys.crop] as Array<
  keyof Adjustments
>;

export const getOriginalAdjustments = (adjustments: Adjustments): Adjustments => {
  const original = { ...INITIAL_ADJUSTMENTS };
  ORIGINAL_PRESERVED_KEYS.forEach((key) => {
    (original as any)[key] = adjustments[key];
  });
  return original;
};

const getCompareState = (mode: CompareMode, adjustments: Adjustments) =>
  mode === 'toggle'
    ? { showOriginal: true, previewOverride: getOriginalAdjustments(adjustments), compareView: 'off' as const }
    : { showOriginal: false, previewOverride: null, compareView: mode };

const reloadLibraryActiveAdjustments = async (paths: readonly string[]) => {
  const { libraryActivePath, setLibrary } = useLibraryStore.getState();
  if (libraryActivePath && paths.includes(libraryActivePath)) {
    const meta = await invoke<LoadMetadataResult>(Invokes.LoadMetadata, { path: libraryActivePath });
    if (meta.adjustments !== null) {
      setLibrary({ libraryActiveAdjustments: normalizeLoadedAdjustments(meta.adjustments) });
    }
  }
};

/**
 * Runs a backend command that rewrites the sidecars of `paths`. When the open editor image is a target, its
 * pending save drains first, edits made meanwhile are held, and the editor then reloads the persisted result
 * through the metadata-first loader rather than patching adjustments in place.
 */
export const applyBackendAdjustmentMutation = async (paths: string[], mutate: () => Promise<unknown>) => {
  const invalidatePreviews = () => paths.forEach((path) => globalImageCache.delete(path));
  const editorWasTarget = await routeAdjustmentMutationForSelection(
    () => useEditorStore.getState().selectedImage,
    paths,
    (selectedPath, guardedMutate) =>
      runEditorMutation(
        selectedPath,
        async (historyToken) => {
          // The backend result wins: the open image is unready while the command rewrites its sidecar and then
          // reloads it, so no edit made against the old state can be saved over the result.
          const reload: { snapshot: AdjustmentSessionSnapshot | null } = { snapshot: null };
          try {
            await guardedMutate(() => {
              reload.snapshot = useEditorStore.getState().beginAdjustmentReload(selectedPath, historyToken);
            });
          } catch (error) {
            if (reload.snapshot) useEditorStore.getState().restoreAdjustmentSession(reload.snapshot);
            throw error;
          }
        },
        invalidatePreviews,
      ),
    mutate,
  );
  if (!editorWasTarget) invalidatePreviews();
  await reloadLibraryActiveAdjustments(paths);
};

export const applyCrop = () => {
  useEditorStore.getState().setEditor({ isStraightenActive: false, liveRotation: null });
  useUIStore.getState().setPanel(Panel.Adjustments);
};

export const cancelCrop = () => {
  const { cropSessionSnapshot, selectedImage, adjustments, applyExplicitAdjustments } = useEditorStore.getState();
  applyCrop();
  if (cropSessionSnapshot && cropSessionSnapshot.path === (selectedImage?.path ?? null)) {
    const { geometry } = cropSessionSnapshot;
    const hasChanged = CROP_GEOMETRY_KEYS.some(
      (key) => JSON.stringify(adjustments[key]) !== JSON.stringify(geometry[key]),
    );
    if (hasChanged) {
      applyExplicitAdjustments({ ...useEditorStore.getState().adjustments, ...geometry });
    }
  }
};

export function useEditorActions() {
  const { t } = useTranslation();
  const setEditor = useEditorStore((s) => s.setEditor);
  const applyExplicitAdjustments = useEditorStore((s) => s.applyExplicitAdjustments);

  const setAdjustments = useCallback(
    (value: Partial<Adjustments> | ((prev: Adjustments) => Adjustments), label?: string) => {
      const previous = useEditorStore.getState().adjustments;
      const next = typeof value === 'function' ? value(previous) : { ...previous, ...value };
      applyExplicitAdjustments(next, { label });
    },
    [applyExplicitAdjustments],
  );

  const handleRotate = useCallback(
    (degrees: number) => {
      const { selectedImage, adjustments } = useEditorStore.getState();
      const increment = degrees > 0 ? 1 : 3;
      const newAspectRatio = adjustments.aspectRatio ? 1 / adjustments.aspectRatio : adjustments.aspectRatio;
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

  const handleAutoAdjustments = useCallback(
    async (mode: AutoAdjustMode = AutoAdjustMode.Normal) => {
      try {
        // A result that arrives after navigation or a reload belongs to a stale session and is discarded.
        await runAutoAdjustmentsForCurrentSession(
          () => {
            const editor = useEditorStore.getState();
            return {
              adjustmentSessionGeneration: editor.adjustmentSessionGeneration,
              selectedImage: editor.selectedImage,
            };
          },
          () =>
            invoke<Adjustments>(Invokes.CalculateAutoAdjustments, {
              jsAdjustments: useEditorStore.getState().adjustments,
              mode,
            }),
          (autoAdjustments) => {
            setAdjustments(
              (prev: Adjustments) => ({
                ...prev,
                ...autoAdjustments,
                activeTools: mergeActiveTools(prev, autoAdjustments),
              }),
              t('contextMenus.editor.autoAdjust'),
            );
          },
        );
      } catch (err) {
        toast.error(`Failed to apply auto adjustments: ${err}`);
      }
    },
    [setAdjustments, t],
  );

  const handleAutoStraighten = useCallback(async () => {
    const { selectedImage, isAutoStraightening } = useEditorStore.getState();
    if (!selectedImage || isAutoStraightening) return;
    setEditor({ isAutoStraightening: true });
    try {
      if (!selectedImage.isReady && !(await waitForImageReady(selectedImage.path))) return;
      const rotation: number | null = await invoke(Invokes.CalculateAutoStraighten, {
        jsAdjustments: useEditorStore.getState().adjustments,
      });
      const loadedImage = useEditorStore.getState().selectedImage;
      if (loadedImage?.path !== selectedImage.path) return;
      if (rotation === null) {
        toast.info(t('editor.crop.autoStraightenNoLines'));
        return;
      }
      setEditor({ liveRotation: null, isStraightenActive: false });
      setAdjustments((prev: Adjustments) => withRotation(prev, loadedImage, rotation));
    } catch (err) {
      toast.error(t('editor.crop.autoStraightenFailed', { error: String(err) }));
    } finally {
      setEditor({ isAutoStraightening: false });
    }
  }, [setAdjustments, setEditor, t]);

  const toggleCompare = useCallback(() => {
    const mode = useSettingsStore.getState().appSettings?.compareMode ?? 'toggle';
    setEditor((state) =>
      state.showOriginal || state.compareView !== 'off'
        ? { showOriginal: false, previewOverride: null, compareView: 'off' }
        : getCompareState(mode, state.adjustments),
    );
  }, [setEditor]);

  const selectCompareMode = useCallback(
    (mode: CompareMode) => {
      const { appSettings, handleSettingsChange } = useSettingsStore.getState();
      if (appSettings) handleSettingsChange({ ...appSettings, compareMode: mode });
      setEditor((state) => getCompareState(mode, state.adjustments));
    },
    [setEditor],
  );

  const handleLutSelect = useCallback(
    async (path: string, isBuiltIn: boolean = false) => {
      const isAndroid = useSettingsStore.getState().osPlatform === 'android';
      try {
        const result: { size: number } = await invoke('load_and_parse_lut', { path });
        const name =
          isAndroid && path.startsWith('content://')
            ? await invoke<string>('resolve_android_content_uri_name', { uriStr: path })
            : path.split(/[\\/]/).pop() || 'LUT';
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          lutPath: path,
          lutName: name,
          lutSize: result.size,
          lutIntensity: 100,
          lutIsSceneReferred: isBuiltIn,
          activeTools: setToolActive(getActiveTools(prev), 'lut', true),
        }));
      } catch (err) {
        toast.error(`Failed to load LUT: ${err}`);
      }
    },
    [setAdjustments],
  );

  const setLutPreviewOverride = useCallback(
    (path: string | null, isBuiltIn: boolean = false) => {
      setEditor((state) => {
        if (!path) return { previewOverride: null };
        const name = path.split(/[\\/]/).pop() || 'LUT';
        return {
          previewOverride: {
            ...state.adjustments,
            lutPath: path,
            lutName: name,
            lutIntensity: state.adjustments.lutIntensity,
            lutIsSceneReferred: isBuiltIn,
          },
        };
      });
    },
    [setEditor],
  );

  const handleResetAdjustments = useCallback(async (paths?: string[]) => {
    const { multiSelectedPaths, libraryActivePath, setLibrary } = useLibraryStore.getState();
    const pathsToReset = paths || multiSelectedPaths;
    if (pathsToReset.length === 0) return;

    const finishReset = () => {
      pathsToReset.forEach((path) => globalImageCache.delete(path));
      if (libraryActivePath && pathsToReset.includes(libraryActivePath)) {
        setLibrary({ libraryActiveAdjustments: { ...INITIAL_ADJUSTMENTS } });
      }
    };

    try {
      // The backend resolves only after every sidecar holds literal null adjustments.
      const reset = () => invoke(Invokes.ResetAdjustmentsForPaths, { paths: pathsToReset });
      await routeResetForSelection(
        () => useEditorStore.getState().selectedImage,
        pathsToReset,
        async (selectedPath) => {
          // The open image reloads a fresh camera-default baseline that stays unsaved until the next edit.
          const editor = useEditorStore.getState();
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

  const handleAutoLensCorrection = useCallback((paths?: string[]) => {
    const { multiSelectedPaths } = useLibraryStore.getState();
    const { selectedImage } = useEditorStore.getState();

    const pathsToUpdate =
      paths && paths.length > 0
        ? paths
        : multiSelectedPaths.length > 0
          ? multiSelectedPaths
          : selectedImage
            ? [selectedImage.path]
            : [];

    if (pathsToUpdate.length === 0) return;

    applyBackendAdjustmentMutation(pathsToUpdate, () =>
      invoke('apply_auto_lens_correction_to_paths', { paths: pathsToUpdate }),
    ).catch((err) => toast.error(`Failed to apply auto lens correction: ${err}`));
  }, []);

  const handleAutoStraightenPaths = useCallback(
    (paths: string[]) => {
      const { selectedImage } = useEditorStore.getState();
      const editingPath = useUIStore.getState().activeView === 'editor' ? selectedImage?.path : undefined;
      const batchPaths = paths.filter((path) => path !== editingPath);
      if (batchPaths.length < paths.length) {
        handleAutoStraighten();
      }
      if (batchPaths.length === 0) return;
      applyBackendAdjustmentMutation(batchPaths, () =>
        invoke(Invokes.ApplyAutoStraightenToPaths, { paths: batchPaths }),
      ).catch((err) => toast.error(t('editor.crop.autoStraightenFailed', { error: String(err) })));
    },
    [handleAutoStraighten, t],
  );

  const handleEnableAdjustments = useCallback(
    (paths: string[], patch: Partial<Adjustments>) => {
      const { selectedImage } = useEditorStore.getState();
      const editingPath = useUIStore.getState().activeView === 'editor' ? selectedImage?.path : undefined;
      const batchPaths = paths.filter((path) => path !== editingPath);
      if (batchPaths.length < paths.length) {
        setAdjustments((prev: Adjustments) => ({ ...prev, ...patch }));
      }
      if (batchPaths.length === 0) return;
      applyBackendAdjustmentMutation(batchPaths, () =>
        invoke(Invokes.ApplyAdjustmentsToPaths, { paths: batchPaths, adjustments: patch }),
      ).catch((err) => toast.error(`Failed to apply adjustments: ${err}`));
    },
    [setAdjustments],
  );

  const handleCopyAdjustments = useCallback(async (pathOrEvent?: string | any) => {
    const pathOverride = typeof pathOrEvent === 'string' ? pathOrEvent : undefined;
    const { selectedImage, adjustments } = useEditorStore.getState();
    const { libraryActivePath, multiSelectedPaths } = useLibraryStore.getState();
    let sourceAdjustments: any = null;

    const editingPath = useUIStore.getState().activeView === 'editor' ? selectedImage?.path : undefined;
    const pathToCopyFrom =
      pathOverride || editingPath || libraryActivePath || multiSelectedPaths[0] || selectedImage?.path;

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
      const { copiedAdjustments, selectedImage } = useEditorStore.getState();
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

      if (Object.keys(adjustmentsToApply).length === 0) {
        setProcess({ isPasted: true });
        return;
      }

      const pathsToUpdate =
        paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
      if (pathsToUpdate.length === 0) return;

      pathsToUpdate.forEach((p) => globalImageCache.delete(p));

      const openPath = selectedImage && pathsToUpdate.includes(selectedImage.path) ? selectedImage.path : null;
      const openSessionGeneration = useEditorStore.getState().adjustmentSessionGeneration;

      // The open image's pending save lands before the backend merges the pasted keys into its sidecar.
      (openPath ? flushPendingSave(openPath) : Promise.resolve())
        .then(() => invoke(Invokes.ApplyAdjustmentsToPaths, { paths: pathsToUpdate, adjustments: adjustmentsToApply }))
        .then(async () => {
          if (!openPath) return;
          const { adjustments: persisted } = await invoke<LoadMetadataResult>(Invokes.LoadMetadata, { path: openPath });
          const editor = useEditorStore.getState();
          if (
            !persisted ||
            editor.selectedImage?.path !== openPath ||
            editor.adjustmentSessionGeneration !== openSessionGeneration
          ) {
            return;
          }

          const pasted = Object.fromEntries(Object.keys(adjustmentsToApply).map((key) => [key, persisted[key]]));
          setAdjustments((prev: any) => ({ ...prev, ...pasted }), t('contextMenus.editor.pasteAdjustments'));
        })
        .catch((err) => toast.error(`Failed to paste adjustments: ${err}`));

      setProcess({ isPasted: true });
    },
    [setAdjustments, t],
  );

  const handleZoomChange = useCallback((zoomValue: number, fitToWindow: boolean = false) => {
    const { originalSize, baseRenderSize, adjustments } = useEditorStore.getState();
    const dpr = getDevicePixelRatio();
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
    handleAutoStraighten,
    handleAutoStraightenPaths,
    handleLutSelect,
    setLutPreviewOverride,
    handleResetAdjustments,
    handleAutoLensCorrection,
    handleEnableAdjustments,
    handleCopyAdjustments,
    handlePasteAdjustments,
    handleZoomChange,
    toggleCompare,
    selectCompareMode,
  };
}

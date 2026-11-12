import { RefObject } from 'react';
import { create } from 'zustand';
import {
  Adjustments,
  INITIAL_ADJUSTMENTS,
  MaskContainer,
  AiPatch,
  CROP_GEOMETRY_KEYS,
  CropGeometry,
  pickCropGeometry,
} from '../utils/adjustments';
import { SelectedImage, WaveformData, BrushSettings, CompareView } from '../components/ui/AppProperties';
import { ChannelConfig } from '../components/adjustments/Curves';
import { ImageDimensions } from '../hooks/useImageRenderSize';
import { ToolType } from '../components/panel/right/Masks';
import { OverlayMode } from '../components/panel/right/CropPanel';
import { describeHistoryChange } from '../utils/editHistory';
import { HslMixerProperty } from '../utils/hslMixer';
import type { SpeedEditTarget } from '../components/ui/Slider';
import type { AdjustmentLoadContext } from '../types/imageLoading';
import {
  cancelPendingHistory,
  flushPendingHistory,
  restorePendingHistory,
  scheduleHistory,
  scheduleSave,
  suspendPendingHistory,
  type SuspendedHistoryToken,
} from '../services/editorPersistence';
import { adjustmentsForPersistence, markAdjustmentLoadDirty, structurallyEqual } from '../utils/rafCameraDefaults';

export type CenterMarker = 'vignette' | 'centre';

interface InteractivePatch {
  url: string;
  normX: number;
  normY: number;
  normW: number;
  normH: number;
}

interface BaseRenderSize extends ImageDimensions {
  containerHeight: number;
  containerWidth: number;
  offsetX: number;
  offsetY: number;
}

export type WgpuPhase = 'hidden' | 'arming' | 'live';

// Adjustment state may only change through the focused actions below, never through the generic setter.
type ProtectedEditorKey =
  | 'adjustments'
  | 'history'
  | 'historyLabels'
  | 'historyIndex'
  | 'adjustmentLoadContext'
  | 'adjustmentReloadSnapshot'
  | 'adjustmentLoadGeneration'
  | 'adjustmentSessionGeneration';

type EditorPatch = Omit<Partial<EditorState>, ProtectedEditorKey> & {
  [Key in ProtectedEditorKey]?: never;
};

export interface AdjustmentSessionSnapshot {
  adjustmentLoadContext: AdjustmentLoadContext | null;
  adjustmentLoadGeneration: number;
  adjustmentSessionGeneration: number;
  adjustments: Adjustments;
  history: Adjustments[];
  historyLabels: string[];
  historyIndex: number;
  reloadId: number;
  selectedImage: SelectedImage | null;
  suspendedHistory: SuspendedHistoryToken | null;
}

export interface ExplicitAdjustmentOptions {
  /** A labelled action gets its own history step instead of merging with pending slider edits. */
  label?: string;
}

interface EditorState {
  // Core Image & Adjustments
  selectedImage: SelectedImage | null;
  adjustments: Adjustments;
  adjustmentLoadContext: AdjustmentLoadContext | null;
  adjustmentLoadGeneration: number;
  adjustmentSessionGeneration: number;
  adjustmentReloadSnapshot: AdjustmentSessionSnapshot | null;
  previewOverride: Adjustments | null;

  // History State
  history: Adjustments[];
  historyLabels: string[];
  historyIndex: number;

  // Previews & Overlays
  finalPreviewUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  interactivePatch: InteractivePatch | null;
  showOriginal: boolean;
  compareView: CompareView;
  splitPosition: number;
  originalPreview: { path: string; url: string | null } | null;

  // Analytics
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  isWaveformVisible: boolean;
  activeWaveformChannel: string;
  waveformHeight: number;

  // Interaction State
  isSliderDragging: boolean;
  speedEditTarget: RefObject<SpeedEditTarget | null> | null;
  isSpeedEditActive: boolean;
  zoom: number;
  displaySize: ImageDimensions;
  baseRenderSize: BaseRenderSize;
  originalSize: ImageDimensions;

  // Tools State
  isRotationActive: boolean;
  overlayMode: OverlayMode;
  overlayRotation: number;
  isStraightenActive: boolean;
  isAutoStraightening: boolean;
  isWbPickerActive: boolean;
  isRelightPickerActive: boolean;
  activeRelightLightId: string | null;
  activeCenterMarker: CenterMarker | null;
  mixerPickerProperty: HslMixerProperty | null;
  isGuidedPerspectiveActive: boolean;
  liveRotation: number | null;
  cropSessionSnapshot: { path: string | null; geometry: CropGeometry } | null;
  brushSettings: BrushSettings | null;

  // Masks & AI
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  activeAiPatchContainerId: string | null;
  activeAiSubMaskId: string | null;
  isMaskControlHovered: boolean;
  isGeneratingAiMask: boolean;
  isGeneratingAi: boolean;
  aiDenoiseProgress: Record<string, number>;
  aiUpscaleProgress: Record<string, number>;
  isAIConnectorConnected: boolean;
  wgpuPhase: WgpuPhase;
  patchesSentToBackend: Set<string>;

  // Clipboard
  copiedSectionAdjustments: any | null;
  copiedMask: MaskContainer | null;
  copiedAdjustments: Adjustments | null;

  // Actions
  setEditor: (updater: EditorPatch | ((state: EditorState) => EditorPatch)) => void;
  pushHistory: (newAdjustments: Adjustments, label?: string) => void;
  /** Installs the provisional metadata-stage state of the current unready image. */
  beginAdjustmentLoad: (adjustments: Adjustments, context: AdjustmentLoadContext) => void;
  /** Atomically installs the reconciled state, its single-entry history, and readiness. */
  completeAdjustmentLoad: (
    adjustments: Adjustments,
    context: AdjustmentLoadContext,
    selectedImage: SelectedImage,
    dimensions: { originalSize: ImageDimensions },
  ) => boolean;
  /** Applies a user edit: marks a reconciled load dirty, schedules the save, and records history. */
  applyExplicitAdjustments: (value: Adjustments, options?: ExplicitAdjustmentOptions) => void;
  /** Applies an asynchronous backend result for the current image without recording a history step. */
  applyAsyncAdjustments: (path: string, update: (current: Adjustments) => Adjustments) => void;
  /** Makes the current image unready so the loader reloads backend-persisted adjustments. */
  beginAdjustmentReload: (path: string, suspendedHistory?: SuspendedHistoryToken | null) => AdjustmentSessionSnapshot;
  /** Installs a new unready image; only display data and provisional adjustments may be supplied. */
  beginImageSelection: (selectedImage: SelectedImage, provisionalAdjustments?: Adjustments) => void;
  restoreAdjustmentSession: (snapshot: AdjustmentSessionSnapshot) => void;
  clearEditorSession: () => void;
  undo: () => void;
  redo: () => void;
  goToHistoryIndex: (index: number) => void;
}

type CanvasToolState = Pick<
  EditorState,
  'isWbPickerActive' | 'isRelightPickerActive' | 'activeCenterMarker' | 'mixerPickerProperty'
>;

export const canvasToolState = (activeTool: Partial<CanvasToolState> = {}): CanvasToolState => ({
  isWbPickerActive: false,
  isRelightPickerActive: false,
  activeCenterMarker: null,
  mixerPickerProperty: null,
  ...activeTool,
});

const clone = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) as T;
  }
  return value;
};

const emptyAdjustments = () => clone(INITIAL_ADJUSTMENTS);
const LOAD_GENERATION_KEY = '__rapidrawEditorLoadGeneration';
type GenerationContext = AdjustmentLoadContext & { [LOAD_GENERATION_KEY]?: number };
let nextReloadId = 0;

const contextGeneration = (context: AdjustmentLoadContext): number | undefined =>
  (context as GenerationContext)[LOAD_GENERATION_KEY];

// Marking dirty clones the context, so an already-dirty load keeps its object during slider drags.
const markExplicitEdit = (context: AdjustmentLoadContext | null): AdjustmentLoadContext | null =>
  context?.reconciled && !context.dirty ? markAdjustmentLoadDirty(context) : context;

// Like upstream, nothing is written while a slider drag is in progress; the settled value is saved when it ends.
const scheduleAdjustmentPersistence = (state: EditorState) => {
  if (!state.selectedImage?.isReady || state.isSliderDragging) return;
  const persisted = adjustmentsForPersistence(state.adjustmentLoadContext, state.adjustments);
  if (persisted !== undefined) scheduleSave(state.selectedImage.path, persisted);
};

const CROP_GEOMETRY_KEY_SET = new Set<string>(CROP_GEOMETRY_KEYS);

/**
 * Edits made while the image was still loading survive its authoritative baseline, as they did before camera
 * defaults existed. Crop geometry is never carried over: it was expressed against the provisional framing.
 */
const carryLoadingEdits = (
  provisional: Adjustments | undefined,
  current: Adjustments,
  reconciled: Adjustments,
): Adjustments | null => {
  if (!provisional || current === provisional) return null;
  const carried: Record<string, unknown> = {};
  for (const key of Object.keys(current)) {
    if (CROP_GEOMETRY_KEY_SET.has(key) || structurallyEqual(current[key], provisional[key])) continue;
    carried[key] = clone(current[key]);
  }
  return Object.keys(carried).length > 0 ? ({ ...reconciled, ...carried } as Adjustments) : null;
};

const reseedCropSession = (state: EditorState, path: string | null, adjustments: Adjustments) =>
  state.cropSessionSnapshot ? { cropSessionSnapshot: { path, geometry: pickCropGeometry(adjustments) } } : {};

const freezeGraph = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach((entry) => freezeGraph(entry));
    Object.freeze(value);
  }
  return value;
};

export const useEditorStore = create<EditorState>((set, get) => ({
  selectedImage: null,
  adjustments: emptyAdjustments(),
  adjustmentLoadContext: null,
  adjustmentLoadGeneration: 0,
  adjustmentSessionGeneration: 0,
  adjustmentReloadSnapshot: null,
  previewOverride: null,
  history: [],
  historyLabels: [],
  historyIndex: -1,

  finalPreviewUrl: null,
  uncroppedAdjustedPreviewUrl: null,
  showOriginal: false,
  compareView: 'off',
  splitPosition: 0.5,
  originalPreview: null,
  histogram: null,
  waveform: null,
  isWaveformVisible: false,
  activeWaveformChannel: 'luma',
  waveformHeight: 220,

  isSliderDragging: false,
  speedEditTarget: null,
  isSpeedEditActive: false,
  interactivePatch: null,
  activeMaskContainerId: null,
  activeMaskId: null,
  activeAiPatchContainerId: null,
  activeAiSubMaskId: null,

  zoom: 1,
  displaySize: { width: 0, height: 0 },
  baseRenderSize: { width: 0, height: 0, offsetX: 0, offsetY: 0, containerWidth: 0, containerHeight: 0 },
  originalSize: { width: 0, height: 0 },

  isRotationActive: false,
  overlayMode: 'thirds',
  overlayRotation: 0,
  isStraightenActive: false,
  isAutoStraightening: false,
  isWbPickerActive: false,
  isRelightPickerActive: false,
  activeRelightLightId: null,
  activeCenterMarker: null,
  mixerPickerProperty: null,
  isGuidedPerspectiveActive: false,
  liveRotation: null,
  cropSessionSnapshot: null,

  copiedSectionAdjustments: null,
  copiedMask: null,
  brushSettings: { size: 100, feather: 50, tool: ToolType.Brush },
  copiedAdjustments: null,

  isGeneratingAiMask: false,
  isAIConnectorConnected: false,
  isGeneratingAi: false,
  aiDenoiseProgress: {},
  aiUpscaleProgress: {},
  isMaskControlHovered: false,
  wgpuPhase: 'hidden',
  patchesSentToBackend: new Set<string>(),

  setEditor: (updater) => {
    const wasSliderDragging = get().isSliderDragging;
    set((state) => (typeof updater === 'function' ? updater(state) : updater));
    if (wasSliderDragging && !get().isSliderDragging) scheduleAdjustmentPersistence(get());
  },

  pushHistory: (newAdj, label) =>
    set((state) => {
      const previous = state.history[state.historyIndex];
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      const newLabels = state.historyLabels.slice(0, state.historyIndex + 1);
      newLabels.push(label || (previous ? describeHistoryChange(previous, newAdj) : ''));
      newHistory.push(newAdj);
      if (newHistory.length > 50) {
        newHistory.shift();
        newLabels.shift();
      }
      return { history: newHistory, historyLabels: newLabels, historyIndex: newHistory.length - 1 };
    }),

  beginAdjustmentLoad: (adjustments, context) => {
    const state = get();
    if (!state.selectedImage || state.selectedImage.isReady) return;
    cancelPendingHistory();
    const nextAdjustments = clone(adjustments);
    const generation = state.adjustmentLoadGeneration + 1;
    const nextContext: GenerationContext = {
      ...clone(context),
      dirty: false,
      reconciled: false,
      sourceKind: null,
      [LOAD_GENERATION_KEY]: generation,
    };
    set({
      adjustments: nextAdjustments,
      adjustmentLoadContext: nextContext,
      adjustmentLoadGeneration: generation,
      history: [nextAdjustments],
      historyLabels: [''],
      historyIndex: 0,
    });
  },

  completeAdjustmentLoad: (adjustments, context, selectedImage, dimensions) => {
    const current = get();
    const currentImage = current.selectedImage;
    if (
      currentImage?.path !== selectedImage.path ||
      currentImage.isReady ||
      !context.reconciled ||
      context.sourceKind === null ||
      contextGeneration(context) !== current.adjustmentLoadGeneration
    ) {
      return false;
    }

    cancelPendingHistory();
    const nextAdjustments = clone(adjustments);
    let completed = false;
    let carriedEdits = false;
    set((state) => {
      if (
        state.selectedImage?.path !== selectedImage.path ||
        state.selectedImage.isReady ||
        contextGeneration(context) !== state.adjustmentLoadGeneration
      ) {
        return {};
      }
      completed = true;
      const baselineContext = { ...clone(context), dirty: false };
      const carried = carryLoadingEdits(state.history[0], state.adjustments, nextAdjustments);
      carriedEdits = carried !== null;
      const nextContext = carried ? markAdjustmentLoadDirty(baselineContext) : baselineContext;
      const finalAdjustments = carried ?? nextAdjustments;
      // Display placeholders stay visible until the first render of the reconciled state replaces them.
      return {
        adjustments: finalAdjustments,
        adjustmentLoadContext: nextContext,
        adjustmentLoadGeneration: state.adjustmentLoadGeneration + 1,
        adjustmentReloadSnapshot: null,
        history: carried ? [nextAdjustments, carried] : [nextAdjustments],
        historyLabels: carried ? ['', describeHistoryChange(nextAdjustments, carried)] : [''],
        historyIndex: carried ? 1 : 0,
        originalSize: clone(dimensions.originalSize),
        selectedImage: {
          ...state.selectedImage,
          ...clone(selectedImage),
          isReady: true,
          sourceKind: nextContext.sourceKind,
        },
        ...reseedCropSession(state, selectedImage.path, finalAdjustments),
      };
    });
    if (carriedEdits) scheduleAdjustmentPersistence(get());
    return completed;
  },

  applyExplicitAdjustments: (value, options = {}) => {
    const state = get();
    if (value === state.adjustments) return;
    const { label } = options;
    if (label) flushPendingHistory();
    const sessionGeneration = state.adjustmentSessionGeneration;
    set((current) => ({
      adjustments: value,
      adjustmentLoadContext: markExplicitEdit(current.adjustmentLoadContext),
      ...(current.showOriginal ? { showOriginal: false, previewOverride: null } : {}),
    }));
    scheduleAdjustmentPersistence(get());
    scheduleHistory(value, (entry) => {
      const active = useEditorStore.getState();
      if (active.adjustmentSessionGeneration === sessionGeneration) active.pushHistory(entry, label);
    });
    if (label) flushPendingHistory();
  },

  applyAsyncAdjustments: (path, update) => {
    const state = get();
    if (state.selectedImage?.path !== path) return;
    const next = update(state.adjustments);
    if (next === state.adjustments) return;
    // A result that changes persisted content is saved like an edit; a pure refresh only re-renders.
    const changesContent = !structurallyEqual(next, state.adjustments);
    set((current) => ({
      adjustments: next,
      ...(changesContent ? { adjustmentLoadContext: markExplicitEdit(current.adjustmentLoadContext) } : {}),
    }));
    if (changesContent) scheduleAdjustmentPersistence(get());
  },

  beginAdjustmentReload: (path, providedHistory) => {
    const state = get();
    if (state.selectedImage?.path !== path || !state.selectedImage.isReady || state.adjustmentReloadSnapshot !== null) {
      if (state.adjustmentReloadSnapshot) return clone(state.adjustmentReloadSnapshot);
      return {
        adjustmentLoadContext: clone(state.adjustmentLoadContext),
        adjustmentLoadGeneration: state.adjustmentLoadGeneration,
        adjustmentSessionGeneration: state.adjustmentSessionGeneration,
        adjustments: clone(state.adjustments),
        history: clone(state.history),
        historyLabels: [...state.historyLabels],
        historyIndex: state.historyIndex,
        reloadId: 0,
        selectedImage: clone(state.selectedImage),
        suspendedHistory: null,
      };
    }

    const currentHistory = suspendPendingHistory();
    const suspendedHistory =
      currentHistory && (!providedHistory || currentHistory.generation >= providedHistory.generation)
        ? currentHistory
        : (providedHistory ?? null);
    const snapshot: AdjustmentSessionSnapshot = freezeGraph({
      adjustmentLoadContext: clone(state.adjustmentLoadContext),
      adjustmentLoadGeneration: state.adjustmentLoadGeneration,
      adjustmentSessionGeneration: state.adjustmentSessionGeneration,
      adjustments: clone(state.adjustments),
      history: clone(state.history),
      historyLabels: [...state.historyLabels],
      historyIndex: state.historyIndex,
      reloadId: ++nextReloadId,
      selectedImage: clone(state.selectedImage),
      suspendedHistory,
    });

    set({
      adjustmentLoadContext: null,
      adjustmentLoadGeneration: state.adjustmentLoadGeneration + 1,
      adjustmentSessionGeneration: state.adjustmentSessionGeneration + 1,
      adjustmentReloadSnapshot: snapshot,
      history: [],
      historyLabels: [],
      historyIndex: -1,
      selectedImage: {
        ...state.selectedImage,
        isReady: false,
        sourceKind: null,
      },
    });
    return clone(snapshot);
  },

  beginImageSelection: (selectedImage, provisionalAdjustments) => {
    cancelPendingHistory();
    set((state) => ({
      adjustments: provisionalAdjustments ? clone(provisionalAdjustments) : emptyAdjustments(),
      adjustmentLoadContext: null,
      adjustmentLoadGeneration: state.adjustmentLoadGeneration + 1,
      adjustmentSessionGeneration: state.adjustmentSessionGeneration + 1,
      adjustmentReloadSnapshot: null,
      history: [],
      historyLabels: [],
      historyIndex: -1,
      selectedImage: {
        ...clone(selectedImage),
        isReady: false,
        sourceKind: null,
      },
    }));
  },

  restoreAdjustmentSession: (snapshot) => {
    const state = get();
    const activeSnapshot = state.adjustmentReloadSnapshot;
    if (!activeSnapshot || activeSnapshot.reloadId !== snapshot.reloadId) return;
    const restoredSessionGeneration =
      Math.max(state.adjustmentSessionGeneration, activeSnapshot.adjustmentSessionGeneration) + 1;
    const restoredAdjustments = clone(activeSnapshot.adjustments);
    set({
      adjustmentLoadContext: clone(activeSnapshot.adjustmentLoadContext),
      adjustmentLoadGeneration: Math.max(state.adjustmentLoadGeneration, activeSnapshot.adjustmentLoadGeneration) + 1,
      adjustmentSessionGeneration: restoredSessionGeneration,
      adjustmentReloadSnapshot: null,
      adjustments: restoredAdjustments,
      history: clone(activeSnapshot.history),
      historyLabels: [...activeSnapshot.historyLabels],
      historyIndex: activeSnapshot.historyIndex,
      selectedImage: clone(activeSnapshot.selectedImage),
      ...reseedCropSession(state, activeSnapshot.selectedImage?.path ?? null, restoredAdjustments),
    });
    restorePendingHistory(activeSnapshot.suspendedHistory, (entry) => {
      const active = useEditorStore.getState();
      if (active.adjustmentSessionGeneration === restoredSessionGeneration) active.pushHistory(entry);
    });
  },

  clearEditorSession: () => {
    cancelPendingHistory();
    set((state) => ({
      selectedImage: null,
      adjustments: emptyAdjustments(),
      adjustmentLoadContext: null,
      adjustmentLoadGeneration: state.adjustmentLoadGeneration + 1,
      adjustmentSessionGeneration: state.adjustmentSessionGeneration + 1,
      adjustmentReloadSnapshot: null,
      history: [],
      historyLabels: [],
      historyIndex: -1,
      previewOverride: null,
      finalPreviewUrl: null,
      uncroppedAdjustedPreviewUrl: null,
      interactivePatch: null,
      histogram: null,
      waveform: null,
      activeMaskContainerId: null,
      activeMaskId: null,
      activeAiPatchContainerId: null,
      activeAiSubMaskId: null,
      ...canvasToolState(),
      activeRelightLightId: null,
      patchesSentToBackend: new Set<string>(),
    }));
  },

  // Undo, redo, and history navigation are explicit user actions: a reconciled load becomes dirty, and the
  // pending slider snapshot is committed first so it stays reachable through redo.
  undo: () => {
    flushPendingHistory();
    let didChange = false;
    set((state) => {
      if (state.historyIndex > 0) {
        didChange = true;
        const newIndex = state.historyIndex - 1;
        return {
          historyIndex: newIndex,
          adjustments: state.history[newIndex],
          adjustmentLoadContext: markExplicitEdit(state.adjustmentLoadContext),
        };
      }
      return {};
    });
    if (didChange) scheduleAdjustmentPersistence(get());
  },

  redo: () => {
    flushPendingHistory();
    let didChange = false;
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        didChange = true;
        const newIndex = state.historyIndex + 1;
        return {
          historyIndex: newIndex,
          adjustments: state.history[newIndex],
          adjustmentLoadContext: markExplicitEdit(state.adjustmentLoadContext),
        };
      }
      return {};
    });
    if (didChange) scheduleAdjustmentPersistence(get());
  },

  goToHistoryIndex: (index) => {
    flushPendingHistory();
    let didChange = false;
    set((state) => {
      if (index >= 0 && index < state.history.length) {
        didChange = true;
        return {
          historyIndex: index,
          adjustments: state.history[index],
          adjustmentLoadContext: markExplicitEdit(state.adjustmentLoadContext),
        };
      }
      return {};
    });
    if (didChange) scheduleAdjustmentPersistence(get());
  },
}));

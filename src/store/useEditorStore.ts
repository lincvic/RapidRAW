import { create } from 'zustand';
import { Adjustments, INITIAL_ADJUSTMENTS, MaskContainer, AiPatch } from '../utils/adjustments';
import { SelectedImage, WaveformData, BrushSettings } from '../components/ui/AppProperties';
import { ChannelConfig } from '../components/adjustments/Curves';
import { ImageDimensions } from '../hooks/useImageRenderSize';
import { ToolType } from '../components/panel/right/Masks';
import { OverlayMode } from '../components/panel/right/CropPanel';
import type { AdjustmentLoadContext } from '../types/imageLoading';
import {
  cancelPendingHistory,
  restorePendingHistory,
  scheduleHistory,
  scheduleSave,
  suspendPendingHistory,
  type SuspendedHistoryToken,
} from '../services/editorPersistence';
import { adjustmentsForPersistence, markAdjustmentLoadDirty } from '../utils/rafCameraDefaults';

export interface InteractivePatch {
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

type ProtectedEditorKey =
  | 'adjustments'
  | 'history'
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
  historyIndex: number;
  reloadId: number;
  selectedImage: SelectedImage | null;
  suspendedHistory: SuspendedHistoryToken | null;
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
  historyIndex: number;

  // Previews & Overlays
  finalPreviewUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  transformedOriginalUrl: string | null;
  interactivePatch: InteractivePatch | null;
  showOriginal: boolean;

  // Analytics
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  isWaveformVisible: boolean;
  activeWaveformChannel: string;
  waveformHeight: number;

  // Interaction State
  isSliderDragging: boolean;
  zoom: number;
  displaySize: ImageDimensions;
  previewSize: ImageDimensions;
  baseRenderSize: BaseRenderSize;
  originalSize: ImageDimensions;

  // Tools State
  isRotationActive: boolean;
  overlayMode: OverlayMode;
  overlayRotation: number;
  isStraightenActive: boolean;
  isWbPickerActive: boolean;
  liveRotation: number | null;
  brushSettings: BrushSettings | null;

  // Masks & AI
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  activeAiPatchContainerId: string | null;
  activeAiSubMaskId: string | null;
  isMaskControlHovered: boolean;
  isGeneratingAiMask: boolean;
  isGeneratingAi: boolean;
  isAIConnectorConnected: boolean;
  hasRenderedFirstFrame: boolean;
  patchesSentToBackend: Set<string>;

  // Clipboard
  copiedSectionAdjustments: any | null;
  copiedMask: MaskContainer | null;
  copiedAdjustments: Adjustments | null;

  // Actions
  setEditor: (updater: EditorPatch | ((state: EditorState) => EditorPatch)) => void;
  pushHistory: (newAdjustments: Adjustments) => void;
  beginAdjustmentLoad: (adjustments: Adjustments, context: AdjustmentLoadContext) => void;
  completeAdjustmentLoad: (
    adjustments: Adjustments,
    context: AdjustmentLoadContext,
    selectedImage: SelectedImage,
    dimensions: {
      originalSize: ImageDimensions;
      previewSize: ImageDimensions;
    },
  ) => {
    finalPreviewUrl: string | null;
    uncroppedPreviewUrl: string | null;
  } | null;
  applyExplicitAdjustments: (value: Adjustments) => void;
  beginAdjustmentReload: (path: string, suspendedHistory?: SuspendedHistoryToken | null) => AdjustmentSessionSnapshot;
  beginImageSelection: (selectedImage: SelectedImage) => void;
  restoreAdjustmentSession: (snapshot: AdjustmentSessionSnapshot) => void;
  clearEditorSession: () => void;
  undo: () => void;
  redo: () => void;
  goToHistoryIndex: (index: number) => void;
}

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

const scheduleAdjustmentPersistence = (state: EditorState) => {
  if (!state.selectedImage?.isReady) return;
  const persisted = adjustmentsForPersistence(state.adjustmentLoadContext, state.adjustments);
  if (persisted !== undefined) scheduleSave(state.selectedImage.path, persisted);
};

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
  historyIndex: -1,

  finalPreviewUrl: null,
  uncroppedAdjustedPreviewUrl: null,
  showOriginal: false,
  histogram: null,
  waveform: null,
  isWaveformVisible: false,
  activeWaveformChannel: 'luma',
  waveformHeight: 220,

  isSliderDragging: false,
  interactivePatch: null,
  activeMaskContainerId: null,
  activeMaskId: null,
  activeAiPatchContainerId: null,
  activeAiSubMaskId: null,

  zoom: 1,
  displaySize: { width: 0, height: 0 },
  previewSize: { width: 0, height: 0 },
  baseRenderSize: { width: 0, height: 0, offsetX: 0, offsetY: 0, containerWidth: 0, containerHeight: 0 },
  originalSize: { width: 0, height: 0 },

  isRotationActive: false,
  overlayMode: 'thirds',
  overlayRotation: 0,
  transformedOriginalUrl: null,
  isStraightenActive: false,
  isWbPickerActive: false,
  liveRotation: null,

  copiedSectionAdjustments: null,
  copiedMask: null,
  brushSettings: { size: 50, feather: 50, tool: ToolType.Brush },
  copiedAdjustments: null,

  isGeneratingAiMask: false,
  isAIConnectorConnected: false,
  isGeneratingAi: false,
  isMaskControlHovered: false,
  hasRenderedFirstFrame: false,
  patchesSentToBackend: new Set<string>(),

  setEditor: (updater) => set((state) => (typeof updater === 'function' ? updater(state) : updater)),

  pushHistory: (newAdj) =>
    set((state) => {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(clone(newAdj));
      if (newHistory.length > 50) newHistory.shift();
      return { history: newHistory, historyIndex: newHistory.length - 1 };
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
      history: [clone(nextAdjustments)],
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
      return null;
    }

    cancelPendingHistory();
    const nextAdjustments = clone(adjustments);
    let retiredPreviews: { finalPreviewUrl: string | null; uncroppedPreviewUrl: string | null } | null = null;
    set((state) => {
      if (
        state.selectedImage?.path !== selectedImage.path ||
        state.selectedImage.isReady ||
        contextGeneration(context) !== state.adjustmentLoadGeneration
      ) {
        return {};
      }
      const nextContext = { ...clone(context), dirty: false };
      retiredPreviews = {
        finalPreviewUrl: state.finalPreviewUrl,
        uncroppedPreviewUrl: state.uncroppedAdjustedPreviewUrl,
      };
      return {
        adjustments: nextAdjustments,
        adjustmentLoadContext: nextContext,
        adjustmentLoadGeneration: state.adjustmentLoadGeneration + 1,
        adjustmentReloadSnapshot: null,
        history: [clone(nextAdjustments)],
        historyIndex: 0,
        finalPreviewUrl: null,
        uncroppedAdjustedPreviewUrl: null,
        histogram: null,
        waveform: null,
        hasRenderedFirstFrame: false,
        originalSize: clone(dimensions.originalSize),
        previewSize: clone(dimensions.previewSize),
        selectedImage: {
          ...state.selectedImage,
          ...clone(selectedImage),
          isReady: true,
          sourceKind: nextContext.sourceKind,
        },
      };
    });
    return retiredPreviews;
  },

  applyExplicitAdjustments: (value) => {
    const sessionGeneration = get().adjustmentSessionGeneration;
    const nextAdjustments = clone(value);
    set((state) => ({
      adjustments: nextAdjustments,
      adjustmentLoadContext: state.adjustmentLoadContext?.reconciled
        ? markAdjustmentLoadDirty(state.adjustmentLoadContext)
        : state.adjustmentLoadContext,
    }));
    scheduleAdjustmentPersistence(get());
    scheduleHistory(nextAdjustments, (entry) => {
      const active = useEditorStore.getState();
      if (active.adjustmentSessionGeneration === sessionGeneration) active.pushHistory(entry);
    });
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
      historyIndex: -1,
      selectedImage: {
        ...state.selectedImage,
        isReady: false,
        sourceKind: null,
      },
    });
    return clone(snapshot);
  },

  beginImageSelection: (selectedImage) => {
    cancelPendingHistory();
    set((state) => ({
      adjustments: emptyAdjustments(),
      adjustmentLoadContext: null,
      adjustmentLoadGeneration: state.adjustmentLoadGeneration + 1,
      adjustmentSessionGeneration: state.adjustmentSessionGeneration + 1,
      adjustmentReloadSnapshot: null,
      history: [],
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
    restorePendingHistory(activeSnapshot.suspendedHistory);
    set({
      adjustmentLoadContext: clone(activeSnapshot.adjustmentLoadContext),
      adjustmentLoadGeneration: Math.max(state.adjustmentLoadGeneration, activeSnapshot.adjustmentLoadGeneration) + 1,
      adjustmentSessionGeneration: activeSnapshot.adjustmentSessionGeneration,
      adjustmentReloadSnapshot: null,
      adjustments: clone(activeSnapshot.adjustments),
      history: clone(activeSnapshot.history),
      historyIndex: activeSnapshot.historyIndex,
      selectedImage: clone(activeSnapshot.selectedImage),
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
      historyIndex: -1,
      previewOverride: null,
      finalPreviewUrl: null,
      uncroppedAdjustedPreviewUrl: null,
      transformedOriginalUrl: null,
      interactivePatch: null,
      histogram: null,
      waveform: null,
      activeMaskContainerId: null,
      activeMaskId: null,
      activeAiPatchContainerId: null,
      activeAiSubMaskId: null,
      isWbPickerActive: false,
      hasRenderedFirstFrame: false,
      zoom: 1,
      patchesSentToBackend: new Set<string>(),
    }));
  },

  undo: () => {
    const pendingHistory = suspendPendingHistory();
    let didChange = false;
    set((state) => {
      if (pendingHistory && state.historyIndex >= 0 && state.historyIndex < state.history.length) {
        didChange = true;
        return {
          adjustments: clone(state.history[state.historyIndex]),
          adjustmentLoadContext: state.adjustmentLoadContext?.reconciled
            ? markAdjustmentLoadDirty(state.adjustmentLoadContext)
            : state.adjustmentLoadContext,
        };
      }
      if (state.historyIndex > 0) {
        didChange = true;
        const newIndex = state.historyIndex - 1;
        return {
          historyIndex: newIndex,
          adjustments: clone(state.history[newIndex]),
          adjustmentLoadContext: state.adjustmentLoadContext?.reconciled
            ? markAdjustmentLoadDirty(state.adjustmentLoadContext)
            : state.adjustmentLoadContext,
        };
      }
      return {};
    });
    if (didChange) scheduleAdjustmentPersistence(get());
  },

  redo: () => {
    cancelPendingHistory();
    let didChange = false;
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        didChange = true;
        const newIndex = state.historyIndex + 1;
        return {
          historyIndex: newIndex,
          adjustments: clone(state.history[newIndex]),
          adjustmentLoadContext: state.adjustmentLoadContext?.reconciled
            ? markAdjustmentLoadDirty(state.adjustmentLoadContext)
            : state.adjustmentLoadContext,
        };
      }
      return {};
    });
    if (didChange) scheduleAdjustmentPersistence(get());
  },

  goToHistoryIndex: (index) => {
    cancelPendingHistory();
    let didChange = false;
    set((state) => {
      if (index >= 0 && index < state.history.length) {
        didChange = true;
        return {
          historyIndex: index,
          adjustments: clone(state.history[index]),
          adjustmentLoadContext: state.adjustmentLoadContext?.reconciled
            ? markAdjustmentLoadDirty(state.adjustmentLoadContext)
            : state.adjustmentLoadContext,
        };
      }
      return {};
    });
    if (didChange) scheduleAdjustmentPersistence(get());
  },
}));

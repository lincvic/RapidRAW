import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { exit } from '@tauri-apps/plugin-process';

import { useProcessStore, type ExternalEditSession } from '../store/useProcessStore';
import { useEditorStore } from '../store/useEditorStore';
import { Invokes } from '../components/ui/AppProperties';
import { ExportSettings, Status } from '../components/ui/ExportImportProperties';
import { flushPendingSave, runAfterEditorSave } from '../services/editorPersistence';
import {
  cancelInvalidatedExternalEditExport,
  createExternalEditOperationTracker,
  createExternalEditPreparationCoordinator,
  type ExternalEditExportToken,
  isReadyNavigationTarget,
  navigateAndWaitForReady,
  navigateExternalEditSource,
} from '../utils/asyncNavigation';

/**
 * Handles files handed to the app from outside (OS "open with" and the
 * external editor protocol: rapidraw --edit <file> --output <file>).
 * Opens the requested image in the editor and, for edit sessions, exports
 * the result to the caller-provided output path and exits the app.
 */
export function useExternalEditSession(handleImageSelect: (path: string) => Promise<boolean>) {
  const initialFileToOpen = useProcessStore((state) => state.initialFileToOpen);
  const externalEditSession = useProcessStore((state) => state.externalEditSession);
  const exportStatus = useProcessStore((state) => state.exportState.status);
  const selectedImage = useEditorStore((state) => state.selectedImage);
  const [isFinishing, setIsFinishing] = useState(false);
  const [preparedSession, setPreparedSession] = useState<{
    generation: number;
    session: ExternalEditSession;
  } | null>(null);
  const operationTrackerRef = useRef<ReturnType<typeof createExternalEditOperationTracker> | null>(null);
  if (operationTrackerRef.current === null) {
    operationTrackerRef.current = createExternalEditOperationTracker();
  }
  const operationTracker = operationTrackerRef.current;
  const preparationCoordinatorRef = useRef<ReturnType<typeof createExternalEditPreparationCoordinator> | null>(null);
  if (preparationCoordinatorRef.current === null) {
    preparationCoordinatorRef.current = createExternalEditPreparationCoordinator();
  }
  const preparationCoordinator = preparationCoordinatorRef.current;
  const dispatchResultsRef = useRef(new Map<ExternalEditExportToken, Promise<boolean>>());
  const sessionIdentityRef = useRef<{ generation: number; session: ExternalEditSession } | null>(null);
  const isExternalEditReady = Boolean(
    externalEditSession &&
    preparedSession?.session === externalEditSession &&
    operationTracker.isSessionPrepared(preparedSession.generation) &&
    isReadyNavigationTarget(externalEditSession.source, selectedImage),
  );

  const handleImageSelectRef = useRef(handleImageSelect);
  useEffect(() => {
    handleImageSelectRef.current = handleImageSelect;
  });

  useEffect(() => {
    if (!initialFileToOpen) return;
    let isEffectActive = true;
    const abortController = new AbortController();
    const isRequestActive = () =>
      isEffectActive &&
      !abortController.signal.aborted &&
      useProcessStore.getState().initialFileToOpen === initialFileToOpen;
    const navigateWhenReady = (path: string) =>
      navigateAndWaitForReady(
        path,
        handleImageSelectRef.current,
        () => useEditorStore.getState().selectedImage,
        (onChange) => useEditorStore.subscribe(onChange),
        isRequestActive,
        abortController.signal,
      );
    void navigateWhenReady(initialFileToOpen)
      .then((didOpen) => {
        if (!isRequestActive()) return;
        useProcessStore.getState().setProcess({ initialFileToOpen: null });
        if (!didOpen) console.error('Failed to open requested image: the image did not become ready.');
      })
      .catch((error) => {
        if (!isRequestActive()) return;
        useProcessStore.getState().setProcess({ initialFileToOpen: null });
        console.error('Failed to open requested image:', error);
      });
    return () => {
      isEffectActive = false;
      abortController.abort();
    };
  }, [initialFileToOpen]);

  useEffect(() => {
    const sessionStart = operationTracker.beginSession();
    sessionIdentityRef.current = externalEditSession
      ? { generation: sessionStart.generation, session: externalEditSession }
      : null;
    let isEffectActive = true;
    const abortController = new AbortController();
    setIsFinishing(false);
    setPreparedSession(null);

    const cancelInvalidatedExport = async () => {
      try {
        await cancelInvalidatedExternalEditExport(
          sessionStart,
          (token) => {
            const dispatchResult = dispatchResultsRef.current.get(token);
            if (!dispatchResult) throw new Error('Missing external edit export dispatch result.');
            return dispatchResult;
          },
          () => invoke(Invokes.CancelExport),
        );
        return true;
      } catch (error) {
        if (String(error).includes('No export task is currently running')) return true;
        if (isEffectActive) {
          useProcessStore.getState().setExportState({
            status: Status.Error,
            errorMessage: typeof error === 'string' ? error : 'Failed to cancel the previous external edit export.',
          });
        }
        return false;
      }
    };

    if (!externalEditSession) {
      void preparationCoordinator.prepare(
        cancelInvalidatedExport,
        async () => false,
        () => false,
      );
      return () => {
        isEffectActive = false;
        abortController.abort();
      };
    }

    const isRequestActive = () =>
      isEffectActive &&
      !abortController.signal.aborted &&
      operationTracker.isSessionCurrent(sessionStart.generation) &&
      sessionIdentityRef.current?.session === externalEditSession &&
      useProcessStore.getState().externalEditSession === externalEditSession;
    const navigateWhenReady = (path: string) =>
      navigateAndWaitForReady(
        path,
        handleImageSelectRef.current,
        () => useEditorStore.getState().selectedImage,
        (onChange) => useEditorStore.subscribe(onChange),
        isRequestActive,
        abortController.signal,
      );
    void preparationCoordinator
      .prepare(
        cancelInvalidatedExport,
        () =>
          navigateExternalEditSource(externalEditSession.source, navigateWhenReady, isRequestActive, (errorMessage) => {
            useProcessStore.getState().setExportState({
              status: Status.Error,
              errorMessage,
            });
          }),
        isRequestActive,
      )
      .then((isPrepared) => {
        if (!isRequestActive()) return;
        if (!isPrepared || !operationTracker.markSessionPrepared(sessionStart.generation)) {
          if (useProcessStore.getState().exportState.status !== Status.Error) {
            useProcessStore.getState().setExportState({
              status: Status.Error,
              errorMessage: 'Could not prepare the external edit source.',
            });
          }
          return;
        }
        setPreparedSession({ generation: sessionStart.generation, session: externalEditSession });
      });
    return () => {
      isEffectActive = false;
      abortController.abort();
    };
  }, [externalEditSession, operationTracker, preparationCoordinator]);

  useEffect(() => {
    if (!isFinishing) return;
    const exportOperation = operationTracker.currentExport();
    const sessionIdentity = sessionIdentityRef.current;
    if (
      !exportOperation ||
      !sessionIdentity ||
      exportOperation.sessionGeneration !== sessionIdentity.generation ||
      useProcessStore.getState().externalEditSession !== sessionIdentity.session
    ) {
      return;
    }

    if (exportStatus === Status.Success) {
      operationTracker.commitExportCompletionIfCurrent(exportOperation, () => {
        const selectedImage = useEditorStore.getState().selectedImage;
        if (!isReadyNavigationTarget(sessionIdentity.session.source, selectedImage)) {
          operationTracker.finishExport(exportOperation);
          setIsFinishing(false);
          useProcessStore.getState().setExportState({
            status: Status.Error,
            errorMessage: 'The external edit source is not ready.',
          });
          return;
        }

        // Backend export events carry no operation id. The local token plus cancellation on
        // session replacement is the strongest correlation available at this boundary.
        void runAfterEditorSave(selectedImage.path, async () => {
          if (!operationTracker.isExportCurrent(exportOperation)) return;
          const latestSession = useProcessStore.getState().externalEditSession;
          const latestImage = useEditorStore.getState().selectedImage;
          if (
            latestSession !== sessionIdentity.session ||
            !isReadyNavigationTarget(sessionIdentity.session.source, latestImage)
          ) {
            operationTracker.finishExport(exportOperation);
            setIsFinishing(false);
            useProcessStore.getState().setExportState({
              status: Status.Error,
              errorMessage: 'The external edit source is not ready.',
            });
            return;
          }
          await exit(0);
        })
          .then(() => {
            if (operationTracker.finishExport(exportOperation)) setIsFinishing(false);
          })
          .catch((error) => {
            if (!operationTracker.finishExport(exportOperation)) return;
            setIsFinishing(false);
            useProcessStore.getState().setExportState({
              status: Status.Error,
              errorMessage: typeof error === 'string' ? error : 'Failed to save changes before exit.',
            });
          });
      });
    } else if (exportStatus === Status.Error || exportStatus === Status.Cancelled) {
      operationTracker.commitExportCompletionIfCurrent(exportOperation, () => {
        if (operationTracker.finishExport(exportOperation)) setIsFinishing(false);
      });
    }
  }, [isFinishing, exportStatus, operationTracker]);

  const finishExternalEdit = useCallback(async () => {
    const sessionIdentity = sessionIdentityRef.current;
    const session = useProcessStore.getState().externalEditSession;
    const selectedImage = useEditorStore.getState().selectedImage;
    if (!session || sessionIdentity?.session !== session) return;
    if (
      preparedSession?.session !== session ||
      preparedSession.generation !== sessionIdentity.generation ||
      !operationTracker.isSessionPrepared(sessionIdentity.generation) ||
      !isReadyNavigationTarget(session.source, selectedImage)
    ) {
      useProcessStore.getState().setExportState({
        status: Status.Error,
        errorMessage: 'The external edit source is not ready.',
      });
      return;
    }
    const exportOperation = operationTracker.beginExport(sessionIdentity.generation);
    if (!exportOperation) return;

    operationTracker.commitExportIfCurrent(exportOperation, () => {
      useProcessStore.getState().setExportState({
        status: Status.Exporting,
        progress: { current: 0, total: 1 },
        errorMessage: '',
      });
      setIsFinishing(true);
    });
    const exportSettings: ExportSettings = {
      filenameTemplate: null,
      jpegQuality: session.jpegQuality,
      keepMetadata: true,
      preserveTimestamps: false,
      preserveFolders: false,
      resize: null,
      stripGps: false,
      exportMasks: false,
      watermark: null,
    };

    try {
      await flushPendingSave(selectedImage.path);
      if (!operationTracker.isExportCurrent(exportOperation)) return;
      const activeSession = useProcessStore.getState().externalEditSession;
      const activeEditor = useEditorStore.getState();
      if (activeSession !== session || !isReadyNavigationTarget(session.source, activeEditor.selectedImage)) {
        operationTracker.finishExport(exportOperation);
        setIsFinishing(false);
        useProcessStore.getState().setExportState({
          status: Status.Error,
          errorMessage: 'The external edit source is not ready.',
        });
        return;
      }

      let resolveDispatch!: (accepted: boolean) => void;
      const dispatchResult = new Promise<boolean>((resolve) => {
        resolveDispatch = resolve;
      });
      dispatchResultsRef.current.set(exportOperation, dispatchResult);
      if (!operationTracker.markExportDispatchStarted(exportOperation)) {
        resolveDispatch(false);
        dispatchResultsRef.current.delete(exportOperation);
        return;
      }
      try {
        await invoke(Invokes.ExportImages, {
          paths: [session.source],
          outputFolderOrFile: session.output,
          isExplicitFilePath: true,
          baseOriginFolders: [],
          exportSettings,
          outputFormat: session.format,
          currentEditPath: activeEditor.selectedImage.path,
          currentEditAdjustments: activeEditor.adjustments || null,
        });
        resolveDispatch(true);
      } catch (error) {
        resolveDispatch(false);
        throw error;
      } finally {
        dispatchResultsRef.current.delete(exportOperation);
      }
      if (!operationTracker.markExportDispatched(exportOperation)) return;
      useProcessStore.getState().setExportState({ status: Status.Exporting });
    } catch (error) {
      if (!operationTracker.finishExport(exportOperation)) return;
      setIsFinishing(false);
      useProcessStore.getState().setExportState({
        status: Status.Error,
        errorMessage: typeof error === 'string' ? error : 'Export failed',
      });
    }
  }, [operationTracker, preparedSession]);

  return { externalEditSession, isExternalEditReady, isFinishing, finishExternalEdit };
}

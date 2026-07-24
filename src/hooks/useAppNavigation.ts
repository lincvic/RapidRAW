import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { homeDir } from '@tauri-apps/api/path';
import { toast } from 'react-toastify';
import { useLibraryStore } from '../store/useLibraryStore';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useProcessStore } from '../store/useProcessStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Invokes, LibraryViewMode, ImageFile } from '../components/ui/AppProperties';
import { createCachedEditorPlaceholder, globalImageCache, type ImageCacheEntry } from '../utils/ImageLRUCache';
import { runEditorTransition } from '../services/editorPersistence';
import {
  createEditorNavigationTransitions,
  createNavigationIntentTracker,
  invalidatePendingPreviewJobs,
  isCurrentEditorSession,
} from '../utils/asyncNavigation';

export interface AppNavigationProps {
  clearThumbnailQueue: () => void;
  refs: {
    transformWrapperRef: React.RefObject<any>;
    preloadedDataRef: React.RefObject<any>;
    cachedEditStateRef: React.RefObject<ImageCacheEntry | null>;
    selectedImagePathRef: React.RefObject<string | null>;
    latestRenderedJobIdRef: React.RefObject<number>;
    previewJobIdRef: React.RefObject<number>;
    currentResRef: React.RefObject<number>;
  };
}

const getCurrentEditorSession = () => {
  const state = useEditorStore.getState();
  return {
    generation: state.adjustmentSessionGeneration,
    path: state.selectedImage?.path ?? null,
  };
};

export function useAppNavigation({ clearThumbnailQueue, refs }: AppNavigationProps) {
  const navigationGenerationRef = useRef(0);
  const navigationIntentGenerationRef = useRef(0);
  const libraryNavigationGenerationRef = useRef(0);
  const {
    transformWrapperRef,
    preloadedDataRef,
    cachedEditStateRef,
    selectedImagePathRef,
    latestRenderedJobIdRef,
    previewJobIdRef,
    currentResRef,
  } = refs;
  const editorNavigationTransitionsRef = useRef<ReturnType<typeof createEditorNavigationTransitions> | null>(null);
  if (editorNavigationTransitionsRef.current === null) {
    editorNavigationTransitionsRef.current = createEditorNavigationTransitions({
      navigationGenerationRef,
      selectedImagePathRef,
      releaseEditorPreviews: () => {
        const { finalPreviewUrl, uncroppedAdjustedPreviewUrl } = useEditorStore.getState();
        globalImageCache.revokeWhenUnprotected(finalPreviewUrl);
        globalImageCache.revokeWhenUnprotected(uncroppedAdjustedPreviewUrl);
      },
      clearEditorSession: () => useEditorStore.getState().clearEditorSession(),
    });
  }
  const editorNavigationTransitions = editorNavigationTransitionsRef.current;
  const navigationIntentTrackerRef = useRef<ReturnType<typeof createNavigationIntentTracker> | null>(null);
  if (navigationIntentTrackerRef.current === null) {
    navigationIntentTrackerRef.current = createNavigationIntentTracker(navigationIntentGenerationRef);
  }
  const navigationIntentTracker = navigationIntentTrackerRef.current;
  const libraryNavigationTrackerRef = useRef<ReturnType<typeof createNavigationIntentTracker> | null>(null);
  if (libraryNavigationTrackerRef.current === null) {
    libraryNavigationTrackerRef.current = createNavigationIntentTracker(libraryNavigationGenerationRef);
  }
  const libraryNavigationTracker = libraryNavigationTrackerRef.current;

  const handleImageLoadFailure = useCallback(() => {
    navigationIntentTracker.begin();
    editorNavigationTransitions.clearForImageLoadFailure();
  }, [editorNavigationTransitions, navigationIntentTracker]);

  const handleGoHome = useCallback(() => {
    navigationIntentTracker.begin();
    libraryNavigationTracker.begin();
    useLibraryStore.getState().setLibrary({
      rootPaths: [],
      currentFolderPath: null,
      activeAlbumId: null,
      imageList: [],
      imageRatings: {},
      folderTrees: [],
      multiSelectedPaths: [],
      libraryActivePath: null,
      expandedFolders: new Set(),
      isViewLoading: false,
    });
    useUIStore.getState().setUI({ isLibraryExportPanelVisible: false });
  }, []);

  const handleBackToLibrary = useCallback(async (): Promise<boolean> => {
    const navigationIntent = navigationIntentTracker.begin();
    const { selectedImage } = useEditorStore.getState();
    const { setLibrary } = useLibraryStore.getState();
    const { setUI } = useUIStore.getState();
    const lastActivePath = selectedImage?.path ?? null;
    const interactivePatchUrl = useEditorStore.getState().interactivePatch?.url;

    try {
      let didNavigate = false;
      await runEditorTransition(
        selectedImage?.path,
        () => {
          if (selectedImage?.path && cachedEditStateRef.current?.selectedImage?.path === selectedImage.path) {
            globalImageCache.set(selectedImage.path, cachedEditStateRef.current);
          }
          if (transformWrapperRef.current) transformWrapperRef.current.resetTransform(0);
          if (interactivePatchUrl) URL.revokeObjectURL(interactivePatchUrl);
          editorNavigationTransitions.clearForBackToLibrary();
          setLibrary({ isViewLoading: false, libraryActivePath: lastActivePath });
          setUI({ slideDirection: 1 });
          didNavigate = true;
        },
        () => navigationIntentTracker.isCurrent(navigationIntent),
      );
      return didNavigate;
    } catch (error) {
      toast.error(`Failed to save changes: ${error}`);
      return false;
    }
  }, [refs]);

  const handleImageSelect = useCallback(
    async (path: string) => {
      const navigationIntent = navigationIntentTracker.begin();
      const { selectedImage } = useEditorStore.getState();

      if (selectedImage?.path === path) return true;

      let didSelect = false;
      const activePath = selectedImage?.path;

      try {
        await runEditorTransition(
          activePath,
          () => {
            const { selectedImage: currentImage, setEditor } = useEditorStore.getState();
            const { setLibrary, multiSelectedPaths } = useLibraryStore.getState();
            const { setUI } = useUIStore.getState();
            const previousFinalPreviewUrl = useEditorStore.getState().finalPreviewUrl;
            const previousUncroppedPreviewUrl = useEditorStore.getState().uncroppedAdjustedPreviewUrl;
            const cached = globalImageCache.takeForNavigation(
              path,
              currentImage?.path && cachedEditStateRef.current?.selectedImage.path === currentImage.path
                ? { key: currentImage.path, entry: cachedEditStateRef.current }
                : undefined,
            );
            editorNavigationTransitions.beginImageSelection(path);
            useEditorStore.getState().beginImageSelection({
              exif: null,
              height: 0,
              isRaw: false,
              isReady: false,
              metadata: null,
              originalUrl: null,
              path,
              sourceKind: null,
              thumbnailUrl: useProcessStore.getState().thumbnails[path] || cached?.selectedImage.thumbnailUrl || '',
              width: 0,
            });
            setEditor({
              originalSize: { width: 0, height: 0 },
              previewSize: { width: 0, height: 0 },
              histogram: null,
              waveform: null,
              uncroppedAdjustedPreviewUrl: null,
              patchesSentToBackend: new Set<string>(),
              hasRenderedFirstFrame: false,
              showOriginal: false,
              activeMaskId: null,
              activeMaskContainerId: null,
              activeAiPatchContainerId: null,
              activeAiSubMaskId: null,
              isWbPickerActive: false,
              transformedOriginalUrl: null,
            });
            setLibrary({
              multiSelectedPaths: multiSelectedPaths.includes(path) ? multiSelectedPaths : [path],
              libraryActivePath: null,
              selectionAnchorPath: path,
              isViewLoading: true,
            });
            setUI({
              isLibraryExportPanelVisible: false,
              compactEditorPanelHeightOverride: null,
            });

            invalidatePendingPreviewJobs(previewJobIdRef, latestRenderedJobIdRef);
            currentResRef.current = 0;

            if (cached) {
              setEditor(createCachedEditorPlaceholder(cached));
            } else {
              setEditor({ finalPreviewUrl: null });
            }

            if (previousFinalPreviewUrl !== cached?.finalPreviewUrl) {
              globalImageCache.revokeWhenUnprotected(previousFinalPreviewUrl);
            }
            if (previousUncroppedPreviewUrl !== cached?.uncroppedPreviewUrl) {
              globalImageCache.revokeWhenUnprotected(previousUncroppedPreviewUrl);
            }

            setEditor((state) => {
              if (state.interactivePatch?.url) URL.revokeObjectURL(state.interactivePatch.url);
              return { interactivePatch: null };
            });
            didSelect = true;
          },
          () => navigationIntentTracker.isCurrent(navigationIntent),
        );
      } catch (error) {
        toast.error(`Failed to save changes: ${error}`);
        return false;
      }

      return didSelect;
    },
    [refs],
  );

  const handleSelectSubfolder = useCallback(
    async (
      path: string | null,
      isNewRoot = false,
      preloadedImages?: ImageFile[],
      expandParents = true,
      preserveEditor = false,
    ) => {
      const libraryNavigation = libraryNavigationTracker.begin();
      const editorNavigation = preserveEditor ? null : navigationIntentTracker.begin();
      const preservedEditorSession = preserveEditor ? getCurrentEditorSession() : null;
      const isCurrentLibraryNavigation = () =>
        libraryNavigationTracker.isCurrent(libraryNavigation) &&
        (preservedEditorSession
          ? isCurrentEditorSession(
              preservedEditorSession.path,
              preservedEditorSession.generation,
              getCurrentEditorSession,
              () => true,
            )
          : editorNavigation !== null && navigationIntentTracker.isCurrent(editorNavigation));
      const { appSettings, handleSettingsChange } = useSettingsStore.getState();
      const { pinnedFolders } = appSettings || { pinnedFolders: [] };
      const { setLibrary, sortCriteria } = useLibraryStore.getState();
      const { setUI } = useUIStore.getState();
      const { setProcess } = useProcessStore.getState();
      const { selectedImage } = useEditorStore.getState();
      const libraryViewMode = appSettings?.libraryViewMode;

      if (!preserveEditor && selectedImage) {
        try {
          await runEditorTransition(
            selectedImage.path,
            editorNavigationTransitions.clearForFolderSelection,
            isCurrentLibraryNavigation,
          );
        } catch (error) {
          if (isCurrentLibraryNavigation()) toast.error(`Failed to save changes: ${error}`);
          return false;
        }
        if (!isCurrentLibraryNavigation()) return false;
      }

      if (!preserveEditor) {
        await invoke('cancel_thumbnail_generation').catch((error) => {
          console.warn('Failed to cancel thumbnail generation:', error);
        });
        if (!isCurrentLibraryNavigation()) return false;
        clearThumbnailQueue();
        setLibrary({ isViewLoading: true, activeAlbumId: null, libraryScrollTop: 0 });
        useLibraryStore.getState().setSearchCriteria({ tags: [], text: '', mode: 'OR' });
        setProcess({ thumbnails: {} });
        globalImageCache.clear();
        setUI({ activeView: 'library' });
      } else {
        setLibrary({ isViewLoading: true });
      }

      try {
        const { rootPaths, expandedFolders: currentExpandedFolders } = useLibraryStore.getState();
        let newExpandedFolders = new Set(currentExpandedFolders);

        if (isNewRoot && path) {
          newExpandedFolders = new Set([path]);
          if (appSettings) {
            handleSettingsChange({ ...appSettings, lastRootPath: path } as any);
          }
        } else if (path && expandParents) {
          const allRoots = [...(rootPaths || []), ...(pinnedFolders || [])].filter(Boolean) as string[];
          const relevantRoot = allRoots.find((r) => path.startsWith(r));

          if (relevantRoot) {
            const separator = path.includes('/') ? '/' : '\\';
            const parentSeparatorIndex = path.lastIndexOf(separator);

            if (parentSeparatorIndex > -1 && path.length > relevantRoot.length) {
              let current = path.substring(0, parentSeparatorIndex);
              while (current && current.length >= relevantRoot.length) {
                newExpandedFolders.add(current);
                const nextParentIndex = current.lastIndexOf(separator);
                if (nextParentIndex === -1 || current === relevantRoot) break;
                current = current.substring(0, nextParentIndex);
              }
            }
            newExpandedFolders.add(relevantRoot);
          }
        }

        setLibrary({
          currentFolderPath: path,
          expandedFolders: newExpandedFolders,
          ...(preserveEditor ? {} : { imageList: [], multiSelectedPaths: [], libraryActivePath: null }),
        });

        const command =
          libraryViewMode === LibraryViewMode.Recursive ? Invokes.ListImagesRecursive : Invokes.ListImagesInDir;

        let files: ImageFile[];
        if (preloadedImages) {
          files = preloadedImages;
        } else {
          files = await invoke(command, { path });
          if (!isCurrentLibraryNavigation()) return false;
        }

        const initialRatings: Record<string, number> = {};
        files.forEach((f) => {
          if (f.rating !== undefined) {
            initialRatings[f.path] = f.rating;
          }
        });
        if (
          !libraryNavigationTracker.commitIfCurrent(libraryNavigation, () =>
            setLibrary({ imageRatings: initialRatings }),
          )
        ) {
          return false;
        }

        const exifSortKeys = ['date_taken', 'iso', 'shutter_speed', 'aperture', 'focal_length'];
        const isExifSortActive = exifSortKeys.includes(sortCriteria.key);

        if (files.length > 0) {
          const paths = files.map((f: ImageFile) => f.path);

          if (isExifSortActive) {
            const exifDataMap: Record<string, any> = await invoke(Invokes.ReadExifForPaths, { paths });
            if (!isCurrentLibraryNavigation()) return false;
            const finalImageList = files.map((image) => ({
              ...image,
              exif: exifDataMap[image.path] || image.exif || null,
            }));
            setLibrary({ imageList: finalImageList });
          } else {
            setLibrary({ imageList: files });
            invoke(Invokes.ReadExifForPaths, { paths })
              .then((exifDataMap: any) => {
                libraryNavigationTracker.commitIfCurrent(libraryNavigation, () => {
                  setLibrary((state) => ({
                    imageList: state.imageList.map((image) => ({
                      ...image,
                      exif: exifDataMap[image.path] || image.exif || null,
                    })),
                  }));
                });
              })
              .catch((err) => {
                if (isCurrentLibraryNavigation()) console.error('Failed to read EXIF data in background:', err);
              });
          }
        } else {
          setLibrary({ imageList: files });
        }

        if (!preserveEditor) {
          invoke(Invokes.StartBackgroundIndexing, { folderPath: path }).catch((err) => {
            console.error('Failed to start background indexing:', err);
          });
        }
        return true;
      } catch (err) {
        if (isCurrentLibraryNavigation()) {
          console.error('Failed to load folder contents:', err);
          toast.error('Failed to load images from the selected folder.');
        }
        return false;
      } finally {
        libraryNavigationTracker.commitIfCurrent(
          libraryNavigation,
          () => {
            useLibraryStore.getState().setLibrary({ isViewLoading: false });
          },
          isCurrentLibraryNavigation,
        );
      }
    },
    [clearThumbnailQueue, refs],
  );

  const handleSelectAlbum = useCallback(
    async (albumId: string, albumName: string, imagePaths: string[], preserveEditor = false) => {
      const libraryNavigation = libraryNavigationTracker.begin();
      const editorNavigation = preserveEditor ? null : navigationIntentTracker.begin();
      const preservedEditorSession = preserveEditor ? getCurrentEditorSession() : null;
      const isCurrentLibraryNavigation = () =>
        libraryNavigationTracker.isCurrent(libraryNavigation) &&
        (preservedEditorSession
          ? isCurrentEditorSession(
              preservedEditorSession.path,
              preservedEditorSession.generation,
              getCurrentEditorSession,
              () => true,
            )
          : editorNavigation !== null && navigationIntentTracker.isCurrent(editorNavigation));
      const { setLibrary } = useLibraryStore.getState();
      const { setUI } = useUIStore.getState();

      const { selectedImage } = useEditorStore.getState();
      if (!preserveEditor && selectedImage) {
        try {
          await runEditorTransition(
            selectedImage.path,
            editorNavigationTransitions.clearForAlbumSelection,
            isCurrentLibraryNavigation,
          );
        } catch (error) {
          if (isCurrentLibraryNavigation()) toast.error(`Failed to save changes: ${error}`);
          return false;
        }
        if (!isCurrentLibraryNavigation()) return false;
      }

      if (!preserveEditor) {
        await invoke('cancel_thumbnail_generation').catch((error) => {
          console.warn('Failed to cancel thumbnail generation:', error);
        });
        if (!isCurrentLibraryNavigation()) return false;
        clearThumbnailQueue();
        useLibraryStore.getState().setSearchCriteria({ tags: [], text: '', mode: 'OR' });
        setLibrary({ libraryScrollTop: 0 });
        globalImageCache.clear();
        setUI({ activeView: 'library' });
      }

      setLibrary({
        isViewLoading: true,
        currentFolderPath: `Album: ${albumName}`,
        activeAlbumId: albumId,
      });

      try {
        const files: ImageFile[] = await invoke(Invokes.GetAlbumImages, { paths: imagePaths });
        if (!isCurrentLibraryNavigation()) return false;

        const initialRatings: Record<string, number> = {};
        files.forEach((f) => {
          if (f.rating !== undefined) initialRatings[f.path] = f.rating;
        });

        libraryNavigationTracker.commitIfCurrent(libraryNavigation, () => {
          setLibrary({
            imageList: files,
            imageRatings: initialRatings,
            ...(preserveEditor ? {} : { multiSelectedPaths: [], libraryActivePath: null }),
          });
        });
      } catch (err) {
        if (isCurrentLibraryNavigation()) {
          console.error('Failed to load album images:', err);
          toast.error(`Failed to load album: ${err}`);
        }
        return false;
      } finally {
        libraryNavigationTracker.commitIfCurrent(
          libraryNavigation,
          () => setLibrary({ isViewLoading: false }),
          isCurrentLibraryNavigation,
        );
      }
      return true;
    },
    [clearThumbnailQueue],
  );

  const handleOpenFolder = async () => {
    const { osPlatform, appSettings, handleSettingsChange } = useSettingsStore.getState();
    const { rootPaths, folderTrees, setLibrary } = useLibraryStore.getState();
    const isAndroid = osPlatform === 'android';

    try {
      let selectedPath = '';
      if (isAndroid) {
        selectedPath = await invoke<string>(Invokes.GetOrCreateInternalLibraryRoot);
      } else {
        const selected = await open({ directory: true, multiple: false, defaultPath: await homeDir() });
        if (typeof selected === 'string') {
          selectedPath = selected;
        }
      }

      if (selectedPath) {
        if (useEditorStore.getState().selectedImage && !(await handleBackToLibrary())) return;

        if (!rootPaths.includes(selectedPath)) {
          const newRootPaths = [...rootPaths, selectedPath];
          setLibrary({ rootPaths: newRootPaths });

          if (appSettings) {
            handleSettingsChange({ ...appSettings, rootFolders: newRootPaths } as any);
          }

          setLibrary({ isTreeLoading: true });
          try {
            const newTree = await invoke(Invokes.GetFolderTree, {
              path: selectedPath,
              expandedFolders: [selectedPath],
              showImageCounts:
                appSettings?.enableFolderImageCounts || appSettings?.folderTreeSort?.key === 'imageCount',
            });
            setLibrary({ folderTrees: [...folderTrees, newTree] });
          } catch (e) {
            toast.error(`Failed to load folder tree: ${e}`);
          } finally {
            setLibrary({ isTreeLoading: false });
          }
        }
        await handleSelectSubfolder(selectedPath, true);
      }
    } catch (err) {
      console.error(isAndroid ? 'Failed to open Android library root:' : 'Failed to open directory dialog:', err);
      toast.error(isAndroid ? 'Failed to open library.' : 'Failed to open folder selection dialog.');
    }
  };

  const handleContinueSession = () => {
    const restore = async () => {
      const { appSettings } = useSettingsStore.getState();
      const { setLibrary } = useLibraryStore.getState();

      const rootFolders = appSettings?.rootFolders?.length
        ? appSettings.rootFolders
        : appSettings?.lastRootPath
          ? [appSettings.lastRootPath]
          : [];

      if (rootFolders.length === 0) return;

      const folderState = appSettings?.lastFolderState;
      const pathToSelect = folderState?.currentFolderPath || rootFolders[0];

      setLibrary({ rootPaths: rootFolders });

      if (folderState?.expandedFolders) {
        const newExpandedFolders = new Set<string>(folderState.expandedFolders);
        setLibrary({ expandedFolders: newExpandedFolders });
      } else {
        setLibrary({ expandedFolders: new Set(rootFolders) });
      }

      setLibrary({ isTreeLoading: true });
      try {
        let treesData;
        if (preloadedDataRef.current?.rootPaths?.join() === rootFolders.join() && preloadedDataRef.current.trees) {
          treesData = await preloadedDataRef.current.trees;
          preloadedDataRef.current.trees = undefined;
        } else {
          const expandedArr = folderState?.expandedFolders
            ? Array.from(new Set(folderState.expandedFolders))
            : rootFolders;
          treesData = await invoke(Invokes.GetPinnedFolderTrees, {
            paths: rootFolders,
            expandedFolders: expandedArr,
            showImageCounts: appSettings?.enableFolderImageCounts || appSettings?.folderTreeSort?.key === 'imageCount',
          });
        }
        setLibrary({ folderTrees: treesData });
      } catch (err) {
        console.error('Failed to restore folder trees:', err);
      } finally {
        setLibrary({ isTreeLoading: false });
      }

      let preloadedImages: ImageFile[] | undefined = undefined;
      if (preloadedDataRef.current?.currentPath === pathToSelect && preloadedDataRef.current.images) {
        try {
          preloadedImages = await preloadedDataRef.current.images;
          preloadedDataRef.current.images = undefined;
        } catch (e) {
          console.error('Failed to retrieve preloaded images', e);
        }
      }

      if (pathToSelect && pathToSelect.startsWith('Album: ')) {
        const activeAlbumId = folderState?.activeAlbumId;
        if (activeAlbumId) {
          try {
            const albumTree: any = await invoke(Invokes.GetAlbums);
            setLibrary({ albumTree });

            const findObj = (nodes: any[]): any => {
              for (const n of nodes) {
                if (n.id === activeAlbumId) return n;
                if (n.type === 'group') {
                  const f = findObj(n.children);
                  if (f) return f;
                }
              }
              return null;
            };

            const album = findObj(albumTree);
            if (album) {
              await handleSelectAlbum(album.id, album.name, album.images);
            } else {
              await handleSelectSubfolder(rootFolders[0], false, undefined, false);
            }
          } catch (e) {
            console.error('Failed to restore album session:', e);
            await handleSelectSubfolder(rootFolders[0], false, undefined, false);
          }
        } else {
          await handleSelectSubfolder(rootFolders[0], false, undefined, false);
        }
      } else {
        await handleSelectSubfolder(pathToSelect, false, preloadedImages, false);
      }
    };

    restore().catch((err) => {
      console.error('Failed to restore session:', err);
      toast.error('Failed to restore session. A folder may have been moved or deleted.');
      handleGoHome();
      useLibraryStore.getState().setLibrary({ isTreeLoading: false });
    });
  };

  return {
    handleGoHome,
    handleBackToLibrary,
    handleImageSelect,
    handleSelectSubfolder,
    handleSelectAlbum,
    handleOpenFolder,
    handleContinueSession,
    handleImageLoadFailure,
  };
}

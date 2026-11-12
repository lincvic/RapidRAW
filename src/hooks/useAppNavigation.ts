import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { homeDir } from '@tauri-apps/api/path';
import { toast } from 'react-toastify';
import { useLibraryStore } from '../store/useLibraryStore';
import { canvasToolState, useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useProcessStore } from '../store/useProcessStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Invokes, LibraryViewMode, ImageFile, SelectedImage } from '../components/ui/AppProperties';
import { createCachedEditorPlaceholder, globalImageCache, type ImageCacheEntry } from '../utils/ImageLRUCache';
import { decodeImage } from '../utils/decodeImage';
import { cancelPendingHistory, flushPendingSave, runEditorTransition } from '../services/editorPersistence';
import { invalidatePendingPreviewJobs } from '../utils/asyncNavigation';
import { clearLibrarySelection } from './useLibraryActions';
import { computeSortedLibrary } from './useSortedLibrary';
import { getImmichAlbumImages, isImmichAlbumId } from '../components/immich/immichApi';

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

let exifLoadGeneration = 0;
let imageSelectGeneration = 0;

const EXIF_CHUNK_SIZE = 250;

const loadExifForImages = async (
  files: ImageFile[],
  expectedFolderPath: string | null,
  sortKey: string,
  setLibrary: (updater: any) => void,
) => {
  const exifSortKeys = ['date_taken', 'iso', 'shutter_speed', 'aperture', 'focal_length'];
  const isExifSortActive = exifSortKeys.includes(sortKey);
  const generation = ++exifLoadGeneration;

  const previousExif = useLibraryStore.getState().exifByPath;
  const knownExif: Record<string, Record<string, string>> = {};
  for (const file of files) {
    const exif = previousExif[file.path] || file.exif;
    if (exif) knownExif[file.path] = exif;
  }

  if (files.length === 0) {
    setLibrary({ imageList: files, exifByPath: knownExif });
    return;
  }

  const paths = files.map((f: ImageFile) => f.path);

  if (isExifSortActive) {
    for (let i = 0; i < paths.length; i += EXIF_CHUNK_SIZE) {
      const chunk = paths.slice(i, i + EXIF_CHUNK_SIZE);
      try {
        const chunkExif: Record<string, Record<string, string>> = await invoke(Invokes.ReadExifForPaths, {
          paths: chunk,
        });
        Object.assign(knownExif, chunkExif);
      } catch (err) {
        console.error('Failed to read EXIF chunk:', err);
      }
    }

    if (generation !== exifLoadGeneration) return;
    setLibrary({ imageList: files, exifByPath: knownExif });
  } else {
    setLibrary({ imageList: files, exifByPath: knownExif });

    setTimeout(() => {
      const fetchExifInChunks = async () => {
        for (let i = 0; i < paths.length; i += EXIF_CHUNK_SIZE) {
          if (generation !== exifLoadGeneration) break;
          if (useLibraryStore.getState().currentFolderPath !== expectedFolderPath) break;

          const chunk = paths.slice(i, i + EXIF_CHUNK_SIZE);
          try {
            const chunkExif: Record<string, Record<string, string>> = await invoke(Invokes.ReadExifForPaths, {
              paths: chunk,
            });
            if (generation !== exifLoadGeneration) break;
            setLibrary((state: any) => ({ exifByPath: { ...state.exifByPath, ...chunkExif } }));
            await new Promise((resolve) => setTimeout(resolve, 50));
          } catch (err) {
            console.error('Failed to read EXIF chunk:', err);
          }
        }
      };
      fetchExifInChunks();
    }, 500);
  }
};

export function useAppNavigation({ clearThumbnailQueue, refs }: AppNavigationProps) {
  const {
    transformWrapperRef,
    preloadedDataRef,
    cachedEditStateRef,
    selectedImagePathRef,
    latestRenderedJobIdRef,
    previewJobIdRef,
    currentResRef,
  } = refs;

  const handleGoHome = useCallback(() => {
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
    });
    useUIStore.getState().setUI({ isLibraryExportPanelVisible: false });
  }, []);

  const handleBackToLibrary = useCallback(() => {
    const { selectedImage } = useEditorStore.getState();
    const { setLibrary } = useLibraryStore.getState();
    const { setUI } = useUIStore.getState();

    if (selectedImage?.path && cachedEditStateRef.current?.selectedImage.path === selectedImage.path) {
      globalImageCache.set(selectedImage.path, cachedEditStateRef.current);
    }
    if (transformWrapperRef.current) {
      transformWrapperRef.current.resetTransform(0);
    }
    useEditorStore.getState().setEditor({
      zoom: 1,
      showOriginal: false,
      previewOverride: null,
    });

    // The session stays open in the library, so its queued save is only started early here.
    if (selectedImage?.path) {
      flushPendingSave(selectedImage.path).catch((err) => toast.error(`Failed to save changes: ${err}`));
    }
    cancelPendingHistory();

    const lastActivePath = selectedImage?.path ?? null;
    const isStillVisible =
      lastActivePath !== null &&
      computeSortedLibrary(useLibraryStore.getState(), useSettingsStore.getState()).some(
        (img) => img.path === lastActivePath,
      );

    if (isStillVisible) {
      setLibrary({ libraryActivePath: lastActivePath });
    } else {
      clearLibrarySelection();
    }
    setUI({ activeView: 'library', slideDirection: 1 });
  }, [refs]);

  const handleImageSelect = useCallback(
    async (path: string, openInEditor: boolean = true): Promise<boolean> => {
      const generation = ++imageSelectGeneration;
      const isCurrentSelection = () => generation === imageSelectGeneration;
      const { selectedImage } = useEditorStore.getState();
      const { setUI } = useUIStore.getState();
      const wasEditorVisible = useUIStore.getState().activeView === 'editor';

      if (openInEditor) {
        setUI({ activeView: 'editor' });
      }

      if (selectedImage?.path === path) return true;

      const cachedThumb = useProcessStore.getState().thumbnails[path];
      const cachedMedium = useProcessStore.getState().mediumThumbnails[path] || cachedThumb;

      // A read-only peek: the entry is only taken once the switch commits.
      const peekedEntry = globalImageCache.get(path);
      const isFrontendCached = Boolean(peekedEntry);
      const canKeepWgpuLive =
        useSettingsStore.getState().appSettings?.useWgpuRenderer !== false &&
        wasEditorVisible &&
        useEditorStore.getState().wgpuPhase === 'live';
      const isCachedInBackend = canKeepWgpuLive
        ? await invoke<boolean>('is_image_cached', { path }).catch(() => false)
        : false;

      if (!isCurrentSelection()) return false;

      const keepWgpuLive = canKeepWgpuLive && isCachedInBackend && useEditorStore.getState().wgpuPhase === 'live';

      if (!keepWgpuLive) {
        await decodeImage((isFrontendCached && peekedEntry?.finalPreviewUrl) || cachedMedium);
        if (!isCurrentSelection()) return false;
      }

      // The outgoing image's saves land before its session is replaced; if they fail it stays open.
      let didSelect = false;
      try {
        await runEditorTransition(
          useEditorStore.getState().selectedImage?.path,
          () => {
            const {
              selectedImage: outgoing,
              finalPreviewUrl: previousFinalPreviewUrl,
              uncroppedAdjustedPreviewUrl: previousUncroppedPreviewUrl,
              setEditor,
            } = useEditorStore.getState();
            const { setLibrary, multiSelectedPaths } = useLibraryStore.getState();

            // A cache hit is only a provisional placeholder: the metadata-first loader still runs, and the
            // image becomes ready once load_metadata and load_image agree on the effective baseline.
            const outgoingEntry = cachedEditStateRef.current;
            const cached = globalImageCache.takeForNavigation(
              path,
              outgoing?.path && outgoingEntry?.selectedImage.path === outgoing.path
                ? { key: outgoing.path, entry: outgoingEntry }
                : undefined,
            );
            const imageFile = useLibraryStore.getState().imageList.find((img) => img.path === path);
            const provisionalImage: SelectedImage = cached
              ? {
                  ...cached.selectedImage,
                  isReady: false,
                  sourceKind: null,
                  thumbnailUrl: cachedMedium || cached.selectedImage.thumbnailUrl,
                }
              : {
                  exif: null,
                  group_id: imageFile?.group_id ?? null,
                  height: 0,
                  isRaw: false,
                  isReady: false,
                  metadata: null,
                  path,
                  sourceKind: null,
                  thumbnailUrl: cachedMedium,
                  width: 0,
                };

            selectedImagePathRef.current = path;
            useEditorStore.getState().patchesSentToBackend.clear();
            if (!cached) invoke('clear_session_caches').catch((e) => console.warn('Cache clear failed:', e));
            invalidatePendingPreviewJobs(previewJobIdRef, latestRenderedJobIdRef);
            currentResRef.current = 0;

            useEditorStore.getState().beginImageSelection(provisionalImage, cached?.effectiveAdjustments);
            setEditor((state) => {
              if (state.interactivePatch?.url) URL.revokeObjectURL(state.interactivePatch.url);
              return {
                ...(keepWgpuLive ? {} : { wgpuPhase: 'hidden' as const }),
                ...(cached
                  ? createCachedEditorPlaceholder(cached)
                  : {
                      originalSize: { width: 0, height: 0 },
                      histogram: null,
                      waveform: null,
                      finalPreviewUrl: null,
                      uncroppedAdjustedPreviewUrl: null,
                    }),
                interactivePatch: null,
                showOriginal: false,
                activeMaskId: null,
                activeMaskContainerId: null,
                activeAiPatchContainerId: null,
                activeAiSubMaskId: null,
                ...canvasToolState(),
                activeRelightLightId: null,
                previewOverride: null,
              };
            });
            if (previousFinalPreviewUrl !== cached?.finalPreviewUrl) {
              globalImageCache.revokeWhenUnprotected(previousFinalPreviewUrl);
            }
            if (previousUncroppedPreviewUrl !== cached?.uncroppedPreviewUrl) {
              globalImageCache.revokeWhenUnprotected(previousUncroppedPreviewUrl);
            }

            setLibrary({
              multiSelectedPaths: multiSelectedPaths.includes(path) ? multiSelectedPaths : [path],
              libraryActivePath: path,
              selectionAnchorPath: path,
              isViewLoading: !cached,
            });
            setUI({
              isLibraryExportPanelVisible: false,
              compactEditorPanelHeightOverride: null,
            });
            didSelect = true;
          },
          isCurrentSelection,
        );
      } catch (error) {
        if (isCurrentSelection()) toast.error(`Failed to save changes: ${error}`);
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
      skipHistory = false,
    ) => {
      const { appSettings, handleSettingsChange } = useSettingsStore.getState();
      const { pinnedFolders } = appSettings || { pinnedFolders: [] };
      const { setLibrary, sortCriteria } = useLibraryStore.getState();
      const { setUI } = useUIStore.getState();
      const { setProcess } = useProcessStore.getState();
      const { selectedImage } = useEditorStore.getState();
      const libraryViewMode = appSettings?.libraryViewMode;

      // Leaving the folder closes the editor session only after its saves land; a failed save keeps it open.
      if (!preserveEditor && selectedImage) {
        const generation = ++imageSelectGeneration;
        let didClear = false;
        try {
          await runEditorTransition(
            selectedImage.path,
            () => {
              const { finalPreviewUrl, uncroppedAdjustedPreviewUrl, clearEditorSession } = useEditorStore.getState();
              selectedImagePathRef.current = null;
              clearEditorSession();
              globalImageCache.revokeWhenUnprotected(finalPreviewUrl);
              globalImageCache.revokeWhenUnprotected(uncroppedAdjustedPreviewUrl);
              didClear = true;
            },
            () => generation === imageSelectGeneration,
          );
        } catch (error) {
          toast.error(`Failed to save changes: ${error}`);
          return;
        }
        // A newer image selection made while the save drained wins over this folder change.
        if (!didClear) return;
      }

      if (!skipHistory && path) {
        useLibraryStore.getState().pushNavHistory({ type: 'folder', path });
      }

      if (!preserveEditor) {
        await invoke('cancel_thumbnail_generation');
        clearThumbnailQueue();
        setLibrary({ isViewLoading: true, activeAlbumId: null, libraryScrollTop: 0 });
        setProcess({ thumbnails: {}, mediumThumbnails: {} });
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
          const isInsideRoot = (r: string) =>
            path === r || (path.startsWith(r) && (/[\\/]$/.test(r) || ['/', '\\'].includes(path[r.length])));
          const relevantRoot = allRoots
            .filter(isInsideRoot)
            .reduce<string | undefined>((best, r) => (!best || r.length > best.length ? r : best), undefined);

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
          if (useLibraryStore.getState().currentFolderPath !== path) return;
        }

        const initialRatings: Record<string, number> = {};
        files.forEach((f) => {
          if (f.rating !== undefined) {
            initialRatings[f.path] = f.rating;
          }
        });
        setLibrary({ imageRatings: initialRatings });

        await loadExifForImages(files, path, sortCriteria.key, setLibrary);

        if (!preserveEditor) {
          invoke(Invokes.StartBackgroundIndexing, { folderPath: path }).catch((err) => {
            console.error('Failed to start background indexing:', err);
          });
        }
      } catch (err) {
        console.error('Failed to load folder contents:', err);
        toast.error('Failed to load images from the selected folder.');
      } finally {
        if (useLibraryStore.getState().currentFolderPath === path) {
          useLibraryStore.getState().setLibrary({ isViewLoading: false });
        }
      }
    },
    [clearThumbnailQueue, refs],
  );

  const handleSelectAlbum = useCallback(
    async (albumId: string, albumName: string, imagePaths: string[], preserveEditor = false, skipHistory = false) => {
      const { setLibrary, sortCriteria } = useLibraryStore.getState();
      const { setUI } = useUIStore.getState();

      if (!skipHistory) {
        useLibraryStore.getState().pushNavHistory({ type: 'album', path: albumId, albumName, images: imagePaths });
      }

      if (!preserveEditor) {
        await invoke('cancel_thumbnail_generation');
        clearThumbnailQueue();
        setLibrary({ libraryScrollTop: 0 });
        globalImageCache.clear();
        setUI({ activeView: 'library' });
      }

      const albumFolderPath = `Album: ${albumName}`;
      const isCurrentAlbum = () => {
        const { currentFolderPath, activeAlbumId } = useLibraryStore.getState();
        return currentFolderPath === albumFolderPath && activeAlbumId === albumId;
      };

      setLibrary({
        isViewLoading: true,
        currentFolderPath: albumFolderPath,
        activeAlbumId: albumId,
      });

      try {
        const files: ImageFile[] = isImmichAlbumId(albumId)
          ? await getImmichAlbumImages(albumId)
          : await invoke(Invokes.GetAlbumImages, { paths: imagePaths });
        if (!isCurrentAlbum()) return true;

        const initialRatings: Record<string, number> = {};
        files.forEach((f) => {
          if (f.rating !== undefined) initialRatings[f.path] = f.rating;
        });

        setLibrary({
          imageRatings: initialRatings,
          ...(preserveEditor ? {} : { multiSelectedPaths: [], libraryActivePath: null }),
        });

        await loadExifForImages(files, albumFolderPath, sortCriteria.key, setLibrary);
        return true;
      } catch (err) {
        console.error('Failed to load album images:', err);
        toast.error(`Failed to load album: ${err}`);
        return false;
      } finally {
        if (isCurrentAlbum()) {
          setLibrary({ isViewLoading: false });
        }
      }
    },
    [clearThumbnailQueue],
  );

  const handleNavBack = useCallback(async () => {
    const { navHistory, navIndex, setLibrary } = useLibraryStore.getState();

    if (navIndex > 0) {
      const targetIndex = navIndex - 1;
      const target = navHistory[targetIndex];
      setLibrary({ navIndex: targetIndex });

      if (target.type === 'folder') {
        handleSelectSubfolder(target.path, false, undefined, true, false, true);
      } else if (target.type === 'album') {
        handleSelectAlbum(target.path, target.albumName!, target.images!, false, true);
      }
    }
  }, [handleSelectSubfolder, handleSelectAlbum]);

  const handleNavForward = useCallback(async () => {
    const { navHistory, navIndex, setLibrary } = useLibraryStore.getState();

    if (navIndex < navHistory.length - 1) {
      const targetIndex = navIndex + 1;
      const target = navHistory[targetIndex];
      setLibrary({ navIndex: targetIndex });

      if (target.type === 'folder') {
        handleSelectSubfolder(target.path, false, undefined, true, false, true);
      } else if (target.type === 'album') {
        handleSelectAlbum(target.path, target.albumName!, target.images!, false, true);
      }
    }
  }, [handleSelectSubfolder, handleSelectAlbum]);

  const handleOpenFolder = useCallback(async () => {
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
  }, [handleSelectSubfolder]);

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
            } else if (
              !isImmichAlbumId(activeAlbumId) ||
              !(await handleSelectAlbum(activeAlbumId, pathToSelect.slice('Album: '.length), []))
            ) {
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
    handleNavBack,
    handleNavForward,
    handleContinueSession,
  };
}

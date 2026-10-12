// SnClipper/src/app.tsx
// Vinod Nair

import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  ToastAndroid,
  Pressable,
  Image,
  AppState,
  ScrollView,
  FlatList,
  TextInput,
  Modal,
  ActivityIndicator,
  PixelRatio,
} from 'react-native';
import { ClipService } from './services/ClipService';
import { NavService, normalizePath } from './services/NavService';
import { FloatingButton, FloatingAnchor } from './services/FloatingButton';
import { FloatingMenu, PickItem, MenuAnchor } from './components/FloatingMenu';
import { ClipItem, ClipSubElement, StorageService, DEFAULT_INSERT_FONT_SIZE } from './services/StorageService';
import { PluginManager } from 'sn-plugin-lib';
import { HighContrastButton } from './components/HighContrastButton';
import { CropOverlay } from './components/CropOverlay';
import { EraseOverlay } from './components/EraseOverlay';
import { PromptDialog } from './components/PromptDialog';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { SearchBar } from './components/SearchBar';
import { FilterPopover } from './components/FilterPopover';
import { SettingsPopover } from './components/SettingsPopover';
import { IndexService, HeadingItem } from './services/IndexService';
import { PermissionService, FILE_READ, FILE_WRITE } from './services/PermissionService';
import { ClipList } from './components/ClipList';
import { deriveArticleName, isDocFile, isNoteFile as checkIsNoteFile, isOpenableFile, isImageFile } from './utils/paths';
import { splitTextToFit, countWrappedLines, measureWrappedText } from './utils/text';
import { pollForTargetPage } from './utils/pageNav';
// Bundled at build time; versionCode is auto-incremented by buildPlugin.sh before bundling.
const pluginConfig = require('../PluginConfig.json');
const BUILD_LABEL = `v${pluginConfig.versionName} (build ${pluginConfig.versionCode})`;

// Best-effort cleanup of transient capture PNGs orphaned by a crash. Full-screen reader
// shots (reader_shot_*), temp page renders (temp_crop_page_*) and the per-layer renders a
// multi-layer note capture flattens (temp_layer_*), and the page templates the ToC renders
// to create pages (tpl_*) are all consumed within seconds; saved
// clip images (clip_*) are kept only while a clip references them. Runs once
// on launch and only touches files older than CAPTURE_STALE_MS, so it can never race an
// in-flight capture or a just-saved clip.
const CAPTURE_STALE_MS = 5 * 60 * 1000;
async function sweepOrphanCaptures(): Promise<void> {
  try {
    const { FileUtils } = require('sn-plugin-lib');
    const dir = await PluginManager.getPluginDirPath();
    if (!dir || !FileUtils || typeof FileUtils.listFiles !== 'function') return;
    const entries = await FileUtils.listFiles(dir);
    if (!Array.isArray(entries)) return;

    const now = Date.now();
    for (const entry of entries) {
      const name = entry.substring(entry.lastIndexOf('/') + 1);
      // Only sweep TRANSIENT captures (reader screenshots / temp crop pages) that were orphaned
      // by a crash mid-capture. NEVER touch clip_* files — those are user data (the backing
      // images of image clips), already deleted by ClipService.deleteClips when a clip is
      // removed. Sweeping them here previously deleted LIVE clip images whenever the clip list
      // was momentarily empty at mount, leaving blank-image clips (data loss).
      const isTransient = name.startsWith('reader_shot_') || name.startsWith('temp_crop_page_')
        || name.startsWith('temp_layer_') || name.startsWith('tpl_');
      if (!isTransient) continue;

      const tsMatch = name.match(/(\d{10,})/); // embedded Date.now() (13 digits)
      const ts = tsMatch ? parseInt(tsMatch[1], 10) : 0;
      const isStale = !ts || now - ts > CAPTURE_STALE_MS;
      if (!isStale) continue; // keep a possibly-pending fresh capture

      const full = entry.startsWith('/') ? entry : `${dir}/${name}`;
      try { await FileUtils.deleteFile(full); } catch (e) { /* best-effort */ }
    }
  } catch (e) { /* best-effort */ }
}

// True when a clip contains an image element (a figure). Figures lay out and select
// differently from text (their own page; not copyable or mergeable).
const clipHasImage = (clip: ClipItem): boolean => !!clip.elements?.some((e) => e.type === 'image');

export default function App() {
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isNoteFile, setIsNoteFile] = useState(false);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [currentPageNum, setCurrentPageNum] = useState<number>(0);

  // Cropping States
  const [isCropping, setIsCropping] = useState<boolean>(() => {
    const shot = ClipService.getPendingCropShot();
    return !!shot && (Date.now() - shot.ts < 60000);
  });
  const [cropLoading, setCropLoading] = useState(false);
  const [cropPagePath, setCropPagePath] = useState<string | null>(() => {
    const shot = ClipService.getPendingCropShot();
    return shot && (Date.now() - shot.ts < 60000) ? shot.path : null;
  });
  const [cropImageSize, setCropImageSize] = useState<{ width: number; height: number }>(() => {
    const shot = ClipService.getPendingCropShot();
    return shot && (Date.now() - shot.ts < 60000)
      ? { width: shot.width, height: shot.height }
      : { width: 1404, height: 1872 };
  });
  // The crop overlay doubles as a text-placement box. 'region' = crop an image region (default);
  // 'placeText' = position a single text clip, then insert it at the drawn box. pendingPlaceClip
  // holds the clip being placed while the overlay is up.
  const [cropMode, setCropMode] = useState<'region' | 'placeText'>('region');
  const [pendingPlaceClip, setPendingPlaceClip] = useState<ClipItem | null>(null);

  // Pre-insert erase/mask tool state (whites-out parts of an image clip before it's inserted).
  const [showErase, setShowErase] = useState(false);
  const [eraseClipId, setEraseClipId] = useState<string | null>(null);
  const [eraseElementIndex, setEraseElementIndex] = useState<number>(-1);
  const [erasePath, setErasePath] = useState<string | null>(null);
  const [eraseSize, setEraseSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [eraseLoading, setEraseLoading] = useState(false);

  // Search, Filter & Sort States
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [activeSourceFilter, setActiveSourceFilter] = useState<string | null>(null); // null = All Sources
  const [clipTypeFilter, setClipTypeFilter] = useState<'all' | 'image' | 'text'>('all'); // Picture/Text Clippings
  const [activeSortMode, setActiveSortMode] = useState<'oldest' | 'newest'>('newest');
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showPromptDialog, setShowPromptDialog] = useState(false);
  const [promptText, setPromptText] = useState('');

  // Floating-button long-press menu state.
  const [showFloatMenu, setShowFloatMenu] = useState(false);
  const [floatRecents, setFloatRecents] = useState<PickItem[]>([]);
  const [floatPinned, setFloatPinned] = useState<string | null>(null);
  const [floatPairNames, setFloatPairNames] = useState<string[]>([]);
  const [floatCanUndo, setFloatCanUndo] = useState(false);
  const [floatAnchor, setFloatAnchor] = useState<MenuAnchor | null>(null);

  // Settings (persisted). Auto-remove: delete clips from FlipClip once they have
  // been successfully inserted into a note. Defaults on.
  const [autoRemoveInserted, setAutoRemoveInserted] = useState(true);
  // Font size (px) for text inserted into notes. Defaults to Medium (44).
  const [insertFontSize, setInsertFontSize] = useState<number>(DEFAULT_INSERT_FONT_SIZE);
  // Combine inserted text clips into a single text box (default off — separate keeps a
  // per-clip inline source link, matching the plugin's per-document referencing purpose).
  const [combineInserted, setCombineInserted] = useState(false);
  // Source-reference toggles (both default on). Source is always captured; these only
  // gate the two display surfaces: the FlipClip card jump icon, and the inserted-note link.
  const [showSourceInClipper, setShowSourceInClipper] = useState(true);
  const [insertSourceLink, setInsertSourceLink] = useState(true);
  const [enableToc, setEnableToc] = useState(false);
  // Drag-to-place a single text clip before it lands in the note (default on). See
  // StorageService.getPlaceTextManually.
  const [placeTextManually, setPlaceTextManually] = useState(true);

  // Tab State: 'clips' | 'toc'
  const [activeTab, setActiveTab] = useState<'clips' | 'toc'>('clips');
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [isGeneratingToc, setIsGeneratingToc] = useState(false);
  const [tocPhase, setTocPhase] = useState<'scanning' | 'recognizing'>('scanning');
  const [tocUpdatedAt, setTocUpdatedAt] = useState<number | null>(null);

  const [editingHeading, setEditingHeading] = useState<HeadingItem | null>(null);
  const [editTitleInput, setEditTitleInput] = useState<string>('');

  // If the active tab gets disabled in Settings, fall back to the Clips tab so its content
  // doesn't linger on screen after the feature is turned off.
  useEffect(() => {
    if (activeTab === 'toc' && !enableToc) setActiveTab('clips');
  }, [enableToc, activeTab]);

  const handleOpenEditHeadingModal = (h: HeadingItem) => {
    setEditingHeading(h);
    setEditTitleInput(h.title);
  };

  const handleSaveHeadingTitle = async () => {
    if (!editingHeading || !currentFilePath) return;
    try {
      const trimmed = editTitleInput.trim();
      const overrides = await StorageService.getHeadingOverrides(currentFilePath);
      if (trimmed) {
        overrides[editingHeading.id] = trimmed;
        await StorageService.saveHeadingOverrides(currentFilePath, overrides);
        setHeadings(prev => prev.map(h => h.id === editingHeading.id ? { ...h, title: trimmed } : h));
        setEditingHeading(null);
        ToastAndroid.show('Heading title updated!', ToastAndroid.SHORT);
      } else {
        // Clearing the field removes the override and reverts to the detected/recognized title.
        delete overrides[editingHeading.id];
        await StorageService.saveHeadingOverrides(currentFilePath, overrides);
        setEditingHeading(null);
        const items = await IndexService.scanHeadings(currentFilePath);
        setHeadings(items);
        ToastAndroid.show('Reverted to detected title.', ToastAndroid.SHORT);
      }
    } catch (e) {
      ToastAndroid.show('Failed to save title', ToastAndroid.SHORT);
    }
  };



  // True while an insert is running — disables the Insert button so rapid taps can't kick off
  // a second concurrent insert (which would duplicate content). insertingRef guards re-entry
  // synchronously (before the state update lands).
  const [isInserting, setIsInserting] = useState(false);
  const insertingRef = useRef(false);

  // False until the first context check resolves the launch mode. We hold back the dashboard
  // render until then so a prompt/crop launch never flashes the dashboard first (the "glimpse
  // of FlipClip" before the prompt dialog).
  const [contextResolved, setContextResolved] = useState(false);

  // Confirmation Dialog States (for deleted/broken source links)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [confirmDescription, setConfirmDescription] = useState('');
  const [confirmConfirmLabel, setConfirmConfirmLabel] = useState('Confirm');
  const [confirmCancelLabel, setConfirmCancelLabel] = useState('Cancel');
  const [onConfirmCallback, setOnConfirmCallback] = useState<{ fn: () => void } | null>(null);
  const [onCancelCallback, setOnCancelCallback] = useState<{ fn: () => void } | null>(null);

  const askUserConfirmation = (
    title: string,
    description: string,
    confirmLabel = 'OK',
    cancelLabel?: string,
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmTitle(title);
      setConfirmDescription(description);
      setConfirmConfirmLabel(confirmLabel);
      setConfirmCancelLabel(cancelLabel || '');
      setOnConfirmCallback({
        fn: () => {
          setShowConfirmDialog(false);
          resolve(true);
        },
      });
      setOnCancelCallback({
        fn: () => {
          setShowConfirmDialog(false);
          resolve(false);
        },
      });
      setShowConfirmDialog(true);
    });
  };

  // True while a launch-mode 'prompt' dialog is active for this launch. Guards against a
  // follow-up context check (e.g. AppState 'active') reading the already-consumed 'normal'
  // launch mode and dismissing the just-shown prompt (the flash-then-disappear regression).
  const promptActiveRef = useRef(false);
  // True while a launch-mode 'crop' session is active for this launch. Guards against a
  // follow-up context check (e.g. AppState 'active') reading the already-consumed 'normal'
  // launch mode and dismissing the active crop screen.
  const cropActiveRef = useRef(false);

  // Switch to the floating menu synchronously if a long-press is pending, so the plugin view
  // never briefly shows its previous dashboard state before the menu appears. The async
  // context check (runContextCheck 'floatmenu' branch) then fills recents/current-file details.
  const maybeEnterMenu = () => {
    if (!FloatingButton.consumePendingMenu()) return false;
    const raw = FloatingButton.getAnchor();
    if (raw) {
      const r = PixelRatio.get() || 1;
      setFloatAnchor({ x: raw.x / r, y: raw.y / r, size: raw.size / r, screenW: raw.screenW / r, screenH: raw.screenH / r });
    } else {
      setFloatAnchor(null);
    }
    setShowFloatMenu(true);
    setContextResolved(true);
    return true;
  };

  useEffect(() => {
    // Enter the menu immediately on mount if a long-press is pending (prevents the flash).
    maybeEnterMenu();
    // Sync current list from Storage on open
    ClipService.init().then(async () => {
      setClips(ClipService.getClipsSync());
      // One-time cleanup of capture PNGs orphaned by a prior crash.
      sweepOrphanCaptures();

      // Uninstalling the plugin deletes its folder, and every clip image with it, while the
      // records survive in the host's storage. Offer to tidy up the clips that lost their
      // images. ASKED, never automatic: the trigger is a detection heuristic, and a heuristic
      // that can silently destroy is the bug rather than the fix (design review 2026-09-05).
      // Declining is a real answer — the "image unavailable" card covers their display.
      try {
        const { reset, orphanedClipIds } = await ClipService.detectReinstall();
        if (reset && orphanedClipIds.length > 0) {
          const n = orphanedClipIds.length;
          const remove = await askUserConfirmation(
            'Stored images are missing',
            `FlipClip was uninstalled and reinstalled, which removes saved clip images. ${n} clip${n === 1 ? '' : 's'} now reference${n === 1 ? 's' : ''} a missing image. Remove ${n === 1 ? 'it' : 'them'}, or keep ${n === 1 ? 'it' : 'them'} without images?`,
            'Remove',
            'Keep',
          );
          if (remove) {
            await ClipService.deleteClips(orphanedClipIds);
            setClips(ClipService.getClipsSync());
            ToastAndroid.show(`${n} clip(s) removed`, ToastAndroid.SHORT);
          }
        }
      } catch (e) { /* never block startup on this */ }
    });

    // Load persisted settings
    StorageService.getAutoRemoveInserted().then(setAutoRemoveInserted);
    StorageService.getInsertFontSize().then(setInsertFontSize);
    StorageService.getCombineInserted().then(setCombineInserted);
    StorageService.getShowSourceInClipper().then(setShowSourceInClipper);
    StorageService.getInsertSourceLink().then(setInsertSourceLink);
    StorageService.getEnableToc().then(setEnableToc);
    StorageService.getPlaceTextManually().then(setPlaceTextManually);

    // Check active file context (Note vs Document)
    const runContextCheck = async () => {
      try {
        const { PluginCommAPI, PluginDocAPI } = require('sn-plugin-lib');
        
        const launchMode = await ClipService.getLaunchMode();
        if (launchMode === 'autoclipped') {
          await ClipService.setLaunchMode('normal');
          const { BackHandler } = require('react-native');
          BackHandler.exitApp();
          return;
        }

        // Fallback for the background Clip button (index.js, showType:0): the host could not
        // show its permission dialog without a foreground UI, so index.js opened FlipClip in
        // 'permission' mode. Re-request here — where there IS a UI — and, once granted,
        // finish the clip the user asked for. Mirrors the index.js word-count routing.
        if (launchMode === 'permission') {
          await ClipService.setLaunchMode('normal');
          cropActiveRef.current = false;
          setIsCropping(false);
          setContextResolved(true);

          const outcome = await PermissionService.ensure(
            FILE_READ,
            'FlipClip needs read access to capture the text you selected.',
          );
          if (outcome !== 'granted') {
            ToastAndroid.show(
              outcome === 'blocked'
                ? PermissionService.blockedMessage('FlipClip')
                : 'FlipClip needs permission to clip',
              ToastAndroid.LONG,
            );
            PluginManager.closePluginView();
            return;
          }

          const selRes = await PluginDocAPI.getLastSelectedText() as any;
          const selected = (selRes && selRes.success && selRes.result) ? selRes.result : '';
          if (!selected || selected.trim().length === 0) {
            ToastAndroid.show('Nothing selected to clip.', ToastAndroid.SHORT);
            PluginManager.closePluginView();
            return;
          }

          let articleName = 'Unknown Document';
          let documentPath: string | undefined;
          let documentPage: number | undefined;
          try {
            const fRes = await PluginCommAPI.getCurrentFilePath();
            if (fRes.success && fRes.result) {
              documentPath = fRes.result;
              articleName = deriveArticleName(documentPath);
            }
            const pRes = await PluginCommAPI.getCurrentPageNum();
            if (pRes.success && pRes.result !== undefined && pRes.result !== null) {
              documentPage = pRes.result;
            }
          } catch (metaErr) {
            console.error('Failed to get current file metadata:', metaErr);
          }

          const words = selected.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
          if (words.length > 5) {
            await ClipService.addClip(selected, articleName, documentPath, documentPage);
            ToastAndroid.show('Clipped as Text!', ToastAndroid.SHORT);
            PluginManager.closePluginView();
          } else {
            // Short selection — same "text or image?" prompt the background handler uses.
            setCurrentFilePath(documentPath ?? null);
            if (documentPath) setIsNoteFile(!isDocFile(documentPath));
            setCurrentPageNum(documentPage ?? 0);
            setPromptText(selected);
            promptActiveRef.current = true;
            setShowPromptDialog(true);
          }
          return;
        }

        if (launchMode === 'prompt') {
          await ClipService.setLaunchMode('normal');
          cropActiveRef.current = false;
          setIsCropping(false);
          const text = await ClipService.getPromptText();
          if (text && text.trim().length > 0) {
            setPromptText(text);
            promptActiveRef.current = true;
            setShowPromptDialog(true);
          } else {
            const { BackHandler } = require('react-native');
            BackHandler.exitApp();
          }
          
          // Still load active file path so we can crop if user chooses Image
          const fileRes = await PluginCommAPI.getCurrentFilePath();
          if (fileRes.success && fileRes.result) {
            const filePath = fileRes.result;
            setCurrentFilePath(filePath);
            setIsNoteFile(!isDocFile(filePath));

            let pageNum = 0;
            const pageRes = await PluginCommAPI.getCurrentPageNum();
            if (pageRes.success && pageRes.result !== undefined && pageRes.result !== null) {
              pageNum = pageRes.result;
              setCurrentPageNum(pageNum);
            }
          }
          return;
        }

        if (launchMode === 'crop') {
          await ClipService.setLaunchMode('normal');
          cropActiveRef.current = true;
          setCropMode('region');
          setPendingPlaceClip(null);
          setIsCropping(true);
          setCropLoading(true);

          let filePath: string | undefined;
          let pageNum = 0;
          try {
            const fileRes = await PluginCommAPI.getCurrentFilePath();
            if (fileRes && fileRes.success && fileRes.result) {
              filePath = fileRes.result;
              setCurrentFilePath(filePath);
              setIsNoteFile(!isDocFile(filePath));
            }
            const pageRes = await PluginCommAPI.getCurrentPageNum();
            if (pageRes && pageRes.success && pageRes.result !== undefined && pageRes.result !== null) {
              pageNum = pageRes.result;
              setCurrentPageNum(pageNum);
            }
          } catch (e) {
            console.warn('Metadata query in crop failed:', e);
          }

          const targetFile = filePath || currentFilePath;
          const isNote = targetFile ? checkIsNoteFile(targetFile) : false;

          let bgShot: any = null;
          if (!isNote) {
            // Check for background screenshot from index.js for DOC files
            bgShot = ClipService.getPendingCropShot();
            if (bgShot && (Date.now() - bgShot.ts < 60000)) {
              setCropPagePath(bgShot.path);
              setCropImageSize({ width: bgShot.width, height: bgShot.height });
              setCropLoading(false);
            }
          } else {
            ClipService.clearPendingCropShot();
          }

          setContextResolved(true);
          if (!bgShot) {
            await handleStartCropping(targetFile, pageNum);
          }
          return;
        }

        if (launchMode === 'floatmenu') {
          await ClipService.setLaunchMode('normal');
          // Capture the underlying reader's file/page so the menu's Clip Region / context works.
          let menuPath: string | null = null;
          try {
            const fileRes = await PluginCommAPI.getCurrentFilePath();
            let pageNum = 0;
            if (fileRes && fileRes.success && fileRes.result) {
              menuPath = fileRes.result;
              setCurrentFilePath(fileRes.result);
              setIsNoteFile(!isDocFile(fileRes.result));
              const pageRes = await PluginCommAPI.getCurrentPageNum();
              if (pageRes && pageRes.success && pageRes.result !== undefined && pageRes.result !== null) {
                pageNum = pageRes.result;
                setCurrentPageNum(pageNum);
              }
              NavService.observe(fileRes.result, pageNum);
            }
          } catch (e) { /* best-effort */ }
          const recents = await NavService.getRecents(3);
          setFloatRecents(recents.map((r) => ({ path: r.path, name: deriveArticleName(r.path), page: r.page })));
          const pin = await NavService.getPinnedOverride();
          setFloatPinned(pin ? normalizePath(pin.path) : null);
          // Live pair the switch will flip between, for the caption.
          const pair = await NavService.getTogglePair(menuPath ?? currentFilePath);
          const names: string[] = [];
          if (pair.current) names.push(deriveArticleName(pair.current.path));
          if (pair.other) names.push(deriveArticleName(pair.other.path));
          setFloatPairNames(names);
          // Offer Undo only when the pending undo targets the note we're on now.
          const undo = ClipService.getInsertUndo();
          setFloatCanUndo(!!undo && !!menuPath && normalizePath(undo.notePath) === normalizePath(menuPath));
          // Convert the native anchor (device pixels) to dp for RN absolute positioning.
          const rawAnchor: FloatingAnchor | null = FloatingButton.getAnchor();
          if (rawAnchor) {
            const r = PixelRatio.get() || 1;
            setFloatAnchor({
              x: rawAnchor.x / r,
              y: rawAnchor.y / r,
              size: rawAnchor.size / r,
              screenW: rawAnchor.screenW / r,
              screenH: rawAnchor.screenH / r,
            });
          } else {
            setFloatAnchor(null);
          }
          setShowFloatMenu(true);
          setContextResolved(true);
          return;
        }

        // The 'prompt', 'permission', and 'crop' modes have already returned above, so here
        // launchMode is 'normal'. Clear stale prompt state — but NOT when a prompt
        // is active for this launch: a follow-up check (AppState 'active') sees the already-
        // consumed 'normal' mode and would otherwise dismiss the just-shown prompt.
        if (!promptActiveRef.current) {
          setShowPromptDialog(false);
          setPromptText('');
        }

        if (!cropActiveRef.current) {
          setIsCropping(false);
        }

        const fileRes = await PluginCommAPI.getCurrentFilePath();
        if (fileRes.success && fileRes.result) {
          const filePath = fileRes.result;
          setCurrentFilePath(filePath);
          setIsNoteFile(!isDocFile(filePath));

          // Restore the last-built ToC snapshot so the ToC tab shows its state (count + last
          // updated time) without re-scanning the note on open.
          StorageService.getTocState(filePath).then(state => {
            if (state) {
              setHeadings(state.headings);
              setTocUpdatedAt(state.updatedAt);
            }
          });

          let pageNum = 0;
          const pageRes = await PluginCommAPI.getCurrentPageNum();
          if (pageRes.success && pageRes.result !== undefined && pageRes.result !== null) {
            pageNum = pageRes.result;
            setCurrentPageNum(pageNum);
          }

          // Record this location for the Switch-Document feature (keeps the 2-slot history
          // warm whenever FlipClip is opened over a note or document). Fire-and-forget.
          NavService.observe(filePath, pageNum);
        } else {
          setIsNoteFile(true); // Default to note file context
        }
      } catch (e) {
        console.error('Failed to query file path context:', e);
        setIsNoteFile(true);
      } finally {
        // The launch mode is now known — safe to render the dashboard (or the prompt/crop view
        // already shown above). Runs on every path so we never get stuck on the placeholder.
        setContextResolved(true);
      }
    };

    // Coalesce overlapping context checks. Launch mode is a single shared value that is
    // consumed read-then-reset (e.g. 'prompt' -> 'normal'); mount, AppState 'active', and
    // the synchronous onLaunchModeChange emit can all fire near-simultaneously and race that
    // read/reset (dropping a prompt or crop). This guard runs one check at a time and, if a
    // trigger arrives mid-run, re-runs exactly once afterwards so no mode change is lost.
    let contextCheckBusy = false;
    let contextCheckPending = false;
    const checkContext = async () => {
      if (contextCheckBusy) { contextCheckPending = true; return; }
      contextCheckBusy = true;
      try {
        do {
          contextCheckPending = false;
          await runContextCheck();
        } while (contextCheckPending);
      } finally {
        contextCheckBusy = false;
      }
    };
    checkContext();

    const handleAppStateChange = (nextAppState: any) => {
      if (nextAppState === 'active') {
        // Show the menu instantly if a long-press is pending, before the async context check,
        // so the dashboard doesn't flash first.
        maybeEnterMenu();
        checkContext();
      }
    };
    const appStateSub = AppState.addEventListener('change', handleAppStateChange);

    // Persistent long-press listener: the instant the floating button's menu gesture fires, flip
    // to the menu view. This runs even while the plugin view is hidden (the RN instance stays
    // resident), so when the view reopens it is ALREADY showing the menu — no dashboard/clippings
    // flash before it (AppState 'active' alone lands after a paint). Mirrors maybeEnterMenu's
    // synchronous anchor set, then runs the context check to fill recents/pair/pinned.
    const longPressSub = FloatingButton.onLongPress((rawAnchor) => {
      if (rawAnchor) {
        const r = PixelRatio.get() || 1;
        setFloatAnchor({ x: rawAnchor.x / r, y: rawAnchor.y / r, size: rawAnchor.size / r, screenW: rawAnchor.screenW / r, screenH: rawAnchor.screenH / r });
      } else {
        setFloatAnchor(null);
      }
      FloatingButton.consumePendingMenu(); // we're handling it here; don't double-enter on 'active'
      setShowFloatMenu(true);
      setContextResolved(true);
      checkContext();
    });

    // Reactively refresh UI when background actions add elements
    const unsubscribe = ClipService.subscribe(() => {
      setClips([...ClipService.getClipsSync()]);
    });

    const { NativeModules, DeviceEventEmitter } = require('react-native');
    const { ImageCropModule } = NativeModules;
    if (ImageCropModule && typeof ImageCropModule.registerAsForeground === 'function') {
      ImageCropModule.registerAsForeground().catch((err: any) => console.error(err));
    }

    let subscription: any = null;
    if (DeviceEventEmitter && typeof DeviceEventEmitter.addListener === 'function') {
      subscription = DeviceEventEmitter.addListener('onLaunchModeChange', (mode: string) => {
        if (mode === 'crop') {
          cropActiveRef.current = true;
          setCropMode('region');
          setPendingPlaceClip(null);
          const bgShot = ClipService.getPendingCropShot();
          if (bgShot && (Date.now() - bgShot.ts < 60000)) {
            setCropPagePath(bgShot.path);
            setCropImageSize({ width: bgShot.width, height: bgShot.height });
            setCropLoading(false);
            setIsCropping(true);
          }
          checkContext();
        } else if (mode === 'prompt') {
          checkContext();
        }
      });
    }

    return () => {
      unsubscribe();
      appStateSub.remove();
      longPressSub.remove();
      if (subscription) {
        subscription.remove();
      }
    };
  }, []);

  // Harvest unique document filenames from clips list
  const uniqueSources = useMemo(() => {
    const sources = clips.map((c) => c.articleName).filter(Boolean);
    return Array.from(new Set(sources));
  }, [clips]);

  // Memoized Filter & Sort Selector
  const processedClips = useMemo(() => {
    let list = [...clips];

    // 1. Filter by Search Query
    if (isSearchVisible && searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      list = list.filter(
        (c) =>
          c.text.toLowerCase().includes(query) ||
          c.articleName.toLowerCase().includes(query)
      );
    }

    // 2. Filter by Source
    if (activeSourceFilter) {
      list = list.filter((c) => c.articleName === activeSourceFilter);
    }

    // 2b. Filter by clip type (Picture Clippings / Text Clippings)
    if (clipTypeFilter === 'image') {
      list = list.filter((c) => clipHasImage(c));
    } else if (clipTypeFilter === 'text') {
      list = list.filter((c) => !clipHasImage(c));
    }

    // 3. Sort Order
    if (activeSortMode === 'newest') {
      list.sort((a, b) => b.timestamp - a.timestamp);
    } else if (activeSortMode === 'oldest') {
      list.sort((a, b) => a.timestamp - b.timestamp);
    }

    return list;
  }, [clips, searchQuery, isSearchVisible, activeSourceFilter, clipTypeFilter, activeSortMode]);

  const handleCardPress = (id: string) => {
    if (!isSelectionMode) return;
    toggleSelect(id);
  };

  const handleCardLongPress = (id: string) => {
    if (isSelectionMode) return;
    setIsSelectionMode(true);
    setSelectedIds([id]);
  };

  const toggleSelect = (id: string) => {
    let updated = [...selectedIds];
    if (updated.includes(id)) {
      updated = updated.filter((item) => item !== id);
    } else {
      // Figures and text can be selected together — Insert now stacks mixed content, Copy
      // copies the text parts (images skipped), and Merge stays disabled for figures.
      updated.push(id);
    }

    setSelectedIds(updated);
    if (updated.length === 0) {
      setIsSelectionMode(false);
    }
  };

  const handleCopyAllVisible = () => {
    const text = ClipService.getAggregateTextSync(processedClips);
    if (text) {
      const { Clipboard } = require('react-native');
      Clipboard.setString(text);
      ToastAndroid.show('Visible clips copied!', ToastAndroid.SHORT);
    } else {
      ToastAndroid.show('No clips to copy!', ToastAndroid.SHORT);
    }
  };

  const handleCopySelected = () => {
    const selectedClips = clips.filter((c) => selectedIds.includes(c.id));
    const text = ClipService.getAggregateTextSync(selectedClips);
    
    if (text) {
      const { Clipboard } = require('react-native');
      Clipboard.setString(text);
      ToastAndroid.show(`${selectedIds.length} clip(s) copied!`, ToastAndroid.SHORT);
      handleCancel();
    }
  };

  const handleDeleteSelected = async () => {
    await ClipService.deleteClips(selectedIds);
    ToastAndroid.show(`${selectedIds.length} clip(s) deleted!`, ToastAndroid.SHORT);
    handleCancel();
  };

  // A selection is mergeable only when it's 2+ clips that are ALL text (no images) — a page
  // can't lay out an image alongside text, so text+image clips are disallowed.
  const selectionHasImage = useMemo(
    () => clips.some((c) => selectedIds.includes(c.id) && clipHasImage(c)),
    [clips, selectedIds]
  );
  // Whether the selection contains any copyable text (a mixed image+text selection does;
  // an image-only selection does not). Copy is enabled only when there is text to copy.
  const selectionHasText = useMemo(
    () => clips.some((c) => selectedIds.includes(c.id) && !!c.elements && c.elements.some((e) => e.type === 'text' && !!e.text && e.text.trim().length > 0)),
    [clips, selectedIds]
  );
  const canMerge = selectedIds.length >= 2 && !selectionHasImage;

  const handleMergeSelected = async () => {
    if (selectedIds.length < 2) {
      ToastAndroid.show('Select at least 2 clips to merge!', ToastAndroid.SHORT);
      return;
    }
    if (selectionHasImage) {
      ToastAndroid.show('Only text clips can be merged.', ToastAndroid.SHORT);
      return;
    }
    try {
      await ClipService.mergeClips(selectedIds);
      ToastAndroid.show(`${selectedIds.length} clip(s) merged!`, ToastAndroid.SHORT);
      handleCancel();
    } catch (e: any) {
      ToastAndroid.show(`Merge failed: ${e.message}`, ToastAndroid.SHORT);
    }
  };

  // Number of selected clips that are actually merged (have >1 element) and can be unmerged.
  const unmergeableCount = useMemo(
    () => clips.filter((c) => selectedIds.includes(c.id) && c.elements && c.elements.length > 1).length,
    [clips, selectedIds]
  );

  const handleUnmergeSelected = async () => {
    const targets = clips.filter((c) => selectedIds.includes(c.id) && c.elements && c.elements.length > 1);
    if (targets.length === 0) {
      ToastAndroid.show('Select a merged clip to unmerge.', ToastAndroid.SHORT);
      return;
    }
    let pieces = 0;
    for (const c of targets) {
      pieces += await ClipService.unmergeClip(c.id);
    }
    ToastAndroid.show(`Unmerged into ${pieces} clip(s).`, ToastAndroid.SHORT);
    handleCancel();
  };

  // The single selected image clip (and its first image element) that Erase can act on, or null.
  const eraseTarget = useMemo(() => {
    if (selectedIds.length !== 1) return null;
    const c = clips.find((cl) => cl.id === selectedIds[0]);
    if (!c || !c.elements) return null;
    const idx = c.elements.findIndex((e) => e.type === 'image' && !!e.imagePath);
    if (idx < 0) return null;
    return { clipId: c.id, index: idx, path: c.elements[idx].imagePath as string };
  }, [selectedIds, clips]);

  // Open the erase/mask tool on the selected image clip. Reads the image's raw pixel size via the
  // native decoder (RN Image.getSize can report density-scaled dims) so masks map 1:1.
  const handleStartErase = async () => {
    if (!eraseTarget) return;
    setEraseClipId(eraseTarget.clipId);
    setEraseElementIndex(eraseTarget.index);
    setErasePath(eraseTarget.path);
    setEraseSize({ width: 0, height: 0 });
    setEraseLoading(true);
    setShowErase(true);
    try {
      const { NativeModules } = require('react-native');
      const { ImageCropModule } = NativeModules;
      if (ImageCropModule && typeof ImageCropModule.getImageSize === 'function') {
        const dim = await ImageCropModule.getImageSize(eraseTarget.path);
        if (dim && dim.width && dim.height) setEraseSize({ width: dim.width, height: dim.height });
      }
    } catch (e) { /* overlay will show at 0 and the user can cancel */ }
    setEraseLoading(false);
  };

  const closeErase = () => {
    setShowErase(false);
    setEraseClipId(null);
    setEraseElementIndex(-1);
    setErasePath(null);
    setEraseLoading(false);
  };

  const handleCancelErase = () => { closeErase(); };

  // Paint the chosen rectangles white and repoint the clip at the edited PNG (new path → RN's
  // Image cache shows it immediately). Masking preserves dimensions, so width/height are unchanged.
  const handleApplyErase = async (rects: { x: number; y: number; width: number; height: number }[]) => {
    const clipId = eraseClipId;
    const idx = eraseElementIndex;
    const src = erasePath;
    const size = eraseSize;
    if (!src || !clipId || idx < 0 || rects.length === 0) { closeErase(); handleCancel(); return; }
    try {
      const { NativeModules } = require('react-native');
      const { ImageCropModule } = NativeModules;
      const { FileUtils } = require('sn-plugin-lib');
      const pluginDir = await PluginManager.getPluginDirPath();
      const dest = `${pluginDir}/clip_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.png`;
      const ok = await ImageCropModule.maskRectangles(src, rects, dest);
      if (ok) {
        await ClipService.updateElementImage(clipId, idx, dest, size.width, size.height);
        setClips(ClipService.getClipsSync());
        try { await FileUtils.deleteFile(src); } catch (e) { /* best-effort */ }
        ToastAndroid.show('Erased.', ToastAndroid.SHORT);
      } else {
        ToastAndroid.show('Erase failed.', ToastAndroid.SHORT);
      }
    } catch (e: any) {
      ToastAndroid.show(`Erase failed: ${e.message}`, ToastAndroid.SHORT);
    } finally {
      closeErase();
      handleCancel();
    }
  };

  const handleClearAll = async () => {
    // Confirm first. Clear All sits permanently in the bottom bar, one tap away, and it is
    // irreversible: `ClipService.clearClips` deletes each clip's PNG from disk as well as the
    // records. Vinod lost a full clip list to a stray tap on 2026-09-05. Delete Selected is
    // left unguarded on purpose — it takes a long-press and an explicit selection first, so
    // the intent is already established.
    const imageCount = clips.filter(clipHasImage).length;
    const ok = await askUserConfirmation(
      'Clear all clips?',
      imageCount > 0
        ? `This permanently deletes all ${clips.length} clip(s), including ${imageCount} saved image(s). It cannot be undone.`
        : `This permanently deletes all ${clips.length} clip(s). It cannot be undone.`,
      'Clear All',
      'Cancel',
    );
    if (!ok) return;

    await ClipService.clearClips();
    ToastAndroid.show('Clipboard cleared!', ToastAndroid.SHORT);
    handleCancel();
  };

  const handleCancel = () => {
    setSelectedIds([]);
    setIsSelectionMode(false);
  };

  const handleClose = () => {
    PluginManager.closePluginView();
  };

  // -------------------------------------------------------------
  // Permission gates (host plugin permission system)
  // -------------------------------------------------------------
  // Gate at the user-action level, not per API call: one prompt per thing the user asked
  // for. Grants are never cached — "allow this time only" is revoked when the plugin exits,
  // so every action re-checks (hasPermission is cheap).

  /** Returns true when the action may proceed; otherwise the user has already been told why not. */
  const ensurePermissions = async (
    action: string,
    requests: Array<{ permission: string; desc: string }>,
  ): Promise<boolean> => {
    const outcome = await PermissionService.ensureAll(requests);
    if (outcome === 'granted') return true;

    if (outcome === 'blocked') {
      // "Don't allow" — re-requesting only produces a go-to-Settings dialog, so say so in a
      // blocking dialog rather than a toast the user can miss.
      setConfirmTitle('File access needed');
      setConfirmDescription(PermissionService.blockedMessage(action));
      setConfirmConfirmLabel('OK');
      setConfirmCancelLabel('');
      setOnConfirmCallback({ fn: () => setShowConfirmDialog(false) });
      setShowConfirmDialog(true);
    } else {
      // Dismissed, or the dialog could not be shown — retrying is worthwhile.
      ToastAndroid.show(`${action} needs file access. Tap again to allow.`, ToastAndroid.LONG);
    }
    return false;
  };

  /**
   * Turn a 1501/1503/1500/1502/1217 failure into a clear message. Returns true when the error
   * was a permission problem (and has been reported), false for ordinary failures so callers
   * can fall back to their own error text.
   */
  const reportPermissionError = (e: any): boolean => {
    const msg = PermissionService.messageForError(e);
    if (!msg) return false;
    ToastAndroid.show(msg, ToastAndroid.LONG);
    return true;
  };

  const handleOpenSource = async (clip: ClipItem, element: ClipSubElement, elementIndex: number) => {
    if (!element.documentPath) return;

    // Jump-to-Source stats the source file in shared storage and re-opens it in the reader —
    // both are FILE:READ operations under the host permission system.
    const allowed = await ensurePermissions('Opening the source document', [
      { permission: FILE_READ, desc: 'FlipClip needs read access to reopen the document this clip came from.' },
    ]);
    if (!allowed) return;

    try {
      const { FileUtils, PluginCommAPI } = require('sn-plugin-lib');
      const exists = await FileUtils.exists(element.documentPath);
      if (!exists) {
        setConfirmTitle('Broken Source Link');
        setConfirmDescription(
          `The original document "${element.articleName || clip.articleName}" has been deleted. Would you like to remove the source link from this clipping? (The highlight text will be kept).`
        );
        setConfirmConfirmLabel('Remove Link');
        setConfirmCancelLabel('Keep Link');
        setOnConfirmCallback({
          fn: async () => {
            await ClipService.removeLinkFromElement(clip.id, elementIndex);
            setShowConfirmDialog(false);
            ToastAndroid.show('Source link removed.', ToastAndroid.SHORT);
          },
        });
        setShowConfirmDialog(true);
        return;
      }

      // Skip a redundant relaunch when the reader is already on the target file+page.
      const fileRes = await PluginCommAPI.getCurrentFilePath();
      const pageRes = await PluginCommAPI.getCurrentPageNum();
      if (fileRes.success && fileRes.result && pageRes.success && pageRes.result !== undefined && pageRes.result !== null) {
        const normalizePath = (p: string) => p.startsWith('file://') ? p.substring(7) : p;
        const targetPath = normalizePath(element.documentPath);
        const currentPath = normalizePath(fileRes.result);
        const targetPage = element.documentPage ?? 0;
        const currentPage = pageRes.result;

        if (targetPath === currentPath && targetPage === currentPage) {
          ToastAndroid.show('Already on this page.', ToastAndroid.SHORT);
          PluginManager.closePluginView();
          return;
        }
      }

      const { PluginFileAPI } = require('sn-plugin-lib');
      try {
        const encRes = await PluginFileAPI.getPathEncryptionStatus(element.documentPath) as any;
        if (encRes && encRes.success && encRes.result === 1) {
          ToastAndroid.show('This file is locked with a password.', ToastAndroid.LONG);
          return;
        }
      } catch (e) { /* best-effort */ }
      const openRes: any = await PluginFileAPI.openFile(element.documentPath, element.documentPage ?? 0);
      if (openRes && openRes.success === false) {
        if (PermissionService.isPermissionError(openRes)) {
          if (!reportPermissionError(openRes)) {
            ToastAndroid.show(`Failed to open source document: ${openRes.error?.message || 'Permission denied'}`, ToastAndroid.SHORT);
          }
        } else {
          ToastAndroid.show('Could not open the source document (it may have been moved or deleted)', ToastAndroid.LONG);
        }
        return;
      }
      PluginManager.closePluginView();
    } catch (err: any) {
      if (!reportPermissionError(err)) {
        ToastAndroid.show(`Failed to open source document: ${err.message}`, ToastAndroid.SHORT);
      }
    }
  };

  const toggleSearch = () => {
    if (isSearchVisible) {
      setSearchQuery('');
    }
    setIsSearchVisible(!isSearchVisible);
  };

  // -------------------------------------------------------------
  // Visible content layers of a note page, bottom-most first, for the capture composite.
  //
  // Excludes layerId -1 (the Background Layer): that is the page template, it renders opaque
  // white, and including it would both reintroduce the ruled lines we removed and hide every
  // layer stacked under it. Returns [0] when the layer list is unavailable, so a host that
  // does not answer getLayers keeps the previous single-layer behaviour.
  const getVisibleContentLayerIds = async (notePath: string, page: number): Promise<number[]> => {
    try {
      const { PluginFileAPI } = require('sn-plugin-lib');
      const res = await PluginFileAPI.getLayers(notePath, page) as any;
      if (res && res.success && Array.isArray(res.result)) {
        const ids = res.result
          .filter((l: any) => l && typeof l.layerId === 'number' && l.layerId >= 0 && l.isVisible !== false)
          .map((l: any) => l.layerId as number)
          .sort((a: number, b: number) => a - b);
        if (ids.length > 0) return ids;
      }
    } catch (e) { /* fall through to the main layer alone */ }
    return [0];
  };

  // Custom Page Cropping Logic & Coordinates Scaling
  const handleStartCropping = async (targetPath?: string, targetPage?: number) => {
    const file = targetPath || currentFilePath;
    const pg = targetPage !== undefined ? targetPage : currentPageNum;
    const isNote = file ? checkIsNoteFile(file) : (currentFilePath ? checkIsNoteFile(currentFilePath) : false);

    // 0. Image files are already a raster "page": crop them directly. Copy to a temp first,
    // because the crop save/cancel paths DELETE cropPagePath — we must never delete the
    // user's original image.
    if (file && isImageFile(file)) {
      const allowed = await ensurePermissions('Region capture', [
        { permission: FILE_READ, desc: 'FlipClip needs read access to the image you are cropping.' },
      ]);
      if (!allowed) { cropActiveRef.current = false; setIsCropping(false); setCropLoading(false); return; }
      cropActiveRef.current = true;
      setIsCropping(true);
      setCropLoading(true);
      try {
        const { NativeModules } = require('react-native');
        const { ImageCropModule } = NativeModules;
        const { FileUtils: SnFileUtils } = require('sn-plugin-lib');
        const pluginDir = await PluginManager.getPluginDirPath();
        const src = file.startsWith('file://') ? file.substring(7) : file;
        const temp = `${pluginDir}/temp_crop_page_${Date.now()}.png`;
        await SnFileUtils.copyFile(src, temp);
        // Use the NATIVE decoder for the size, matching cropImage's coordinate space exactly
        // (RN Image.getSize can report density-scaled dims, which collapses the crop to the
        // upper-left corner).
        let w = 0;
        let h = 0;
        if (ImageCropModule && typeof ImageCropModule.getImageSize === 'function') {
          const dim = await ImageCropModule.getImageSize(temp);
          if (dim && dim.width && dim.height) { w = dim.width; h = dim.height; }
        }
        if (w > 0 && h > 0) {
          setCropImageSize({ width: w, height: h });
          setCropPagePath(temp);
          setCropLoading(false);
        } else {
          ToastAndroid.show('Could not read the image.', ToastAndroid.SHORT);
          cropActiveRef.current = false; setIsCropping(false); setCropLoading(false);
        }
      } catch (e) {
        ToastAndroid.show('Could not open the image for cropping.', ToastAndroid.SHORT);
        cropActiveRef.current = false; setIsCropping(false); setCropLoading(false);
      }
      return;
    }

    // 1. Consume the fresh reader screenshot captured in background by index.js ONLY for DOC files
    if (!isNote) {
      const bgShot = ClipService.getPendingCropShot();
      if (bgShot && (Date.now() - bgShot.ts < 60000)) {
        setCropPagePath(bgShot.path);
        setCropImageSize({ width: bgShot.width, height: bgShot.height });
        setCropLoading(false);
        cropActiveRef.current = true;
        setIsCropping(true);
        return;
      }
    } else {
      ClipService.clearPendingCropShot();
    }

    // 2. Primary for NOTE files (or Fallback for DOC): file-based render if no live screenshot is available
    if (!file) {
      ToastAndroid.show('No active document to crop.', ToastAndroid.SHORT);
      cropActiveRef.current = false;
      setIsCropping(false);
      return;
    }

    // Rendering the page to crop from (generateNotePng / generateCurrentDocImage, plus
    // getPageSize) reads the user's document, so gate on FILE:READ. The crop itself and the
    // saved PNG live in the plugin's private dir, which is exempt.
    const allowed = await ensurePermissions('Region capture', [
      { permission: FILE_READ, desc: 'FlipClip needs read access to render the page you are cropping.' },
    ]);
    if (!allowed) {
      cropActiveRef.current = false;
      setIsCropping(false);
      return;
    }

    cropActiveRef.current = true;
    setIsCropping(true);
    setCropLoading(true);

    // Drop any capture left over from a previous aborted session before making a new one.
    if (cropPagePath) {
      const { FileUtils } = require('sn-plugin-lib');
      FileUtils.deleteFile(cropPagePath).catch(() => {});
    }

    try {
      const { PluginFileAPI, PluginDocAPI, PluginNoteAPI, FileUtils: FileUtilsForCleanup } = require('sn-plugin-lib');
      const pluginDir = await PluginManager.getPluginDirPath();
      if (!pluginDir) {
        ToastAndroid.show('Storage error: Cannot access plugin folder.', ToastAndroid.SHORT);
        cropActiveRef.current = false;
        setIsCropping(false);
        setCropLoading(false);
        return;
      }

      const tempPath = `${pluginDir}/temp_crop_page_${Date.now()}.png`;

      // Fetch the page size once and reuse it for both the capture and the crop scaling.
      let pageSize = { width: 1404, height: 1872 };
      const sizeRes = await PluginFileAPI.getPageSize(file, pg);
      if (sizeRes.success && sizeRes.result) {
        pageSize = sizeRes.result;
      }

      let success = false;
      // Keep the failing response around: a permission failure carries code 1503 and deserves
      // a different message from a genuine render failure.
      let genRes: any = null;
      if (isNote) {
        // generateLayerPreviewImage renders ONE layer, without the page's background
        // template (ruled lines, dot grid). generateNotePng would give us every layer at
        // once but bakes the template in regardless of its `type` param on this firmware
        // (confirmed on-device: type:0 "transparent background" still produced ruled
        // lines), so it stays a last-resort fallback only.
        //
        // A Standard note can carry ink on layers other than the main one, and rendering
        // layer 0 alone silently drops it (confirmed on-device: ink on Layer 1 was absent
        // from the capture while Main Layer content survived). So enumerate the layers and
        // composite every visible content layer.
        //
        // Layer ids from getLayers: -1 is the Background Layer (the template — it renders
        // OPAQUE white and would hide everything under it, so it must be excluded), 0 is
        // the Main Layer, 1..3 are the extra layers. Content layers render with a fully
        // transparent background, which is why they can simply be stacked. getLayers only
        // reports layers that exist, and it carries no isBackgroundLayer flag, so the id is
        // the only way to spot the template.
        const contentLayerIds = await getVisibleContentLayerIds(file, pg);

        if (contentLayerIds.length <= 1) {
          // The overwhelmingly common case (a note that only uses its main layer): render
          // straight to the destination, exactly as before, and involve no compositing.
          genRes = await PluginNoteAPI.generateLayerPreviewImage(
            file, pg, contentLayerIds.length === 1 ? contentLayerIds[0] : 0, tempPath,
          ) as any;
          success = genRes && genRes.success;
        } else {
          const layerPaths: string[] = [];
          for (const layerId of contentLayerIds) {
            const layerPath = `${pluginDir}/temp_layer_${layerId}_${Date.now()}.png`;
            try {
              const layerRes = await PluginNoteAPI.generateLayerPreviewImage(file, pg, layerId, layerPath) as any;
              if (layerRes && layerRes.success) {
                layerPaths.push(layerPath);
              } else if (layerRes) {
                genRes = layerRes; // keep the failure so a 1503 still reports as a permission error
              }
            } catch (e) { /* skip this layer; a partial composite beats no capture */ }
          }

          if (layerPaths.length > 0) {
            if (layerPaths.length < contentLayerIds.length) {
              // Some layers rendered and some did not. Compositing what we have beats failing
              // the capture, but the clip is missing content the user can see on the page, so
              // say so rather than handing back a silently incomplete image.
              ToastAndroid.show('Some note layers could not be captured; the clip may be incomplete.', ToastAndroid.LONG);
            }
            const { NativeModules: RN } = require('react-native');
            const Compositor = RN && RN.ImageCropModule;
            if (Compositor && typeof Compositor.compositeImages === 'function') {
              try {
                // Ordered bottom-up by layer id, so higher layers draw over lower ones.
                success = !!(await Compositor.compositeImages(layerPaths, tempPath));
              } catch (e) { success = false; }
            }
            if (!success) {
              // Compositing unavailable or failed — fall back to the bottom-most layer so
              // the user still gets a capture rather than an error.
              genRes = await PluginNoteAPI.generateLayerPreviewImage(file, pg, contentLayerIds[0], tempPath) as any;
              success = genRes && genRes.success;
            }
            for (const layerPath of layerPaths) {
              try { await FileUtilsForCleanup.deleteFile(layerPath); } catch (e) { /* best-effort */ }
            }
          }
        }

        if (!success) {
          genRes = await PluginFileAPI.generateNotePng({
            notePath: file,
            page: pg,
            times: 1,
            pngPath: tempPath,
            type: 0,
          });
          success = genRes && genRes.success;
        }
      } else {
        // sn-plugin-lib 0.1.65 replaced generateDocImage(docPath, page, pngPath, size) with
        // generateCurrentDocImage(page, pngPath, size, type) — it always renders the CURRENTLY
        // open document, which is exactly what the crop flow captures. type 0 = plain page
        // (type 1 bakes in text-selection highlight/underline styling, which we don't want in
        // a cropped region).
        genRes = await PluginDocAPI.generateCurrentDocImage(
          pg,
          tempPath,
          { width: Math.round(pageSize.width), height: Math.round(pageSize.height) },
          0
        );
        success = genRes && genRes.success;
      }

      if (success) {
        setCropPagePath(tempPath);
        setCropImageSize(pageSize);
        setCropLoading(false);
      } else {
        if (!reportPermissionError(genRes)) {
          ToastAndroid.show('Capture failed: Failed to screenshot page.', ToastAndroid.SHORT);
        }
        cropActiveRef.current = false;
        setIsCropping(false);
        setCropLoading(false);
      }
    } catch (err: any) {
      if (!reportPermissionError(err)) {
        ToastAndroid.show(`Capture error: ${err.message}`, ToastAndroid.SHORT);
      }
      cropActiveRef.current = false;
      setIsCropping(false);
      setCropLoading(false);
    }
  };

  // Receives the selection in image-space pixels from CropOverlay, performs the
  // native crop, stores the resulting image clip, and returns to the document.
  const runCropSave = async (rect: { x: number; y: number; width: number; height: number }) => {
    if (!cropPagePath) return;
    try {
      const { NativeModules, ToastAndroid } = require('react-native');
      const { ImageCropModule } = NativeModules;
      if (!ImageCropModule) {
        ToastAndroid.show('Crop failed: ImageCropModule is not registered.', ToastAndroid.SHORT);
        return;
      }

      const pluginDir = await PluginManager.getPluginDirPath();
      const destPath = `${pluginDir}/clip_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.png`;

      const success = await ImageCropModule.cropImage(
        cropPagePath,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        destPath
      );

      if (success) {
        // Clean up the temporary full-page capture only once the crop has succeeded,
        // so a failed crop leaves the source intact and the user can retry.
        const { FileUtils } = require('sn-plugin-lib');
        try {
          await FileUtils.deleteFile(cropPagePath);
        } catch (err) {
          console.error('Failed to delete temp crop page:', err);
        }

        const articleName = deriveArticleName(currentFilePath);
        const count = await ClipService.addImageClip(
          destPath,
          articleName,
          rect.width,
          rect.height,
          currentFilePath || undefined,
          currentPageNum
        );
        ToastAndroid.show(`Region cropped! (${count} clips aggregated)`, ToastAndroid.SHORT);
        cropActiveRef.current = false;
        setIsCropping(false);
        ClipService.clearPendingCropShot();
        // Automatically close plugin view to return back to the document
        PluginManager.closePluginView();
      } else {
        ToastAndroid.show('Crop failed. Please try again.', ToastAndroid.SHORT);
      }
    } catch (err: any) {
      ToastAndroid.show(`Crop failed: ${err.message}`, ToastAndroid.SHORT);
    }
  };

  // Enter the drag-to-place flow for a single clip (text or image): render the current note page
  // into the crop overlay (reusing all its multi-layer render logic) and switch the overlay to
  // placement mode. The box the user draws is routed to placeSingleTextClip / placeSingleImageClip
  // via the overlay's onSave (handleCropOverlaySave branches on the clip's content).
  const startManualPlacement = async (clip: ClipItem) => {
    setPendingPlaceClip(clip);
    setCropMode('placeText');
    await handleStartCropping(currentFilePath || undefined, currentPageNum);
  };

  // UUIDs currently on a page — snapshot BEFORE an insert so we can find the NEW elements after.
  const snapshotPageUuids = async (notePath: string, page: number): Promise<Set<string>> => {
    const set = new Set<string>();
    try {
      const { PluginFileAPI } = require('sn-plugin-lib');
      const res = await PluginFileAPI.getElements(page, notePath) as any;
      if (res && res.success && Array.isArray(res.result)) {
        for (const el of res.result) if (el && el.uuid) set.add(el.uuid);
      }
    } catch (e) { /* best-effort */ }
    return set;
  };

  // numInPage of elements added since the `before` snapshot — the targets a one-tap undo deletes.
  const capturedNewNums = async (notePath: string, page: number, before: Set<string>): Promise<number[]> => {
    try {
      const { PluginFileAPI } = require('sn-plugin-lib');
      const res = await PluginFileAPI.getElements(page, notePath) as any;
      if (res && res.success && Array.isArray(res.result)) {
        return res.result
          .filter((el: any) => el && el.uuid && !before.has(el.uuid) && typeof el.numInPage === 'number')
          .map((el: any) => el.numInPage as number);
      }
    } catch (e) { /* best-effort */ }
    return [];
  };

  // Record the one-tap undo for a just-placed single clip. When auto-remove is on we keep the
  // clip's backing file (so undo can fully restore it); otherwise the clip is still in FlipClip
  // and undo only removes the note element(s).
  const recordPlacementUndo = async (notePath: string, page: number, nums: number[], clip: ClipItem, autoRemove: boolean) => {
    let snapshots: ClipItem[] = [];
    if (autoRemove) {
      snapshots = await ClipService.removeClipsKeepingFiles([clip.id]);
    }
    await ClipService.recordInsertUndo({ notePath, page, nums, clips: snapshots });
    setClips(ClipService.getClipsSync());
  };

  // Remember the last placement box (page-pixel rect) so the next placement starts from it
  // instead of a fresh 60%-centered box.
  const lastPlaceRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  // Insert the pending text clip at the box the user drew (rect is in page-pixel space, which is
  // exactly the coordinate space insertText uses). The box sets the start/left/width; the height
  // auto-grows to fit the text so nothing is clipped if the box was drawn short.
  const placeSingleTextClip = async (rect: { x: number; y: number; width: number; height: number }) => {
    const clip = pendingPlaceClip;
    const tempPage = cropPagePath;
    const cleanup = () => {
      if (tempPage) {
        const { FileUtils } = require('sn-plugin-lib');
        FileUtils.deleteFile(tempPage).catch(() => {});
      }
      setCropPagePath(null);
      setPendingPlaceClip(null);
      setCropMode('region');
      cropActiveRef.current = false;
      setIsCropping(false);
    };

    if (!clip) { cleanup(); PluginManager.closePluginView(); return; }

    const allowed = await ensurePermissions('Placing text', [
      { permission: FILE_READ, desc: 'FlipClip needs read access to place text on the current note page.' },
    ]);
    if (!allowed) { cleanup(); PluginManager.closePluginView(); return; }

    try {
      const { PluginNoteAPI } = require('sn-plugin-lib');
      const notePath = currentFilePath as string;
      const page = currentPageNum;

      const text = (clip.elements || [])
        .filter((e) => e.type === 'text' && !!e.text)
        .map((e) => e.text)
        .join('\n\n')
        .trim();
      if (!text) {
        ToastAndroid.show('Nothing to place.', ToastAndroid.SHORT);
        cleanup();
        PluginManager.closePluginView();
        return;
      }

      const fontSize = insertFontSize;
      const lineHeight = Math.round(fontSize * 1.2);
      const descenderPad = Math.round(lineHeight * 0.35);
      const left = Math.max(0, Math.round(rect.x));
      const top = Math.max(0, Math.round(rect.y));
      const width = Math.max(fontSize * 4, Math.round(rect.width));
      const charsPerLine = Math.max(1, Math.floor(width / (fontSize * 0.5)));
      const wrap = measureWrappedText(text, charsPerLine);
      const estH = wrap.lines * lineHeight;
      const boxH = Math.max(Math.round(rect.height), estH + descenderPad);
      lastPlaceRectRef.current = { x: left, y: top, width, height: boxH };

      const beforeUuids = await snapshotPageUuids(notePath, page);
      await PluginNoteAPI.saveCurrentNote();
      await PluginNoteAPI.insertText({
        textContentFull: text,
        textRect: { left, top, right: left + width, bottom: top + boxH },
        fontSize,
        textAlign: 0,
        textBold: 0,
        textItalics: 0,
        textFrameWidthType: 0,
        textFrameStyle: 0,
        textEditable: 1,
      });

      // Optional ↗ jump link to the source, placed just under the box's bottom-right.
      const linkSource = await StorageService.getInsertSourceLink();
      const srcEl = (clip.elements || []).find((e) => !!e.documentPath);
      if (linkSource && srcEl && srcEl.documentPath) {
        const fontSizeLink = Math.round(fontSize * 0.8);
        const linkHeight = Math.round(fontSizeLink * 1.35);
        const iconWidth = Math.round(fontSizeLink * 1.4);
        const destPath = srcEl.documentPath;
        const destPage = srcEl.documentPage ?? 0;
        const linkType = destPath.endsWith('.note') || destPath.endsWith('.not')
          ? (srcEl.documentPage !== undefined ? 0 : 1)
          : 2;
        const iconTop = top + boxH + Math.round(lineHeight * 0.2);
        try {
          await PluginNoteAPI.insertTextLink({
            destPath,
            destPage: destPage || 0,
            style: 0,
            linkType,
            rect: { left: left + width - iconWidth, top: iconTop, right: left + width, bottom: iconTop + linkHeight },
            fontSize: fontSizeLink,
            fullText: '↗',
            showText: '↗',
            isItalic: 0,
          });
        } catch (e) { /* link is best-effort; the text is already placed */ }
      }

      await PluginNoteAPI.saveCurrentNote();

      const nums = await capturedNewNums(notePath, page, beforeUuids);
      const autoRemove = await StorageService.getAutoRemoveInserted();
      await recordPlacementUndo(notePath, page, nums, clip, autoRemove);
      ToastAndroid.show('Text placed! (double-tap → Undo to remove)', ToastAndroid.SHORT);
    } catch (e: any) {
      if (!reportPermissionError(e)) {
        ToastAndroid.show(`Place failed: ${e.message}`, ToastAndroid.SHORT);
      }
    } finally {
      cleanup();
      PluginManager.closePluginView();
    }
  };

  // Place a single IMAGE clip at the box the user drew (rect in page-pixel space = the space
  // insertImage/modifyElements use). The image is scaled to FIT inside the box preserving aspect,
  // and never upscaled past its source (upscaling makes the note's OpenCV resize read past the
  // bitmap and crash the note app). The user can draw the box over existing content to overlay,
  // or clear of it to avoid overlap — so there is always "room".
  const placeSingleImageClip = async (rect: { x: number; y: number; width: number; height: number }) => {
    const clip = pendingPlaceClip;
    const tempPage = cropPagePath;
    const cleanup = () => {
      if (tempPage) {
        const { FileUtils } = require('sn-plugin-lib');
        FileUtils.deleteFile(tempPage).catch(() => {});
      }
      setCropPagePath(null);
      setPendingPlaceClip(null);
      setCropMode('region');
      cropActiveRef.current = false;
      setIsCropping(false);
    };

    const imgEl = clip?.elements?.find((e) => e.type === 'image' && !!e.imagePath);
    if (!clip || !imgEl || !imgEl.imagePath) { cleanup(); PluginManager.closePluginView(); return; }

    const allowed = await ensurePermissions('Placing the image', [
      { permission: FILE_READ, desc: 'FlipClip needs read access to lay out the image on the note page.' },
      { permission: FILE_WRITE, desc: 'FlipClip needs write access to place the image in your note.' },
    ]);
    if (!allowed) { cleanup(); PluginManager.closePluginView(); return; }

    try {
      const { PluginNoteAPI, PluginFileAPI, PluginCommAPI, FileUtils } = require('sn-plugin-lib');
      const fileRes = await PluginCommAPI.getCurrentFilePath();
      const notePath = (fileRes && fileRes.success && fileRes.result) ? fileRes.result : currentFilePath;
      const pageRes = await PluginCommAPI.getCurrentPageNum();
      const targetPage = (pageRes && pageRes.success && pageRes.result !== undefined && pageRes.result !== null) ? pageRes.result : currentPageNum;

      const left = Math.max(0, Math.round(rect.x));
      const top = Math.max(0, Math.round(rect.y));
      const boxW = Math.max(1, Math.round(rect.width));
      const boxH = Math.max(1, Math.round(rect.height));
      lastPlaceRectRef.current = { x: left, y: top, width: boxW, height: boxH };

      const beforeUuids = await snapshotPageUuids(notePath, targetPage);
      await PluginNoteAPI.saveCurrentNote();
      await PluginNoteAPI.insertImage(imgEl.imagePath);
      await PluginNoteAPI.saveCurrentNote();

      const lastRes = await PluginFileAPI.getLastElement() as any;
      const el = (lastRes && lastRes.result) ? lastRes.result : null;
      if (el && el.type === 200 && el.picture && el.picture.rect) {
        const r = el.picture.rect;
        const natW = r.right - r.left;
        const natH = r.bottom - r.top;
        if (natW > 0 && natH > 0) {
          const scale = Math.min(boxW / natW, boxH / natH, 1); // never upscale past source
          const targetW = Math.max(1, Math.round(natW * scale));
          const targetH = Math.max(1, Math.round(natH * scale));
          const picturePath = el.picture.picturePath;
          if (picturePath && !(await FileUtils.exists(picturePath))) {
            try { await FileUtils.copyFile(imgEl.imagePath, picturePath); } catch (e) { /* fall through */ }
          }
          const modified = {
            ...el,
            pageNum: targetPage,
            layerNum: 0,
            picture: { ...el.picture, rect: { left, top, right: left + targetW, bottom: top + targetH } },
          };
          const modRes = await PluginFileAPI.modifyElements(notePath, targetPage, [modified]) as any;
          if (modRes && modRes.success === false && PermissionService.isPermissionError(modRes)) {
            reportPermissionError(modRes);
          }
          await PluginNoteAPI.saveCurrentNote();
        }
      }

      const nums = await capturedNewNums(notePath, targetPage, beforeUuids);
      const autoRemove = await StorageService.getAutoRemoveInserted();
      await recordPlacementUndo(notePath, targetPage, nums, clip, autoRemove);
      ToastAndroid.show('Image placed! (double-tap → Undo to remove)', ToastAndroid.SHORT);
    } catch (e: any) {
      if (!reportPermissionError(e)) {
        ToastAndroid.show(`Place failed: ${e.message}`, ToastAndroid.SHORT);
      }
    } finally {
      cleanup();
      PluginManager.closePluginView();
    }
  };

  // Routes the crop overlay's save to the right action for the current mode (and clip content).
  const handleCropOverlaySave = (rect: { x: number; y: number; width: number; height: number }) => {
    if (cropMode === 'placeText') {
      const hasImage = !!pendingPlaceClip?.elements?.some((e) => e.type === 'image' && !!e.imagePath);
      if (hasImage) placeSingleImageClip(rect);
      else placeSingleTextClip(rect);
    } else {
      runCropSave(rect);
    }
  };

  const handleCancelCropping = () => {
    cropActiveRef.current = false;
    setIsCropping(false);
    // Reset placement mode so a cancelled placement doesn't leak into the next region crop.
    setCropMode('region');
    setPendingPlaceClip(null);
    ClipService.clearPendingCropShot();
    // Don't leave the full-page capture (potentially sensitive document content) on disk
    // when the user abandons the crop.
    if (cropPagePath) {
      const { FileUtils } = require('sn-plugin-lib');
      FileUtils.deleteFile(cropPagePath).catch((err: any) =>
        console.error('Failed to delete temp crop page on cancel:', err)
      );
      setCropPagePath(null);
    }
    PluginManager.closePluginView();
  };

  const handleInsertVisible = async () => {
    await runInsertClips(processedClips);
  };

  const handleInsertSelected = async () => {
    const selectedClips = clips.filter((c) => selectedIds.includes(c.id));
    selectedClips.sort((a, b) => a.timestamp - b.timestamp);
    await runInsertClips(selectedClips);
    handleCancel();
  };

  const runInsertClips = async (clipsToInsert: ClipItem[]) => {
    if (clipsToInsert.length === 0) return;

    // Manual placement: for a SINGLE clip going into a note (text-only OR image-only), let the
    // user drag a box to position it — so they can overlay existing content or size it to avoid
    // overlap, and there is always "room". Batches and non-note targets keep the proven
    // auto-layout engine below. (Opt-out in Settings.)
    if (placeTextManually && clipsToInsert.length === 1 && !insertingRef.current) {
      const only = clipsToInsert[0];
      const els = only.elements || [];
      const textOnly = els.length > 0 && els.every((e) => e.type === 'text' && !!e.text && e.text.trim().length > 0);
      const imageOnly = els.length > 0 && els.every((e) => e.type === 'image' && !!e.imagePath);
      const noteTarget = !!currentFilePath && checkIsNoteFile(currentFilePath);
      if ((textOnly || imageOnly) && noteTarget) {
        startManualPlacement(only);
        return;
      }
    }

    if (insertingRef.current) return; // ignore re-entrant taps while an insert is in progress
    // Claim the guard BEFORE the first await: the permission gate below is async, and two
    // quick taps would otherwise both get past this check and insert twice.
    insertingRef.current = true;
    setIsInserting(true);

    // Insert always reads the page layout (getElements/getPageSize are both FILE:READ-gated
    // in the host), but WRITE is only needed for image clips.
    //
    // Verified against the host's own enforcement (HostCommImpl.checkFileWritePermission):
    // the note-editing APIs that act on the CURRENTLY OPEN file — insertText, insertTextLink,
    // insertImage, saveCurrentNote — carry no permission check at all. Only APIs that take a
    // file path are gated, and the one this flow uses is modifyElements(notePath, ...), called
    // solely to reposition an image after insertImage. So a text-only insert that asked for
    // WRITE would prompt for a permission it never uses, and would refuse to run for anyone
    // who denied it.
    const needsWrite = clipsToInsert.some(clipHasImage);
    const requests = [
      { permission: FILE_READ, desc: 'FlipClip needs read access to lay out clips on the current note page.' },
    ];
    if (needsWrite) {
      requests.push({ permission: FILE_WRITE, desc: 'FlipClip needs write access to place images in your note.' });
    }
    const allowed = await ensurePermissions('Inserting clips', requests);
    if (!allowed) {
      insertingRef.current = false;
      setIsInserting(false);
      return;
    }
    try {
      const { PluginCommAPI, PluginFileAPI, PluginNoteAPI } = require('sn-plugin-lib');
      
      const fileRes = await PluginCommAPI.getCurrentFilePath();
      if (!fileRes.success || !fileRes.result) {
        ToastAndroid.show('Insert failed: No active file.', ToastAndroid.SHORT);
        return;
      }
      const notePath = fileRes.result;
      const pageRes = await PluginCommAPI.getCurrentPageNum();
      let currentPage = (pageRes.success && pageRes.result !== undefined && pageRes.result !== null) ? pageRes.result : 0;

      let totalPages = 1;
      try {
        const totRes = await PluginFileAPI.getNoteTotalPageNum(notePath) as any;
        if (totRes && totRes.success && typeof totRes.result === 'number') {
          totalPages = totRes.result;
        }
      } catch (e) { /* fallback */ }
      let currentTotalPages = Math.max(totalPages, currentPage + 1);

      // Read settings FRESH from storage
      const autoRemove = await StorageService.getAutoRemoveInserted();
      const combine = await StorageService.getCombineInserted();
      const linkSource = await StorageService.getInsertSourceLink();

      await PluginNoteAPI.saveCurrentNote();

      const fontSize = insertFontSize;
      const lineHeight = Math.round(fontSize * 1.2);
      const gap = Math.round(lineHeight * 0.6);
      // Text boxes render their glyphs inset from the frame's left edge; images draw
      // edge-to-edge. To line images up with text (and clear the note's left toolbar), inset the
      // image left by this much. Scaled to the font (calibrated on Manta: font 44 → ~26px inset,
      // ≈0.6·fontSize) so it tracks the user's font choice; may need per-device tuning (e.g. Nomad).
      const imageLeftInset = Math.round(fontSize * 0.6);
      const MIN_SPLIT_LINES = 3;

      // Flatten clips into an ordered list of element "items", tagging each with its clip id
      const items: {
        clipId: string;
        type: 'text' | 'image';
        text?: string;
        imagePath?: string;
        width?: number;
        height?: number;
        documentPath?: string;
        documentPage?: number;
        articleName?: string;
      }[] = [];
      const elemCountByClip: Record<string, number> = {};
      for (const clip of clipsToInsert) {
        for (const el of clip.elements) {
          items.push({
            clipId: clip.id,
            type: el.type,
            text: el.text,
            imagePath: el.imagePath,
            width: el.width,
            height: el.height,
            documentPath: el.documentPath,
            documentPage: el.documentPage,
            articleName: el.articleName || clip.articleName
          });
          elemCountByClip[clip.id] = (elemCountByClip[clip.id] || 0) + 1;
        }
      }

      const fontSizeLink = Math.round(fontSize * 0.8);
      const linkHeight = Math.round(fontSizeLink * 1.35);
      const linkSpace = linkHeight + gap;
      const linkGap = Math.round(lineHeight * 0.2);
      const JUMP_ICON = '↗';
      const iconWidth = Math.round(fontSizeLink * 1.4);
      const charWidthPx = fontSize * 0.5;

      const { FileUtils } = require('sn-plugin-lib');

      const performInsertJumpIcon = async (destPath: string, destPage: number, topY: number, rightMargin: number) => {
        const linkType = destPath.endsWith('.note') || destPath.endsWith('.not')
          ? (destPage !== undefined ? 0 : 1)
          : 2;
        await PluginNoteAPI.insertTextLink({
          destPath,
          destPage: destPage || 0,
          style: 0,
          linkType,
          rect: { left: rightMargin - iconWidth, top: topY, right: rightMargin, bottom: topY + linkHeight },
          fontSize: fontSizeLink,
          fullText: JUMP_ICON,
          showText: JUMP_ICON,
          isItalic: 0,
        });
      };

      const performInsertLabeledLink = async (destPath: string, destPage: number, articleNameStr: string, topY: number, maxW: number) => {
        const pageNum = destPage !== undefined ? destPage + 1 : 1;
        const cleanName = (articleNameStr || 'Unknown Document').replace(/\.[^/.]+$/, '');
        const shortenedName = cleanName.length > 24 ? cleanName.substring(0, 23) + '…' : cleanName;
        const labelText = `[${shortenedName}, p. ${pageNum} ↗]`;
        const linkType = destPath.endsWith('.note') || destPath.endsWith('.not')
          ? (destPage !== undefined ? 0 : 1)
          : 2;
        await PluginNoteAPI.insertTextLink({
          destPath,
          destPage: destPage || 0,
          style: 0,
          linkType,
          rect: { left: 100, top: topY, right: 100 + maxW, bottom: topY + linkHeight },
          fontSize: fontSizeLink,
          fullText: labelText,
          showText: labelText,
          isItalic: 0,
        });
      };

      const placeJumpIconForBlock = async (
        boxTop: number,
        lines: number,
        lastLineChars: number,
        links: { path: string; page: number }[],
        maxW: number,
      ): Promise<number> => {
        const contentBottom = boxTop + lines * lineHeight;
        const [primary, ...rest] = links;
        const lastLineTop = boxTop + (lines - 1) * lineHeight;
        const lastWordRight = 100 + Math.round(lastLineChars * charWidthPx);
        const iconLeft = (100 + maxW) - iconWidth;
        const rightMargin = 100 + maxW;
        const fitsInline = lastWordRight + Math.round(charWidthPx) <= iconLeft;
        let y: number;
        if (fitsInline) {
          await performInsertJumpIcon(primary.path, primary.page, lastLineTop + Math.round((lineHeight - linkHeight) / 2), rightMargin);
          y = contentBottom;
        } else {
          const iconTop = contentBottom + linkGap;
          await performInsertJumpIcon(primary.path, primary.page, iconTop, rightMargin);
          y = iconTop + linkHeight;
        }
        for (const link of rest) {
          const iconTop = y + linkGap;
          await performInsertJumpIcon(link.path, link.page, iconTop, rightMargin);
          y = iconTop + linkHeight;
        }
        return y + gap;
      };

      const getUniqueLinksSync = (groupItems: typeof items) => {
        const keys = new Set<string>();
        for (const item of groupItems) {
          if (item.documentPath) {
            keys.add(`${item.documentPath}#${item.documentPage || 0}`);
          }
        }
        return keys.size;
      };

      const getValidLinksForGroup = async (groupItems: typeof items) => {
        const uniqueLinksMap = new Map<string, { path: string; page: number; articleName: string }>();
        for (const item of groupItems) {
          if (item.documentPath) {
            const exists = await FileUtils.exists(item.documentPath);
            if (exists) {
              const key = `${item.documentPath}#${item.documentPage || 0}`;
              uniqueLinksMap.set(key, {
                path: item.documentPath,
                page: item.documentPage || 0,
                articleName: item.articleName || 'Unknown Document',
              });
            } else {
              try {
                const matchClip = clips.find(c => c.id === item.clipId);
                if (matchClip && matchClip.elements) {
                  const elemIdx = matchClip.elements.findIndex(
                    el => el.documentPath === item.documentPath && el.documentPage === item.documentPage
                  );
                  if (elemIdx !== -1) {
                    await ClipService.removeLinkFromElement(matchClip.id, elemIdx);
                  }
                }
              } catch (e) {}
            }
          }
        }
        return Array.from(uniqueLinksMap.values());
      };

      const getImageDimensions = (imagePath: string): Promise<{ width: number; height: number }> => {
        return new Promise((resolve) => {
          const uri = imagePath.startsWith('file://') ? imagePath : `file://${imagePath}`;
          Image.getSize(
            uri,
            (width, height) => resolve({ width, height }),
            () => resolve({ width: 0, height: 0 })
          );
        });
      };

      // Bottom-most Y an element occupies, for deciding where the next insert starts.
      //
      // The `pageHeight - 120` bound on maxY/recognition values is a digitizer-noise guard
      // (item 8a): stroke elements can report a maxY far past the page — link elements were
      // measured reporting maxY≈16224 on a 2560-tall page — and letting such a value through
      // would push the start-Y off the page and make everything look like it "doesn't fit".
      // The pre-item-8 code avoided this by ignoring strokes (type 0) and text-links (type 600)
      // outright; strokes are now included deliberately so inserts land BELOW handwriting
      // rather than on top of it, with the clamp doing the filtering instead.
      const getElemBottom = (el: any, pageHeight: number): number => {
        if (!el) return 0;
        if (el.status === -1 || el.status === 2) return 0; // Skip explicitly deleted elements

        // Ignore a page-background / template element. These come back from getElements with a
        // rect spanning the ENTIRE page; counting one as occupied content pins the start-Y at the
        // bottom and makes a nearly-empty page report "no room" (the reported "no space" bug). A
        // real full-page drawing is rare; the trade is worth not blocking inserts on blank pages.
        const primaryRect = (el.picture && el.picture.rect) || (el.textBox && el.textBox.textRect) || el.textRect || null;
        if (primaryRect && typeof primaryRect.top === 'number' && typeof primaryRect.bottom === 'number') {
          const spansPage = primaryRect.top <= pageHeight * 0.05 && primaryRect.bottom >= pageHeight * 0.95;
          if (spansPage) return 0;
        }

        let bottom = 0;

        // 1. Text boxes (500, 501, 502)
        if (el.textBox && el.textBox.textRect && typeof el.textBox.textRect.bottom === 'number') {
          bottom = Math.max(bottom, el.textBox.textRect.bottom);
        }
        if (el.textRect && typeof el.textRect.bottom === 'number') {
          bottom = Math.max(bottom, el.textRect.bottom);
        }

        // 2. Pictures (200)
        if (el.picture && el.picture.rect && typeof el.picture.rect.bottom === 'number') {
          bottom = Math.max(bottom, el.picture.rect.bottom);
        }

        // 3. Titles (100)
        if (el.title) {
          bottom = Math.max(bottom, (el.title.Y || 0) + (el.title.height || 0));
        }

        // 4. Links (600)
        if (el.link) {
          bottom = Math.max(bottom, (el.link.Y || 0) + (el.link.height || 0));
        }

        // 5. Recognition bounds (handwriting strokes & recognized titles)
        const rr = el.recognizeResult;
        if (rr && typeof rr.down_right_point_y === 'number' && rr.down_right_point_y > 0) {
          if (rr.down_right_point_y <= pageHeight - 120) {
            bottom = Math.max(bottom, rr.down_right_point_y);
          }
        }

        // 6. Direct maxY (strokes & geometries)
        if (typeof el.maxY === 'number' && el.maxY > 0 && el.maxY <= pageHeight - 120) {
          bottom = Math.max(bottom, el.maxY);
        }

        // 7. General Y + height fallback
        if (typeof el.Y === 'number' && typeof el.height === 'number' && el.height > 0) {
          const yBottom = el.Y + el.height;
          if (yBottom <= pageHeight - 120) {
            bottom = Math.max(bottom, yBottom);
          }
        }

        return bottom;
      };


      // Insert an image and position it at the given rect. Supernote's insertImage centers the
      // image by default; the recipe to place it: insert → save → getLastElement → recreate the
      // element's backing PNG (deleted after save, else code 1211) from our clip image →
      // modifyElements with pageNum/layerNum set (else code 107) + the target rect → save.
      // CRITICAL: the size is derived from the element's OWN natural rect and NEVER upscaled —
      // asking the note to render an image larger than its source PNG makes its OpenCV resize
      // read past the image bounds and crash the note app (cv::Exception ROI assertion).
      // Returns the placed height on success, or null (image left centered) on failure.
      const insertPositionedImage = async (
        imagePath: string,
        top: number,
        maxW: number,
        maxH: number,
        targetPage: number,
      ): Promise<number | null> => {
        const attemptInsert = async (): Promise<{ success: boolean; targetH?: number; misdropped?: boolean; misdropNum?: number }> => {
          await PluginNoteAPI.insertImage(imagePath);
          await PluginNoteAPI.saveCurrentNote();
          try {
            const lastRes = await PluginFileAPI.getLastElement() as any;
            const el = (lastRes && lastRes.result) ? lastRes.result : null;
            if (el && el.type === 200 && el.picture && el.picture.rect) {
              // Verify it landed on the intended target page
              if (el.pageNum !== undefined && el.pageNum !== targetPage) {
                return { success: false, misdropped: true, misdropNum: el.numInPage };
              }
              const r = el.picture.rect;
              const natW = r.right - r.left, natH = r.bottom - r.top;
              if (natW <= 0 || natH <= 0) return { success: false };
              // Never scale above 1 (no upscale) → the target never exceeds the source PNG.
              const scale = Math.min(maxW / natW, maxH / natH, 1);
              const targetW = Math.max(1, Math.round(natW * scale));
              const targetH = Math.max(1, Math.round(natH * scale));
              const picturePath = el.picture.picturePath;
              if (picturePath && !(await FileUtils.exists(picturePath))) {
                try { await FileUtils.copyFile(imagePath, picturePath); } catch (e) { /* fall through */ }
              }
              // Inset the image left to align with the text's visual left (see imageLeftInset).
              const imgLeft = 100 + imageLeftInset;
              const modified = {
                ...el, pageNum: targetPage, layerNum: 0,
                picture: { ...el.picture, rect: { left: imgLeft, top, right: imgLeft + targetW, bottom: top + targetH } },
              };
              const modRes = await PluginFileAPI.modifyElements(notePath, targetPage, [modified]) as any;
              if (modRes && modRes.success === false && PermissionService.isPermissionError(modRes)) {
                reportPermissionError(modRes);
                return { success: false };
              }
              await PluginNoteAPI.saveCurrentNote();
              return (modRes && modRes.success) ? { success: true, targetH } : { success: false };
            }
          } catch (e: any) {
            if (PermissionService.isPermissionError(e)) {
              reportPermissionError(e);
            }
          }
          return { success: false };
        };

        // Try insert once
        let res = await attemptInsert();
        if (!res.success && res.misdropped) {
          // Clean up misdropped element if we have its num
          if (res.misdropNum) {
            try {
              const curPgRes = await PluginCommAPI.getCurrentPageNum() as any;
              const actualPg = (curPgRes && curPgRes.success) ? curPgRes.result : (targetPage > 0 ? targetPage - 1 : 0);
              await PluginFileAPI.deleteElements(notePath, actualPg, [res.misdropNum]);
              await PluginNoteAPI.saveCurrentNote();
            } catch (delErr) {}
          }
          // Re-verify and re-jump to target page
          await PluginCommAPI.jumpToPage(targetPage);
          await pollForTargetPage(targetPage, 2000);
          // Retry once
          res = await attemptInsert();
        }

        return (res.success && res.targetH !== undefined) ? res.targetH : null;
      };

      let i = 0;
      const insertedCountByClip: Record<string, number> = {};
      const splitRemainder: Record<string, string> = {};
      let attemptedInserts = 0;
      // Counts new elements that actually persisted, summed over the pages we touched. Guards
      // auto-remove: we must NEVER delete clip content that didn't land in the note (image
      // inserts can silently drop). Verified per page, since the page loop re-snapshots
      // beforeIds each time it moves on.
      let persistedNew = 0;
      // Bound the page loop so a pathological batch cannot walk the whole note. Hitting this
      // is reported rather than looking like a normal finish (see budgetExhausted below).
      let pageBudget = 20;
      let budgetExhausted = false;
      let stoppedEarlyOutOfSpace = false;

      while (i < items.length && pageBudget > 0) {
        pageBudget--;
        if (pageBudget === 0 && i < items.length) budgetExhausted = true;

        let pageWidth = 1404;
        let pageHeight = 1872;
        try {
          const sizeRes = await PluginFileAPI.getPageSize(notePath, currentPage) as any;
          if (sizeRes && sizeRes.success && sizeRes.result) {
            pageWidth = sizeRes.result.width;
            pageHeight = sizeRes.result.height;
          }
        } catch (e) {}

        const maxWidth = pageWidth - 200;
        const charsPerLine = Math.max(1, Math.floor(maxWidth / (fontSize * 0.5)));
        const estimateTextLines = (t: string) => countWrappedLines(t, charsPerLine);
        const estimateTextHeight = (linesCount: number) => linesCount * lineHeight;
        const boxDescenderPad = Math.round(lineHeight * 0.35);

        const insertTextBox = async (content: string, top: number, height: number) => {
          await PluginNoteAPI.insertText({
            textContentFull: content,
            textRect: { left: 100, top, right: 100 + maxWidth, bottom: top + height + boxDescenderPad },
            fontSize,
            textAlign: 0,
            textBold: 0,
            textItalics: 0,
            textFrameWidthType: 0,
            textFrameStyle: 0,
            textEditable: 1,
          });
        };

        let currentY = 100;
        const beforeIds = new Set<string>();
        const attemptedAtPageStart = attemptedInserts;
        let existingImageCount = 0;

        const elementsRes = await PluginFileAPI.getElements(currentPage, notePath) as any;
        if (elementsRes && elementsRes.success && Array.isArray(elementsRes.result)) {
          for (const el of elementsRes.result) {
            if (el.uuid) beforeIds.add(el.uuid);
            if (el.type === 200) existingImageCount++;
            const elBottom = getElemBottom(el, pageHeight);
            if (elBottom > currentY && elBottom <= pageHeight) {
              currentY = elBottom;
            }
          }
        }
        if (currentY > 100) {
          currentY += gap;
        }

        let pageHasContent = currentY > 100 || existingImageCount > 0;

        while (i < items.length) {
          const item = items[i];

          if (item.type === 'image') {
            if (!item.imagePath) {
              insertedCountByClip[item.clipId] = (insertedCountByClip[item.clipId] || 0) + 1;
              i++;
              continue;
            }

            // 8b: Upfront real image dimension reading
            let imgW = item.width || 0;
            let imgH = item.height || 0;
            if (!imgW || !imgH) {
              const dims = await getImageDimensions(item.imagePath);
              if (dims.width > 0 && dims.height > 0) {
                imgW = dims.width;
                imgH = dims.height;
              }
            }

            const availHeight = (pageHeight - gap) - currentY;
            const fullPageAvail = (pageHeight - gap) - 100;
            const maxW = maxWidth - imageLeftInset;

            const targetW = imgW > 0 ? Math.min(maxW, imgW) : maxW;
            const targetH = imgH > 0 && imgW > 0 ? Math.round(imgH * (targetW / imgW)) : 400;
            const linkReserve = (item.documentPath && linkSource) ? linkSpace : 0;
            const requiredHeight = targetH + linkReserve;

            // If page already has content and requiredHeight doesn't fit in remaining space:
            // defer immediately to next page (no guessFitH squeezing!)
            if (pageHasContent && requiredHeight > availHeight) {
              break; // move to next page
            }

            // If on a fresh page, scale down to fit full page if necessary
            const maxH = Math.max(1, (pageHasContent ? availHeight : fullPageAvail) - linkReserve);
            const top = currentY;
            const placedH = await insertPositionedImage(item.imagePath, top, maxW, maxH, currentPage);
            attemptedInserts++;
            insertedCountByClip[item.clipId] = (insertedCountByClip[item.clipId] || 0) + 1;
            pageHasContent = true;
            await new Promise(r => setTimeout(r, 200));
            i++;
            if (placedH === null) {
              break;
            }
            currentY = top + placedH;
            if (item.documentPath && linkSource) {
              const validLinks = await getValidLinksForGroup([item]);
              if (validLinks.length > 0) {
                const iconTop = currentY + linkGap;
                await performInsertJumpIcon(validLinks[0].path, validLinks[0].page, iconTop, 100 + maxWidth);
                currentY = iconTop + linkHeight;
              }
            }
            currentY += gap;
            continue;
          }

          if (!item.text || !item.text.trim()) {
            insertedCountByClip[item.clipId] = (insertedCountByClip[item.clipId] || 0) + 1;
            i++;
            continue;
          }

          const availHeight = (pageHeight - gap) - currentY;

          if (combine) {
            const group: typeof items = [];
            let groupLines = 0;
            let j = i;
            while (j < items.length && items[j].type === 'text' && items[j].text) {
              const tempGroup = [...group, items[j]];
              const tempCombined = tempGroup.map((g) => g.text).join('\n\n');
              const tempGroupLines = estimateTextLines(tempCombined);
              const tempGroupHeight = estimateTextHeight(tempGroupLines);
              const linkCount = getUniqueLinksSync(tempGroup);
              const totalBlockHeight = tempGroupHeight + (linkCount * linkSpace);
              if (group.length === 0) {
                if (totalBlockHeight > availHeight) break;
              } else if (totalBlockHeight > availHeight) {
                break;
              }
              group.push(items[j]);
              groupLines = tempGroupLines;
              j++;
            }
            if (group.length > 0) {
              const combined = group.map((g) => g.text).join('\n\n');
              const combinedWrap = measureWrappedText(combined, charsPerLine);
              const groupHeight = combinedWrap.lines * lineHeight;
              await insertTextBox(combined, currentY, groupHeight);
              attemptedInserts++;
              group.forEach((g) => {
                insertedCountByClip[g.clipId] = (insertedCountByClip[g.clipId] || 0) + 1;
                // This item may be a previously-split element whose leftover tail just got
                // fully absorbed into this combined box — clear it so a stale remainder can't
                // leak onto a later, unrelated element of the same (merged) clip.
                delete splitRemainder[g.clipId];
              });

              const validLinks = linkSource ? await getValidLinksForGroup(group) : [];
              if (validLinks.length > 0) {
                let ny = currentY + groupHeight + linkGap;
                for (const link of validLinks) {
                  await performInsertLabeledLink(link.path, link.page, link.articleName, ny, maxWidth);
                  ny += linkSpace;
                }
                currentY = ny;
              } else {
                currentY = currentY + groupHeight + gap;
              }
              pageHasContent = true;
              i = j;
              await new Promise(r => setTimeout(r, 200));
              break;
            }
          }

          // Single text item
          const t = item.text;
          const wrap = measureWrappedText(t, charsPerLine);
          const estLines = wrap.lines;
          const estH = estLines * lineHeight;
          const singleLinkCount = item.documentPath ? 1 : 0;
          const totalSingleHeight = estH + (singleLinkCount * linkSpace);

          if (totalSingleHeight <= availHeight) {
            await insertTextBox(t, currentY, estH);
            attemptedInserts++;
            insertedCountByClip[item.clipId] = (insertedCountByClip[item.clipId] || 0) + 1;
            // This item may be a previously-split element (item.text was reduced to its
            // leftover tail on an earlier page) now fully placed here — clear its stale
            // remainder so it can't leak onto a later, unrelated element of the same clip.
            delete splitRemainder[item.clipId];

            let linksInserted = false;
            if (item.documentPath && linkSource) {
              const validLinks = await getValidLinksForGroup([item]);
              if (validLinks.length > 0) {
                currentY = await placeJumpIconForBlock(currentY, estLines, wrap.lastLineChars, validLinks, maxWidth);
                linksInserted = true;
              }
            }
            if (!linksInserted) currentY = currentY + estH + gap;
            pageHasContent = true;
            i++;
            await new Promise(r => setTimeout(r, 200));
            if (combine) break;
            continue;
          } else {
            const fullPageAvail = (pageHeight - gap) - 100;
            if (!autoRemove && totalSingleHeight <= fullPageAvail) {
              break; // Defer whole clip to next page
            }
            const linesThatFit = Math.floor((availHeight - (item.documentPath ? linkSpace : 0)) / lineHeight);
            if (linesThatFit < MIN_SPLIT_LINES) {
              break; // Defer to fresh page
            }
            const charBudget = Math.floor(linesThatFit * charsPerLine * 0.9);
            const [chunk, remainder] = splitTextToFit(t, charBudget);
            if (!chunk) {
              break;
            }
            const chunkWrap = measureWrappedText(chunk, charsPerLine);
            const chunkH = chunkWrap.lines * lineHeight;
            await insertTextBox(chunk, currentY, chunkH);
            attemptedInserts++;
            if (remainder) {
              item.text = remainder;
              splitRemainder[item.clipId] = remainder;
            }

            if (item.documentPath && linkSource) {
              const validLinks = await getValidLinksForGroup([item]);
              if (validLinks.length > 0) {
                currentY = await placeJumpIconForBlock(currentY, chunkWrap.lines, chunkWrap.lastLineChars, validLinks, maxWidth);
              } else {
                currentY = currentY + chunkH + gap;
              }
            } else {
              currentY = currentY + chunkH + gap;
            }
            await PluginNoteAPI.saveCurrentNote();
            await new Promise(r => setTimeout(r, 200));
            break;
          }
        }

        await PluginNoteAPI.saveCurrentNote();

        // Count how many of this page's inserts survived the save before moving on.
        if (attemptedInserts > attemptedAtPageStart) {
          try {
            const verify = await PluginFileAPI.getElements(currentPage, notePath) as any;
            if (verify && verify.success && Array.isArray(verify.result)) {
              persistedNew += verify.result.filter((el: any) => el.uuid && !beforeIds.has(el.uuid)).length;
            }
          } catch (e) { /* best-effort */ }
        }

        if (i >= items.length) {
          break;
        }

        // Advance to next existing page or notify end of note
        const nextPage = currentPage + 1;
        if (nextPage < currentTotalPages) {
          const jumpRes = await PluginCommAPI.jumpToPage(nextPage) as any;
          if (!jumpRes || jumpRes.success === false) {
            stoppedEarlyOutOfSpace = true;
            break;
          }
          const settled = await pollForTargetPage(nextPage, 3000);
          if (!settled) {
            ToastAndroid.show('Turn the page and tap Insert to continue.', ToastAndroid.LONG);
            stoppedEarlyOutOfSpace = true;
            break;
          }
          currentPage = nextPage;
        } else {
          // Guidance modal rather than ask-then-create, by choice for 0.3.0 — NOT a platform
          // limit. insertNotePage DOES work (verified on Chauvet 3.29.44_beta: pass a rendered
          // PNG path from generateNoteTemplatePng as `template`; a style name from
          // getNotePageTemplate fails with 802). An earlier report claimed the host did not
          // implement it; that was wrong. See reports/0.3.0-insertNotePage-retest-2026-09-03.md.
          // Converting this flow to ask-then-create is deferred to 0.3.1 (design review D2).
          await askUserConfirmation(
            'Page Full',
            'No more room in this note. Add a new page to the note, then reopen FlipClip and tap Insert to continue.',
            'OK'
          );
          stoppedEarlyOutOfSpace = true;
          break;
        }
      }

      await PluginNoteAPI.saveCurrentNote();

      const allPersisted = attemptedInserts > 0 && persistedNew >= attemptedInserts;
      if (autoRemove && allPersisted) {
        const fullyInsertedIds: string[] = [];
        for (const c of clipsToInsert) {
          const inserted = insertedCountByClip[c.id] || 0;
          const total = elemCountByClip[c.id] || 0;
          const remainder = splitRemainder[c.id];
          if (remainder) {
            await ClipService.trimInsertedElements(c.id, inserted, remainder);
          } else if (total > 0 && inserted === total) {
            fullyInsertedIds.push(c.id);
          } else if (inserted > 0) {
            await ClipService.trimInsertedElements(c.id, inserted);
          }
        }
        if (fullyInsertedIds.length > 0) await ClipService.deleteClips(fullyInsertedIds);
      }

      if (i < items.length && splitRemainder[items[i]?.clipId]) {
        ToastAndroid.show(
          'Clip too long for one page, so part was inserted. Turn to a new page, then Insert again to continue.',
          ToastAndroid.LONG
        );
        PluginManager.closePluginView();
      } else if (budgetExhausted) {
        // The page loop hit its bound with clips still queued. Without this the run would
        // close exactly like a normal finish, so the user would have no idea why the batch
        // stopped or that tapping Insert again continues it.
        ToastAndroid.show(
          'Stopped after 20 pages. The remaining clips are still in FlipClip; tap Insert again to continue.',
          ToastAndroid.LONG
        );
        PluginManager.closePluginView();
      } else if (stoppedEarlyOutOfSpace || i < items.length) {
        // Page Full modal was already acknowledged by the user; close cleanly
        PluginManager.closePluginView();
      } else if (!allPersisted) {
        // Something was attempted but didn't persist. Keep the clips AND the plugin view open,
        // so the failure is visible rather than looking like a successful insert.
        ToastAndroid.show('Some clips could not be inserted; they are kept in FlipClip.', ToastAndroid.LONG);
      } else {
        ToastAndroid.show(
          autoRemove ? 'Clips inserted successfully!' : 'Clips inserted (kept in FlipClip)',
          ToastAndroid.SHORT
        );
        PluginManager.closePluginView();
      }
    } catch (e: any) {
      // A grant can expire mid-insert ("allow this time only" dies with the session), which
      // surfaces as 1501/1503 rather than a generic failure — say so, so retrying is obvious.
      if (!reportPermissionError(e)) {
        ToastAndroid.show(`Insert failed: ${e.message}`, ToastAndroid.SHORT);
      }
    } finally {
      insertingRef.current = false;
      setIsInserting(false);
    }
  };

  // Handlers for Table of Contents

  // Build/refresh the ToC on the page the reader is currently on. generateTocPage guards against
  // overwriting: it writes only to a verified-empty current page (inserting a blank first if the
  // current page has content), so nothing is ever written over existing notes.
  const runTocBuild = async () => {
    if (!currentFilePath) {
      ToastAndroid.show('No active note file open', ToastAndroid.SHORT);
      return;
    }

    // Building a ToC scans every page (getElements/getTitles/getPageSize/recognizeElements)
    // and then writes the ToC page (insertText/insertTextLink/replaceElements/deleteElements).
    const allowed = await ensurePermissions('Building the Table of Contents', [
      { permission: FILE_READ, desc: 'FlipClip needs read access to scan this note for headings.' },
      { permission: FILE_WRITE, desc: 'FlipClip needs write access to write the Table of Contents page.' },
    ]);
    if (!allowed) return;

    setTocPhase('scanning');
    setIsGeneratingToc(true);
    try {
      const res = await IndexService.generateTocPage(
        currentFilePath,
        insertFontSize,
        setTocPhase,
        // Asked once per run, only for the shortfall, and only when the headings genuinely
        // need more room. Declining is a normal answer: the ToC is written as far as it
        // fits and says so, rather than failing the build.
        async (pagesNeeded: number) => {
          // Drop the progress overlay first. It is a <Modal>, so it renders ABOVE the
          // ConfirmationDialog (a plain View) and swallows every touch — leaving the run
          // hung on a question the user cannot answer. Restore it afterwards so the rest
          // of the build still shows progress.
          setIsGeneratingToc(false);
          try {
            return await askUserConfirmation(
              'More pages needed',
              `The Table of Contents needs ${pagesNeeded} more page${pagesNeeded === 1 ? '' : 's'}. Add ${pagesNeeded === 1 ? 'it' : 'them'} to this note?`,
              'Add',
              'Not now',
            );
          } finally {
            setIsGeneratingToc(true);
          }
        },
        // Heading recognition is not reliably repeatable — the same note scanned 24, 24
        // then 16 headings on device (2026-09-04 §7) — and a short ToC looks perfectly
        // normal, so the loss is invisible. Ask before replacing a bigger ToC with a
        // smaller one. Same overlay dance as above: the Modal would eat the touches.
        //
        // Sequenced AFTER the replace confirmation below: the user agrees to lose the page
        // first, then — if the scan also came up short — decides whether it is worth it.
        async (found: number, previous: number) => {
          setIsGeneratingToc(false);
          try {
            return await askUserConfirmation(
              'Fewer headings than last time',
              `This scan found ${found} headings; the last build found ${previous}. Some titles may not have been recognised. Rebuild anyway, or keep the Table of Contents you have?`,
              'Rebuild anyway',
              'Keep existing',
            );
          } finally {
            setIsGeneratingToc(true);
          }
        },
        // Refreshing wipes the whole ToC page — clearPageElements replaces its contents
        // outright rather than removing our rows selectively — so anything the user added
        // to that page goes with it. Ask, every time (design review 2026-09-05).
        //
        // Unconditional on purpose. We tried deciding for the user by classifying each
        // element as ours-or-theirs, and it failed both ways: first refusing every refresh,
        // then silently deleting a text box reading "notes ..." because a trailing ellipsis
        // looks like a dot leader. A dialog that always appears cannot fail to appear.
        //
        // Asked before the scan, so declining is instant and touches nothing.
        async () => {
          setIsGeneratingToc(false);
          try {
            return await askUserConfirmation(
              'Replace this page?',
              'Refreshing replaces everything on this page, including anything you added since. Continue?',
              'Replace',
              'Cancel',
            );
          } finally {
            setIsGeneratingToc(true);
          }
        },
      );

      if (res.success) {
        // The ToC now lives in the note — clear the FlipClip snapshot so the ToC tab doesn't keep
        // showing a stale headings list next time FlipClip opens.
        await StorageService.clearTocState(currentFilePath);
        setHeadings([]);
        setTocUpdatedAt(null);
        ToastAndroid.show(res.message || 'Table of Contents created!', ToastAndroid.LONG);
        PluginManager.closePluginView();
      } else if (res.needsBlankPage) {
        // Blocking dialog (easy-to-miss toast won't do): the page isn't blank. OK-only.
        setConfirmTitle('Page is not blank!');
        setConfirmDescription(res.message || 'Open or add a blank page, then tap Build ToC.');
        setConfirmConfirmLabel('OK');
        setConfirmCancelLabel('');
        setOnConfirmCallback({ fn: () => setShowConfirmDialog(false) });
        setShowConfirmDialog(true);
      } else {
        if (res.error && reportPermissionError(res.error)) {
          // Permission error handled by reportPermissionError
        } else {
          ToastAndroid.show(res.message || 'Failed to generate ToC page', ToastAndroid.LONG);
        }
      }
    } catch (e: any) {
      if (!reportPermissionError(e)) {
        ToastAndroid.show('Failed to generate ToC page', ToastAndroid.LONG);
      }
    } finally {
      setIsGeneratingToc(false);
    }
  };

  const handleBuildToc = () => { runTocBuild(); };

  // ---- Floating long-press menu ----
  // List openable documents/notes/images under the device's shared-storage roots, for the
  // "Switch to… → Browse" picker. One level per root; FILE:READ-gated (declared).
  // Top-level folders for the Browse navigator, under the storage root derived from the open file.
  const browseRoots = useMemo<PickItem[]>(() => {
    let root = '/storage/emulated/0';
    if (currentFilePath) {
      const n = normalizePath(currentFilePath);
      const m = n.match(/^(.*?)\/(Document|Note|EXPORT|INBOX|MyStyle|SCREENSHOT)\//);
      if (m) root = m[1];
    }
    return ['Document', 'Note', 'EXPORT', 'INBOX'].map((d) => ({ name: d, path: `${root}/${d}`, isDir: true }));
  }, [currentFilePath]);

  // One directory level: folders first, then openable files; non-openable files are hidden.
  const listDir = useCallback(async (dir: string): Promise<PickItem[]> => {
    const { FileUtils } = require('sn-plugin-lib');
    const baseName = (p: string) => p.substring(p.lastIndexOf('/') + 1);
    const hasExt = (name: string) => /\.[a-z0-9]{1,5}$/i.test(name);
    let files: any[];
    try {
      files = await FileUtils.listFiles(dir);
    } catch (e) {
      return [];
    }
    if (!Array.isArray(files)) return [];
    const folders: PickItem[] = [];
    const docs: PickItem[] = [];
    for (const f of files) {
      // listFiles entries may be strings, {path}, {uri}, or {name} — normalize to a path.
      let p: string | null = null;
      if (typeof f === 'string') p = f;
      else if (f && typeof f.path === 'string') p = f.path;
      else if (f && typeof f.uri === 'string') p = f.uri;
      else if (f && typeof f.name === 'string') p = `${dir}/${f.name}`;
      if (!p) continue;
      const name = baseName(normalizePath(p));
      if (isOpenableFile(p)) docs.push({ path: p, name, isDir: false });
      else if (!hasExt(name)) folders.push({ path: p, name, isDir: true });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    docs.sort((a, b) => a.name.localeCompare(b.name));
    return [...folders, ...docs];
  }, []);

  // Picture Clippings / Text Clippings: open the dashboard filtered to that clip type.
  const handleFloatPictureClips = () => {
    setShowFloatMenu(false);
    setActiveTab('clips');
    setActiveSourceFilter(null);
    setSearchQuery('');
    setClipTypeFilter('image');
  };
  const handleFloatTextClips = () => {
    setShowFloatMenu(false);
    setActiveTab('clips');
    setActiveSourceFilter(null);
    setSearchQuery('');
    setClipTypeFilter('text');
  };
  const handleFloatClipRegion = () => {
    setShowFloatMenu(false);
    // Always a region crop — clear any leftover text-placement mode so routing is correct even
    // if a prior placement render failed before the overlay (and its reset paths) ran.
    setCropMode('region');
    setPendingPlaceClip(null);
    const f = currentFilePath;
    const bgShot = ClipService.getPendingCropShot();
    const freshShot = bgShot && (Date.now() - bgShot.ts < 60000);
    if (freshShot) {
      cropActiveRef.current = true;
      setCropPagePath(bgShot.path);
      setCropImageSize({ width: bgShot.width, height: bgShot.height });
      setCropLoading(false);
      setIsCropping(true);
      return;
    }
    // Render the page IN PLACE for every type (notes → layer render, images → direct crop,
    // PDFs/EPUBs → generateCurrentDocImage), so we never close and reopen the plugin view. The
    // old PDF path closed the view to screenshot the reader and reopened into crop, but on this
    // firmware the delayed showPluginView() wasn't honored — the view never came back ("Capturing
    // page…" then nothing). handleStartCropping already renders the current doc for DOC files.
    if (!f) {
      ToastAndroid.show('No document open to clip.', ToastAndroid.SHORT);
      return;
    }
    cropActiveRef.current = true;
    setIsCropping(true);
    setCropLoading(true);
    handleStartCropping(f, currentPageNum);
  };
  const handleFloatPinTarget = async (item: PickItem) => {
    await NavService.setPinnedOverride({ path: item.path, page: item.page ?? 0 });
    setFloatPinned(normalizePath(item.path));
    setShowFloatMenu(false);
    FloatingButton.refreshState();
    ToastAndroid.show(`Pinned: ${item.name}. A tap flips this ⇄ ${item.name}.`, ToastAndroid.SHORT);
    PluginManager.closePluginView();
  };

  const handleFloatUndo = async () => {
    setShowFloatMenu(false);
    const u = ClipService.getInsertUndo();
    if (!u) { PluginManager.closePluginView(); return; }
    if (!currentFilePath || normalizePath(currentFilePath) !== normalizePath(u.notePath)) {
      ToastAndroid.show('Open the note you inserted into, then undo.', ToastAndroid.LONG);
      PluginManager.closePluginView();
      return;
    }
    const allowed = await ensurePermissions('Undoing the insert', [
      { permission: FILE_READ, desc: 'FlipClip needs read access to the note to undo the insert.' },
      { permission: FILE_WRITE, desc: 'FlipClip needs write access to remove the inserted element.' },
    ]);
    if (!allowed) { PluginManager.closePluginView(); return; }
    try {
      const { PluginFileAPI, PluginNoteAPI } = require('sn-plugin-lib');
      if (u.nums && u.nums.length > 0) {
        await PluginFileAPI.deleteElements(u.notePath, u.page, u.nums);
        await PluginNoteAPI.saveCurrentNote();
      }
      if (u.clips && u.clips.length > 0) {
        await ClipService.restoreClips(u.clips);
        setClips(ClipService.getClipsSync());
      }
      ClipService.consumeInsertUndo();
      setFloatCanUndo(false);
      ToastAndroid.show('Undone.', ToastAndroid.SHORT);
    } catch (e: any) {
      if (!reportPermissionError(e)) ToastAndroid.show(`Undo failed: ${e.message}`, ToastAndroid.SHORT);
    } finally {
      PluginManager.closePluginView();
    }
  };

  const handleFloatClearOverride = async () => {
    await NavService.clearPinnedOverride();
    setFloatPinned(null);
    setShowFloatMenu(false);
    FloatingButton.refreshState();
    ToastAndroid.show('Override cleared — tapping flips the last 2 documents.', ToastAndroid.SHORT);
    PluginManager.closePluginView();
  };
  const handleFloatClose = () => {
    setShowFloatMenu(false);
    PluginManager.closePluginView();
  };

  if (showFloatMenu) {
    return (
      <FloatingMenu
        recents={floatRecents}
        pairNames={floatPairNames}
        pinnedPath={floatPinned}
        browseRoots={browseRoots}
        anchor={floatAnchor}
        onClipRegion={handleFloatClipRegion}
        onPictureClips={handleFloatPictureClips}
        onTextClips={handleFloatTextClips}
        onPinTarget={handleFloatPinTarget}
        onClearOverride={handleFloatClearOverride}
        canUndo={floatCanUndo}
        onUndo={handleFloatUndo}
        listDir={listDir}
        onClose={handleFloatClose}
      />
    );
  }

  if (showErase) {
    return (
      <View style={styles.cropRoot}>
        <EraseOverlay
          pagePath={erasePath}
          imageSize={eraseSize}
          loading={eraseLoading}
          onCancel={handleCancelErase}
          onApply={handleApplyErase}
        />
      </View>
    );
  }

  if (isCropping) {
    return (
      <View style={styles.cropRoot}>
        <CropOverlay
          pagePath={cropPagePath}
          imageSize={cropImageSize}
          loading={cropLoading}
          onCancel={handleCancelCropping}
          onSave={handleCropOverlaySave}
          title={cropMode === 'placeText' ? 'Place clip' : undefined}
          saveLabel={cropMode === 'placeText' ? 'Place here' : undefined}
          loadingLabel={cropMode === 'placeText' ? 'Preparing page…' : undefined}
          initialRect={cropMode === 'placeText' ? lastPlaceRectRef.current : null}
        />
      </View>
    );
  }

  if (showPromptDialog) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <PromptDialog
          text={promptText}
          imageLabel="Clip Region"
          textLabel="Clip Text"
          primaryAction="image"
          onClipImage={async () => {
            promptActiveRef.current = false;
            cropActiveRef.current = true;
            setShowPromptDialog(false);
            const bgShot = ClipService.getPendingCropShot();
            if (bgShot && (Date.now() - bgShot.ts < 60000)) {
              setCropPagePath(bgShot.path);
              setCropImageSize({ width: bgShot.width, height: bgShot.height });
              setCropLoading(false);
              setIsCropping(true);
            } else {
              setIsCropping(true);
              setCropLoading(true);
              handleStartCropping(currentFilePath || undefined, currentPageNum);
            }
            await ClipService.setPromptText('');
          }}
          onClipText={async () => {
            promptActiveRef.current = false;
            setShowPromptDialog(false);
            ClipService.clearPendingCropShot();
            await ClipService.setPromptText('');
            await ClipService.addClip(
              promptText,
              deriveArticleName(currentFilePath),
              currentFilePath || undefined,
              currentPageNum
            );
            ToastAndroid.show('Clipped as Text!', ToastAndroid.SHORT);
            const { PluginManager } = require('sn-plugin-lib');
            PluginManager.closePluginView();
          }}
          onCancel={async () => {
            promptActiveRef.current = false;
            setShowPromptDialog(false);
            ClipService.clearPendingCropShot();
            await ClipService.setPromptText('');
            const { PluginManager } = require('sn-plugin-lib');
            PluginManager.closePluginView();
          }}
        />
      </SafeAreaView>
    );
  }

  // Hold back the dashboard until the launch mode is known, so a prompt/crop launch shows the
  // dialog directly instead of flashing the (possibly still-loading) dashboard first.
  if (!contextResolved) {
    return <SafeAreaView style={styles.safeArea} />;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>

        {/* Header Section */}
        <View style={styles.header}>
          <View style={styles.headerTitleRow}>
            <View style={styles.headerLeft}>
              <Pressable onPress={handleClose} style={styles.iconButton} testID="header-close-btn">
                <Image source={require('../assets/icon/close.png')} style={styles.iconImage} />
              </Pressable>
            </View>
            <Text style={styles.title}>FlipClip</Text>
            <View style={styles.headerIcons}>
              <Pressable onPress={toggleSearch} style={styles.iconButton} testID="search-btn">
                <Image source={require('../assets/icon/search.png')} style={styles.iconImage} />
              </Pressable>
              <Pressable onPress={() => setIsPopoverOpen(true)} style={styles.iconButton} testID="filter-btn">
                <Image source={require('../assets/icon/filter.png')} style={styles.iconImage} />
              </Pressable>
              <Pressable onPress={() => setIsSettingsOpen(true)} style={styles.iconButton} testID="settings-btn">
                <Image source={require('../assets/icon/settings.png')} style={styles.iconImage} />
              </Pressable>
            </View>
          </View>
        </View>

        {/* Navigation Bar (Tabs) */}
        {enableToc && (
          <View style={styles.navTabBar}>
            <Pressable
              onPress={() => setActiveTab('clips')}
              style={[styles.navTab, activeTab === 'clips' && styles.navTabActive]}
            >
              <Text style={[styles.navTabText, activeTab === 'clips' && styles.navTabTextActive]}>
                📋 Clips ({clips.length})
              </Text>
            </Pressable>
            {enableToc && (
              <Pressable
                onPress={() => setActiveTab('toc')}
                style={[styles.navTab, activeTab === 'toc' && styles.navTabActive]}
              >
                <Text style={[styles.navTabText, activeTab === 'toc' && styles.navTabTextActive]}>
                  📖 ToC ({headings.length})
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Tab 1: Clips View */}
        {activeTab === 'clips' && (
          <>
            {/* Subtitle / Status row */}
            <View style={styles.headerSubtitleRow}>
              <Text style={styles.subtitle}>
                {isSelectionMode 
                  ? `${selectedIds.length} of ${processedClips.length} clip(s) selected` 
                  : `${processedClips.length} clip(s) visible`}
              </Text>
              {(activeSourceFilter !== null || clipTypeFilter !== 'all' || (isSearchVisible && searchQuery.trim() !== '')) && (
                <View style={styles.headerChips}>
                  {isSearchVisible && searchQuery.trim() !== '' && (
                    <Pressable onPress={() => setSearchQuery('')} style={styles.headerChip}>
                      <Text style={styles.headerChipText} numberOfLines={1}>Search: "{searchQuery}"</Text>
                      <Image source={require('../assets/icon/clear.png')} style={styles.headerChipClearImage} />
                    </Pressable>
                  )}
                  {clipTypeFilter !== 'all' && (
                    <Pressable onPress={() => setClipTypeFilter('all')} style={styles.headerChip}>
                      <Text style={styles.headerChipText} numberOfLines={1}>{clipTypeFilter === 'image' ? 'Picture clippings' : 'Text clippings'}</Text>
                      <Image source={require('../assets/icon/clear.png')} style={styles.headerChipClearImage} />
                    </Pressable>
                  )}
                  {activeSourceFilter !== null && (
                    <Pressable onPress={() => setActiveSourceFilter(null)} style={styles.headerChip}>
                      <Text style={styles.headerChipText} numberOfLines={1}>Source: {activeSourceFilter}</Text>
                      <Image source={require('../assets/icon/clear.png')} style={styles.headerChipClearImage} />
                    </Pressable>
                  )}
                </View>
              )}
            </View>

            {/* Toggleable Search Bar */}
            {isSearchVisible && (
              <SearchBar
                value={searchQuery}
                onChangeText={setSearchQuery}
                onClear={() => setSearchQuery('')}
              />
            )}

            {/* Scrollable list of clippings */}
            <ClipList
              data={processedClips}
              totalCount={clips.length}
              selectedIds={selectedIds}
              isSelectionMode={isSelectionMode}
              onCardPress={handleCardPress}
              onCardLongPress={handleCardLongPress}
              onOpenSource={handleOpenSource}
              showSource={showSourceInClipper}
              onInsert={isNoteFile && !isSelectionMode ? (clip) => runInsertClips([clip]) : undefined}
            />

            {/* Footer Actions Area */}
            <View style={styles.footer}>
              {!isSelectionMode ? (
                <View style={styles.btnRow}>
                  <HighContrastButton label="Copy Visible" onPress={handleCopyAllVisible} disabled={processedClips.length === 0} />
                  {isNoteFile && (
                    <HighContrastButton label="Insert into open Note" onPress={handleInsertVisible} disabled={processedClips.length === 0 || isInserting} />
                  )}
                  <HighContrastButton label="Clear All" onPress={handleClearAll} disabled={clips.length === 0} />
                </View>
              ) : (
                <>
                  {isNoteFile ? (
                    <>
                      <View style={styles.btnRow}>
                        <HighContrastButton label="Copy Selected" onPress={handleCopySelected} disabled={!selectionHasText} />
                        <HighContrastButton label="Insert into open Note" onPress={handleInsertSelected} disabled={isInserting} />
                        <HighContrastButton label="Merge Selected" onPress={handleMergeSelected} disabled={!canMerge} />
                      </View>
                      <View style={styles.btnRow}>
                        <HighContrastButton label="Delete Selected" onPress={handleDeleteSelected} />
                        <HighContrastButton label="Unmerge" onPress={handleUnmergeSelected} disabled={unmergeableCount === 0} />
                        <HighContrastButton label="Cancel" onPress={handleCancel} />
                      </View>
                      {eraseTarget && (
                        <View style={styles.btnRow}>
                          <HighContrastButton label="Erase areas (image)" onPress={handleStartErase} />
                        </View>
                      )}
                    </>
                  ) : (
                    <>
                      <View style={styles.btnRow}>
                        <HighContrastButton label="Copy Selected" onPress={handleCopySelected} disabled={!selectionHasText} />
                        <HighContrastButton label="Merge Selected" onPress={handleMergeSelected} disabled={!canMerge} />
                        <HighContrastButton label="Delete Selected" onPress={handleDeleteSelected} />
                      </View>
                      <View style={styles.btnRow}>
                        <HighContrastButton label="Unmerge" onPress={handleUnmergeSelected} disabled={unmergeableCount === 0} />
                        <HighContrastButton label="Cancel" onPress={handleCancel} />
                      </View>
                      {eraseTarget && (
                        <View style={styles.btnRow}>
                          <HighContrastButton label="Erase areas (image)" onPress={handleStartErase} />
                        </View>
                      )}
                    </>
                  )}
                </>
              )}
            </View>
          </>
        )}

        {/* Tab 2: Table of Contents View */}
        {enableToc && activeTab === 'toc' && (
          <View style={styles.tabViewContainer}>
            <Text style={styles.subtitle}>
              {tocUpdatedAt
                ? `${headings.length} heading(s) found. The ToC is created on the page you're viewing, so open a blank page first (it won't overwrite notes).`
                : 'Open the note to a blank page where you want the ToC, then tap "Build ToC". It writes on the current page and never overwrites existing notes.'}
            </Text>

            <ScrollView style={{ flex: 1, marginVertical: 12 }}>
              {headings.length === 0 ? (
                <Text style={{ textAlign: 'center', marginVertical: 32, fontSize: 16, color: '#666' }}>
                  {tocUpdatedAt
                    ? 'No headings detected. Add titles/headings in your note, then tap Update ToC.'
                    : 'No Table of Contents yet. Tap "Build ToC" below to scan this note for titles/headings.'}
                </Text>
              ) : (
                headings.map((h, idx) => (
                  <View
                    key={h.id || idx}
                    style={[
                      styles.tocCard,
                      h.level && h.level > 1 ? { marginLeft: (h.level - 1) * 16 } : null,
                    ]}
                  >
                    <Text style={styles.tocTitle}>
                      {h.numberLabel ? `${h.numberLabel} ${h.title}` : `${idx + 1}. ${h.title}`}
                    </Text>
                    <Text style={styles.tocPage}>Page {h.page}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Pressable
                        onPress={() => handleOpenEditHeadingModal(h)}
                        style={styles.editButton}
                      >
                        <Text style={styles.editButtonText}>✏️ Edit</Text>
                      </Pressable>
                    </View>
                  </View>
                ))
              )}
            </ScrollView>

            <View style={styles.footer}>
              <View style={styles.btnRow}>
                <HighContrastButton
                  label="📖 Build ToC on current page"
                  onPress={handleBuildToc}
                  disabled={!isNoteFile || isGeneratingToc}
                />
              </View>
            </View>
          </View>
        )}

        <Text style={styles.buildLabel}>{BUILD_LABEL}</Text>
      </View>

      {/* Local Filter & Sort Popover Menu */}
      {isPopoverOpen && (
        <FilterPopover
          sortMode={activeSortMode}
          onSortChange={(mode) => {
            setActiveSortMode(mode);
            setIsPopoverOpen(false);
          }}
          activeSourceFilter={activeSourceFilter}
          sources={uniqueSources}
          onSourceChange={(source) => {
            setActiveSourceFilter(source);
            setIsPopoverOpen(false);
          }}
          onClose={() => setIsPopoverOpen(false)}
        />
      )}

      {/* Settings Popover Menu */}
      {isSettingsOpen && (
        <SettingsPopover
          autoRemoveInserted={autoRemoveInserted}
          onAutoRemoveChange={(value) => {
            setAutoRemoveInserted(value);
            StorageService.setAutoRemoveInserted(value);
          }}
          combineInserted={combineInserted}
          onCombineChange={(value) => {
            setCombineInserted(value);
            StorageService.setCombineInserted(value);
          }}
          placeTextManually={placeTextManually}
          onPlaceTextChange={(value) => {
            setPlaceTextManually(value);
            StorageService.setPlaceTextManually(value);
          }}
          showSourceInClipper={showSourceInClipper}
          onShowSourceChange={(value) => {
            setShowSourceInClipper(value);
            StorageService.setShowSourceInClipper(value);
          }}
          insertSourceLink={insertSourceLink}
          onInsertSourceLinkChange={(value) => {
            setInsertSourceLink(value);
            StorageService.setInsertSourceLink(value);
          }}
          insertFontSize={insertFontSize}
          onInsertFontSizeChange={(size) => {
            setInsertFontSize(size);
            StorageService.setInsertFontSize(size);
          }}
          enableToc={enableToc}
          onEnableTocChange={(value) => {
            setEnableToc(value);
            StorageService.setEnableToc(value);
          }}
          onResetToDefault={() => {
            // Restore every setting to its application default.
            setAutoRemoveInserted(true); StorageService.setAutoRemoveInserted(true);
            setCombineInserted(false); StorageService.setCombineInserted(false);
            setPlaceTextManually(true); StorageService.setPlaceTextManually(true);
            setInsertFontSize(DEFAULT_INSERT_FONT_SIZE); StorageService.setInsertFontSize(DEFAULT_INSERT_FONT_SIZE);
            setShowSourceInClipper(true); StorageService.setShowSourceInClipper(true);
            setInsertSourceLink(true); StorageService.setInsertSourceLink(true);
            setEnableToc(false); StorageService.setEnableToc(false);
            ToastAndroid.show('Settings reset to default.', ToastAndroid.SHORT);
          }}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
      {/* Shared confirmation dialog (broken links, ToC blank-page prompt, …) */}
      <ConfirmationDialog
        visible={showConfirmDialog}
        title={confirmTitle}
        description={confirmDescription}
        confirmLabel={confirmConfirmLabel}
        cancelLabel={confirmCancelLabel}
        onConfirm={() => {
          onConfirmCallback?.fn();
        }}
        onCancel={() => {
          if (onCancelCallback?.fn) {
            onCancelCallback.fn();
          } else {
            setShowConfirmDialog(false);
          }
        }}
      />

      {/* Modal for Editing Heading Title */}
      {editingHeading && (
        <Modal
          transparent
          animationType="none"
          statusBarTranslucent
          visible={!!editingHeading}
          onRequestClose={() => setEditingHeading(null)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Edit Heading Title (Page {editingHeading.page})</Text>
              <TextInput
                style={styles.modalInput}
                value={editTitleInput}
                onChangeText={setEditTitleInput}
                placeholder="Enter title name..."
                placeholderTextColor="#666666"
                autoFocus
                selectTextOnFocus
              />
              <View style={styles.modalBtnRow}>
                <Pressable
                  style={[styles.modalBtn, styles.modalBtnClear]}
                  onPress={() => setEditTitleInput('')}
                >
                  <Text style={styles.modalBtnCancelText}>🗑 Clear</Text>
                </Pressable>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <Pressable
                    style={[styles.modalBtn, styles.modalBtnCancel]}
                    onPress={() => setEditingHeading(null)}
                  >
                    <Text style={styles.modalBtnCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.modalBtn, styles.modalBtnSave]}
                    onPress={handleSaveHeadingTitle}
                  >
                    <Text style={styles.modalBtnSaveText}>Save</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* Progress dialog shown while the ToC is being scanned + written */}
      {isGeneratingToc && (
        <Modal transparent animationType="none" statusBarTranslucent visible={isGeneratingToc}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <ActivityIndicator size="large" color="#000000" style={{ marginBottom: 12 }} />
              <Text style={[styles.modalTitle, { marginBottom: 0, textAlign: 'center' }]}>
                {tocPhase === 'recognizing' ? 'Recognizing handwriting…' : 'Scanning headings…'}
              </Text>
              <Text style={{ textAlign: 'center', color: '#666', marginTop: 6 }}>
                {tocPhase === 'recognizing'
                  ? 'Converting handwritten titles to text. This may take some time.'
                  : 'Reading the note’s titles.'}
              </Text>
            </View>
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    flex: 1,
    padding: 16,
    flexDirection: 'column',
    backgroundColor: '#ffffff',
  },
  header: {
    marginBottom: 12,
    borderBottomWidth: 2,
    borderBottomColor: '#000000',
    paddingBottom: 8,
  },
  headerLeft: {
    position: 'absolute',
    left: 0,
    zIndex: 10,
  },
  headerTitleRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    position: 'relative',
    minHeight: 64,
  },
  headerIcons: {
    position: 'absolute',
    right: 0,
    flexDirection: 'row',
    gap: 16,
    zIndex: 10,
  },
  iconButton: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 64,
    height: 64,
  },
  iconImage: {
    width: 48,
    height: 48,
    resizeMode: 'contain',
  },
  title: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#000000',
    textAlign: 'center',
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 1,
  },
  subtitle: {
    fontSize: 18,
    color: '#666666',
    textAlign: 'center',
    width: '100%',
  },
  headerSubtitleRow: {
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    width: '100%',
  },
  headerChips: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  headerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#000000',
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: '#000000',
    gap: 6,
  },
  headerChipText: {
    fontSize: 12,
    color: '#ffffff',
  },
  headerChipClearImage: {
    width: 12,
    height: 12,
    tintColor: '#ffffff',
  },
  footer: {
    flexDirection: 'column',
    gap: 8,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 8,
  },
  // Root wrapper for crop mode: holds the CropOverlay plus the (absolute) selection modal.
  cropRoot: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  buildLabel: {
    fontSize: 12,
    color: '#666666',
    textAlign: 'right',
    marginTop: 6,
  },
  navTabBar: {
    flexDirection: 'row',
    borderBottomWidth: 2,
    borderColor: '#000000',
    backgroundColor: '#f5f5f5',
    marginBottom: 8,
  },
  navTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRightWidth: 1,
    borderColor: '#cccccc',
  },
  navTabActive: {
    backgroundColor: '#ffffff',
    borderBottomWidth: 3,
    borderBottomColor: '#000000',
  },
  navTabText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#666666',
  },
  navTabTextActive: {
    color: '#000000',
  },
  tabViewContainer: {
    flex: 1,
    paddingVertical: 4,
  },
  tocCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderWidth: 1,
    borderColor: '#000000',
    backgroundColor: '#ffffff',
    marginBottom: 8,
  },
  tocTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#000000',
    flex: 1,
  },
  tocPage: {
    fontSize: 14,
    color: '#666666',
    marginRight: 12,
  },
  editButton: {
    borderWidth: 1,
    borderColor: '#000000',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#ffffff',
  },
  editButtonText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#000000',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 8,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#000000',
    marginBottom: 12,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 4,
    padding: 10,
    fontSize: 16,
    color: '#000000',
    backgroundColor: '#ffffff',
    marginBottom: 16,
  },
  modalBtnRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalBtnClear: {
    backgroundColor: '#f5f5f5',
  },
  modalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#000000',
  },
  modalBtnCancel: {
    backgroundColor: '#f5f5f5',
  },
  modalBtnCancelText: {
    color: '#000000',
    fontWeight: 'bold',
  },
  modalBtnSave: {
    backgroundColor: '#000000',
  },
  modalBtnSaveText: {
    color: '#ffffff',
    fontWeight: 'bold',
  },
});

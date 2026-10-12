// SnClipper/src/components/FloatingMenu.tsx
//
// The long-press menu for the always-on-top floating button. Rendered as a compact panel
// anchored NEXT TO the floating button (position flips based on which half of the screen the
// button is on), falling back to centered if no anchor is known. Tapping outside closes it.
// Views: main (FlipClip / Clip Region / Picture / Text / Switch to…), picker (recents + Browse…),
// browse (folder navigator).
//
// SWITCH MODEL: a quick tap on the floating button toggles between the TWO most-recently-opened
// documents automatically. The picker here lets the user optionally PIN one document (tap a
// recent, or Browse to one) to override one side of the toggle, or Clear the override to return
// to the automatic last-two. The main-view caption shows the live pair a tap flips between.

import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, ViewStyle } from 'react-native';

export interface PickItem {
  path: string;
  name: string;
  page?: number;
  isDir?: boolean;
}

export interface MenuAnchor {
  x: number; // dp
  y: number; // dp
  size: number; // dp
  screenW: number; // dp
  screenH: number; // dp
}

interface FloatingMenuProps {
  recents: PickItem[];
  pairNames: string[]; // live [current, other] names for the caption
  pinnedPath: string | null; // normalized path of the pinned override (radio-checked), or null
  browseRoots: PickItem[];
  anchor: MenuAnchor | null;
  onClipRegion: () => void;
  onPictureClips: () => void;
  onTextClips: () => void;
  onPinTarget: (item: PickItem) => void;
  onClearOverride: () => void;
  canUndo: boolean; // a just-placed clip can be undone (on this note)
  onUndo: () => void;
  listDir: (dir: string) => Promise<PickItem[]>;
  onClose: () => void;
}

type View3 = 'main' | 'picker' | 'browse';

const PANEL_W = 300;
const PANEL_MAX_H = 560;
const GAP = 10;

const norm = (p: string): string => (p.startsWith('file://') ? p.substring(7) : p);

function positionStyle(anchor: MenuAnchor | null): ViewStyle {
  if (!anchor) {
    return { alignSelf: 'center', marginTop: 72, width: PANEL_W, maxHeight: PANEL_MAX_H };
  }
  const onLeftHalf = anchor.x + anchor.size / 2 < anchor.screenW / 2;
  let left = onLeftHalf ? anchor.x + anchor.size + GAP : anchor.x - GAP - PANEL_W;
  left = Math.max(8, Math.min(left, anchor.screenW - PANEL_W - 8));
  const maxH = Math.max(180, Math.min(PANEL_MAX_H, anchor.screenH - 16));
  let top = anchor.y - 8;
  top = Math.max(8, Math.min(top, anchor.screenH - maxH - 8));
  return { position: 'absolute', left, top, width: PANEL_W, maxHeight: maxH };
}

export function FloatingMenu(props: FloatingMenuProps) {
  const { recents, pairNames, pinnedPath, browseRoots, anchor, onClipRegion, onPictureClips, onTextClips, onPinTarget, onClearOverride, canUndo, onUndo, listDir, onClose } = props;
  const [view, setView] = useState<View3>('main');
  const [stack, setStack] = useState<string[]>([]);
  const [entries, setEntries] = useState<PickItem[]>([]);
  const [loading, setLoading] = useState(false);

  const currentDir = stack.length ? stack[stack.length - 1] : null;

  useEffect(() => {
    if (view !== 'browse') return;
    if (currentDir === null) { setEntries(browseRoots); return; }
    let cancelled = false;
    setLoading(true);
    listDir(currentDir)
      .then((items) => { if (!cancelled) setEntries(items); })
      .catch(() => { if (!cancelled) setEntries([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [view, currentDir, browseRoots, listDir]);

  const back = (() => {
    if (view === 'picker') return () => setView('main');
    if (view === 'browse') return () => { if (stack.length > 0) setStack((s) => s.slice(0, -1)); else setView('picker'); };
    return undefined;
  })();

  const title = view === 'main' ? 'FlipClip'
    : view === 'picker' ? 'Pin a document'
    : (currentDir ? currentDir.substring(currentDir.lastIndexOf('/') + 1) : 'Browse');

  const pill = (glyph: string, label: string, onPress: () => void) => (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.pill, pressed && styles.pressed]}>
      <Text style={styles.pillGlyph}>{glyph}</Text>
      <Text style={styles.pillText}>{label}</Text>
    </Pressable>
  );

  // A file row: tap to pin it as the override. A radio dot marks the currently pinned doc.
  const fileRow = (item: PickItem) => {
    const checked = !!pinnedPath && norm(pinnedPath) === norm(item.path);
    return (
      <Pressable key={norm(item.path)} onPress={() => onPinTarget(item)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <View style={styles.radio}>{checked ? <View style={styles.radioDot} /> : null}</View>
        <Text style={styles.rowText} numberOfLines={1}>{item.name}</Text>
      </Pressable>
    );
  };

  const folderRow = (item: PickItem) => (
    <Pressable key={norm(item.path)} onPress={() => setStack((s) => [...s, item.path])} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <Text style={styles.folderIcon}>▸</Text>
      <Text style={styles.rowText} numberOfLines={1}>{item.name}/</Text>
    </Pressable>
  );

  return (
    <View style={styles.root}>
      {/* Tap outside the panel to dismiss. */}
      <Pressable style={styles.dismiss} onPress={onClose} />
      <View style={[styles.card, positionStyle(anchor)]}>
        <View style={styles.header}>
          {back ? (
            <Pressable onPress={back} style={styles.headerBtn} hitSlop={8}><Text style={styles.headerBtnText}>‹</Text></Pressable>
          ) : (
            <View style={styles.headerBtn} />
          )}
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <Pressable onPress={onClose} style={styles.headerBtn} hitSlop={8}><Text style={styles.headerBtnText}>✕</Text></Pressable>
        </View>

        {view === 'main' && (
          <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.body}>
            <View style={styles.targetCaption}>
              <Text style={styles.targetCaptionLabel}>A tap switches between</Text>
              <Text style={styles.targetCaptionValue} numberOfLines={2}>
                {pairNames && pairNames.length > 0 ? pairNames.join('  ⇄  ') : 'the last two documents'}
              </Text>
              {pinnedPath ? <Text style={styles.pinnedNote}>Override pinned — change it in “Switch to…”</Text> : null}
            </View>
            {pill('▣', 'Clip Region', onClipRegion)}
            {pill('◩', 'Picture Clippings', onPictureClips)}
            {pill('≡', 'Text Clippings', onTextClips)}
            {pill('⇄', 'Switch to…', () => setView('picker'))}
            {canUndo ? pill('↩', 'Undo last place', onUndo) : null}
          </ScrollView>
        )}

        {view === 'picker' && (
          <>
            <Text style={styles.pickerHint}>Tap a document to pin it as one side of the switch, or Browse for another.</Text>
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {recents.length === 0 ? <Text style={styles.empty}>No recent documents yet. Use Browse…</Text> : recents.map(fileRow)}
            </ScrollView>
            <View style={styles.footer}>
              {pill('⌕', 'Browse…', () => { setStack([]); setView('browse'); })}
              {pinnedPath ? (
                <Pressable onPress={onClearOverride} style={({ pressed }) => [styles.clearBtn, pressed && styles.pressed]}>
                  <Text style={styles.clearBtnText}>Use last 2</Text>
                </Pressable>
              ) : null}
            </View>
          </>
        )}

        {view === 'browse' && (
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {loading ? <Text style={styles.empty}>Loading…</Text>
              : entries.length === 0 ? <Text style={styles.empty}>Empty folder.</Text>
              : entries.map((e) => (e.isDir ? folderRow(e) : fileRow(e)))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  dismiss: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.15)' },
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 3,
    borderColor: '#000000',
    borderRadius: 16,
    overflow: 'hidden',
  },
  header: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    borderBottomWidth: 2,
    borderColor: '#000000',
  },
  headerBtn: { minWidth: 40, paddingVertical: 8, alignItems: 'center' },
  headerBtnText: { fontSize: 20, fontWeight: 'bold', color: '#000000' },
  title: { flex: 1, fontSize: 17, fontWeight: 'bold', color: '#000000', textAlign: 'center' },
  bodyScroll: { flexShrink: 1 },
  body: { padding: 14 },
  targetCaption: {
    marginBottom: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderColor: '#000000',
  },
  targetCaptionLabel: { fontSize: 12, color: '#666666', marginBottom: 2 },
  targetCaptionValue: { fontSize: 15, fontWeight: 'bold', color: '#000000' },
  pinnedNote: { fontSize: 11, color: '#666666', marginTop: 4, fontStyle: 'italic' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 54,
    paddingHorizontal: 18,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 27,
    backgroundColor: '#ffffff',
    marginBottom: 12,
  },
  pressed: { backgroundColor: '#d0d0d0' },
  pillGlyph: { fontSize: 20, fontWeight: 'bold', color: '#000000', width: 30, textAlign: 'center', marginRight: 8 },
  pillText: { fontSize: 16, fontWeight: 'bold', color: '#000000', letterSpacing: 0.3 },
  pickerHint: { fontSize: 13, color: '#666666', paddingHorizontal: 12, paddingTop: 10 },
  list: { flex: 1 },
  listContent: { padding: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 12,
    marginBottom: 8,
  },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#000000', marginRight: 10, justifyContent: 'center', alignItems: 'center' },
  radioDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: '#000000' },
  folderIcon: { fontSize: 16, fontWeight: 'bold', color: '#000000', width: 22, marginRight: 10, textAlign: 'center' },
  rowText: { flex: 1, fontSize: 15, color: '#000000' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderTopWidth: 2, borderColor: '#000000' },
  clearBtn: {
    minHeight: 48,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  clearBtnText: { fontSize: 15, fontWeight: 'bold', color: '#000000' },
  empty: { fontSize: 14, color: '#000000', padding: 16, textAlign: 'center' },
});

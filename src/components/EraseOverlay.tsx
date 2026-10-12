// SnClipper/src/components/EraseOverlay.tsx
//
// Pre-insert erase/mask tool. Shows an image clip and lets the user drag rectangles that will be
// painted white — the workaround for the firmware limit that a picture pasted into a note cannot
// be erased (gotcha #45). The user masks parts HERE, while it is still an ordinary PNG, before it
// becomes a note picture. Reports the rectangles in image-pixel space to the parent, which calls
// the native masker. Geometry mirrors CropOverlay (scale image into the workspace, preserve
// aspect); the difference is it accumulates MANY rectangles instead of one crop box.

import React, { useMemo, useRef, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View, Pressable, Image } from 'react-native';
import { HighContrastButton } from './HighContrastButton';

interface Size { width: number; height: number; }
interface Box { left: number; top: number; width: number; height: number; }
interface Rect { x: number; y: number; width: number; height: number; }

interface EraseOverlayProps {
  pagePath: string | null;
  imageSize: Size;
  loading: boolean;
  onCancel: () => void;
  onApply: (rects: Rect[]) => void; // rectangles in image-space pixels
}

const MIN_DRAW = 12; // ignore accidental taps smaller than this (displayed px)
const THROTTLE_MS = 90; // e-ink ghosts on every move; commit the draft at most this often

export function EraseOverlay({ pagePath, imageSize, loading, onCancel, onApply }: EraseOverlayProps) {
  const [workspaceSize, setWorkspaceSize] = useState<Size>({ width: 0, height: 0 });
  const [rects, setRects] = useState<Box[]>([]); // committed masks, in displayed px
  const [draft, setDraft] = useState<Box | null>(null); // the rectangle being drawn

  const start = useRef<{ x: number; y: number } | null>(null);
  const lastCommit = useRef(0);

  const onWorkspaceLayout = (e: any) => {
    const { width, height } = e.nativeEvent.layout;
    setWorkspaceSize({ width, height });
  };

  const displayedSize = useMemo<Size>(() => {
    if (workspaceSize.width === 0 || imageSize.width === 0) return { width: 0, height: 0 };
    const ratio = Math.min(workspaceSize.width / imageSize.width, workspaceSize.height / imageSize.height);
    return { width: Math.floor(imageSize.width * ratio), height: Math.floor(imageSize.height * ratio) };
  }, [workspaceSize, imageSize]);

  const imageOffset = useMemo(() => ({
    left: Math.floor((workspaceSize.width - displayedSize.width) / 2),
    top: Math.floor((workspaceSize.height - displayedSize.height) / 2),
  }), [workspaceSize, displayedSize]);

  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));

  const boxFrom = (x0: number, y0: number, x1: number, y1: number): Box => {
    const left = clamp(Math.min(x0, x1), displayedSize.width);
    const top = clamp(Math.min(y0, y1), displayedSize.height);
    const right = clamp(Math.max(x0, x1), displayedSize.width);
    const bottom = clamp(Math.max(y0, y1), displayedSize.height);
    return { left, top, width: right - left, height: bottom - top };
  };

  const onTouchStart = (e: any) => {
    const { locationX, locationY } = e.nativeEvent;
    start.current = { x: locationX, y: locationY };
    setDraft({ left: locationX, top: locationY, width: 0, height: 0 });
  };

  const onTouchMove = (e: any) => {
    if (!start.current) return;
    const { locationX, locationY } = e.nativeEvent;
    const now = Date.now();
    if (now - lastCommit.current < THROTTLE_MS) return;
    lastCommit.current = now;
    setDraft(boxFrom(start.current.x, start.current.y, locationX, locationY));
  };

  const onTouchEnd = (e: any) => {
    if (!start.current) return;
    const { locationX, locationY } = e.nativeEvent;
    const box = boxFrom(start.current.x, start.current.y, locationX, locationY);
    start.current = null;
    setDraft(null);
    if (box.width >= MIN_DRAW && box.height >= MIN_DRAW) {
      setRects((prev) => [...prev, box]);
    }
  };

  const undo = () => setRects((prev) => prev.slice(0, -1));
  const clearAll = () => setRects([]);

  const apply = () => {
    if (displayedSize.width === 0) { onApply([]); return; }
    const sx = imageSize.width / displayedSize.width;
    const sy = imageSize.height / displayedSize.height;
    const out: Rect[] = rects.map((b) => ({
      x: Math.max(0, Math.floor(b.left * sx)),
      y: Math.max(0, Math.floor(b.top * sy)),
      width: Math.ceil(b.width * sx),
      height: Math.ceil(b.height * sy),
    }));
    onApply(out);
  };

  const allBoxes = draft ? [...rects, draft] : rects;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Erase areas</Text>
          <Pressable onPress={onCancel} style={styles.closeBtn}><Text style={styles.closeText}>Cancel</Text></Pressable>
        </View>

        {loading ? (
          <View style={styles.loading}><Text style={styles.loadingText}>Loading image…</Text></View>
        ) : (
          <View style={styles.workspace} onLayout={onWorkspaceLayout}>
            {workspaceSize.width > 0 && pagePath && (
              <View style={styles.wrapper}>
                <Image
                  source={{ uri: 'file://' + pagePath }}
                  style={{ width: displayedSize.width, height: displayedSize.height, position: 'absolute', left: imageOffset.left, top: imageOffset.top }}
                  resizeMode="contain"
                />
                {/* Touch layer over the displayed image; coords are relative to this view. */}
                <View
                  style={{ position: 'absolute', left: imageOffset.left, top: imageOffset.top, width: displayedSize.width, height: displayedSize.height }}
                  onTouchStart={onTouchStart}
                  onTouchMove={onTouchMove}
                  onTouchEnd={onTouchEnd}
                  onTouchCancel={onTouchEnd}
                >
                  {allBoxes.map((b, i) => (
                    <View key={i} style={[styles.mask, { left: b.left, top: b.top, width: b.width, height: b.height }]} />
                  ))}
                </View>
              </View>
            )}
          </View>
        )}

        {!loading && (
          <>
            <Text style={styles.hint}>Drag over the parts to white out. {rects.length} area(s) marked.</Text>
            <View style={styles.footer}>
              <Pressable onPress={undo} disabled={rects.length === 0} style={[styles.secondaryBtn, rects.length === 0 && styles.disabled]}>
                <Text style={styles.secondaryText}>Undo</Text>
              </Pressable>
              <Pressable onPress={clearAll} disabled={rects.length === 0} style={[styles.secondaryBtn, rects.length === 0 && styles.disabled]}>
                <Text style={styles.secondaryText}>Clear</Text>
              </Pressable>
              <View style={styles.applyWrap}>
                <HighContrastButton label={rects.length === 0 ? 'Done (no changes)' : 'Apply erase'} onPress={apply} />
              </View>
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#ffffff' },
  container: { flex: 1, backgroundColor: '#ffffff' },
  header: {
    height: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, borderBottomWidth: 2, borderColor: '#000000',
  },
  title: { fontSize: 20, fontWeight: 'bold', color: '#000000' },
  closeBtn: { paddingVertical: 6, paddingHorizontal: 12, borderWidth: 2, borderColor: '#000000' },
  closeText: { fontSize: 16, fontWeight: 'bold', color: '#000000' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { fontSize: 18, color: '#000000' },
  workspace: { flex: 1, backgroundColor: '#e0e0e0', justifyContent: 'center', alignItems: 'center' },
  wrapper: { width: '100%', height: '100%', position: 'relative' },
  // Opaque white with a dashed black outline so the user can see what will be erased.
  mask: { position: 'absolute', backgroundColor: '#ffffff', borderWidth: 2, borderColor: '#000000', borderStyle: 'dashed' },
  hint: { fontSize: 14, color: '#333333', textAlign: 'center', paddingVertical: 6 },
  footer: {
    minHeight: 80, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10,
    borderTopWidth: 2, borderColor: '#000000',
  },
  secondaryBtn: { paddingVertical: 12, paddingHorizontal: 16, borderWidth: 2, borderColor: '#000000' },
  secondaryText: { fontSize: 16, fontWeight: 'bold', color: '#000000' },
  disabled: { opacity: 0.4 },
  applyWrap: { flex: 1 },
});

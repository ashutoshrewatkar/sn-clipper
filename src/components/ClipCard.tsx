// SnClipper/src/components/ClipCard.tsx
// Vinod Nair
//
// A single clip card: header (selection checkbox + date + source) and a body of
// chronological text/image sub-elements.

import React from 'react';
import { StyleSheet, Text, View, Pressable, Image, Modal } from 'react-native';
import { ClipItem } from '../services/StorageService';

/**
 * A clip's image, or an explanation when the file behind it is gone.
 *
 * Region clips are stored as two halves with different lifetimes: the PNG lives in the
 * plugin's own directory, which the host removes when the plugin is uninstalled, while the
 * record lives in AsyncStorage, which is the host app's and survives. Uninstalling therefore
 * leaves the record pointing at a file that no longer exists (measured 2026-09-05; installing
 * an update over the top is safe).
 *
 * Rendered blank, that reads as a rendering bug. Say what happened instead.
 *
 * Detection is `Image.onError` rather than an existence check: it costs nothing until a load
 * actually fails, needs no filesystem call per card, and catches an unreadable or corrupt file
 * as well as a missing one.
 */
function ClipImage({ path, onZoom }: { path: string; onZoom?: (path: string) => void }) {
  const [failed, setFailed] = React.useState(false);

  if (failed) {
    return (
      <View style={styles.imageUnavailable} testID="clip-image-unavailable">
        <Text style={styles.imageUnavailableTitle}>Image unavailable</Text>
        <Text style={styles.imageUnavailableHint}>
          The saved image is no longer on this device. Uninstalling FlipClip removes stored clip
          images; updating over the existing plugin does not.
        </Text>
      </View>
    );
  }

  // Tap the thumbnail to open it full-screen (region clips are small at 180px on e-ink).
  // stopPropagation so a zoom tap doesn't also toggle card selection.
  return (
    <Pressable
      onPress={(e) => { e.stopPropagation(); onZoom?.(path); }}
      disabled={!onZoom}
    >
      <Image
        source={{ uri: 'file://' + path }}
        style={styles.clipImage}
        onError={() => setFailed(true)}
      />
    </Pressable>
  );
}

const formatDate = (timestamp?: number) => {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const fullMonths = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const month = fullMonths[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const minutesStr = minutes < 10 ? '0' + minutes : minutes;
  return `${month} ${day}, ${year} ${hours}:${minutesStr} ${ampm}`;
};

interface ClipCardProps {
  clip: ClipItem;
  isSelected: boolean;
  isSelectionMode: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onOpenSource?: (clip: ClipItem, element: any, elementIndex: number) => void;
  showSource?: boolean;
  onInsert?: (clip: ClipItem) => void; // when set (note open, not selecting), shows a per-card Insert
}

export function ClipCard({ clip, isSelected, isSelectionMode, onPress, onLongPress, onOpenSource, showSource = true, onInsert }: ClipCardProps) {
  const [zoomPath, setZoomPath] = React.useState<string | null>(null);
  // Only allow zoom when not selecting, so a tap in selection mode still toggles the card.
  const onZoom = isSelectionMode ? undefined : (p: string) => setZoomPath(p);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={[
        styles.clipItem,
        isSelectionMode && styles.selectableClipItem,
        isSelected && styles.selectedClipItem,
      ]}
    >
      <View style={styles.clipItemHeader}>
        <View style={styles.clipIndexRow}>
          {isSelectionMode && (
            <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
              {isSelected && <Text style={styles.checkMark}>✓</Text>}
            </View>
          )}
          <Text style={styles.clipIndex}>{formatDate(clip.timestamp)}</Text>
        </View>
        {(() => {
          const firstSrcIdx = (showSource && clip.elements) ? clip.elements.findIndex(el => !!el.documentPath) : -1;
          if (firstSrcIdx !== -1) {
            const firstSrc = clip.elements[firstSrcIdx];
            const pageNum = firstSrc.documentPage !== undefined ? firstSrc.documentPage + 1 : 1;
            const docName = firstSrc.articleName || clip.articleName;
            return (
              <View style={styles.headerSourceRow}>
                <Text style={styles.articleName} numberOfLines={1}>
                  {docName} (p. {pageNum})
                </Text>
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    onOpenSource?.(clip, firstSrc, firstSrcIdx);
                  }}
                  style={styles.jumpButton}
                  testID="jump-btn"
                >
                  <Image
                    source={require('../../assets/icon/jump.png')}
                    style={styles.jumpIcon}
                  />
                </Pressable>
              </View>
            );
          } else {
            return (
              <Text style={styles.articleName} numberOfLines={1}>
                {clip.articleName}
              </Text>
            );
          }
        })()}
      </View>
      {clip.elements && clip.elements.map((elem, idx) => {
        return (
          <View key={idx} style={styles.elementContainer}>
            {elem.type === 'text' && elem.text ? (
              <Text style={styles.clipText}>{elem.text}</Text>
            ) : elem.type === 'image' && elem.imagePath ? (
              <ClipImage path={elem.imagePath} onZoom={onZoom} />
            ) : null}
          </View>
        );
      })}

      {/* Per-card Insert: a direct "insert just this clipping" action (only when a note is open
          and we're not in multi-select). stopPropagation so it doesn't toggle selection. */}
      {onInsert && !isSelectionMode && (
        <Pressable
          onPress={(e) => { e.stopPropagation(); onInsert(clip); }}
          style={({ pressed }) => [styles.insertBtn, pressed && styles.insertBtnPressed]}
          testID="card-insert-btn"
        >
          <Text style={styles.insertBtnText}>⤵  Insert this clip</Text>
        </Pressable>
      )}

      {/* Full-screen zoom of a tapped image clip. */}
      <Modal visible={!!zoomPath} transparent animationType="fade" onRequestClose={() => setZoomPath(null)}>
        <Pressable style={styles.zoomBackdrop} onPress={() => setZoomPath(null)}>
          {zoomPath ? (
            <Image source={{ uri: 'file://' + zoomPath }} style={styles.zoomImage} resizeMode="contain" />
          ) : null}
          <View style={styles.zoomCloseBtn}>
            <Text style={styles.zoomCloseText}>Close ✕</Text>
          </View>
        </Pressable>
      </Modal>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  clipItem: {
    borderWidth: 1,
    borderColor: '#cccccc',
    padding: 12,
    backgroundColor: '#ffffff',
  },
  selectableClipItem: {
    borderColor: '#888888',
  },
  selectedClipItem: {
    borderWidth: 3,
    borderColor: '#000000',
  },
  clipItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#eeeeee',
    paddingBottom: 6,
    marginBottom: 8,
  },
  clipIndexRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    gap: 8,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 2,
    borderColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#000000',
  },
  checkMark: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  clipIndex: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#000000',
  },
  articleName: {
    fontSize: 14,
    color: '#666666',
    fontStyle: 'italic',
    flexShrink: 1,
    textAlign: 'right',
  },
  headerSourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    maxWidth: '65%',
  },
  clipText: {
    fontSize: 18,
    color: '#000000',
    lineHeight: 26,
  },
  imageUnavailable: {
    width: '100%',
    height: 180,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderStyle: 'dashed',
    marginTop: 6,
    backgroundColor: '#f9f9f9',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  imageUnavailableTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#555555',
    marginBottom: 6,
  },
  imageUnavailableHint: {
    fontSize: 13,
    color: '#777777',
    textAlign: 'center',
  },
  clipImage: {
    width: '100%',
    height: 180,
    resizeMode: 'contain',
    borderWidth: 1,
    borderColor: '#e0e0e0',
    marginTop: 6,
    backgroundColor: '#f9f9f9',
  },
  elementContainer: {
    marginBottom: 8,
  },
  jumpButton: {
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  jumpIcon: {
    width: 20,
    height: 20,
    resizeMode: 'contain',
  },
  insertBtn: {
    marginTop: 4,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 20,
    backgroundColor: '#ffffff',
  },
  insertBtnPressed: { backgroundColor: '#d0d0d0' },
  insertBtnText: { fontSize: 14, fontWeight: 'bold', color: '#000000' },
  zoomBackdrop: {
    flex: 1,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  zoomImage: {
    width: '100%',
    height: '100%',
  },
  zoomCloseBtn: {
    position: 'absolute',
    top: 24,
    right: 24,
    borderWidth: 2,
    borderColor: '#000000',
    backgroundColor: '#ffffff',
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  zoomCloseText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#000000',
  },
});

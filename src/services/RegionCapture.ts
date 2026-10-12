// SnClipper/src/services/RegionCapture.ts
//
// Reader-screenshot capture for Region clipping, shared by the background toolbar flow
// (index.js) and the floating menu (App.tsx). DOC/PDF/EPUB region capture needs the reader
// visible, so capturing must happen while the plugin view is NOT on top.

import { NativeModules, ToastAndroid } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { ClipService } from './ClipService';
import { FloatingButton } from './FloatingButton';

const { ImageCropModule } = NativeModules;

// How long to let the reader repaint after the plugin view closes, before screen-capturing it.
// Too short and the first capture catches a half-painted/blank page (the "needs a 2nd Clip
// Region press" bug); this value makes the first press reliable on the A5X2.
const READER_REPAINT_MS = 700;

// Screenshot the currently-visible reader page into the pending-crop slot.
export async function captureReaderScreenToPending(): Promise<void> {
  if (ImageCropModule && typeof ImageCropModule.captureScreen === 'function') {
    try {
      const dir = await PluginManager.getPluginDirPath();
      if (dir) {
        ClipService.clearPendingCropShot();
        const shotPath = `${dir}/reader_shot_${Date.now()}.png`;
        const cap = await ImageCropModule.captureScreen(shotPath);
        if (cap && cap.path && cap.width && cap.height) {
          ClipService.setPendingCropShot({
            path: cap.path,
            width: cap.width,
            height: cap.height,
            ts: Date.now(),
          });
        }
      }
    } catch (e) {
      console.warn('captureReaderScreenToPending error:', e);
    }
  }
}

// Used by the floating menu's "Clip Region" when the reader is a DOC/PDF/EPUB: the plugin view
// is currently on top (hiding the reader), so close it, let the reader repaint, screenshot it,
// then reopen straight into the crop UI. Runs in a service module so it survives the plugin
// view (and its React tree) being torn down by closePluginView.
export async function captureFromReaderAndReopen(): Promise<void> {
  try {
    // Tell the user the brief blank gap is expected (closing the view to see the reader), so it
    // doesn't look frozen.
    try { ToastAndroid.show('Capturing page…', ToastAndroid.SHORT); } catch (e) { /* non-RN test env */ }

    // Pull the floating button off-screen BEFORE capturing, or screencap bakes the ⇄ button into
    // the clip (it floats above the reader). Restore it after we reopen.
    await FloatingButton.setOverlayHidden(true);

    await PluginManager.closePluginView();
    await new Promise((r) => setTimeout(r, READER_REPAINT_MS));
    await captureReaderScreenToPending();
    await ClipService.setLaunchMode('crop');
    await PluginManager.showPluginView();
  } catch (e) {
    console.warn('captureFromReaderAndReopen error:', e);
  } finally {
    // Restore the button once we're back (the plugin view/crop UI is on top now, so it won't be
    // in any further capture).
    await FloatingButton.setOverlayHidden(false);
  }
}

// SnClipper/src/services/RegionCapture.ts
//
// Reader-screenshot capture for Region clipping, used by the background DOC text-selection flow
// (index.js, button 300) when a short selection needs a page screenshot for the "text or image?"
// prompt. The menu's Clip Region renders the page in place (App.handleStartCropping) instead of
// screenshotting, so it no longer closes/reopens the plugin view.

import { NativeModules } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';
import { ClipService } from './ClipService';

const { ImageCropModule } = NativeModules;

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

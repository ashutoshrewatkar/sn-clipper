// SnClipper/index.js
// Vinod Nair

import {AppRegistry, Image, ToastAndroid, NativeModules, DeviceEventEmitter} from 'react-native';
import App from './src/App';
import {name as appName} from './app.json';
import {PluginManager, PluginDocAPI, PluginCommAPI, PluginFileAPI, FileUtils} from 'sn-plugin-lib';
import {ClipService} from './src/services/ClipService';
import {StorageService} from './src/services/StorageService';
import {NavService} from './src/services/NavService';
import {FloatingButton} from './src/services/FloatingButton';
import {deriveArticleName, isImageFile} from './src/utils/paths';
import {PermissionService, FILE_READ} from './src/services/PermissionService';
import {captureReaderScreenToPending} from './src/services/RegionCapture';

const { ImageCropModule } = NativeModules;

// Initialize Supernote Plugin framework first
PluginManager.init();

// Initialize the aggregated clip state (this will automatically register/
// update the dashboard button name with the loaded count)
ClipService.init().then(() => FloatingButton.refreshState());

// Keep the floating button's badge (pending-clip count) in sync as clips are added/removed in
// the background. getClipsSync is updated before listeners fire, so this reads the fresh count.
ClipService.subscribe(() => { FloatingButton.refreshState(); });

// Switch to the previously-seen document, returning to the page last seen there. Shared by
// the floating button's quick tap (and available as the core of the Switch-Document feature).
async function performSwitch() {
  try {
    let curPath;
    let curPage = 0;
    const fRes = await PluginCommAPI.getCurrentFilePath();
    if (fRes && fRes.success && fRes.result) curPath = fRes.result;
    const pRes = await PluginCommAPI.getCurrentPageNum();
    if (pRes && pRes.success && pRes.result !== undefined && pRes.result !== null) {
      curPage = pRes.result;
    }
    await NavService.observe(curPath, curPage);

    const target = await NavService.getSwitchTarget(curPath);
    if (!target || !target.path) {
      ToastAndroid.show(
        'Switch: open another note or PDF first (or pick one via long-press), then tap the floating button.',
        ToastAndroid.LONG,
      );
      return;
    }

    // openFile reads shared storage — FILE:READ gated under the host permission system.
    const outcome = await PermissionService.ensure(
      FILE_READ,
      'FlipClip needs read access to switch documents.',
    );
    if (outcome !== 'granted') {
      ToastAndroid.show('FlipClip needs file access to switch documents.', ToastAndroid.LONG);
      return;
    }

    const exists = await FileUtils.exists(target.path);
    if (!exists) {
      ToastAndroid.show('Switch: the other document was moved or deleted.', ToastAndroid.LONG);
      return;
    }

    // Images open via the native intent path (ImageCropModule.openFileDirectly sets an image
    // mime type); notes/PDFs/EPUBs go through the SDK openFile.
    if (isImageFile(target.path) && ImageCropModule && typeof ImageCropModule.openFileDirectly === 'function') {
      try {
        await ImageCropModule.openFileDirectly(target.path, target.page ?? 0);
      } catch (e) {
        ToastAndroid.show('Switch: could not open the image.', ToastAndroid.SHORT);
      }
    } else {
      const openRes = await PluginFileAPI.openFile(target.path, target.page ?? 0);
      if (openRes && openRes.success === false) {
        ToastAndroid.show('Switch: could not open the other document.', ToastAndroid.SHORT);
      }
    }
  } catch (err) {
    console.error('performSwitch error:', err);
  }
}

// Floating-button events (registered once at module load; they stay live in the background,
// so a tap works even when the plugin view is closed).
FloatingButton.onTap(() => {
  performSwitch();
});
FloatingButton.onLongPress(async () => {
  // Long-press opens the floating menu (FlipClip / Clip Region / All Clips / Switch-to…).
  try {
    await ClipService.setLaunchMode('floatmenu');
    await PluginManager.showPluginView();
  } catch (e) {
    console.error('floating long-press error:', e);
  }
});
FloatingButton.onPermissionDenied(() => {
  ToastAndroid.show(
    'Allow "Display over other apps" for FlipClip to use the floating button.',
    ToastAndroid.LONG,
  );
});

// Register the standard React Native UI component
AppRegistry.registerComponent(appName, () => App);

// Register Background Selection Button (DOC text-selection toolbar)
PluginManager.registerButton(3, ['DOC'], {
  id: 300,
  name: 'Clip',
  icon: Image.resolveAssetSource(require('./assets/icon/icon.png')).uri,
  showType: 0, // Executes background handler, no UI popup
});

// NOTE: A lasso image-clip button (type 2) was removed — the document lasso toolbar is
// gated on `editDataTypes` (note-element types), so it never appears over rendered
// PDF/EPUB content. Region capture now has a single entry point: the reader's
// text-selection popup ("Clip" → "Clip Region"), which screenshots the live reader page.

// The ONLY Plugins-menu/sidebar entry: it toggles the always-on-top floating button, which is
// the single access point for everything else (Clip Region, Picture/Text Clippings, Switch).
// (The old "FlipClip" dashboard and "Clip Region" toolbar entries were removed — their actions
// now live in the floating button's long-press menu.)
PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: 102,
  name: 'FlipClip',
  icon: Image.resolveAssetSource(require('./assets/icon/icon.png')).uri,
  showType: 0,
});


// Register Event Listeners
PluginManager.registerButtonListener({
  async onButtonPress(event) {
    if (event.id === 102) {
      // "Switch Doc" toolbar button toggles the always-on-top floating button on/off.
      // (The floating button itself performs the switch; see performSwitch + the listeners.)
      try {
        if (!FloatingButton.isAvailable()) {
          ToastAndroid.show('Floating button not available in this build.', ToastAndroid.LONG);
          return;
        }
        if (await FloatingButton.isShowing()) {
          await FloatingButton.hide();
          ToastAndroid.show('Floating button hidden.', ToastAndroid.SHORT);
          return;
        }
        if (!(await FloatingButton.hasPermission())) {
          ToastAndroid.show(
            'Allow "Display over other apps" for FlipClip, then tap FlipClip again.',
            ToastAndroid.LONG,
          );
          await FloatingButton.requestPermission();
          return;
        }
        const shown = await FloatingButton.show();
        if (shown) {
          // Push the current badge count + selected-target state onto the freshly shown overlay.
          FloatingButton.refreshState();
          // One-time tip: the menu trigger is a DOUBLE-tap now (a long-press was removed because
          // it leaked a paste into the note). Show it once so the change isn't a surprise.
          if (!(await StorageService.getDoubleTapHintShown())) {
            ToastAndroid.show('Tip: single-tap switches documents, double-tap opens the menu.', ToastAndroid.LONG);
            await StorageService.setDoubleTapHintShown(true);
          }
        }
        ToastAndroid.show(
          shown ? 'Floating button on. Tap to switch; double-tap for the menu.' : 'Could not show floating button.',
          ToastAndroid.LONG,
        );
      } catch (err) {
        console.error('Error in button 102 handler:', err);
      }
      return;
    }

    if (event.id === 300) {
      try {
        // Reading the reader's selection is a FILE:READ operation under the host permission
        // system. Gate it here, before the first API call, so a missing grant produces
        // guidance instead of a silent no-op (getLastSelectedText would fail with 1503).
        const outcome = await PermissionService.ensure(
          FILE_READ,
          'FlipClip needs read access to capture the text you selected.',
        );

        if (outcome === 'blocked') {
          ToastAndroid.show(
            'FlipClip: allow file access in Settings → Apps → Plugins → FlipClip → Permissions',
            ToastAndroid.LONG,
          );
          return;
        }

        if (outcome === 'unavailable') {
          // The host could not show its dialog from this background (showType:0) press.
          // Fall back to the foreground: open FlipClip in 'permission' launch mode, which
          // re-requests with a UI attached and completes the clip from there.
          await ClipService.setLaunchMode('permission');
          await PluginManager.showPluginView();
          return;
        }

        if (outcome === 'denied') {
          // Dialog was shown and dismissed — the next press prompts again.
          ToastAndroid.show('FlipClip needs permission to clip', ToastAndroid.SHORT);
          return;
        }

        const response = await PluginDocAPI.getLastSelectedText();
        // Defense in depth: an "allow this time only" grant dies with the plugin session, so
        // a read can still come back 1503 after the gate above said granted.
        if (response && response.success === false && PermissionService.isPermissionError(response)) {
          ToastAndroid.show(
            PermissionService.messageForError(response) || 'FlipClip needs permission to clip',
            ToastAndroid.LONG,
          );
          return;
        }
        if (response.success && response.result) {
          const selectedText = response.result;
          // Collapse wrap newlines/whitespace before counting so a short phrase that merely
          // wrapped to a second line isn't miscounted as a long multi-line block. Decide
          // purely on word count (the old `|| hasNewlines` misfired on wrapped selections).
          const words = selectedText.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

          if (words.length > 5) {
            // Case A: > 5 words -> Auto-clip as text (Completely Silent)
            let articleName = 'Unknown Document';
            let documentPath = undefined;
            let documentPage = undefined;
            try {
              const fileRes = await PluginCommAPI.getCurrentFilePath();
              if (fileRes.success && fileRes.result) {
                documentPath = fileRes.result;
                articleName = deriveArticleName(documentPath);
              }
              const pageRes = await PluginCommAPI.getCurrentPageNum();
              if (pageRes.success && pageRes.result !== undefined && pageRes.result !== null) {
                documentPage = pageRes.result;
              }
            } catch (fileErr) {
              console.error('Failed to get current file metadata:', fileErr);
            }
            
            await ClipService.addClip(selectedText, articleName, documentPath, documentPage);
            ToastAndroid.show('Clipped as Text!', ToastAndroid.SHORT);
          } else {
            // Case B: <= 5 words -> Prompt user (take screenshot first while reader is still visible)
            await captureReaderScreenToPending();
            await Promise.all([
              ClipService.setPromptText(selectedText),
              ClipService.setLaunchMode('prompt'),
            ]);
            await PluginManager.showPluginView();
          }
        }
      } catch (err) {
        console.error('Error in button 300 handler:', err);
        const permMsg = PermissionService.messageForError(err);
        if (permMsg) {
          ToastAndroid.show(permMsg, ToastAndroid.LONG);
        }
      }
    }

    // (Button id 101 — the old "Clip Region" toolbar entry — was removed when its action moved
    // into the floating button's long-press menu. No handler needed.)
  },
});

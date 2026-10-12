// SnClipper/src/services/FloatingButton.ts
//
// Thin JS wrapper over the native FloatingButtonModule (android/.../FloatingButtonModule.kt):
// an always-on-top overlay button for the Switch-Document feature. The native side owns the
// window; this exposes show/hide/permission and the tap/long-press events to JS.

import { NativeModules, DeviceEventEmitter, EmitterSubscription } from 'react-native';

const { FloatingButton: Native } = NativeModules;

export const FLOATING_TAP_EVENT = 'onFloatingTap';
export const FLOATING_LONG_PRESS_EVENT = 'onFloatingLongPress';
export const FLOATING_PERMISSION_DENIED_EVENT = 'onFloatingPermissionDenied';

export interface FloatingAnchor {
  x: number; // button left, device pixels
  y: number; // button top, device pixels
  size: number; // button size, device pixels
  screenW: number; // device pixels
  screenH: number; // device pixels
}

export class FloatingButton {
  // Last long-press anchor (button position), set by the long-press listener and read by the
  // menu so it can position itself next to the button. Same JS runtime, so this is shared.
  static lastAnchor: FloatingAnchor | null = null;

  // Set synchronously the instant a long-press fires, so App can switch to the menu view
  // immediately on (re)activation instead of briefly showing its previous dashboard state.
  static pendingMenu: boolean = false;

  static getAnchor(): FloatingAnchor | null {
    return this.lastAnchor;
  }

  static setPendingMenu(v: boolean): void {
    this.pendingMenu = v;
  }

  /** Returns whether a menu open is pending and clears the flag. */
  static consumePendingMenu(): boolean {
    const v = this.pendingMenu;
    this.pendingMenu = false;
    return v;
  }

  /** Whether the native module is present in this build. */
  static isAvailable(): boolean {
    return !!Native;
  }

  static async hasPermission(): Promise<boolean> {
    if (!Native) return false;
    try {
      return await Native.checkPermission();
    } catch {
      return false;
    }
  }

  /** Opens the system "Display over other apps" settings when permission is missing. */
  static async requestPermission(): Promise<boolean> {
    if (!Native) return false;
    try {
      return await Native.requestPermission();
    } catch {
      return false;
    }
  }

  static async isShowing(): Promise<boolean> {
    if (!Native) return false;
    try {
      return await Native.isShowing();
    } catch {
      return false;
    }
  }

  /** Show the overlay. Resolves false if the overlay permission is not granted. */
  static async show(): Promise<boolean> {
    if (!Native) return false;
    try {
      return await Native.show();
    } catch {
      return false;
    }
  }

  static async hide(): Promise<boolean> {
    if (!Native) return false;
    try {
      return await Native.hide();
    } catch {
      return false;
    }
  }

  /**
   * Temporarily pull the overlay off-screen (or restore it) without changing the on/off intent.
   * Used around a reader screen-capture so the button isn't baked into the screenshot. No-op on
   * older builds lacking the native method.
   */
  static async setOverlayHidden(hidden: boolean): Promise<void> {
    if (!Native || typeof Native.setOverlayHidden !== 'function') return;
    try {
      await Native.setOverlayHidden(hidden);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Pause/resume the native foreground-app watcher. Called with true while the plugin view is
   * foreground (no need to poll then) and false when it goes to the background. No-op on older
   * builds lacking the method.
   */
  static async setWatcherPaused(paused: boolean): Promise<void> {
    if (!Native || typeof Native.setWatcherPaused !== 'function') return;
    try {
      await Native.setWatcherPaused(paused);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Push display state to the native overlay: `count` drives the pending-clip badge, and
   * `hasTarget` renders the button filled (a switch target is selected) vs outline (none).
   * No-op when the native module or the method is absent (older builds), so callers can fire
   * it freely without guarding.
   */
  static async setButtonState(count: number, hasTarget: boolean): Promise<void> {
    if (!Native || typeof Native.setButtonState !== 'function') return;
    try {
      await Native.setButtonState(count, hasTarget);
    } catch {
      /* best-effort cosmetic update */
    }
  }

  /** Read the current clip count + selected target and push both to the native button. */
  static async refreshState(): Promise<void> {
    try {
      // Required lazily to avoid a static import cycle (ClipService → FloatingButton).
      const { ClipService } = require('./ClipService');
      const { NavService } = require('./NavService');
      const count = ClipService.getClipsSync ? ClipService.getClipsSync().length : 0;
      // "Filled" when the user has pinned an override document (otherwise it auto-toggles the
      // two most-recent docs and stays outline).
      const pin = await NavService.getPinnedOverride();
      await this.setButtonState(count, !!pin);
    } catch {
      /* best-effort */
    }
  }

  // Subscribe safely: in non-RN contexts (e.g. the jest test env) DeviceEventEmitter may be
  // undefined, so return a no-op subscription rather than throwing.
  private static safeAdd(event: string, handler: (payload: any) => void): EmitterSubscription {
    if (DeviceEventEmitter && typeof DeviceEventEmitter.addListener === 'function') {
      return DeviceEventEmitter.addListener(event, handler);
    }
    return { remove() {} } as unknown as EmitterSubscription;
  }

  static onTap(cb: () => void): EmitterSubscription {
    return this.safeAdd(FLOATING_TAP_EVENT, () => cb());
  }

  static onLongPress(cb: (anchor: FloatingAnchor | null) => void): EmitterSubscription {
    return this.safeAdd(FLOATING_LONG_PRESS_EVENT, (payload: any) => {
      let anchor: FloatingAnchor | null = null;
      try {
        if (typeof payload === 'string') anchor = JSON.parse(payload);
        else if (payload && typeof payload === 'object') anchor = payload;
      } catch {
        anchor = null;
      }
      FloatingButton.lastAnchor = anchor;
      FloatingButton.pendingMenu = true;
      cb(anchor);
    });
  }

  static onPermissionDenied(cb: () => void): EmitterSubscription {
    return this.safeAdd(FLOATING_PERMISSION_DENIED_EVENT, () => cb());
  }
}

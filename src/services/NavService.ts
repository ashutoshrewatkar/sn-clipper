// SnClipper/src/services/NavService.ts
//
// Document navigation state for the Switch-Document feature (branch feature/toggle-back).
//
// The PluginHost emits no "document changed" event, so the plugin only learns the current
// document when it is invoked (a button press, or its view opening). This service keeps a
// most-recently-used list of locations (each {path, page}), persisted in AsyncStorage.
//
// SWITCH MODEL (2026-10-10 redesign): a quick tap toggles between the TWO most-recently-opened
// documents automatically — no configuration. Optionally the user can PIN one document (via the
// menu's Browse, or by tapping a recent) to override one side of the toggle: while a pin is set a
// tap goes current ↔ pinned. "Clear override" returns to the automatic last-two behaviour. There
// is no stored multi-document ring any more (an old persisted ring is ignored on read) — that
// fixed-ring design is what made the button keep returning to a stale document.
//
// - observe(path, page): move that path to the front of the MRU and record the page.
// - getSwitchTarget(current): where a quick tap should go (pinned if set, else most-recent other).
// - getPinnedOverride / setPinnedOverride / clearPinnedOverride: the single optional pin.
//
// CACHE: reads hit an in-memory copy (loaded once, kept in sync on every write), so a tap or a
// menu-open never waits on AsyncStorage. The on-disk copy is still updated on each write.

import AsyncStorage from '@react-native-async-storage/async-storage';

const NAV_KEY = 'clipper_nav_state_v2';
const MAX_RECENTS = 8;

export interface NavLocation {
  path: string; // absolute file path (as returned by getCurrentFilePath / picked via Browse)
  page: number; // 0-indexed page within that file
}

interface NavState {
  recents: NavLocation[]; // most-recent first, distinct by path
  pinnedOverride: NavLocation | null; // optional doc that overrides one side of the toggle
}

// Normalize for comparison only: getCurrentFilePath / openFile paths may differ by a leading
// file:// prefix. Mirrors the normalize used in App.tsx handleOpenSource.
export const normalizePath = (p: string): string => (p.startsWith('file://') ? p.substring(7) : p);

const samePath = (a: string, b: string): boolean => normalizePath(a) === normalizePath(b);

export class NavService {
  // In-memory copy of the persisted state. Loaded once, then every read returns it and every
  // write updates it, so taps/menu-opens never block on AsyncStorage.
  private static cache: NavState | null = null;

  // Debounce the actual disk write. The cache is authoritative for reads, so coalescing the
  // AsyncStorage.setItem (one write per burst of taps instead of one per tap) saves flash work
  // with no correctness cost — at worst a crash within the window loses the last observe(), which
  // is just MRU ordering. Flushed by any read miss path naturally via the cache.
  private static flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FLUSH_DELAY_MS = 1500;

  private static async read(): Promise<NavState> {
    if (this.cache) return this.cache;
    let state: NavState = { recents: [], pinnedOverride: null };
    try {
      const raw = await AsyncStorage.getItem(NAV_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const recents = Array.isArray(parsed.recents) ? parsed.recents : [];
        // Old states carried `cycle`/`selectedPath` (the retired fixed-ring design). Ignore both
        // deliberately — carrying them forward is exactly what pinned a stale document.
        const pin = parsed.pinnedOverride && parsed.pinnedOverride.path
          ? { path: parsed.pinnedOverride.path, page: typeof parsed.pinnedOverride.page === 'number' ? parsed.pinnedOverride.page : 0 }
          : null;
        state = { recents, pinnedOverride: pin };
      }
    } catch (e) {
      console.warn('NavService.read failed:', e);
    }
    this.cache = state;
    return state;
  }

  private static async write(state: NavState): Promise<void> {
    this.cache = state; // keep the in-memory copy authoritative even if the disk write lags
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flush(); }, this.FLUSH_DELAY_MS);
  }

  /** Persist the cached state to disk now (coalesced target of the debounced write). */
  private static async flush(): Promise<void> {
    this.flushTimer = null;
    if (!this.cache) return;
    try {
      await AsyncStorage.setItem(NAV_KEY, JSON.stringify(this.cache));
    } catch (e) {
      console.warn('NavService.flush failed:', e);
    }
  }

  /** Promote `path` to the front of the MRU and record its page. */
  static async observe(path: string | null | undefined, page: number | null | undefined): Promise<void> {
    if (!path) return;
    const loc: NavLocation = { path, page: typeof page === 'number' ? page : 0 };
    const state = await this.read();
    const rest = state.recents.filter((r) => !samePath(r.path, loc.path));
    const recents = [loc, ...rest].slice(0, MAX_RECENTS);
    // Keep the pin's page fresh if we are observing the pinned doc, so returning to it lands on
    // the page the user was last actually on.
    const pin = state.pinnedOverride && samePath(state.pinnedOverride.path, loc.path)
      ? { ...state.pinnedOverride, page: loc.page }
      : state.pinnedOverride;
    await this.write({ recents, pinnedOverride: pin });
  }

  /** Up to `limit` most-recent locations (most-recent first). */
  static async getRecents(limit = 3): Promise<NavLocation[]> {
    const state = await this.read();
    return state.recents.slice(0, limit);
  }

  /** The optional pinned override document, or null when toggling the automatic last-two. */
  static async getPinnedOverride(): Promise<NavLocation | null> {
    const state = await this.read();
    return state.pinnedOverride;
  }

  /** Pin a document to override one side of the toggle (tap then goes current ↔ pinned). */
  static async setPinnedOverride(loc: NavLocation): Promise<void> {
    if (!loc || !loc.path) return;
    const state = await this.read();
    await this.write({ recents: state.recents, pinnedOverride: { path: loc.path, page: typeof loc.page === 'number' ? loc.page : 0 } });
  }

  /** Remove the pin and return to toggling the two most-recent documents. */
  static async clearPinnedOverride(): Promise<void> {
    const state = await this.read();
    await this.write({ recents: state.recents, pinnedOverride: null });
  }

  /**
   * The two documents a tap toggles between, given the current file, for display in the menu:
   * [current, other]. `other` is the pinned doc when set (and we are not on it), otherwise the
   * most-recent other location. Entries may be null when unknown.
   */
  static async getTogglePair(currentPath: string | null | undefined): Promise<{ current: NavLocation | null; other: NavLocation | null }> {
    const state = await this.read();
    const cur = currentPath ? normalizePath(currentPath) : null;
    const curLoc = currentPath ? (state.recents.find((r) => samePath(r.path, currentPath)) ?? { path: currentPath, page: 0 }) : null;
    const other = await this.getSwitchTarget(currentPath);
    // Mild guard: if the computed other equals current (single-doc history), present it as null.
    const otherLoc = other && (!cur || normalizePath(other.path) !== cur) ? other : null;
    return { current: curLoc, other: otherLoc };
  }

  /**
   * Where a quick tap should navigate, given the current file. With a pin set, toggles
   * current ↔ pinned; otherwise goes to the most-recent OTHER location (automatic last-two).
   * The returned page prefers the freshest observed page so a switch lands where the user was.
   */
  static async getSwitchTarget(currentPath: string | null | undefined): Promise<NavLocation | null> {
    const state = await this.read();
    const cur = currentPath ? normalizePath(currentPath) : null;

    const pageFor = (loc: NavLocation): NavLocation => {
      const recent = state.recents.find((r) => samePath(r.path, loc.path));
      return recent ? { path: loc.path, page: recent.page } : loc;
    };

    const pin = state.pinnedOverride;
    if (pin) {
      if (!cur || normalizePath(pin.path) !== cur) {
        return pageFor(pin); // go to the pinned doc
      }
      // Currently ON the pinned doc → go to the most-recent other (non-pinned) location.
      const other = state.recents.find((r) => normalizePath(r.path) !== cur && normalizePath(r.path) !== normalizePath(pin.path));
      return other ?? null;
    }

    // No pin → most-recent OTHER location (automatic two-document toggle).
    const other = state.recents.find((r) => !cur || normalizePath(r.path) !== cur);
    return other ?? null;
  }
}

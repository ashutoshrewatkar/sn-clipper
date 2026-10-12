package com.sn_clipper

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlin.math.abs

/**
 * Always-on-top floating button for the Switch-Document feature.
 *
 * Draws a draggable button via WindowManager + TYPE_APPLICATION_OVERLAY, which survives
 * closePluginView() and floats over the Note/Document apps. Quick tap emits `onFloatingTap`,
 * long press emits `onFloatingLongPress` (with the button's screen rect) to JS.
 *
 * AUTO-HIDE: while enabled (`wantVisible`), a background watcher polls the foreground app and
 * removes the overlay whenever the user is NOT in the Note/Document/plugin apps, re-adding it
 * when they return — so the button doesn't float over unrelated apps. `isShowing` reports the
 * user intent (`wantVisible`), not the transient on-screen state, so the toggle stays correct.
 *
 * EFFICIENCY (why the watcher is cheap): each poll spawns a `dumpsys` subprocess, which is the
 * heaviest thing this module does on an e-ink device, so the watcher throttles itself hard:
 *   - It backs off exponentially (fast → slow) while the foreground app is unchanged, and
 *     snaps back to the fast rate the instant the foreground app changes.
 *   - It stops polling entirely while the screen is OFF (a SCREEN_ON/OFF receiver flips a flag
 *     and wakes the thread), so a sleeping device spawns no subprocesses at all.
 *
 * STATE (badge + selected): the button shows a small count badge (pending clips) and renders
 * filled when a switch target is selected / outline when not, pushed from JS via setButtonState.
 */
class FloatingButtonModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var overlayView: View? = null
    private var buttonLabel: TextView? = null
    private var badgeView: TextView? = null
    private var layoutParams: WindowManager.LayoutParams? = null

    private var wantVisible = false
    // Temporarily pulls the overlay off-screen WITHOUT changing wantVisible (so the toggle state
    // is preserved). Used while screen-capturing the reader so the button isn't in the shot.
    @Volatile private var suppressed = false
    @Volatile private var watching = false
    @Volatile private var screenOn = true
    // Paused while the plugin's own view is foreground (AppState 'active'): no need to poll the
    // foreground app then — pluginhost IS the foreground app, so the overlay should show — and it
    // saves a dumpsys subprocess every couple of seconds while the user is in the plugin UI.
    @Volatile private var paused = false
    private var watcher: Thread? = null
    private var screenReceiver: BroadcastReceiver? = null

    // Button state pushed from JS; applied on build and on every change.
    @Volatile private var clipCount = 0
    @Volatile private var hasTarget = false

    private val targetPkgs = setOf(
        "com.ratta.supernote.note",
        "com.supernote.document",
        "com.ratta.supernote.pluginhost",
    )

    // Adaptive poll window. Starts fast so a return to a note shows the button quickly, then
    // backs off toward the slow rate while nothing changes (far fewer dumpsys subprocesses).
    private val fastPollMs = 2000L
    private val slowPollMs = 20000L

    override fun getName(): String = "FloatingButton"

    private fun windowManager(): WindowManager =
        reactApplicationContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private fun hasPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            Settings.canDrawOverlays(reactApplicationContext)

    private fun dp(value: Float): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, reactApplicationContext.resources.displayMetrics,
        ).toInt()

    private fun emit(eventName: String, data: Any? = null) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, data)
        } catch (e: Exception) { /* JS context not ready */ }
    }

    private fun anchorJson(): String {
        val p = layoutParams
        val x = p?.x ?: 0
        val y = p?.y ?: 0
        val size = dp(56f)
        val dm = reactApplicationContext.resources.displayMetrics
        return """{"x":$x,"y":$y,"size":$size,"screenW":${dm.widthPixels},"screenH":${dm.heightPixels}}"""
    }

    @ReactMethod
    fun checkPermission(promise: Promise) { promise.resolve(hasPermission()) }

    @ReactMethod
    fun requestPermission(promise: Promise) {
        try {
            if (hasPermission()) { promise.resolve(true); return }
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + reactApplicationContext.packageName),
            ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("REQUEST_PERMISSION_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun isShowing(promise: Promise) { promise.resolve(wantVisible) }

    /**
     * Temporarily remove / restore the overlay without changing the on/off intent. Used around a
     * reader screen-capture so the floating button is not baked into the screenshot. The watcher
     * respects `suppressed` so it won't re-add the overlay mid-capture.
     */
    /**
     * Pause / resume the foreground-app watcher. The plugin's own view calls this on AppState
     * 'active' (pause — no point polling while pluginhost is foreground) and 'background' (resume),
     * saving a dumpsys subprocess every couple of seconds while the user is in the plugin UI.
     */
    @ReactMethod
    fun setWatcherPaused(pausedFlag: Boolean, promise: Promise) {
        paused = pausedFlag
        if (!pausedFlag) watcher?.interrupt() // wake for an immediate poll on resume
        promise.resolve(true)
    }

    @ReactMethod
    fun setOverlayHidden(hidden: Boolean, promise: Promise) {
        suppressed = hidden
        mainHandler.post {
            if (hidden) removeOverlay()
            else if (wantVisible) addOverlay()
        }
        promise.resolve(true)
    }

    /**
     * Push the button's display state from JS. `count` = pending clips (badge), `hasTarget` =
     * whether a switch target is selected (filled vs outline). Safe to call anytime; the overlay
     * may not be on screen (auto-hidden) — the values are remembered and applied when it returns.
     */
    @ReactMethod
    fun setButtonState(count: Int, targetSelected: Boolean, promise: Promise) {
        clipCount = count
        hasTarget = targetSelected
        mainHandler.post { applyButtonAppearance() }
        promise.resolve(true)
    }

    @ReactMethod
    fun show(promise: Promise) {
        if (!hasPermission()) {
            emit("onFloatingPermissionDenied")
            promise.resolve(false)
            return
        }
        wantVisible = true
        mainHandler.post { addOverlay() }
        registerScreenReceiver()
        startWatcher()
        promise.resolve(true)
    }

    @ReactMethod
    fun hide(promise: Promise) {
        wantVisible = false
        stopWatcher()
        unregisterScreenReceiver()
        mainHandler.post { removeOverlay() }
        promise.resolve(true)
    }

    // --- overlay add/remove (main thread), idempotent; layoutParams reused to keep position ---

    private fun addOverlay() {
        try {
            if (overlayView != null) return
            val button = buildButtonView()
            var params = layoutParams
            if (params == null) {
                // Explicit window size (not WRAP_CONTENT): the badge wrapper made WRAP_CONTENT
                // mis-measure on this firmware and clip the button to a sliver. A fixed box the
                // size of the button draws the whole oval reliably.
                params = WindowManager.LayoutParams(
                    dp(56f),
                    dp(56f),
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    else
                        @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    android.graphics.PixelFormat.TRANSLUCENT,
                )
                params.gravity = Gravity.TOP or Gravity.START
                params.x = dp(16f)
                params.y = dp(160f)
                layoutParams = params
            }
            attachTouch(button, params)
            windowManager().addView(button, params)
            overlayView = button
        } catch (e: Exception) { /* best-effort */ }
    }

    private fun removeOverlay() {
        try {
            overlayView?.let { try { windowManager().removeView(it) } catch (_: Exception) {} }
            overlayView = null
            buttonLabel = null
            badgeView = null
        } catch (e: Exception) { /* best-effort */ }
    }

    // --- screen on/off receiver (pause polling while the device sleeps) ---

    private fun registerScreenReceiver() {
        if (screenReceiver != null) return
        screenReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_SCREEN_OFF -> screenOn = false
                    Intent.ACTION_SCREEN_ON -> {
                        screenOn = true
                        watcher?.interrupt() // wake for an immediate poll
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        }
        try { reactApplicationContext.registerReceiver(screenReceiver, filter) } catch (_: Exception) {}
    }

    private fun unregisterScreenReceiver() {
        screenReceiver?.let { try { reactApplicationContext.unregisterReceiver(it) } catch (_: Exception) {} }
        screenReceiver = null
    }

    // --- foreground-app watcher (auto-hide), adaptive + screen-aware ---

    private fun startWatcher() {
        if (watching) return
        watching = true
        watcher = Thread {
            var interval = fastPollMs
            var lastFg: String? = "__init__"
            while (watching) {
                // Skip polling (no dumpsys subprocess) while the screen is off OR the plugin's own
                // view is foreground (paused). Idle until SCREEN_ON / resume interrupts us, with a
                // slow tick as a safety net.
                if (!screenOn || paused) {
                    interval = fastPollMs // poll promptly once we resume
                    sleepInterruptible(slowPollMs)
                    continue
                }

                val fg = currentForegroundPackage()
                // null = couldn't detect → keep whatever is showing (don't flap on a failed read).
                val shouldShow = fg == null || targetPkgs.contains(fg)
                mainHandler.post {
                    if (!wantVisible) return@post
                    val show = shouldShow && !suppressed
                    if (show && overlayView == null) addOverlay()
                    else if (!show && overlayView != null) removeOverlay()
                }

                // Back off while the foreground app is unchanged; snap back to fast on any change.
                if (fg != null && fg == lastFg) {
                    interval = minOf(interval * 2, slowPollMs)
                } else {
                    interval = fastPollMs
                }
                lastFg = fg

                sleepInterruptible(interval)
            }
        }.apply { isDaemon = true; start() }
    }

    /**
     * Sleep that an interrupt can cut short. An interrupt means either "screen came on, re-poll
     * now" or "we're stopping" — in both cases we just return, and the `while (watching)` check
     * decides: it stays true on a wake (loop continues) and is false on a stop (loop exits).
     */
    private fun sleepInterruptible(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (e: InterruptedException) {
            /* fall through: the loop condition handles wake-vs-stop */
        }
    }

    private fun stopWatcher() {
        watching = false
        watcher?.interrupt()
        watcher = null
    }

    private val resumedRegex = Regex("""mResumedActivity:.*?(\S+)/(\S+)""")

    private fun currentForegroundPackage(): String? {
        var p: Process? = null
        return try {
            p = Runtime.getRuntime().exec(arrayOf("dumpsys", "activity", "activities"))
            val reader = p.inputStream.bufferedReader()
            var pkg: String? = null
            reader.useLines { lines ->
                for (line in lines) {
                    if (line.contains("mResumedActivity")) {
                        resumedRegex.find(line)?.let { pkg = it.groupValues[1] }
                        break
                    }
                }
            }
            p.waitFor()
            pkg
        } catch (e: Exception) {
            null
        } finally {
            p?.let {
                try { it.inputStream.close() } catch (_: Exception) {}
                try { it.errorStream.close() } catch (_: Exception) {}
                try { it.outputStream.close() } catch (_: Exception) {}
                try { it.destroy() } catch (_: Exception) {}
            }
        }
    }

    // --- button view (oval label + count badge), with selected/outline styling ---

    private fun buildButtonView(): View {
        val size = dp(56f)

        val label = TextView(reactApplicationContext).apply {
            text = "⇄"
            textSize = 24f
            gravity = Gravity.CENTER
            width = size
            height = size
        }

        val badge = TextView(reactApplicationContext).apply {
            textSize = 11f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            val bg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.BLACK)
                setStroke(dp(1.5f), Color.WHITE)
            }
            background = bg
            visibility = View.GONE
        }
        val badgeSize = dp(22f)
        val badgeParams = FrameLayout.LayoutParams(badgeSize, badgeSize).apply {
            gravity = Gravity.TOP or Gravity.END
        }

        val container = FrameLayout(reactApplicationContext).apply {
            clipChildren = false
            clipToPadding = false
            addView(label, FrameLayout.LayoutParams(size, size))
            addView(badge, badgeParams)
        }

        buttonLabel = label
        badgeView = badge
        applyButtonAppearance()
        return container
    }

    /** Recolor the button for the current state. No-op if the overlay isn't built. */
    private fun applyButtonAppearance() {
        val label = buttonLabel ?: return
        val filled = hasTarget
        val fg = if (filled) Color.WHITE else Color.BLACK
        val bgColor = if (filled) Color.BLACK else Color.WHITE
        label.setTextColor(fg)
        label.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(bgColor)
            setStroke(dp(2f), Color.BLACK)
        }
        badgeView?.let { b ->
            if (clipCount > 0) {
                b.text = if (clipCount > 99) "99+" else clipCount.toString()
                b.visibility = View.VISIBLE
            } else {
                b.visibility = View.GONE
            }
        }
    }

    private fun attachTouch(view: View, params: WindowManager.LayoutParams) {
        val touchSlop = dp(8f)
        // A single tap switches; a DOUBLE tap opens the menu. We deliberately do NOT use a
        // sustained long-press any more: a held press on the overlay was reaching the note canvas
        // underneath (the EMR pen layer bypasses the overlay's hit-testing) and triggering the
        // note's "paste clipboard" gesture. A double tap never looks like a long-press, so the
        // note is never pasted into. The ~280 ms disambiguation is hidden under the e-ink repaint.
        val doubleTapMs = 280L
        var downRawX = 0f
        var downRawY = 0f
        var startX = 0
        var startY = 0
        var dragging = false
        var pendingTap: Runnable? = null

        view.setOnTouchListener { v, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = event.rawX; downRawY = event.rawY
                    startX = params.x; startY = params.y
                    dragging = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - downRawX).toInt()
                    val dy = (event.rawY - downRawY).toInt()
                    if (!dragging && (abs(dx) > touchSlop || abs(dy) > touchSlop)) {
                        dragging = true
                    }
                    if (dragging) {
                        params.x = startX + dx
                        params.y = startY + dy
                        try { windowManager().updateViewLayout(v, params) } catch (_: Exception) {}
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (dragging) {
                        // A drag cancels any pending tap and edge-docks: snap to whichever vertical
                        // edge the button's centre is nearer, so it rests flush and stops covering
                        // page content.
                        pendingTap?.let { mainHandler.removeCallbacks(it) }
                        pendingTap = null
                        val dm = reactApplicationContext.resources.displayMetrics
                        val viewW = v.width.takeIf { it > 0 } ?: dp(56f)
                        val margin = dp(4f)
                        val centerX = params.x + viewW / 2
                        params.x = if (centerX < dm.widthPixels / 2) margin else dm.widthPixels - viewW - margin
                        val viewH = v.height.takeIf { it > 0 } ?: dp(56f)
                        params.y = params.y.coerceIn(0, maxOf(0, dm.heightPixels - viewH))
                        try { windowManager().updateViewLayout(v, params) } catch (_: Exception) {}
                    } else if (pendingTap != null) {
                        // Second tap within the window → open the menu, cancel the queued switch.
                        pendingTap?.let { mainHandler.removeCallbacks(it) }
                        pendingTap = null
                        emit("onFloatingLongPress", anchorJson())
                    } else {
                        // First tap → switch, unless a second tap arrives within doubleTapMs.
                        val r = Runnable { pendingTap = null; emit("onFloatingTap") }
                        pendingTap = r
                        mainHandler.postDelayed(r, doubleTapMs)
                    }
                    true
                }
                MotionEvent.ACTION_CANCEL -> true
                else -> false
            }
        }
    }

    override fun invalidate() {
        stopWatcher()
        unregisterScreenReceiver()
        mainHandler.post { removeOverlay() }
        super.invalidate()
    }
}

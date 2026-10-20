import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

export type DeckModel =
    | "original_v1"
    | "original_v2"
    | "mini"
    | "mk2"
    | "xl"
    | "xl_v2"
    | "plus"
    | "neo";

export type DeckImageFormat = "jpeg" | "bmp_bgr_rot180" | "bmp_bgr_rot270";

export interface DeckInfo {
    deckId: string;
    model: DeckModel;
    productId: number;
    rows: number;
    cols: number;
    keyCount: number;
    keyImage: {
        w: number;
        h: number;
        format: DeckImageFormat;
        /** Degrees to rotate the rendered image clockwise before sending. */
        rotation: number;
    };
    dialCount: number;
    lcd?: { w: number; h: number };
    /** Neo only: one 248x58 screen (count 1), mounted like the keys, so
     *  its image is rotated 180° as well. */
    infoBars?: { w: number; h: number; count: number };
    touchPoints: number;
    firmwareVersion: string;
    /** False when the deck answered no feature report at open: brightness
     *  and reset are refused (control_pipe_down), but for one short try
     *  every 5 s, until a control request goes through. As of when this
     *  info was read. */
    controlPipeOk: boolean;
    capabilities: string[];
}

/** Both false until the user turns them on (Options › Stream Deck). */
export interface DeckPowerOptions {
    /** A launch caused by the deck — USB attach, or a wake-on-key-press
     *  relaunch — shows the app over the lock screen and turns the
     *  screen on. Any other launch never does. */
    showOverLockScreen: boolean;
    /** While a deck is open: partial wake lock, and a 700 ms heartbeat
     *  that keeps the USB bus out of selective suspend. */
    keepAwake: boolean;
}

export interface KeyEvent {
    deckId: string;
    key: number;
    pressed: boolean;
}

export interface DialRotateEvent {
    deckId: string;
    dial: number;
    delta: number;
}

export interface DialPressEvent {
    deckId: string;
    dial: number;
    pressed: boolean;
}

export interface LcdTouchEvent {
    deckId: string;
    type: "short" | "long" | "drag";
    x: number;
    y: number;
    xEnd?: number;
    yEnd?: number;
}

export interface NeoTouchEvent {
    deckId: string;
    index: number;
    pressed: boolean;
}

export interface DeckLifecycleEvent {
    deckId: string;
    info?: DeckInfo;
    reason?: string;
}

/** Failure of a fire-and-forget key write (setKeyImagesBatch), which has
 *  no Promise to reject: a rejected image or a failed USB transfer. A key
 *  failing again for the same reason is sent once, until a write to it
 *  succeeds. Transfers that keep failing also close the deck, which then
 *  arrives as deckDisconnected with reason "usb_lost:<detail>". */
export interface WriteFailedEvent {
    deckId: string;
    key: number;
    reason: string;
}

/** A deck whose session closed itself is reopened after 2, 4 then 8 s;
 *  this is sent once when the third attempt fails too, or at once when a
 *  retry finds the USB permission missing (reason permission_missing).
 *  Nothing retries it afterwards: unplugging it, restartSessions or
 *  retryAttach reopens it, and gives it its three attempts back.
 *  deckId is "" when no serial was read; reason is the last close or
 *  attach failure. */
export interface ReattachGaveUpEvent {
    deckId: string;
    deviceName: string;
    attempts: number;
    reason: string;
}

/** One attached Stream Deck as getSessionHealth reports it. sick is the
 *  plugin's verdict (SessionHealth.java): restarting this deck would help.
 *  sickReason is "" when healthy, else no_session, reader_ended,
 *  writer_ended, writes_failing or control_failing. Time since the last
 *  input report is not a signal: an idle deck sends none. */
export interface DeckHealth {
    /** System USB path, the key of restartSessions({deviceNames}). */
    deviceName: string;
    /** The session's serial, else the USB serial once readable, else "". */
    deckId: string;
    hasPermission: boolean;
    open: boolean;
    /** An automatic reopen (2, 4, 8 s) is underway for this deck. */
    reopening: boolean;
    readerAlive: boolean;
    writerAlive: boolean;
    writeFailuresInARow: number;
    controlFailuresInARow: number;
    /** False for an open session whose control pipe answered nothing at
     *  open and nothing since; its control failures are then no sickness,
     *  since a restart does not clear them. True when no session is open. */
    controlPipeOk: boolean;
    lastCloseReason: string;
    sick: boolean;
    sickReason: string;
}

export interface ImageWriteResult {
    dropped?: boolean;
}

export interface UsbDeviceDiag {
    deviceName: string;
    vendorId: number;
    productId: number;
    vendorIdHex: string;
    productIdHex: string;
    productName: string;
    manufacturerName: string;
    serial: string;
    isElgato: boolean;
    knownStreamDeck: boolean;
    hasPermission: boolean;
    /** True if the plugin currently has an open DeckSession for this device. */
    inSession: boolean;
    /** Last attach failure reason for this device path (empty if none). */
    lastAttachError: string;
}

/** What one device's permission request came to. already_granted: it
 *  was permitted before the call and no dialog was shown; timeout: the
 *  dialog got no answer within 30 s. */
export type DeckPermissionOutcome =
    | "already_granted"
    | "granted"
    | "denied"
    | "timeout"
    | "error";

export interface DeckPermissionResult {
    /** System USB path, the key of listAllUsbDevices and requestPermissionForUsb. */
    deviceName: string;
    /** The open deck's id, else the USB serial once readable, else "". */
    deckId: string;
    outcome: DeckPermissionOutcome;
    granted: boolean;
    error?: string;
}

export interface DeckPermissionResponse {
    /** True only when every targeted device is granted. */
    granted: boolean;
    results: DeckPermissionResult[];
}

/** One log line per device of a requestPermission response. */
export function describePermissionResponse(r: DeckPermissionResponse): string[] {
    if (!Array.isArray(r.results)) return [`granted=${r.granted}`];
    return r.results.map((x) =>
        `${x.deviceName}${x.deckId ? ` (${x.deckId})` : ""} → ${x.outcome}`
        + (x.error ? `: ${x.error}` : ""),
    );
}

interface StreamDeckPluginApi {
    listDecks(): Promise<{ decks: DeckInfo[] }>;
    /** Diagnostic: every USB device on the phone, regardless of vendor. */
    listAllUsbDevices(): Promise<{ devices: UsbDeviceDiag[] }>;
    /** Ask the OS for permission on a USB device by its system name. */
    requestPermissionForUsb(opts: { deviceName: string }): Promise<{ granted: boolean; error?: string }>;
    /**
     * Re-run onDeckAttached for every USB device that is a known Stream
     * Deck with permission but has no open DeckSession. Use this after
     * the diagnostic UI's listener attaches (boot-time attach errors
     * are otherwise lost).
     */
    retryAttach(): Promise<{ retried: number }>;
    /**
     * Toggle raw-input dump from the reader thread (one event per
     * successful interrupt-IN transfer, including timeouts? no, only
     * data-bearing reads).
     */
    setDebugLogging(opts: { enabled: boolean }): Promise<{ enabled: boolean }>;
    /** Switch reader strategy. Three options:
     *   - "userequest": UsbRequest async on interrupt-IN (default)
     *   - "bulk":       bulkTransfer sync on interrupt-IN
     *   - "polled":     HID GET_REPORT on EP0 (~30 Hz polling)
     *  Takes effect on next session open — call restartSessions to
     *  apply without unplugging. */
    setReaderMode(opts: { mode: "userequest" | "bulk" | "polled" }):
        Promise<{ mode: "userequest" | "bulk" | "polled" }>;
    getReaderMode():
        Promise<{ mode: "userequest" | "bulk" | "polled" }>;
    /** @deprecated — use setReaderMode. */
    setReaderUseBulk(opts: { enabled: boolean }): Promise<{ enabled: boolean }>;
    /** @deprecated — use getReaderMode. */
    getReaderUseBulk(): Promise<{ enabled: boolean }>;
    /** Close every open session, then attach every permitted deck that
     *  has no session — including one whose session closed itself while
     *  it stayed plugged in. Used to pick up a reader-mode change without
     *  an unplug. With deviceNames, only those USB devices are closed and
     *  reopened. `restarted` counts the decks re-attached, a deck whose
     *  close outlasts the 3 s wait included: it reopens once that close
     *  ends. */
    restartSessions(opts?: { deviceNames?: string[] }): Promise<{ restarted: number }>;
    /** Per attached Stream Deck, the session signals and the plugin's
     *  sick verdict; makes no USB transfer. */
    getSessionHealth(): Promise<{ decks: DeckHealth[] }>;
    /** Call once the app's keyChanged handler is subscribed. Until then,
     *  and again after each page load, the plugin holds key events: the
     *  last 16 at most, delivered through keyChanged in arrival order by
     *  this call, except those older than 10 s. Later events pass
     *  straight through. Resolves with what the held events became. */
    keyListenerReady(): Promise<{ delivered: number; dropped: number }>;
    getDeckInfo(opts: { deckId: string }): Promise<DeckInfo>;
    /**
     * Ask the OS for USB permission on one deck or, without deckId, on
     * every attached Stream Deck — the only way to reach a deck whose
     * serial Android still hides. A device already permitted resolves
     * already_granted without a dialog; the call resolves once every
     * device has an outcome. A granted deck that is not open is opened
     * and announced by deckConnected. Rejects "no_stream_deck" /
     * "no_such_deck:<id>".
     */
    requestPermission(opts?: { deckId?: string }): Promise<DeckPermissionResponse>;
    reset(opts: { deckId: string }): Promise<void>;
    /** Drop every queued image write for a deck. Used to flush the
     *  WriterQueue at the end of camera streaming so leftover frames
     *  don't keep the firmware busy and miss the next button press. */
    clearPendingWrites(opts: { deckId: string }): Promise<{ dropped: number }>;
    setBrightness(opts: { deckId: string; percent: number }): Promise<void>;

    /**
     * When enabled, a key press while the host activity is paused brings
     * MainActivity to the foreground. With the screen off it does so only
     * with the showOverLockScreen power option on, which turns the screen
     * on and shows the app over the lock screen; without that option the
     * screen stays off and the press arrives as keyChanged only.
     * A press reaches the reader with
     * the screen off reliably only with the keepAwake power option, whose
     * wake lock and heartbeat keep the USB bus up; this method only arms
     * the wake-on-press path.
     */
    setWakeOnKeyPress(opts: { enabled: boolean }): Promise<{ enabled: boolean }>;

    /** Both power options as stored natively. */
    getPowerOptions(): Promise<DeckPowerOptions>;
    /** Store the fields given, leave the others; resolves with both.
     *  keepAwake applies at once to the open decks. */
    setPowerOptions(opts: Partial<DeckPowerOptions>): Promise<DeckPowerOptions>;

    /** Rejects "missing:key" / "invalid_key:N" for a key the deck lacks,
     *  "image_oversized:WxH>KWxKH" for an image larger than the key, and
     *  "format_mismatch:bmp_model_requires_png" or
     *  "format_mismatch:jpeg_model_requires_jpeg" for bytes the deck's
     *  keyImage.format does not take. */
    setKeyImage(opts: {
        deckId: string;
        key: number;
        bytes: string; // base64
        format: "jpeg" | "png";
    }): Promise<ImageWriteResult>;
    /**
     * Streaming-friendly batch — queues every entry through a single
     * JNI crossing. Each entry is fire-and-forget on the writer queue;
     * the promise resolves once Java finishes Base64-decoding and
     * offering, not when USB completes. Use for camera streaming.
     * A write that fails later is reported through writeFailed.
     */
    setKeyImagesBatch(opts: {
        deckId: string;
        format: "jpeg" | "png";
        entries: { key: number; bytes: string }[];
    }): Promise<{ queued: number; dropped: number }>;
    /** Paints the key black at its native size; same key checks as setKeyImage. */
    clearKey(opts: { deckId: string; key: number }): Promise<ImageWriteResult>;
    clearAllKeys(opts: { deckId: string }): Promise<void>;

    setLcdImage(opts: { deckId: string; bytes: string }): Promise<ImageWriteResult>;
    setLcdRegion(opts: {
        deckId: string;
        x: number;
        y: number;
        w: number;
        h: number;
        bytes: string;
    }): Promise<ImageWriteResult>;
    /** index runs 0..infoBars.count-1, so 0 on the Neo; any other rejects
     *  "invalid_index:N". */
    setInfoBar(opts: { deckId: string; index: number; bytes: string }): Promise<ImageWriteResult>;

    addListener(
        eventName: "deckConnected",
        listener: (ev: DeckLifecycleEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: "deckDisconnected",
        listener: (ev: DeckLifecycleEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: "permissionDenied",
        listener: (ev: DeckLifecycleEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: "keyChanged",
        listener: (ev: KeyEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: "dialRotated",
        listener: (ev: DialRotateEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: "dialPressed",
        listener: (ev: DialPressEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: "lcdTouched",
        listener: (ev: LcdTouchEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: "neoTouched",
        listener: (ev: NeoTouchEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: "writeFailed",
        listener: (ev: WriteFailedEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: "reattachGaveUp",
        listener: (ev: ReattachGaveUpEvent) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: "rawInputReport",
        listener: (ev: { deckId: string; len: number; bytes: string }) => void
    ): Promise<PluginListenerHandle>;
}

export const StreamDeckPlugin = registerPlugin<StreamDeckPluginApi>("StreamDeckPlugin");

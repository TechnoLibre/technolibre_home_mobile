import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

export type DeckModel =
    | "original_v1"
    | "original_v2"
    | "mini"
    | "mk2"
    | "xl"
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
    keyImage: { w: number; h: number; format: DeckImageFormat };
    dialCount: number;
    lcd?: { w: number; h: number };
    infoBars?: { w: number; h: number; count: number };
    touchPoints: number;
    firmwareVersion: string;
    capabilities: string[];
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
    getDeckInfo(opts: { deckId: string }): Promise<DeckInfo>;
    requestPermission(opts: { deckId: string }): Promise<{ granted: boolean }>;
    reset(opts: { deckId: string }): Promise<void>;
    setBrightness(opts: { deckId: string; percent: number }): Promise<void>;

    setKeyImage(opts: {
        deckId: string;
        key: number;
        bytes: string; // base64
        format: "jpeg" | "png";
    }): Promise<ImageWriteResult>;
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
    setInfoBar(opts: { deckId: string; index: 0 | 1; bytes: string }): Promise<ImageWriteResult>;

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
}

export const StreamDeckPlugin = registerPlugin<StreamDeckPluginApi>("StreamDeckPlugin");

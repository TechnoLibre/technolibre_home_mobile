import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import type {
    ChatHttp, DownloadAnswer, DownloadRequest, HttpAnswer, TransferProgress, UploadRequest,
} from "../services/chat/chatFiles";
import type { JpegAnswer, JpegRequest } from "../services/chat/chatCapture";
import { ChatTransferCancelledError } from "../services/chat/chatTransfer";
import { RequestNotSentError } from "../services/odoo/odooRpcClient";

/** Code of a rejection whose request never reached the server (failed before its headers went out). */
export const CHAT_FILE_UNSENT = "UNSENT";
/** Code of a rejection of a transfer stopped by cancel(). */
export const CHAT_FILE_CANCELLED = "CANCELLED";
/** Code of an openWith rejection when no app on the phone opens the file. */
export const CHAT_FILE_NO_APP = "NO_APP";

export interface ChatFilePlugin {
    getText(options: { url: string; headers: Record<string, string> }): Promise<HttpAnswer>;
    upload(options: UploadRequest): Promise<HttpAnswer>;
    download(options: DownloadRequest): Promise<DownloadAnswer>;
    cancel(options: { id: string }): Promise<void>;
    /**
     * Writes the image at from as a JPEG at to (both inside the chat
     * directory; to may be from): EXIF orientation applied, the long side
     * fitted to maxPx (0 keeps the size), transparency on white. Rejects
     * when the phone cannot decode the image (a HEIC before Android 9).
     */
    toJpeg(options: JpegRequest): Promise<JpegAnswer>;
    /**
     * Opens a file of the chat directory (uri as ChatFiles.uri gives it) in
     * another app, through Android's chooser titled title: shared as a
     * FileProvider content: URI with a read grant. Rejects with code NO_APP
     * when no app takes mimetype.
     */
    openWith(options: { uri: string; mimetype: string; title?: string }): Promise<void>;
    addListener(
        event: "chatFileProgress",
        fn: (ev: TransferProgress) => void
    ): Promise<PluginListenerHandle>;
}

/**
 * Native streamed file transfer (OkHttp): multipart uploads read from a
 * file and downloads written to one, with the session Cookie sent as given;
 * JPEG conversion of a picked image; « open with » of a file. Files must
 * lie inside the app's chat directory.
 */
export const ChatFile = registerPlugin<ChatFilePlugin>("ChatFile");

/**
 * The typed error of a transport rejection: code UNSENT becomes
 * RequestNotSentError, code CANCELLED ChatTransferCancelledError; any
 * other passes as is. Every ChatHttp (fakeChatHttp too) maps through it,
 * so callers only ever see the typed errors.
 */
export function transportError(e: unknown): unknown {
    const code = (e as { code?: unknown } | null)?.code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === CHAT_FILE_UNSENT) return new RequestNotSentError(msg);
    if (code === CHAT_FILE_CANCELLED) return new ChatTransferCancelledError(msg);
    return e;
}

async function bridged<T>(call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (e: unknown) {
        throw transportError(e);
    }
}

/** ChatHttp over the ChatFile plugin. */
export function nativeChatHttp(): ChatHttp {
    return {
        getText: (url, headers) => bridged(() => ChatFile.getText({ url, headers })),
        upload: (r) => bridged(() => ChatFile.upload(r)),
        download: (r) => bridged(() => ChatFile.download(r)),
        cancel: (id) => ChatFile.cancel({ id }),
        onProgress(fn) {
            let off = false;
            const handle = ChatFile.addListener("chatFileProgress", (ev) => {
                if (!off) fn(ev);
            });
            return () => {
                off = true;
                handle.then((h) => h.remove()).catch(() => {});
            };
        },
    };
}

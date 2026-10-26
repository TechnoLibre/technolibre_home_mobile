import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import type {
    ChatHttp, DownloadAnswer, DownloadRequest, HttpAnswer, TransferProgress, UploadRequest,
} from "../services/chat/chatFiles";
import { RequestNotSentError } from "../services/odoo/odooRpcClient";

/** Code of a rejection whose request never reached the server (failed before its headers went out). */
export const CHAT_FILE_UNSENT = "UNSENT";
/** Code of a rejection of a transfer stopped by cancel(). */
export const CHAT_FILE_CANCELLED = "CANCELLED";

export interface ChatFilePlugin {
    getText(options: { url: string; headers: Record<string, string> }): Promise<HttpAnswer>;
    upload(options: UploadRequest): Promise<HttpAnswer>;
    download(options: DownloadRequest): Promise<DownloadAnswer>;
    cancel(options: { id: string }): Promise<void>;
    addListener(
        event: "chatFileProgress",
        fn: (ev: TransferProgress) => void
    ): Promise<PluginListenerHandle>;
}

/**
 * Native streamed file transfer (OkHttp): multipart uploads read from a
 * file and downloads written to one, with the session Cookie sent as given.
 * Files must lie inside the app's chat directory.
 */
export const ChatFile = registerPlugin<ChatFilePlugin>("ChatFile");

/** An UNSENT rejection becomes RequestNotSentError; any other passes as is, its code kept. */
async function bridged<T>(call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (e: unknown) {
        if ((e as { code?: unknown } | null)?.code === CHAT_FILE_UNSENT) {
            throw new RequestNotSentError(e instanceof Error ? e.message : String(e));
        }
        throw e;
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

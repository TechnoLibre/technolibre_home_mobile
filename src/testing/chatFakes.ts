import { transportError } from "../plugins/chatFilePlugin";
import type {
    ChatFiles, ChatHttp, DownloadAnswer, DownloadRequest, HttpAnswer, TransferProgress, UploadRequest,
} from "../services/chat/chatFiles";

/** Where memoryChatFiles pretends Directory.Data is. */
const MEMORY_ROOT = "file:///memory/files/";

/**
 * ChatFiles held in memory, by relative path. put() also stores bytes
 * under any key (a content: URI, a cache path) for copyFrom to read.
 */
export function memoryChatFiles(): ChatFiles & {
    bytes(rel: string): Uint8Array | undefined;
    put(rel: string, bytes: Uint8Array): void;
} {
    const store = new Map<string, Uint8Array>();
    const keyOf = (pathOrUri: string) =>
        pathOrUri.startsWith(MEMORY_ROOT) ? decodeURI(pathOrUri.slice(MEMORY_ROOT.length)) : pathOrUri;
    return {
        bytes: (rel) => store.get(rel),
        put: (rel, bytes) => void store.set(rel, bytes),
        uri: async (rel) => MEMORY_ROOT + encodeURI(rel),
        webUrl: async (rel) => `http://localhost/_capacitor_file_/memory/files/${encodeURI(rel)}`,
        size: async (rel) => store.get(rel)?.length ?? null,
        async writeBlob(rel, blob) {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            store.set(rel, bytes);
            return bytes.length;
        },
        async copyFrom(source, rel) {
            const bytes = store.get(keyOf(source));
            if (!bytes) throw new Error(`File does not exist: ${source}`);
            store.set(rel, bytes.slice());
            return bytes.length;
        },
        async rename(from, to) {
            const bytes = store.get(from);
            if (!bytes) throw new Error(`File does not exist: ${from}`);
            store.delete(from);
            store.set(to, bytes);
        },
        remove: async (rel) => void store.delete(rel),
        async removeDir(rel) {
            for (const key of [...store.keys()]) if (key.startsWith(`${rel}/`)) store.delete(key);
        },
    };
}

type Answerable<T> = T | Promise<T>;

/** One request seen by fakeChatHttp. */
export interface FakeHttpCall {
    kind: "getText" | "upload" | "download" | "cancel";
    url: string;
    id?: string;
    headers?: Record<string, string>;
    fields?: Record<string, string>;
    file?: { uri: string; name: string; mimetype: string };
    uri?: string;
}

/**
 * ChatHttp answering through handlers, recording each call (cancel's url
 * is ""). A missing handler rejects. A handler error goes through
 * transportError as the native bridge's does: `code: CHAT_FILE_UNSENT`
 * gives RequestNotSentError, `code: CHAT_FILE_CANCELLED`
 * ChatTransferCancelledError. emit() sends a progress event to the
 * subscribers.
 */
export function fakeChatHttp(handlers: {
    getText?: (url: string, headers: Record<string, string>) => Answerable<HttpAnswer>;
    upload?: (r: UploadRequest) => Answerable<HttpAnswer>;
    download?: (r: DownloadRequest) => Answerable<DownloadAnswer>;
    cancel?: (id: string) => Answerable<void>;
}): ChatHttp & { calls: FakeHttpCall[]; emit(p: TransferProgress): void } {
    const calls: FakeHttpCall[] = [];
    const listeners = new Set<(p: TransferProgress) => void>();
    const missing = (kind: string) => Promise.reject(new Error(`fakeChatHttp: no ${kind} handler`));
    const answer = async <T>(run: () => Answerable<T>): Promise<T> => {
        try {
            return await run();
        } catch (e) {
            throw transportError(e);
        }
    };
    return {
        calls,
        emit: (p) => listeners.forEach((fn) => fn(p)),
        async getText(url, headers) {
            calls.push({ kind: "getText", url, headers: { ...headers } });
            return handlers.getText ? answer(() => handlers.getText!(url, headers)) : missing("getText");
        },
        async upload(r) {
            calls.push({
                kind: "upload", url: r.url, id: r.id, headers: { ...r.headers }, fields: { ...r.fields }, file: { ...r.file },
            });
            return handlers.upload ? answer(() => handlers.upload!(r)) : missing("upload");
        },
        async download(r) {
            calls.push({ kind: "download", url: r.url, id: r.id, headers: { ...r.headers }, uri: r.uri });
            return handlers.download ? answer(() => handlers.download!(r)) : missing("download");
        },
        async cancel(id) {
            calls.push({ kind: "cancel", url: "", id });
            await handlers.cancel?.(id);
        },
        onProgress(fn) {
            listeners.add(fn);
            return () => void listeners.delete(fn);
        },
    };
}

import { useRef, useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { getCurrentLocale, t } from "../../i18n";
import type { OutgoingFile } from "../../models/chat";
import { ChatCapture, type PickKind, type StageRefusal } from "../../services/chat/chatCapture";
import type { ChatFiles } from "../../services/chat/chatFiles";
import { deviceChatFiles } from "../../services/chat/chatFiles";
import { chatSettings } from "../../services/chat/chatSettings";
import { ChatVoiceRecorder, sharedVoiceRecorder, type VoiceStart } from "../../services/chat/chatVoice";
import { formatBytes } from "../../utils/formatBytes";

/** Where a chip's file comes from: a pick of that kind, or the voice recorder. */
export type ChipOrigin = PickKind | "voice";

export interface ComposerChip {
    key: string;
    file: OutgoingFile;
    origin: ChipOrigin;
}

/**
 * "starting" while start() asks for the microphone; "preparing" while
 * stop() turns the recording into its MP3 (seconds for a long one).
 */
export type VoiceState = "idle" | "starting" | "recording" | "preparing";

export interface ComposerAttachState {
    /** The camera / gallery / file sheet is open. */
    sheet: boolean;
    /** Staged files waiting for the next send, in pick order. */
    chips: ComposerChip[];
    voice: VoiceState;
    /** Time left before the recording stops by itself, ms, refreshed while recording. */
    remainingMs: number;
    /** The server's upload limit in bytes; null while unknown. */
    limit: number | null;
    /** What the last pick or recording could not do, one line each. */
    notices: string[];
    /** Picks being staged now. */
    staging: number;
}

/** The part of ChatVoiceRecorder the composer drives. */
export type ComposerRecorder = Pick<
    ChatVoiceRecorder,
    "onAutoStop" | "onBackground" | "start" | "remainingMs" | "stop" | "discard"
>;

export interface ComposerAttachDeps {
    capture: Pick<ChatCapture, "pickFiles" | "stage" | "compress">;
    recorder: ComposerRecorder;
    files: Pick<ChatFiles, "removeDir">;
    /** The account's directory under chat/, where picks and recordings are staged. */
    fileDir: () => Promise<string>;
    /** The server's upload limit in bytes; null when it cannot be read now. */
    uploadLimit: () => Promise<number | null>;
    /** The « ask to compress » setting. */
    askCompress: () => boolean;
    /** Asks a yes / no question. */
    confirm: (message: string) => Promise<boolean>;
    /** Sends the composer: its text, its chips (take()) and these files after them. */
    send: (extra: OutgoingFile[]) => Promise<void>;
}

/**
 * Stage limit while the server's is unknown: Odoo's default. The outbox
 * checks the real one again before uploading.
 */
const FALLBACK_LIMIT = 128 * 1024 * 1024;

/** Countdown refresh while recording, ms. */
const TICK_MS = 250;

/** Images compress() reduces: the « ask to compress » question is only for these. */
const PHOTO = /^image\/(jpeg|png|hei[cf])$/;

export function newComposerAttachState(): ComposerAttachState {
    return { sheet: false, chips: [], voice: "idle", remainingMs: 0, limit: null, notices: [], staging: 0 };
}

/** The line under the sheet's items naming the server's limit; "" while it is unknown. */
export function limitLine(limit: number | null): string {
    return limit === null ? "" : t("chat.attach_limit", { size: formatBytes(limit, getCurrentLocale()) });
}

/** The countdown shown while recording, from the time left in ms. */
export function countdownLine(remainingMs: number): string {
    const seconds = Math.ceil(remainingMs / 1000);
    const time = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
    return t("chat.voice_left", { time });
}

function isRefusal(r: OutgoingFile | StageRefusal): r is StageRefusal {
    return "refused" in r;
}

/** The directory stage() or the recorder made for one file: `out/<localUuid>`. */
function stagedDir(file: OutgoingFile): string {
    return file.path.slice(0, file.path.lastIndexOf("/"));
}

let chipSeq = 0;

/**
 * The attachments of one composer: the files picked (camera, gallery, any
 * file) staged one after another and shown as chips, and the voice
 * message.
 *
 * The voice: mic() starts recording, mic() again stops it and sends it at
 * once, with the composer's text and chips (deps.send); the recorder's
 * 60 s auto-stop sends the same way. While its MP3 is prepared, busy() is
 * true, so the composer refuses another send that would overtake it. The
 * app going to the background stops the recording and keeps it as an
 * unsent voice chip; one voice per composer, so the mic hides while a
 * voice chip exists.
 *
 * The recorder is the app's one ChatVoiceRecorder (sharedVoiceRecorder):
 * its start() empties the shared recording directory. start() hooks its
 * callbacks to this composer; dispose() discards a recording under way,
 * deletes the chips' staged files and unhooks the callbacks still its own.
 */
export class ComposerAttach {
    private disposed = false;
    private tick: ReturnType<typeof setInterval> | null = null;
    private readonly autoStop = () => {
        if (this.state.voice === "recording") void this.stopAndSend();
    };
    private readonly background = () => {
        if (this.state.voice === "recording") void this.keepUnsent();
    };

    constructor(readonly state: ComposerAttachState, readonly deps: ComposerAttachDeps) {}

    /** Hooks the recorder's callbacks to this composer and reads the server's limit. */
    async start(): Promise<void> {
        this.deps.recorder.onAutoStop = this.autoStop;
        this.deps.recorder.onBackground = this.background;
        await this.refreshLimit();
    }

    private async refreshLimit(): Promise<void> {
        const limit = await this.deps.uploadLimit().catch(() => null);
        if (limit !== null && !this.disposed) this.state.limit = limit;
    }

    toggleSheet(): void {
        this.state.sheet = !this.state.sheet;
        if (this.state.sheet) void this.refreshLimit();
    }

    hasVoiceChip(): boolean {
        return this.state.chips.some((c) => c.origin === "voice");
    }

    /** True while a voice message is being prepared: a send now would go before it. */
    busy(): boolean {
        return this.state.voice === "preparing";
    }

    /**
     * Opens the picker of kind and stages what it gives, one file after
     * another (a photo's decode is the phone's memory), each as a chip. The
     * picker opens before anything is awaited, so this must be called from
     * the tap's own handler. A file over the server's limit, one that
     * cannot be staged, and a HEIC the phone could not convert (kept as it
     * is) are each named in a notice.
     */
    async pick(input: HTMLInputElement, kind: PickKind): Promise<void> {
        const picking = this.deps.capture.pickFiles(input, kind);
        this.state.sheet = false;
        const picked = await picking;
        if (picked.length === 0 || this.disposed) return;
        this.state.notices = [];
        this.state.staging++;
        try {
            const fileDir = await this.deps.fileDir();
            await this.refreshLimit();
            const maxUploadSize = this.state.limit ?? FALLBACK_LIMIT;
            const lang = getCurrentLocale();
            for (const file of picked) {
                let staged: OutgoingFile | StageRefusal;
                try {
                    staged = await this.deps.capture.stage(fileDir, file, { maxUploadSize });
                } catch {
                    this.notice(t("chat.attach_failed", { name: file.name }));
                    continue;
                }
                if (isRefusal(staged)) {
                    this.notice(t("chat.file_too_big", { name: file.name, limit: formatBytes(staged.limit, lang) }));
                    continue;
                }
                if (this.disposed) {
                    await this.deps.files.removeDir(stagedDir(staged)).catch(() => {});
                    continue;
                }
                if (/^image\/hei[cf]/.test(staged.mimetype)) this.notice(t("chat.heic_kept", { name: staged.name }));
                this.addChip(staged, kind);
            }
        } finally {
            this.state.staging--;
        }
    }

    /** Takes the chip off and deletes its staged file. */
    async remove(chip: ComposerChip): Promise<void> {
        this.state.chips = this.state.chips.filter((c) => c.key !== chip.key);
        await this.deps.files.removeDir(stagedDir(chip.file)).catch(() => {});
    }

    /**
     * The chips, taken off the composer at once (before the send's first
     * await, so a second tap finds none), with the notices of the picks
     * before. Their files then belong to the send: the outbox deletes them
     * if it cannot queue them.
     */
    take(): ComposerChip[] {
        const chips = this.state.chips;
        this.state.chips = [];
        this.state.notices = [];
        return chips;
    }

    /**
     * The files of the chips taken, in order. With « ask to compress » on
     * and a camera or gallery photo among them, the user is asked first;
     * yes reduces those photos (ChatCapture.compress), one at a time. A
     * file picked as « any file » is never asked about.
     */
    async prepare(chips: ComposerChip[]): Promise<OutgoingFile[]> {
        const isPhoto = (c: ComposerChip) => (c.origin === "camera" || c.origin === "gallery") && PHOTO.test(c.file.mimetype);
        if (!this.deps.askCompress() || !chips.some(isPhoto)) return chips.map((c) => c.file);
        const yes = await this.deps.confirm(t("chat.compress_ask")).catch(() => false);
        const files: OutgoingFile[] = [];
        for (const chip of chips) files.push(yes && isPhoto(chip) ? await this.deps.capture.compress(chip.file) : chip.file);
        return files;
    }

    /** The mic button: starts a recording when none runs, stops and sends the one running. */
    async mic(): Promise<void> {
        if (this.state.voice === "recording") return this.stopAndSend();
        if (this.state.voice !== "idle" || this.hasVoiceChip()) return;
        this.state.notices = [];
        this.state.voice = "starting";
        let answer: VoiceStart;
        try {
            answer = await this.startRecorder();
        } catch {
            answer = "unavailable";
        }
        if (this.state.voice !== "starting" || this.disposed) return;
        if (answer !== "recording") {
            this.state.voice = "idle";
            this.notice(t(answer === "denied" ? "chat.voice_denied" : "chat.voice_unavailable"));
            return;
        }
        this.state.voice = "recording";
        this.state.remainingMs = this.deps.recorder.remainingMs();
        this.tick = setInterval(() => {
            this.state.remainingMs = this.deps.recorder.remainingMs();
        }, TICK_MS);
    }

    /**
     * The recorder's start(). One that throws still holds a recording no
     * composer stops (a composer gone before its callback ran): it is
     * discarded and started once more.
     */
    private async startRecorder(): Promise<VoiceStart> {
        try {
            return await this.deps.recorder.start();
        } catch {
            await this.deps.recorder.discard();
            return this.deps.recorder.start();
        }
    }

    /** The ✕ of the recording: stops it and deletes it, nothing is sent. */
    async discardVoice(): Promise<void> {
        if (this.state.voice !== "recording" && this.state.voice !== "starting") return;
        this.endTick();
        this.state.voice = "idle";
        await this.deps.recorder.discard();
    }

    /** Stops the recording and, once its MP3 is ready, sends it with the composer's text and chips. */
    private async stopAndSend(): Promise<void> {
        const file = await this.finishRecording();
        if (file) await this.deps.send([file]);
    }

    /** Stops the recording and keeps it as an unsent voice chip. */
    private async keepUnsent(): Promise<void> {
        const file = await this.finishRecording();
        if (!file) return;
        if (this.disposed) await this.deps.files.removeDir(stagedDir(file)).catch(() => {});
        else this.addChip(file, "voice");
    }

    /** The recording as its MP3 staged file, "preparing" meanwhile; null with a notice when it fails. */
    private async finishRecording(): Promise<OutgoingFile | null> {
        this.endTick();
        this.state.voice = "preparing";
        try {
            return await this.deps.recorder.stop(await this.deps.fileDir());
        } catch {
            this.notice(t("chat.voice_failed"));
            return null;
        } finally {
            this.state.voice = "idle";
        }
    }

    /**
     * The composer leaves the screen: a recording under way is discarded
     * (a halted one would hold the recorder for the next start), the chips'
     * staged files are deleted, and the recorder's callbacks are let go
     * while they are still this composer's. A voice message being prepared
     * is still sent: its tap was a send.
     */
    async dispose(): Promise<void> {
        this.disposed = true;
        this.endTick();
        const { recorder } = this.deps;
        const owned = recorder.onAutoStop === this.autoStop;
        if (owned) recorder.onAutoStop = null;
        if (recorder.onBackground === this.background) recorder.onBackground = null;
        const chips = this.take();
        const recording = this.state.voice === "recording" || this.state.voice === "starting";
        if (recording) this.state.voice = "idle";
        await Promise.all([
            owned && recording ? recorder.discard().catch(() => {}) : Promise.resolve(),
            ...chips.map((c) => this.deps.files.removeDir(stagedDir(c.file)).catch(() => {})),
        ]);
    }

    private addChip(file: OutgoingFile, origin: ChipOrigin): void {
        this.state.chips = [...this.state.chips, { key: "c" + ++chipSeq, file, origin }];
    }

    private notice(text: string): void {
        this.state.notices = [...this.state.notices, text];
    }

    private endTick(): void {
        if (this.tick !== null) clearInterval(this.tick);
        this.tick = null;
    }
}

/** The device's dependencies of a composer, around the thread's own (account, send). */
export function deviceComposerDeps(
    own: Pick<ComposerAttachDeps, "fileDir" | "uploadLimit" | "send">,
): ComposerAttachDeps {
    return {
        capture: new ChatCapture(),
        recorder: sharedVoiceRecorder(),
        files: deviceChatFiles,
        askCompress: () => chatSettings().askCompress,
        confirm: async (message) =>
            (await Dialog.confirm({
                title: t("chat.compress_title"),
                message,
                okButtonTitle: t("chat.compress_yes"),
                cancelButtonTitle: t("chat.compress_no"),
            })).value,
        ...own,
    };
}

/**
 * What the composer shows of its attachments, above the text field: the
 * camera / gallery / file sheet with the server's limit under it, the
 * chips (name, size, ✕), the recording's countdown and ✕, and the
 * notices. The hidden file input the picks go through lives here. The
 * 📎 and 🎤 buttons sit in the thread's composer row and drive the same
 * ComposerAttach.
 *
 * The template reads the state only through this component's own
 * useState proxy (state, and the methods below): a read through the
 * controller's state (the thread's proxy) subscribes the thread alone, and
 * the thread re-rendering leaves this component, whose props are the same,
 * as it was.
 */
export class ChatComposerAttachComponent extends EnhancedComponent {
    static props = { attach: Object };

    static template = xml`
    <div class="chat-attach">
      <input type="file" class="chat-attach__input" t-ref="picker" tabindex="-1" aria-hidden="true"/>
      <div t-if="state.sheet" class="chat-attach__sheet" role="menu">
        <button role="menuitem" class="chat-attach__item" t-on-click="() => this.onPick('camera')">
          <span aria-hidden="true">📷</span> <t t-esc="t('chat.attach_camera')"/>
        </button>
        <button role="menuitem" class="chat-attach__item" t-on-click="() => this.onPick('gallery')">
          <span aria-hidden="true">🖼️</span> <t t-esc="t('chat.attach_gallery')"/>
        </button>
        <button role="menuitem" class="chat-attach__item" t-on-click="() => this.onPick('file')">
          <span aria-hidden="true">📄</span> <t t-esc="t('chat.attach_file')"/>
        </button>
        <p t-if="limitText()" class="chat-attach__limit" t-esc="limitText()"/>
      </div>
      <ul t-if="state.chips.length" class="chat-attach__chips">
        <li t-foreach="state.chips" t-as="chip" t-key="chip.key" class="chat-attach__chip">
          <span t-if="chip.origin === 'voice'" aria-hidden="true">🎤</span>
          <span class="chat-attach__chip-name" t-esc="chip.file.name"/>
          <span class="chat-attach__chip-size" t-esc="sizeText(chip)"/>
          <button class="chat-attach__chip-remove" t-att-aria-label="t('chat.attach_remove', {name: chip.file.name})"
                  t-on-click="() => this.attach.remove(chip)">✕</button>
        </li>
      </ul>
      <div t-if="state.voice === 'recording'" class="chat-attach__voice" role="status">
        <span class="chat-attach__voice-dot" aria-hidden="true"/>
        <span class="chat-attach__voice-time" t-esc="timerText()"/>
        <button class="chat-attach__voice-discard" t-att-aria-label="t('chat.voice_discard')"
                t-on-click="() => this.attach.discardVoice()">✕</button>
      </div>
      <p t-if="state.voice === 'preparing'" class="chat-attach__voice" role="status" t-esc="t('chat.voice_preparing')"/>
      <p t-if="state.staging" class="chat-attach__staging" role="status" t-esc="t('chat.attach_staging')"/>
      <p t-foreach="state.notices" t-as="line" t-key="line_index" class="chat-attach__notice" role="alert" t-esc="line"/>
    </div>`;

    state!: ComposerAttachState;
    attach!: ComposerAttach;
    picker!: { el: HTMLInputElement | null };

    setup() {
        this.attach = this.props.attach as ComposerAttach;
        this.state = useState(this.attach.state);
        this.picker = useRef("picker") as { el: HTMLInputElement | null };
    }

    limitText(): string {
        return limitLine(this.state.limit);
    }

    timerText(): string {
        return countdownLine(this.state.remainingMs);
    }

    sizeText(chip: ComposerChip): string {
        return formatBytes(chip.file.size, getCurrentLocale());
    }

    /** A sheet item: the picker opens within this tap. */
    onPick(kind: PickKind): void {
        if (this.picker.el) void this.attach.pick(this.picker.el, kind);
    }
}

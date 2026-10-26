import { useRef, useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { getCurrentLocale, t } from "../../i18n";
import type { OutgoingFile } from "../../models/chat";
import { ChatCapture, type PickKind, type StageRefusal } from "../../services/chat/chatCapture";
import { chatSettings } from "../../services/chat/chatSettings";
import { ChatVoiceRecorder, sharedVoiceRecorder, type VoiceStart } from "../../services/chat/chatVoice";
import { UPLOAD_SLACK_BYTES } from "../../services/chat/chatTransfer";
import { formatBytes } from "../../utils/formatBytes";

/** Where a chip's file comes from: a pick of that kind, or the voice recorder. */
export type ChipOrigin = PickKind | "voice";

export interface ComposerChip {
    key: string;
    file: OutgoingFile;
    origin: ChipOrigin;
    /** Position among the conversation's draft files (ChatAttachment.seq of its draft row). */
    seq: number;
}

/**
 * "starting" while start() asks for the microphone; "preparing" while
 * stop() turns the recording into its MP3 (seconds for a long one).
 */
export type VoiceState = "idle" | "starting" | "recording" | "preparing";

export interface ComposerAttachState {
    /**
     * start() ran: the conversation's account is known and the recorder's
     * callbacks are hooked. Until then nothing is picked or recorded.
     */
    ready: boolean;
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

/** The conversation's draft files, as the composer keeps them (ChatService.keepDraftFile, dropDraftFile). */
export interface ComposerDraft {
    /** Stores a staged file as a draft file at chip position seq, with its origin (a reduced photo replaces its own). */
    keep: (file: OutgoingFile, seq: number, origin: ChipOrigin) => Promise<void>;
    /** Removes a draft file and deletes its staged file. */
    drop: (file: OutgoingFile) => Promise<void>;
}

export interface ComposerAttachDeps {
    capture: Pick<ChatCapture, "pickFiles" | "stage" | "compress">;
    recorder: ComposerRecorder;
    draft: ComposerDraft;
    /** The account's directory under chat/, where picks and recordings are staged. */
    fileDir: () => Promise<string>;
    /** The server's upload limit in bytes; null when it cannot be read now. */
    uploadLimit: () => Promise<number | null>;
    /** The « ask to compress » setting. */
    askCompress: () => boolean;
    /** Asks a yes / no question. */
    confirm: (message: string) => Promise<boolean>;
    /**
     * Sends the composer: its text, its chips (take()) and these files
     * after them. false: the send was not taken (another one runs), the
     * files stay the composer's.
     */
    send: (extra: OutgoingFile[]) => Promise<boolean | void>;
}

/** Countdown refresh while recording, ms. */
const TICK_MS = 250;

/** Images compress() reduces: the « ask to compress » question is only for these. */
const PHOTO = /^image\/(jpeg|png|hei[cf])$/;

export function newComposerAttachState(): ComposerAttachState {
    return { ready: false, sheet: false, chips: [], voice: "idle", remainingMs: 0, limit: null, notices: [], staging: 0 };
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

let chipSeq = 0;

/**
 * The attachments of one composer: the files picked (camera, gallery, any
 * file) staged one after another and shown as chips, and the voice
 * message. Every staged file is kept as a draft file of the conversation
 * (deps.draft) before its chip shows, so a chip outlives the screen and
 * the app until it is sent or its ✕ removes it.
 *
 * The voice: mic() starts recording, mic() again stops it and sends it at
 * once, with the composer's text and chips (deps.send); the recorder's
 * 60 s auto-stop sends the same way. While its MP3 is prepared, busy() is
 * true, so the composer refuses another send that would overtake it. The
 * app going to the background, or the screen closing, stops the recording
 * and keeps it as an unsent voice chip; one voice per composer, so the mic
 * hides while a voice chip exists.
 *
 * The recorder is the app's one ChatVoiceRecorder (sharedVoiceRecorder):
 * its start() empties the shared recording directory. start() hooks its
 * callbacks to this composer; dispose() keeps a recording under way as a
 * draft voice file and unhooks the callbacks still its own.
 */
export class ComposerAttach {
    private disposed = false;
    /** The chip position the next draft file takes. */
    private nextSeq = 0;
    private tick: ReturnType<typeof setInterval> | null = null;
    private readonly autoStop = () => {
        if (this.state.voice === "recording") void this.stopAndSend();
    };
    private readonly background = () => {
        if (this.state.voice === "recording") void this.keepUnsent();
    };

    constructor(readonly state: ComposerAttachState, readonly deps: ComposerAttachDeps) {}

    /**
     * Hooks the recorder's callbacks to this composer, then opens the
     * composer to picks and recordings (ready), synchronously, so no
     * recording can start unhooked; then reads the server's limit. Called
     * once the conversation's account is known: a voice stopped before it
     * would have nowhere to go.
     */
    async start(): Promise<void> {
        if (this.disposed) return;
        this.deps.recorder.onAutoStop = this.autoStop;
        this.deps.recorder.onBackground = this.background;
        this.state.ready = true;
        await this.refreshLimit();
    }

    private async refreshLimit(): Promise<void> {
        const limit = await this.deps.uploadLimit().catch(() => null);
        if (limit !== null && !this.disposed) this.state.limit = limit;
    }

    toggleSheet(): void {
        if (!this.state.ready) return;
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
     * is) are each named in a notice. Each staged file is a draft file
     * before its chip shows; one staged after the screen closed stays in
     * the draft without a chip. Staging uses the limit known at the tap
     * (none while it is unknown) and never waits for the server's: read
     * meanwhile, a lower one then takes off, with the same notice, the
     * chips of this pick it rules out. A limit that cannot be read keeps
     * the chips: the outbox checks the real one before uploading and
     * refuses a file over it with its notice.
     */
    async pick(input: HTMLInputElement, kind: PickKind): Promise<void> {
        if (!this.state.ready) return;
        const picking = this.deps.capture.pickFiles(input, kind);
        this.state.sheet = false;
        const picked = await picking;
        if (picked.length === 0 || this.disposed) return;
        this.state.notices = [];
        this.state.staging++;
        const maxUploadSize = this.state.limit ?? Infinity;
        const limitRead = this.refreshLimit();
        const lang = getCurrentLocale();
        const mine = new Set<string>();
        try {
            const fileDir = await this.deps.fileDir();
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
                const seq = this.nextSeq++;
                await this.keepDraft(staged, seq, kind);
                // The screen closed meanwhile: the file waits in the draft for the next visit
                if (this.disposed) continue;
                if (/^image\/hei[cf]/.test(staged.mimetype)) this.notice(t("chat.heic_kept", { name: staged.name }));
                this.addChip(staged, kind, seq);
                mine.add(staged.localUuid);
            }
        } finally {
            this.state.staging--;
        }
        await limitRead;
        const limit = this.state.limit;
        if (limit === null || limit >= maxUploadSize) return;
        for (const chip of this.state.chips) {
            if (!mine.has(chip.file.localUuid) || chip.file.size + UPLOAD_SLACK_BYTES <= limit) continue;
            this.notice(t("chat.file_too_big", { name: chip.file.name, limit: formatBytes(limit, lang) }));
            await this.remove(chip);
        }
    }

    /** Takes the chip off, out of the draft, and deletes its staged file. */
    async remove(chip: ComposerChip): Promise<void> {
        this.state.chips = this.state.chips.filter((c) => c.key !== chip.key);
        await this.deps.draft.drop(chip.file).catch((e) => console.warn("chat: draft file not removed", e));
    }

    /**
     * The chips, taken off the composer at once (before the send's first
     * await, so a second tap finds none), with the notices of the picks
     * before. Their draft files then belong to the send: the outbox gives
     * them to the post in place, or leaves them in the draft when it cannot
     * queue it (restore() shows them again).
     */
    take(): ComposerChip[] {
        const chips = this.state.chips;
        this.state.chips = [];
        this.state.notices = [];
        return chips;
    }

    /**
     * Shows the conversation's draft files (ChatService.draft) as chips,
     * in their order and with the origin their row stores (« any file »,
     * or voice, when it stores none), ahead of the chips picked since; one
     * already shown is skipped. A chip shown before them with a position
     * not after theirs (picked before the draft was read) takes the next
     * positions, its draft row with it: no two files share a position, and
     * the order shown is the order kept. Each name in `lost` (a
     * draft file whose staged copy is gone) is told in a notice.
     */
    restore(files: { file: OutgoingFile; seq: number; origin: ChipOrigin | null }[], lost: string[] = []): void {
        if (this.disposed) return;
        const shown = new Set(this.state.chips.map((c) => c.file.localUuid));
        const back = files
            .filter(({ file }) => !shown.has(file.localUuid))
            .sort((a, b) => a.seq - b.seq)
            .map(({ file, seq, origin }) => this.chipOf(file, origin ?? (file.voice ? "voice" : "file"), seq));
        for (const { seq } of files) this.nextSeq = Math.max(this.nextSeq, seq + 1);
        if (back.length > 0) {
            const last = back[back.length - 1].seq;
            for (const chip of this.state.chips) {
                if (chip.seq > last) continue;
                chip.seq = this.nextSeq++;
                void this.keepDraft(chip.file, chip.seq, chip.origin);
            }
            this.state.chips = [...back, ...this.state.chips];
        }
        for (const name of lost) this.notice(t("chat.draft_file_lost", { name }));
    }

    /**
     * The files of the chips taken, in order. With « ask to compress » on
     * and a camera or gallery photo among them, the user is asked first;
     * yes reduces those photos (ChatCapture.compress), one at a time, each
     * draft row then naming the reduced file. A file picked as « any file »
     * is never asked about.
     */
    async prepare(chips: ComposerChip[]): Promise<OutgoingFile[]> {
        const isPhoto = (c: ComposerChip) => (c.origin === "camera" || c.origin === "gallery") && PHOTO.test(c.file.mimetype);
        if (!this.deps.askCompress() || !chips.some(isPhoto)) return chips.map((c) => c.file);
        const yes = await this.deps.confirm(t("chat.compress_ask")).catch(() => false);
        const files: OutgoingFile[] = [];
        for (const chip of chips) {
            if (!yes || !isPhoto(chip)) {
                files.push(chip.file);
                continue;
            }
            const reduced = await this.deps.capture.compress(chip.file);
            // The draft row follows the file it now names, for a send that is refused
            if (reduced !== chip.file) await this.keepDraft(reduced, chip.seq, chip.origin);
            files.push(reduced);
        }
        return files;
    }

    /** The mic button: starts a recording when none runs, stops and sends the one running. */
    async mic(): Promise<void> {
        if (this.state.voice === "recording") return this.stopAndSend();
        if (!this.state.ready || this.state.voice !== "idle" || this.hasVoiceChip()) return;
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

    /**
     * Stops the recording and, once its MP3 is ready, keeps it as a draft
     * file and sends it with the composer's text and chips: a refused send
     * leaves it in the draft, and a send not taken (another one runs) shows
     * it as a voice chip.
     */
    private async stopAndSend(): Promise<void> {
        const file = await this.finishRecording();
        if (!file) return;
        const seq = this.nextSeq++;
        await this.keepDraft(file, seq, "voice");
        if ((await this.deps.send([file])) === false && !this.disposed) this.addChip(file, "voice", seq);
    }

    /** Stops the recording and keeps it as a draft voice file, a chip while the screen is open. */
    private async keepUnsent(): Promise<void> {
        const file = await this.finishRecording();
        if (!file) return;
        const seq = this.nextSeq++;
        await this.keepDraft(file, seq, "voice");
        if (!this.disposed) this.addChip(file, "voice", seq);
    }

    /** deps.draft.keep, a failure logged: the chip still shows and the file still goes with the next send. */
    private async keepDraft(file: OutgoingFile, seq: number, origin: ChipOrigin): Promise<void> {
        await this.deps.draft.keep(file, seq, origin).catch((e) => console.warn("chat: draft file not kept", e));
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
     * The composer leaves the screen: a recording under way is stopped and
     * kept as a draft voice file (a halted one would hold the recorder for
     * the next start), one still starting is discarded, and the recorder's
     * callbacks are let go while they are still this composer's. The chips
     * stay in the draft. A voice message being prepared still goes where
     * its tap sent it.
     */
    async dispose(): Promise<void> {
        this.disposed = true;
        this.state.ready = false;
        const { recorder } = this.deps;
        const owned = recorder.onAutoStop === this.autoStop;
        if (owned) recorder.onAutoStop = null;
        if (recorder.onBackground === this.background) recorder.onBackground = null;
        if (owned && this.state.voice === "recording") return this.keepUnsent();
        this.endTick();
        if (this.state.voice === "starting") {
            this.state.voice = "idle";
            if (owned) await recorder.discard().catch(() => {});
        }
    }

    private chipOf(file: OutgoingFile, origin: ChipOrigin, seq: number): ComposerChip {
        return { key: "c" + ++chipSeq, file, origin, seq };
    }

    private addChip(file: OutgoingFile, origin: ChipOrigin, seq: number): void {
        this.state.chips = [...this.state.chips, this.chipOf(file, origin, seq)];
    }

    private notice(text: string): void {
        this.state.notices = [...this.state.notices, text];
    }

    private endTick(): void {
        if (this.tick !== null) clearInterval(this.tick);
        this.tick = null;
    }
}

/** The device's dependencies of a composer, around the thread's own (account, send, draft). */
export function deviceComposerDeps(
    own: Pick<ComposerAttachDeps, "fileDir" | "uploadLimit" | "send" | "draft">,
): ComposerAttachDeps {
    return {
        capture: new ChatCapture(),
        recorder: sharedVoiceRecorder(),
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
 * chips (name, size, ✕ removing it from the draft), the recording's countdown and ✕, and the
 * notices. The hidden file input the picks go through lives here. The
 * 📎 and 🎤 buttons sit in the thread's composer row and drive the same
 * ComposerAttach.
 *
 * The recording line is a live region for its appearance and its end;
 * the countdown inside it is aria-live="off", so a screen reader does not
 * read it again at each refresh.
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
        <span class="chat-attach__voice-time" aria-live="off" t-esc="timerText()"/>
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

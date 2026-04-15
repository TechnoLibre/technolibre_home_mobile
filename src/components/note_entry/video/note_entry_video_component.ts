import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";

import { Capacitor } from "@capacitor/core";
import { Dialog } from "@capacitor/dialog";
import { NoteEntryVideoParams } from "../../../models/note";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";

import CameraIcon from "../../../assets/icon/flip_camera_android.svg";
import PlayIcon from "../../../assets/icon/play.svg";
import VideoOffIcon from "../../../assets/icon/video_off.svg";
import CloseIcon from "../../../assets/icon/close.svg";

export class NoteEntryVideoComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry__wrapper"
			t-att-class="{
				'not-empty': props.params.path
			}"
		>
			<div class="note-entry__video__thumbnail__wrapper">
				<div class="note-entry__video__thumbnail">
					<img
						t-if="getThumbnailSrc()"
						t-att-src="getThumbnailSrc()"
						class="note-entry__video__thumbnail__img"
					/>
					<img t-else="" src="${VideoOffIcon}" />
				</div>
			</div>
			<div class="note-entry__video__data">
				<div class="note-entry__video__controls">
					<button
						class="note-entry__video__button note-entry__video__open-camera"
						t-on-click.stop.prevent="onClickOpenCamera"
					>
						<img src="${CameraIcon}" />
						<span>Vidéo</span>
					</button>
					<button
						class="note-entry__video__button note-entry__video__open-video"
						t-if="props.params.path"
						t-on-click.stop.prevent="onClickOpenVideo"
					>
						<img src="${PlayIcon}" />
						<span>Lire</span>
					</button>
					<button
						type="button"
						class="note-entry__video__transcribe"
						t-if="props.params.path and state.transcriptionEnabled"
						t-att-disabled="state.isTranscribing"
						t-on-click.stop.prevent="transcribeVideo"
					>
						<t t-if="state.isTranscribing">
							<t t-if="state.transcriptionPercent > 0">
								<t t-esc="state.transcriptionPercent"/>%
							</t>
							<t t-else="">…</t>
						</t>
						<t t-else="">T</t>
					</button>
					<button
						type="button"
						class="note-entry__video__processes-link"
						t-if="state.isTranscribing or props.params.transcription"
						t-on-click.stop.prevent="goToProcesses"
						title="Voir les processus"
					>↗</button>
				</div>
				<div t-if="props.params.transcription" class="note-entry__video__transcription">
					<p class="note-entry__video__transcription-text" t-esc="props.params.transcription"/>
					<div class="note-entry__video__transcription-actions">
						<button
							type="button"
							class="note-entry__video__add-text"
							t-att-aria-label="t('button.add_text_entry')"
							t-on-click.stop.prevent="addTextEntry"
							t-esc="t('button.add_text_entry_short')"
						/>
						<button
							type="button"
							class="note-entry__video__translate-btn"
							t-att-disabled="state.isTranslating"
							t-att-aria-busy="state.translatingTarget === 'en' ? 'true' : 'false'"
							t-att-aria-label="t('button.translate_fr_en')"
							t-on-click.stop.prevent="() => this.translateTranscription('fr', 'en')"
						>
							<t t-if="state.translatingTarget === 'en'">…</t>
							<t t-else="">FR→EN</t>
						</button>
						<button
							type="button"
							class="note-entry__video__translate-btn"
							t-att-disabled="state.isTranslating"
							t-att-aria-busy="state.translatingTarget === 'fr' ? 'true' : 'false'"
							t-att-aria-label="t('button.translate_en_fr')"
							t-on-click.stop.prevent="() => this.translateTranscription('en', 'fr')"
						>
							<t t-if="state.translatingTarget === 'fr'">…</t>
							<t t-else="">EN→FR</t>
						</button>
					</div>
					<div t-if="props.params.transcriptionTranslation" class="note-entry__video__translation">
						<span class="note-entry__video__translation-lang"
						      t-esc="props.params.transcriptionTranslationLang ? props.params.transcriptionTranslationLang.toUpperCase() : ''"/>
						<p class="note-entry__video__translation-text" t-esc="props.params.transcriptionTranslation"/>
					</div>
				</div>
			</div>
		</div>
		<div t-if="state.showVideo" class="note-entry__video__overlay">
			<button class="note-entry__video__overlay__close" t-on-click.stop.prevent="onClickCloseVideo">
				<img src="${CloseIcon}" />
			</button>
			<video
				class="note-entry__video__overlay__player"
				t-att-src="state.videoSrc"
				autoplay="true"
				controls="true"
				playsinline="true"
			/>
		</div>
	`;

	setup() {
		this.state = useState({
			showVideo:             false,
			videoSrc:              "",
			isTranscribing:        false,
			transcriptionPercent:  0,
			transcriptionEnabled:  false,
			isTranslating:         false,
			translatingTarget:     null as "fr" | "en" | null,
		});

		let _unsubProgress: (() => void) | null = null;
		let _unsubDone: (() => void) | null = null;

		const stopTranscribingUI = () => {
			this.state.isTranscribing = false;
			this.state.transcriptionPercent = 0;
		};

		this.transcriptionService.isEnabled()
			.then((enabled) => {
				this.state.transcriptionEnabled = enabled && Capacitor.isNativePlatform();
			})
			.catch(() => {});

		onMounted(() => {
			const raw = this.props.params?.path;
			if (!raw) return;
			const path = this.toNativePath(raw);
			if (this.transcriptionService.isTranscribing(path)) {
				this.state.isTranscribing = true;
				this.state.transcriptionPercent =
					this.transcriptionService.getTranscriptionProgress(path);

				_unsubProgress = this.transcriptionService.subscribeTranscriptionProgress(
					path,
					(percent) => { this.state.transcriptionPercent = percent; }
				);
				_unsubDone = this.transcriptionService.subscribeTranscription(
					path, stopTranscribingUI
				);
			}
		});

		onWillDestroy(() => {
			if (_unsubProgress) _unsubProgress();
			if (_unsubDone) _unsubDone();
		});
	}

	goToProcesses() {
		this.navigate("/options/processes");
	}

	addTextEntry() {
		const text = this.props.params?.transcription;
		if (!text) return;
		this.eventBus.trigger(Events.ADD_TRANSCRIPTION_TEXT, {
			afterEntryId: this.props.id,
			text,
		});
	}

	async translateTranscription(source: "fr" | "en", target: "fr" | "en") {
		const text = this.props.params?.transcription;
		if (!text?.trim() || this.state.isTranslating) return;

		this.state.isTranslating     = true;
		this.state.translatingTarget = target;
		try {
			const translation = await this.translationService.translate(text, source, target);
			this.eventBus.trigger(Events.SET_ENTRY_TRANSLATION, {
				entryId: this.props.id,
				translation,
				targetLang: target,
				field: "transcription",
			});
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			await Dialog.alert({
				message: this.t("error.translation_failed", { error: msg }),
			});
		} finally {
			this.state.isTranslating     = false;
			this.state.translatingTarget = null;
		}
	}

	async onClickOpenCamera() {
		this.eventBus.trigger(Events.OPEN_CAMERA, {
			entryId: this.props.id
		});
	}

	onClickOpenVideo() {
		this.state.videoSrc = Capacitor.convertFileSrc(this.props.params.path);
		this.state.showVideo = true;
	}

	onClickCloseVideo() {
		this.state.showVideo = false;
		this.state.videoSrc = "";
	}

	getThumbnailSrc(): string | undefined {
		const params = this.props.params as NoteEntryVideoParams;
		if (!params.thumbnailPath) return undefined;
		return Capacitor.convertFileSrc(params.thumbnailPath);
	}

	/**
	 * Convert a Capacitor WebView URL or file:// URI back to a native
	 * absolute path that the Java plugin can open with File().
	 *
	 * Handles:
	 *   https://localhost/_capacitor_file_/storage/…  →  /storage/…
	 *   https://localhost/_capacitor_file/storage/…   →  /storage/…
	 *   file:///storage/…                             →  /storage/…
	 *   /storage/…                                    →  /storage/…  (no-op)
	 */
	private toNativePath(src: string): string {
		// Capacitor uses _capacitor_file_ (with trailing underscore) by default;
		// _capacitor_file (without underscore) appears in some builds — handle both.
		const capacitorMatch = src.match(/https?:\/\/[^/]+\/_capacitor_file_?(\/.*)/);
		if (capacitorMatch) return capacitorMatch[1];
		if (src.startsWith("file://")) return src.slice("file://".length);
		return src;
	}

	async transcribeVideo() {
		const rawPath = this.props.params.path;
		const path = this.toNativePath(rawPath);
		if (!path || this.state.isTranscribing) return;

		const noteId = window.location.pathname.match(/^\/note\/(.+)/)?.[1];

		this.state.isTranscribing = true;
		this.state.transcriptionPercent = 0;

		const unsubProgress = this.transcriptionService.subscribeTranscriptionProgress(
			path,
			(percent) => { this.state.transcriptionPercent = percent; }
		);

		try {
			const text = await this.transcriptionService.transcribe(path, "fr", noteId, rawPath);
			if (text) {
				this.eventBus.trigger(Events.SET_ENTRY_TRANSCRIPTION, {
					entryId: this.props.id,
					text,
				});
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			Dialog.alert({ message: `Transcription échouée : ${msg}` });
		} finally {
			unsubProgress();
			this.state.isTranscribing = false;
			this.state.transcriptionPercent = 0;
		}
	}
}

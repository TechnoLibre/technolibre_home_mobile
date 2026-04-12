import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";

import { Capacitor } from "@capacitor/core";
import { Dialog } from "@capacitor/dialog";
import { Directory, Filesystem } from "@capacitor/filesystem"
import { VoiceRecorder } from "capacitor-voice-recorder";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { ErrorMessages } from "../../../constants/errorMessages";
import { Events } from "../../../constants/events";

import PlayIcon from "../../../assets/icon/play.svg";
import RecordIcon from "../../../assets/icon/mic.svg";
import StopIcon from "../../../assets/icon/stop.svg";

export class NoteEntryAudioComponent extends EnhancedComponent {
	static template = xml`
		<div class="note-entry__wrapper">
			<div class="note-entry--audio__controls" role="group" aria-label="Contrôles audio">
				<button
					type="button"
					class="note-entry--audio__control note-entry--audio__stop-recording"
					t-if="!state.isPlaying and state.isRecording"
					aria-label="Arrêter l'enregistrement"
					t-on-click.stop.prevent="stopRecording"
				>
					<img src="${StopIcon}" alt="" aria-hidden="true" />
				</button>
				<button
					type="button"
					class="note-entry--audio__control note-entry--audio__stop-playback"
					t-if="state.isPlaying and !state.isRecording"
					aria-label="Arrêter la lecture"
					t-on-click.stop.prevent="stopPlayback"
				>
					<img src="${StopIcon}" alt="" aria-hidden="true" />
				</button>
				<button
					type="button"
					class="note-entry--audio__control note-entry--audio__record"
					t-if="!state.isPlaying and !state.isRecording and props.params.path === ''"
					aria-label="Démarrer l'enregistrement"
					t-on-click.stop.prevent="startRecording"
				>
					<img src="${RecordIcon}" alt="" aria-hidden="true" />
				</button>
				<button
					type="button"
					class="note-entry--audio__control note-entry--audio__play"
					t-if="!state.isPlaying and !state.isRecording and props.params.path !== ''"
					aria-label="Lire l'enregistrement"
					t-on-click.stop.prevent="playAudio"
				>
					<img src="${PlayIcon}" alt="" aria-hidden="true" />
				</button>
				<button
					type="button"
					class="note-entry--audio__transcribe"
					t-if="props.params.path !== '' and !state.isRecording and !state.isPlaying and state.transcriptionEnabled"
					t-att-disabled="state.isTranscribing"
					t-att-aria-busy="state.isTranscribing ? 'true' : 'false'"
					t-att-aria-label="state.isTranscribing ? 'Transcription en cours…' : 'Transcrire l\'enregistrement'"
					t-on-click.stop.prevent="transcribeAudio"
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
					class="note-entry--audio__processes-link"
					t-if="state.isTranscribing or props.params.transcription"
					aria-label="Voir les processus"
					t-on-click.stop.prevent="goToProcesses"
				>↗</button>
			</div>
			<div t-if="props.params.transcription" class="note-entry--audio__transcription">
				<p class="note-entry--audio__transcription-text" t-esc="props.params.transcription"/>
				<button
					type="button"
					class="note-entry--audio__add-text"
					aria-label="Créer une entrée texte avec ce contenu"
					t-on-click.stop.prevent="addTextEntry"
				>Texte +</button>
			</div>
		</div>
	`;

	setup() {
		this.state = useState({
			isRecording:           false,
			isPlaying:             false,
			audioRef:              undefined,
			isTranscribing:        false,
			transcriptionPercent:  0,
			transcriptionEnabled:  false,
		});

		let _unsubProgress: (() => void) | null = null;
		let _unsubDone: (() => void) | null = null;

		const stopTranscribingUI = () => {
			this.state.isTranscribing = false;
			this.state.transcriptionPercent = 0;
		};

		// Non-blocking check: show button only if transcription is enabled
		this.transcriptionService.isEnabled()
			.then((enabled) => {
				this.state.transcriptionEnabled = enabled && Capacitor.isNativePlatform();
			})
			.catch(() => {});

		onMounted(() => {
			const path = this.props.params?.path;
			if (path && this.transcriptionService.isTranscribing(path)) {
				// Reconnect to an in-progress transcription that survived navigation.
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
			if (_unsubDone)     _unsubDone();
		});
	}

	private onCanPlayThrough() {
		this.state.isPlaying = true;

		this.state.audioRef.play();
		this.state.audioRef.removeEventListener("canplaythrough", this.onCanPlayThrough.bind(this));
	}

	private onEnded() {
		this.state.isPlaying = false;

		this.state.audioRef.removeEventListener("ended", this.onEnded.bind(this));
	}

	async startRecording() {
		const canVoiceRecord = await VoiceRecorder.canDeviceVoiceRecord();

		if (!canVoiceRecord.value) {
			Dialog.alert({ message: ErrorMessages.VOICE_RECORDING_INCOMPATIBLE });
			return;
		}

		const hasPermission = await VoiceRecorder.hasAudioRecordingPermission();

		if (!hasPermission.value) {
			const requestPermissions = await VoiceRecorder.requestAudioRecordingPermission();

			if (!requestPermissions.value) {
				Dialog.alert({ message: ErrorMessages.VOICE_RECORDING_PERMISSIONS });
				return;
			}
		}

		const recording = await VoiceRecorder.startRecording({
			directory: Directory.Data
		});

		if (!recording.value) {
			Dialog.alert({ message: ErrorMessages.VOICE_RECORDING_GENERIC });
			return;
		}

		this.state.isRecording = true;
	}

	async stopRecording() {
		this.state.isRecording = false;

		const recording = await VoiceRecorder.stopRecording();

		if (recording.value.path) {
			this.eventBus.trigger(Events.SET_AUDIO_RECORDING, {
				entryId: this.props.id,
				path: recording.value.path
			});
		}
	}

	stopPlayback() {
		if (!this.state.audioRef) {
			return;
		}

		this.state.audioRef.pause();
		this.state.isPlaying = false;
	}

	goToProcesses() {
		this.navigate("/options/processes");
	}

	async transcribeAudio() {
		const path = this.props.params.path;
		if (!path || this.state.isTranscribing) return;

		// Extract noteId from the current URL (/note/:id) for the process log.
		const noteId = window.location.pathname.match(/^\/note\/(.+)/)?.[1];

		this.state.isTranscribing = true;
		this.state.transcriptionPercent = 0;

		const unsubProgress = this.transcriptionService.subscribeTranscriptionProgress(
			path,
			(percent) => { this.state.transcriptionPercent = percent; }
		);

		try {
			const text = await this.transcriptionService.transcribe(path, "fr", noteId);
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

	addTextEntry() {
		const text = this.props.params?.transcription;
		if (!text) return;
		this.eventBus.trigger(Events.ADD_TRANSCRIPTION_TEXT, {
			afterEntryId: this.props.id,
			text,
		});
	}

	/**
	 * Voir la {@link https://www.npmjs.com/package/capacitor-voice-recorder | documentation NPM}
	 */
	private async getBlobURL(path: string) {
		const directory = Directory.Data;

		if (Capacitor.getPlatform() === "web") {
			const { data } = await Filesystem.readFile({ directory, path });

			if (!(data instanceof Blob)) {
				// TODO ERROR MESSAGE
				return;
			}

			return URL.createObjectURL(data);
		}

		const { uri } = await Filesystem.getUri({ directory, path });
		return Capacitor.convertFileSrc(uri);
	}

	/**
	 * Voir la {@link https://www.npmjs.com/package/capacitor-voice-recorder | documentation NPM}
	 */
	private async playAudio() {
		const path = this.props.params.path;

		if (!path) {
			// TODO ERROR MESSAGE
			return;
		}

		const url = await this.getBlobURL(path);

		if (!url) {
			// TODO ERROR MESSAGE
			return;
		}

		this.state.audioRef = new Audio(url);

		this.state.audioRef.addEventListener("canplaythrough", this.onCanPlayThrough.bind(this));
		this.state.audioRef.addEventListener("ended", this.onEnded.bind(this));

		this.state.audioRef.onended = function () {
			URL.revokeObjectURL(url);
		}

		this.state.audioRef.play();
	}
}

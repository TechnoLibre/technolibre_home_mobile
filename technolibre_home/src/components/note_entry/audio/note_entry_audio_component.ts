import { useState, xml } from "@odoo/owl";

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
			<button
				type="button"
				class="note-entry--audio__control note-entry--audio__stop-recording"
				t-if="!state.isPlaying and state.isRecording"
				t-on-click.stop.prevent="stopRecording"
			>
				<img src="${StopIcon}" />
			</button>
			<button
				type="button"
				class="note-entry--audio__control note-entry--audio__stop-playback"
				t-if="state.isPlaying and !state.isRecording"
				t-on-click.stop.prevent="stopPlayback"
			>
				<img src="${StopIcon}" />
			</button>
			<button
				type="button"
				class="note-entry--audio__control note-entry--audio__record"
				t-if="!state.isPlaying and !state.isRecording and props.params.path === ''"
				t-on-click.stop.prevent="startRecording"
			>
				<img src="${RecordIcon}" />
			</button>
			<button
				type="button"
				class="note-entry--audio__control note-entry--audio__play"
				t-if="!state.isPlaying and !state.isRecording and props.params.path !== ''"
				t-on-click.stop.prevent="playAudio"
			>
				<img src="${PlayIcon}" />
			</button>
		</div>
	`;

	setup() {
		this.state = useState({ isRecording: false, isPlaying: false, audioRef: undefined });
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

import { useState, xml } from "@odoo/owl";

import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Dialog } from "@capacitor/dialog";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";

import CameraIcon from "../../../assets/icon/flip_camera_android.svg";
import OpenIcon from "../../../assets/icon/open.svg";
import PhotoOffIcon from "../../../assets/icon/photo_off.svg";
import CloseIcon from "../../../assets/icon/close.svg";

export class NoteEntryPhotoComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry__wrapper"
			t-att-class="{
				'not-empty': props.params.path
			}"
		>
			<div class="note-entry__photo__thumbnail__wrapper">
				<t t-if="props.params.path">
					<img
						class="note-entry__photo__thumbnail"
						t-att-src="image"
					/>
				</t>
				<t t-else="">
					<div class="note-entry__photo__thumbnail--empty">
						<img src="${PhotoOffIcon}" />
					</div>
				</t>
			</div>
			<div class="note-entry__photo__data">
				<button
					class="note-entry__photo__button note-entry__photo__open-camera"
					t-on-click.stop.prevent="onClickOpenCamera"
				>
					<img src="${CameraIcon}" />
					<span>Photo</span>
				</button>
				<button
					class="note-entry__photo__button note-entry__photo__open-photo"
					t-if="props.params.path"
					t-on-click.stop.prevent="onClickOpenPhoto"
				>
					<img src="${OpenIcon}" />
					<span>Voir</span>
				</button>
			</div>
		</div>
		<div t-if="state.showPhoto" class="note-entry__photo__overlay">
			<button class="note-entry__photo__overlay__close" t-on-click.stop.prevent="onClickClosePhoto">
				<img src="${CloseIcon}" />
			</button>
			<img
				class="note-entry__photo__overlay__img"
				t-att-src="image"
			/>
		</div>
	`;

	setup() {
		this.state = useState({ showPhoto: false });
	}

	async onClickOpenCamera() {
		try {
			const { camera } = await Camera.requestPermissions({ permissions: ["camera"] });
			if (camera !== "granted") {
				Dialog.alert({ message: "Permission caméra refusée." });
				return;
			}

			const photo = await Camera.getPhoto({
				quality: 90,
				allowEditing: false,
				resultType: CameraResultType.Uri,
				source: CameraSource.Camera,
			});

			if (!photo.path) return;

			this.eventBus.trigger(Events.SET_PHOTO, {
				entryId: this.props.id,
				path: photo.path,
			});
		} catch {
			// User cancelled — no alert needed
		}
	}

	onClickOpenPhoto() {
		this.state.showPhoto = true;
	}

	onClickClosePhoto() {
		this.state.showPhoto = false;
	}

	get image(): string {
		return Capacitor.convertFileSrc(this.props.params.path);
	}
}

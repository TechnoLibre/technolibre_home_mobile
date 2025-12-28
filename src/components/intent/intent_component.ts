import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { Events } from "../../constants/events";

import { NoteTextIntentHandlerComponent } from "../intent-handler/note/text/note_text_intent_handler_component";
import { NoteImageIntentHandlerComponent } from "../intent-handler/note/image/note_image_intent_handler_component";
import { NoteVideoIntentHandlerComponent } from "../intent-handler/note/video/note_video_intent_handler_component";

export class IntentComponent extends EnhancedComponent {
	static template = xml`
		<div id="intent-component">
			<t
				t-if="state.intent"
				t-component="getIntentHandlerComponent()"
				intent="state.intent"
				goHome.bind="goHome"
			/>
		</div>
	`;

	static components = {
		NoteTextIntentHandlerComponent,
		NoteImageIntentHandlerComponent,
		NoteVideoIntentHandlerComponent
	};

	setup() {
		this.state = useState({ intent: undefined });
		this.setIntent();
		this.setParams();
	}

	public getIntentHandlerComponent() {
		if (!this.intentService.isIntentType(this.state.intent.type)) {
			this.goHome();
		}

		switch (this.state.intent.type) {
			case "text":
				return NoteTextIntentHandlerComponent;
			case "image":
				return NoteImageIntentHandlerComponent;
			case "video":
				return NoteVideoIntentHandlerComponent;
		}
	}

	public goHome() {
		this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: "/" });
	}

	private setIntent() {
		const intent = this.intentService.intent;

		if (!intent) {
			this.goHome();
		}

		this.state.intent = intent;
		this.intentService.clearIntent();
	}

	private setParams() {
		const params = this.router.getRouteParams(window.location.pathname);
		this.state.type = decodeURIComponent(params?.get("id") || "");
	}
}

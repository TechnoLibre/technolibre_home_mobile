import { useRef, useState, xml } from "@odoo/owl";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { Events } from "../../constants/events";
import { NoteTextIntentHandlerComponent } from "../intent-handler/note/text/note_text_intent_handler_component";
import { NoteImageIntentHandlerComponent } from "../intent-handler/note/image/note_image_intent_handler_component";
import { NoteVideoIntentHandlerComponent } from "../intent-handler/note/video/note_video_intent_handler_component";

export class IntentComponent extends EnhancedComponent {
	static template = xml`
		<div
			id="intent-component"
			popover=""
			t-on-click.stop.prevent="hidePopover"
			t-ref="intent-popover"
		>
			<div
				id="intent__wrapper"
				t-on-click.stop.prevent=""
			>
				<div id="intent" t-if="state.intent">
					<t
						t-component="getIntentHandlerComponent()"
						intent="state.intent"
						hidePopover.bind="hidePopover"
					/>
				</div>
			</div>
		</div>
	`;

	static components = {};

	intentPopover = useRef("intent-popover");

	state: any = undefined;

	setup() {
		this.state = useState({ intent: undefined });
		this.listenForEvents();
	}

	showPopover() {
		if (!this.intentPopover.el) {
			return;
		}

		this.intentPopover.el.showPopover();
	}

	hidePopover() {
		if (!this.intentPopover.el) {
			return;
		}

		this.intentPopover.el.hidePopover();
	}

	public getIntentHandlerComponent() {
		switch (this.state.intent.type) {
			case "text":
				return NoteTextIntentHandlerComponent;
			case "image":
				return NoteImageIntentHandlerComponent;
			case "video":
				return NoteVideoIntentHandlerComponent;
			default:
				return undefined;
		}
	}

	private listenForEvents() {
		this.eventBus.addEventListener(Events.RECEIVE_INTENT, this.receiveIntent.bind(this));
	}

	private receiveIntent(event: any) {
		if (!event?.detail?.intent) {
			return;
		}

		const intent = this.intentService.from(event.detail.intent);

		if (!intent) {
			return;
		}

		this.state.intent = intent;
		this.showPopover();
	}
}

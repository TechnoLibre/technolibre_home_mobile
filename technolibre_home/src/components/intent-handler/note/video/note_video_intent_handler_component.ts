import { Component, useState, xml } from "@odoo/owl";

export class NoteVideoIntentHandlerComponent extends Component {
	static template = xml`
		<div id="note-video-intent-handler-component">
			<h1>NoteVideoIntentHandler</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

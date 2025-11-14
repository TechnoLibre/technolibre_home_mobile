import { Component, useState, xml } from "@odoo/owl";

export class NoteImageIntentHandlerComponent extends Component {
	static template = xml`
		<div id="note-image-intent-handler-component">
			<h1>NoteImageIntentHandler</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

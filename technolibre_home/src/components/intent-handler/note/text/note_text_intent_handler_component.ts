import { Component, useState, xml } from "@odoo/owl";

export class NoteTextIntentHandlerComponent extends Component {
	static template = xml`
		<div id="note-text-intent-handler-component">
			<h1>NoteTextIntentHandler</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

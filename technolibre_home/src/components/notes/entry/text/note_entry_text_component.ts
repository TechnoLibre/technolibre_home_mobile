import { Component, useState, xml } from "@odoo/owl";

export class NoteEntryTextComponent extends Component {
	static template = xml`
		<div id="note-entry-text-component">
			<h1>NoteEntryText</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

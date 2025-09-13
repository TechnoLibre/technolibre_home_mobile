import { Component, useState, xml } from "@odoo/owl";

export class NoteEntryComponent extends Component {
	static template = xml`
		<div id="note-entry-component">
			<h1>NoteEntry</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

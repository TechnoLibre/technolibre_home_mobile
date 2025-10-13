import { Component, useState, xml } from "@odoo/owl";

export class NoteEntryDeleteComponent extends Component {
	static template = xml`
		<div id="note-entry-delete-component">
			<h1>NoteEntryDelete</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

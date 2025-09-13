import { Component, useState, xml } from "@odoo/owl";

export class NoteEntryTitleComponent extends Component {
	static template = xml`
		<div id="note-entry-title-component">
			<h1>NoteEntryTitle</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

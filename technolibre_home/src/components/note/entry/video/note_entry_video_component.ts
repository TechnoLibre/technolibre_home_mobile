import { Component, useState, xml } from "@odoo/owl";

export class NoteEntryVideoComponent extends Component {
	static template = xml`
		<div id="note-entry-video-component">
			<h1>NoteEntryVideo</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

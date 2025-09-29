import { Component, useState, xml } from "@odoo/owl";

export class NoteContentComponent extends Component {
	static template = xml`
		<div id="note-content-component">
			<h1>NoteContent</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

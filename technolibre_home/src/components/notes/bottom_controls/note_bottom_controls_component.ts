import { Component, useState, xml } from "@odoo/owl";

export class NoteBottomControlsComponent extends Component {
	static template = xml`
		<div id="note-bottom-controls-component">
			<h1>NoteBottomControls</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

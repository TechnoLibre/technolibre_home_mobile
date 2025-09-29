import { Component, useState, xml } from "@odoo/owl";

export class NoteTopControlsComponent extends Component {
	static template = xml`
		<div id="note-top-controls-component">
			<h1>NoteTopControls</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

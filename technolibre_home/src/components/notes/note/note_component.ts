import { Component, useState, xml } from "@odoo/owl";

export class NoteComponent extends Component {
	static template = xml`
		<div id="note-component">
			<h1>Note</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

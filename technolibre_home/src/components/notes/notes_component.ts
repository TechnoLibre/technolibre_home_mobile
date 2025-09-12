import { Component, useState, xml } from "@odoo/owl";

export class NotesComponent extends Component {
	static template = xml`
		<div id="notes-component">
			<h1>Notes</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

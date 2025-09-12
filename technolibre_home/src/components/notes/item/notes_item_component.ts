import { Component, useState, xml } from "@odoo/owl";

export class NotesItemComponent extends Component {
	static template = xml`
		<div id="notes-item-component">
			<h1>NotesItem</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

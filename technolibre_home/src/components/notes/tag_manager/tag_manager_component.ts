import { Component, useState, xml } from "@odoo/owl";

export class TagManagerComponent extends Component {
	static template = xml`
		<div id="tag-manager-component">
			<h1>TagManager</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

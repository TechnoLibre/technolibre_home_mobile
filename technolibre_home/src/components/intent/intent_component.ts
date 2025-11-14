import { Component, useState, xml } from "@odoo/owl";

export class IntentComponent extends Component {
	static template = xml`
		<div id="intent-component">
			<h1>Intent</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

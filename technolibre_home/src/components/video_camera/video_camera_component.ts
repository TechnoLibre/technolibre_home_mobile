import { Component, useState, xml } from "@odoo/owl";

export class VideoCameraComponent extends Component {
	static template = xml`
		<div id="video-camera-component">
			<h1>VideoCamera</h1>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}

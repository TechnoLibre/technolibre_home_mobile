import { Component, xml } from "@odoo/owl";

export class HeadingComponent extends Component {
	static template = xml`
    <div class="heading-component">
      <h1 class="page-heading">
        <t t-esc="props.title"></t>
      </h1>
    </div>
  `;
}

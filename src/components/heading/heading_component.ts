import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";

export class HeadingComponent extends EnhancedComponent {
	static template = xml`
    <div class="heading-component">
      <h1 class="page-heading">
        <t t-esc="props.title"></t>
      </h1>
    </div>
  `;
}

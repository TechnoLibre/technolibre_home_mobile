import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";

export class HeadingComponent extends EnhancedComponent {
	static template = xml`
    <div class="heading-component">
      <t t-if="props.breadcrumbs and props.breadcrumbs.length">
        <nav class="breadcrumb">
          <t t-foreach="props.breadcrumbs" t-as="crumb" t-key="crumb.url">
            <a href="#" t-on-click.stop.prevent="() => navigate(crumb.url)">
              <t t-esc="crumb.label"/>
            </a>
            <span class="breadcrumb__sep">›</span>
          </t>
          <span class="breadcrumb__current"><t t-esc="props.title"/></span>
        </nav>
      </t>
      <h1 class="page-heading">
        <t t-esc="props.title"/>
      </h1>
    </div>
  `;
}

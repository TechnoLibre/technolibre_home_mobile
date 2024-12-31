import { Component, xml } from "@odoo/owl";

import { HeadingComponent } from "../heading/heading_component";
import { OptionsClearCacheComponent } from "./clear_cache/options_clear_cache_component";
import { OptionsToggleBiometryComponent } from "./options_toggle_biometry_component.ts/options_toggle_biometry_component";

export class OptionsComponent extends Component {
	static template = xml`
    <div id="options-component">
      <HeadingComponent title="'Options'" />
      <ul id="options-list">
        <OptionsClearCacheComponent />
        <OptionsToggleBiometryComponent />
      </ul>
    </div>
  `;

	static components = { HeadingComponent, OptionsClearCacheComponent, OptionsToggleBiometryComponent };
}

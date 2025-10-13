import { onMounted, useRef, useState, xml } from "@odoo/owl";

import { DatetimePicker, PresentResult } from "@capawesome-team/capacitor-datetime-picker";
import { WcDatepicker } from "wc-datepicker/dist/components/wc-datepicker";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { events } from "../../../js/events";
import { WebViewUtils } from "../../../utils/webViewUtils";

export class DatePickerComponent extends EnhancedComponent {
	static template = xml`
		<div
			id="datepicker__popover"
			popover=""
			t-if="!state.isMobile"
			t-ref="datepicker-popover"
			t-on-click.stop.prevent="onWcDatePickerPopoverClick"
		>
			<div id="datepicker__wrapper" t-on-click.stop.prevent="">
				<wc-datepicker
					t-att-start-date="this.getStartDate()"
					id="datepicker"
					t-ref="datepicker"
					t-on-selectDate="onWcDatePickerSelect"
				></wc-datepicker>
			</div>
		</div>
	`;

	wcDatePickerPopover = useRef("datepicker-popover");
	wcDatePicker = useRef("datepicker");

	setup() {
		this.state = useState({});
		onMounted(this.onMounted.bind(this));
	}

	private onMounted() {
		if (!customElements.get("wc-datepicker")) {
			customElements.define("wc-datepicker", WcDatepicker);
		}
		this.eventBus.addEventListener(events.DATE_PICKER, this.openDatePicker.bind(this));
	}

	openDatePicker() {
		WebViewUtils.isMobile() ? this.setDateMobile() : this.setDateWeb();
	}

	onWcDatePickerPopoverClick() {
		if (!this.wcDatePickerPopover.el) {
			return;
		}
		this.wcDatePickerPopover.el.hidePopover();
	}

	onWcDatePickerSelect() {
		if (!this.wcDatePickerPopover.el || !this.wcDatePicker.el) {
			return;
		}
		const date = new Date((this.wcDatePicker.el as any)?.value);
		this.setDate(date.toISOString());
		this.wcDatePickerPopover.el.hidePopover();
	}

	getStartDate() {
		const date = this.props.note.date ? new Date(this.props.note.date) : new Date();
		return date.toISOString().split("T")[0];
	}

	private async setDateMobile() {
		const presentResult: PresentResult = await DatetimePicker.present({
			mode: "date"
		});
		const date = new Date(presentResult.value);
		date.setHours(0, 0, 0, 0);
		this.setDate(date.toISOString());
	}

	private setDateWeb() {
		if (!this.wcDatePickerPopover.el) {
			return;
		}

		this.wcDatePickerPopover.el.showPopover();
	}

	private setDate(date: string) {
		this.props.setNoteDate(date);
	}
}

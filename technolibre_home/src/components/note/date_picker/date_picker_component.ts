import { onMounted, useRef, useState, xml } from "@odoo/owl";

import AirDatepicker, { AirDatepickerButton } from "air-datepicker";
import { DatetimePicker, PresentResult } from "@capawesome-team/capacitor-datetime-picker";

import "air-datepicker/air-datepicker.css"
import localeFr from "air-datepicker/locale/fr"

import { Events } from "../../../constants/events";
import { WebViewUtils } from "../../../utils/webViewUtils";

import { EnhancedComponent } from "../../../js/enhancedComponent";

export interface DateSelectEvent {
  date: Date | Date[],
  formattedDate: string | string[],
  datepicker: AirDatepicker<HTMLElement>
}

export class DatePickerComponent extends EnhancedComponent {
	static template = xml`
		<div
			id="datepicker__popover"
			popover=""
			t-if="!state.isMobile"
			t-ref="datepicker-popover"
			t-on-click.stop.prevent="onPopoverClick"
		>
			<div id="datepicker__wrapper" t-on-click.stop.prevent="">
        <div id="datepicker">
        </div>
			</div>
		</div>
	`;

	datePickerPopover = useRef("datepicker-popover");
  airDatePicker: AirDatepicker<HTMLElement> | undefined;

	setup() {
		this.state = useState({ entryId: "" });
		onMounted(this.onMounted.bind(this));
	}

	private onMounted() {
    this.eventBus.addEventListener(Events.DATE_PICKER, this.openDatePicker.bind(this));
		this.datePickerPopover.el?.addEventListener("toggle", this.onPopoverToggle.bind(this));
	}

	private onPopoverToggle(event: ToggleEvent) {
		if (event.newState !== "closed") {
			return;
		}

		this.airDatePicker?.destroy();
	}

  private onDatePickerConfirm(dpInstance: AirDatepicker) {
    if (!this.datePickerPopover.el) {
      return;
    }

    const selectedDate: Date = dpInstance?.selectedDates?.[0];

    this.setDate(selectedDate.toISOString());

    this.datePickerPopover.el.hidePopover();
  }

	openDatePicker(event: any) {
    this.state.entryId = event?.detail?.entryId;
		WebViewUtils.isMobile() ? this.setDateMobile() : this.setDateWeb();
	}

	onPopoverClick() {
		if (!this.datePickerPopover.el) {
      return;
		}
    
		this.datePickerPopover.el.hidePopover();
	}

	getStartDate() {
		const date = this.props.note.date ? new Date(this.props.note.date) : new Date();
		return date.toISOString().split("T")[0];
	}

  private getNewDatePicker(): AirDatepicker<HTMLElement> {
    const startDate: Date = new Date();
    startDate.setHours(0, 0, 0, 0);

    const confirmButton: AirDatepickerButton = {
      content: "Confirmer",
      onClick: this.onDatePickerConfirm.bind(this)
    };

    return new AirDatepicker("#datepicker", {
      locale: localeFr,
      timepicker: true,
      minutesStep: 5,
      startDate,
      buttons: [ confirmButton ]
    });
  }

	private async setDateMobile() {
		const presentResult: PresentResult = await DatetimePicker.present({
			mode: "datetime"
		});
		const date = new Date(presentResult.value);
		this.setDate(date.toISOString());
	}

	private setDateWeb() {
		if (!this.datePickerPopover.el) {
			return;
		}

    this.airDatePicker = this.getNewDatePicker();
		this.datePickerPopover.el.showPopover();
	}

	private setDate(date: string) {
    const entryId: string = this.state.entryId;
    this.state.entryId = "";

		this.props.setEntryDate(entryId, date);
	}
}

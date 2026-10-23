import { onMounted, onPatched, onWillDestroy, useState, xml } from "@odoo/owl";

import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Dialog } from "@capacitor/dialog";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Geolocation, PermissionStatus, Position } from "@capacitor/geolocation";
import { BiometryUtils } from "../../utils/biometryUtils";
import { generateVideoThumbnail } from "../../utils/videoThumbnailUtils";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { ErrorMessages } from "../../constants/errorMessages";
import { NoNoteEntryMatchError, NoNoteMatchError, NoteKeyNotFoundError, UndefinedNoteListError } from "../../js/errors";
import { Events } from "../../constants/events";
import { NoteEntry, NoteEntryAudioParams, NoteEntryDateParams, NoteEntryPhotoParams, NoteEntryTextParams, NoteEntryVideoParams } from "../../models/note";
import {
	ACTIVITY_CREATE,
	AttachedKind,
	KINDS,
	localDay,
	MESSAGE_POST,
	PushOptions,
	RemoteRecordDeletedError,
	SyncConflictError,
	SyncCredentials,
	TargetKind,
	TARGET_KINDS,
	USER_MODEL,
} from "../../services/syncService";
import {
	ActivityRow,
	ActivitySection,
	planActivities,
	buildActivitySection,
	canAddActivity,
	canDeferRecord,
	isEditable,
	loadingSection,
	ModelOption,
	newDraftRow,
	rowModel,
	rowTypes,
	sectionHasWork,
	withModel,
	withRecords,
	withType,
	withUsers,
} from "../../services/activityPicker";
import type { ActivityTypeChoice } from "../../services/odoo/activityTypeService";
import {
	applyTaskTargets,
	buildTargetRows,
	filteredOptions,
	loadingRow,
	needsTaskTarget,
	PICKER_KINDS,
	ProjectOption,
	serverUsable,
	TargetRow,
	InvoiceDraft,
	newInvoiceLine,
	withPartners,
} from "../../services/targetPicker";
import type { FormField } from "../../services/odoo/invoiceForm";

/** Model of the products an invoice line can name. */
const INVOICE_PRODUCT_MODEL = "product.product";
import { OutboxBlockedError } from "../../services/outboxService";
import { networkService } from "../../services/networkService";
import { openRecordInApp } from "../../utils/openRecordInApp";
import { CALENDAR_HANDOFF_KEY } from "../../services/calendarView";
import type { SyncConfig } from "../../models/syncConfig";
import { loadSyncConfigs, syncConfigIdFor } from "../../models/syncConfig";

import { DatePickerComponent } from "./date_picker/date_picker_component";
import { NoteBottomControlsComponent } from "./bottom_controls/note_bottom_controls_component";
import { NoteContentComponent } from "./content/note_content_component";
import { NoteTopControlsComponent } from "./top_controls/note_top_controls_component";
import { TagManagerComponent } from "./tag_manager/tag_manager_component";

/** One conflicted link in the conflict dialog: its fields, each with both values and the choice. */
interface ConflictItem {
	linkId: string;
	label: string;
	rows: Array<{ field: string; mine: string; theirs: string; choice: "mine" | "theirs" }>;
}

/** A conflicting value as shown: tags joined, a yes or no, none as a dash. */
function conflictText(value: any): string {
	if (value === null || value === undefined || value === "") return "—";
	if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "—";
	if (typeof value === "boolean") return value ? "oui" : "non";
	return String(value);
}

/** One remote record of the note, offered by "Ouvrir dans l'app". */
interface OpenInAppItem {
	label: string;
	appUrl: string;
	username: string;
	password: string;
	model: string;
	resId: number;
}

export class NoteComponent extends EnhancedComponent {
	static template = xml`
		<div id="note-component">
			<div
				class="sr-only"
				aria-live="polite"
				aria-atomic="true"
				t-esc="state.syncAnnouncement"
			/>
			<nav class="breadcrumb" t-att-aria-label="t('aria.note_breadcrumb')">
				<a href="#" role="button" t-att-aria-label="t('aria.back_to_notes')" t-on-click.stop.prevent="onBackToNotesClick"><t t-esc="t('nav.notes')"/></a>
				<span class="breadcrumb__sep">›</span>
				<span class="breadcrumb__current" t-esc="state.note.title or 'Nouvelle note'"/>
				<div class="breadcrumb__note-nav">
					<button
						type="button"
						class="breadcrumb__note-nav-btn"
						t-att-aria-label="t('aria.previous_note')"
						t-att-disabled="!hasPrevious"
						t-on-click.stop.prevent="navigatePrevious"
					>‹</button>
					<button
						type="button"
						class="breadcrumb__note-nav-btn"
						t-att-aria-label="t('aria.next_note')"
						t-att-disabled="!hasNext"
						t-on-click.stop.prevent="navigateNext"
					>›</button>
					<div class="breadcrumb__sync-wrap">
						<button
							type="button"
							t-att-class="'breadcrumb__sync-btn breadcrumb__sync-btn--' + state.syncStatus + (state.isPressing ? ' breadcrumb__sync-btn--pressing' : '')"
							t-att-disabled="state.isSyncing or state.newNote"
							t-att-title="syncTitle"
							t-att-aria-label="syncTitle"
							aria-haspopup="dialog"
							t-att-aria-expanded="state.showConfigPicker ? 'true' : 'false'"
							t-on-pointerdown="onSyncPointerDown"
							t-on-pointerup="onSyncPointerUp"
							t-on-pointercancel="onSyncPointerCancel"
							t-esc="syncIcon"
						/>
						<div
							t-if="state.showConfigPicker"
							class="breadcrumb__config-picker"
							role="dialog"
							aria-modal="true"
							aria-labelledby="config-picker-title"
						>
							<p id="config-picker-title" class="breadcrumb__config-picker-label"><t t-esc="t('label.sync_with')"/></p>
							<t t-foreach="state.syncConfigs" t-as="cfg" t-key="cfg.id">
								<label t-att-class="'breadcrumb__config-option' + (isServerUsable(cfg.id) ? '' : ' breadcrumb__config-option--unusable')">
									<input
										type="checkbox"
										t-att-checked="state.selectedConfigIds.includes(cfg.id)"
										t-att-disabled="!isServerUsable(cfg.id)"
										t-on-change="(ev) => this.toggleConfigSelection(cfg.id, ev.target.checked)"
									/>
									<span t-esc="cfg.name or cfg.appUrl"/>
								</label>
								<div t-if="state.selectedConfigIds.includes(cfg.id) and state.companies[cfg.id] and state.companies[cfg.id].list.length > 1" class="breadcrumb__config-kind">
									<label class="breadcrumb__config-note" t-att-for="'sync-company-' + cfg_index"><t t-esc="t('label.sync_company')"/></label>
									<select
										class="breadcrumb__config-select"
										t-att-id="'sync-company-' + cfg_index"
										t-on-change="(ev) => this.setCompany(cfg.id, ev.target.value)"
									>
										<t t-foreach="state.companies[cfg.id].list" t-as="company" t-key="company.id">
											<option t-att-value="'' + company.id" t-att-selected="state.companies[cfg.id].selection === company.id" t-esc="company.name"/>
										</t>
									</select>
								</div>
								<t t-if="state.targets[cfg.id] and state.selectedConfigIds.includes(cfg.id)">
									<t t-foreach="kindRows(cfg.id)" t-as="row" t-key="row.kind">
										<div class="breadcrumb__config-kind">
											<label class="breadcrumb__config-kind-label">
												<input
													type="checkbox"
													t-att-checked="row.checked"
													t-att-disabled="row.loading or row.linkedResId or (row.queued and !row.droppable) or row.unusable or row.failed"
													t-on-change="(ev) => this.setKindChecked(cfg.id, row.kind, ev.target.checked)"
												/>
												<t t-esc="t('label.sync_kind_' + row.kind)"/>
											</label>
											<p t-if="row.loading" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_loading')"/></p>
											<p t-elif="row.failed" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="row.failed"/>
											<p t-elif="row.unusable" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="t('label.sync_target_unusable_' + row.unusable)"/>
											<p t-elif="row.linkedResId" class="breadcrumb__config-note" t-esc="t('label.sync_target_linked', { id: row.linkedResId })"/>
											<p t-elif="row.droppable" class="breadcrumb__config-note breadcrumb__config-note--warn"><t t-esc="t('label.sync_target_stuck')"/></p>
											<p t-elif="row.queued" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_queued')"/></p>
											<div t-elif="row.needsChoice and row.checked" class="breadcrumb__config-project">
												<p t-if="row.reason and row.reason !== 'incomplete'" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="t('label.sync_target_reason_' + row.reason, { id: row.deletedResId or '' })"/>
												<t t-if="row.kind === 'task'">
													<label class="breadcrumb__config-note" t-att-for="'sync-project-' + cfg_index"><t t-esc="t('label.sync_target_project')"/></label>
													<input
														t-if="row.options.length > 10"
														type="search"
														class="breadcrumb__config-filter"
														t-att-placeholder="t('label.sync_target_filter')"
														t-att-aria-label="t('label.sync_target_filter')"
														t-att-value="row.filter"
														t-on-input="(ev) => this.setRowFilter(cfg.id, row.kind, ev.target.value)"
													/>
													<select
														class="breadcrumb__config-select"
														t-att-id="'sync-project-' + cfg_index"
														t-on-change="(ev) => this.setRowSelection(cfg.id, row.kind, ev.target.value)"
													>
														<option value="none" t-att-selected="row.selection === 'none'"><t t-esc="t('label.sync_target_no_project')"/></option>
														<option t-if="row.canDefer" value="later" t-att-selected="row.selection === 'later'"><t t-esc="t('label.sync_target_later')"/></option>
														<t t-foreach="projectOptions(row)" t-as="opt" t-key="opt.value">
															<option t-att-value="opt.value" t-att-selected="row.selection === opt.value" t-esc="opt.name"/>
														</t>
													</select>
												</t>
												<t t-else="">
													<label class="breadcrumb__config-note" t-att-for="'sync-partner-search-' + row.kind + '-' + cfg_index"><t t-esc="t(partnerLabel(row))"/></label>
													<input
														type="search"
														class="breadcrumb__config-filter"
														t-att-id="'sync-partner-search-' + row.kind + '-' + cfg_index"
														t-att-placeholder="t('label.sync_target_partner_search')"
														t-att-value="row.query"
														t-on-input="(ev) => this.searchPartners(cfg, ev.target.value, row.kind)"
													/>
													<select
														class="breadcrumb__config-select"
														t-att-aria-label="t(partnerLabel(row))"
														t-on-change="(ev) => this.setRowSelection(cfg.id, row.kind, ev.target.value)"
													>
														<option value="none" t-att-selected="row.selection === 'none'"><t t-esc="t('label.sync_target_no_partner')"/></option>
														<option t-if="row.canDefer" value="later" t-att-selected="row.selection === 'later'"><t t-esc="t('label.sync_target_later')"/></option>
														<t t-foreach="row.options" t-as="opt" t-key="opt.value">
															<option t-att-value="opt.value" t-att-selected="row.selection === opt.value" t-esc="opt.name"/>
														</t>
													</select>
													<t t-if="row.kind === 'lead'">
													<label class="breadcrumb__config-note" t-att-for="'sync-revenue-' + cfg_index"><t t-esc="t('label.sync_target_revenue')"/></label>
													<input
														type="text"
														inputmode="decimal"
														class="breadcrumb__config-filter"
														t-att-id="'sync-revenue-' + cfg_index"
														t-att-value="row.revenue"
														t-on-input="(ev) => this.setRevenue(cfg.id, ev.target.value)"
													/>
													</t>
													<t t-if="row.kind === 'invoice' and row.invoice">
														<t t-set="inv" t-value="row.invoice"/>
														<label class="breadcrumb__config-note" t-att-for="'sync-inv-type-' + cfg_index"><t t-esc="t('label.sync_invoice_type')"/></label>
														<select
															class="breadcrumb__config-select"
															t-att-id="'sync-inv-type-' + cfg_index"
															t-on-change="(ev) => this.setInvoiceMoveType(cfg, ev.target.value)"
														>
															<option value="out_invoice" t-att-selected="inv.moveType === 'out_invoice'"><t t-esc="t('label.sync_invoice_out')"/></option>
															<option value="in_invoice" t-att-selected="inv.moveType === 'in_invoice'"><t t-esc="t('label.sync_invoice_in')"/></option>
														</select>
														<label class="breadcrumb__config-note" t-att-for="'sync-inv-date-' + cfg_index"><t t-esc="t('label.sync_invoice_date')"/></label>
														<input
															type="date"
															class="breadcrumb__config-filter"
															t-att-id="'sync-inv-date-' + cfg_index"
															t-att-value="inv.invoiceDate"
															t-on-change="(ev) => this.setInvoiceField(cfg.id, 'invoiceDate', ev.target.value)"
														/>
														<label class="breadcrumb__config-note" t-att-for="'sync-inv-ref-' + cfg_index"><t t-esc="t('label.sync_invoice_ref')"/></label>
														<input
															type="text"
															class="breadcrumb__config-filter"
															t-att-id="'sync-inv-ref-' + cfg_index"
															t-att-value="inv.ref"
															t-on-input="(ev) => this.setInvoiceField(cfg.id, 'ref', ev.target.value)"
														/>
														<p class="breadcrumb__config-note"><t t-esc="t('label.sync_invoice_lines')"/></p>
														<t t-foreach="inv.lines" t-as="line" t-key="line.key">
															<div class="breadcrumb__config-project">
																<input
																	type="text"
																	class="breadcrumb__config-filter"
																	t-att-placeholder="t('label.sync_invoice_line_name')"
																	t-att-aria-label="t('label.sync_invoice_line_name')"
																	t-att-value="line.name"
																	t-on-input="(ev) => this.setInvoiceLine(cfg.id, line.key, 'name', ev.target.value)"
																/>
																<input
																	type="text"
																	inputmode="decimal"
																	class="breadcrumb__config-filter"
																	t-att-placeholder="t('label.sync_invoice_line_quantity')"
																	t-att-aria-label="t('label.sync_invoice_line_quantity')"
																	t-att-value="line.quantity"
																	t-on-input="(ev) => this.setInvoiceLine(cfg.id, line.key, 'quantity', ev.target.value)"
																/>
																<input
																	type="text"
																	inputmode="decimal"
																	class="breadcrumb__config-filter"
																	t-att-placeholder="t('label.sync_invoice_line_price')"
																	t-att-aria-label="t('label.sync_invoice_line_price')"
																	t-att-value="line.price"
																	t-on-input="(ev) => this.setInvoiceLine(cfg.id, line.key, 'price', ev.target.value)"
																/>
																<input
																	type="search"
																	class="breadcrumb__config-filter"
																	t-att-placeholder="t('label.sync_invoice_product_search')"
																	t-att-aria-label="t('label.sync_invoice_product_search')"
																	t-att-value="line.productQuery"
																	t-on-input="(ev) => this.searchInvoiceProducts(cfg, line.key, ev.target.value)"
																/>
																<select
																	class="breadcrumb__config-select"
																	t-att-aria-label="t('label.sync_invoice_product')"
																	t-on-change="(ev) => this.setInvoiceLine(cfg.id, line.key, 'productSelection', ev.target.value)"
																>
																	<option value="" t-att-selected="line.productSelection === ''"><t t-esc="t('label.sync_invoice_no_product')"/></option>
																	<t t-foreach="line.products" t-as="opt" t-key="opt.value">
																		<option t-att-value="opt.value" t-att-selected="line.productSelection === opt.value" t-esc="opt.name"/>
																	</t>
																</select>
																<button
																	type="button"
																	class="breadcrumb__config-cancel"
																	t-on-click="() => this.removeInvoiceLine(cfg.id, line.key)"
																><t t-esc="t('label.sync_invoice_line_remove')"/></button>
															</div>
														</t>
														<button
															type="button"
															class="breadcrumb__config-cancel"
															t-on-click="() => this.addInvoiceLine(cfg.id)"
														><t t-esc="t('label.sync_invoice_line_add')"/></button>
														<p t-if="!inv.form" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_loading')"/></p>
														<t t-else="">
															<t t-foreach="inv.form.fields" t-as="field" t-key="field.name">
																<label class="breadcrumb__config-note" t-att-for="'sync-inv-x-' + cfg_index + '-' + field.name" t-esc="field.label"/>
																<t t-if="field.type === 'many2one'">
																	<input
																		type="search"
																		class="breadcrumb__config-filter"
																		t-att-placeholder="t('label.sync_activity_record_search')"
																		t-att-aria-label="field.label"
																		t-att-value="inv.extraQueries[field.name] or ''"
																		t-on-input="(ev) => this.searchInvoiceExtra(cfg, field, ev.target.value)"
																	/>
																	<select
																		class="breadcrumb__config-select"
																		t-att-id="'sync-inv-x-' + cfg_index + '-' + field.name"
																		t-on-change="(ev) => this.setInvoiceExtra(cfg.id, field.name, ev.target.value)"
																	>
																		<option value="" t-att-selected="!inv.extraValues[field.name]"><t t-esc="t('label.sync_activity_record_choose')"/></option>
																		<t t-foreach="inv.extraOptions[field.name] or []" t-as="opt" t-key="opt.value">
																			<option t-att-value="opt.value" t-att-selected="inv.extraValues[field.name] === opt.value" t-esc="opt.name"/>
																		</t>
																	</select>
																</t>
																<select
																	t-elif="field.type === 'selection'"
																	class="breadcrumb__config-select"
																	t-att-id="'sync-inv-x-' + cfg_index + '-' + field.name"
																	t-on-change="(ev) => this.setInvoiceExtra(cfg.id, field.name, ev.target.value)"
																>
																	<option value="" t-att-selected="!inv.extraValues[field.name]"/>
																	<t t-foreach="field.selection or []" t-as="choice" t-key="choice[0]">
																		<option t-att-value="choice[0]" t-att-selected="inv.extraValues[field.name] === choice[0]" t-esc="choice[1]"/>
																	</t>
																</select>
																<input
																	t-elif="field.type === 'boolean'"
																	type="checkbox"
																	t-att-id="'sync-inv-x-' + cfg_index + '-' + field.name"
																	t-att-checked="inv.extraValues[field.name] === '1'"
																	t-on-change="(ev) => this.setInvoiceExtra(cfg.id, field.name, ev.target.checked ? '1' : '')"
																/>
																<input
																	t-else=""
																	t-att-type="field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text'"
																	class="breadcrumb__config-filter"
																	t-att-id="'sync-inv-x-' + cfg_index + '-' + field.name"
																	t-att-value="inv.extraValues[field.name] or ''"
																	t-on-input="(ev) => this.setInvoiceExtra(cfg.id, field.name, ev.target.value)"
																/>
															</t>
															<p t-if="inv.form.unsupported.length > 0" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="t('label.sync_invoice_unsupported', { fields: inv.form.unsupported.join(', ') })"/>
															<p t-if="inv.form.fromCache and !row.offline and inv.form.error" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="inv.form.error"/>
														</t>
														<label class="breadcrumb__config-note" t-att-for="'sync-inv-tie-' + cfg_index"><t t-esc="t('label.sync_invoice_tie')"/></label>
														<select
															class="breadcrumb__config-select"
															t-att-id="'sync-inv-tie-' + cfg_index"
															t-on-change="(ev) => this.setInvoiceField(cfg.id, 'tie', ev.target.value)"
														>
															<option value="none" t-att-selected="inv.tie === 'none'"><t t-esc="t('label.sync_invoice_tie_none')"/></option>
															<t t-foreach="invoiceTies(cfg.id)" t-as="tieKind" t-key="tieKind">
																<option t-att-value="tieKind" t-att-selected="inv.tie === tieKind" t-esc="t('label.sync_invoice_tie_' + tieKind)"/>
															</t>
														</select>
													</t>
												</t>
												<p t-if="row.offline and row.options.length === 0" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_no_cache')"/></p>
												<p t-elif="row.fromCache and !row.offline" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_from_cache')"/></p>
												<p t-elif="row.error" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="row.error"/>
												<p t-if="row.truncated" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_truncated')"/></p>
											</div>
										</div>
									</t>
								</t>
								<t t-set="act" t-value="state.activities[cfg.id]"/>
								<div t-if="act and state.selectedConfigIds.includes(cfg.id)" class="breadcrumb__config-kind breadcrumb__config-activities">
									<p class="breadcrumb__config-kind-label"><t t-esc="t('label.sync_kind_attached')"/></p>
									<p t-if="act.loading" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_loading')"/></p>
									<p t-elif="act.failed" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="act.failed"/>
									<t t-else="">
										<t t-foreach="act.rows" t-as="arow" t-key="arow.key">
											<div t-if="!(arow.removed and arow.status === 'draft')" t-att-class="'breadcrumb__config-activity' + (arow.removed ? ' breadcrumb__config-activity--removed' : '')">
												<p class="breadcrumb__config-note"><t t-esc="t('label.sync_attached_' + arow.kind)"/></p>
												<t t-if="isActivityEditable(arow)">
													<p t-if="arow.reason and arow.reason !== 'incomplete'" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="t((arow.reason === 'model_unusable' ? 'label.sync_' + arow.kind + '_reason_' : 'label.sync_target_reason_') + arow.reason, { id: '' })"/>
													<label class="breadcrumb__config-note" t-att-for="'sync-act-model-' + cfg_index + '-' + arow_index"><t t-esc="t('label.sync_activity_model')"/></label>
													<select
														class="breadcrumb__config-select"
														t-att-id="'sync-act-model-' + cfg_index + '-' + arow_index"
														t-on-change="(ev) => this.setActivityModel(cfg, arow.key, ev.target.value)"
													>
														<t t-foreach="act.models" t-as="m" t-key="m.model">
															<option t-att-value="m.model" t-att-selected="arow.model === m.model" t-att-disabled="m.unusable[arow.kind]" t-esc="activityModelLabel(m, arow.kind)"/>
														</t>
														<option value="__advanced" t-att-selected="arow.model === '__advanced'"><t t-esc="t('label.sync_activity_model_advanced')"/></option>
													</select>
													<input
														t-if="arow.model === '__advanced'"
														type="text"
														class="breadcrumb__config-filter"
														autocapitalize="off"
														t-att-placeholder="t('label.sync_activity_model_technical')"
														t-att-aria-label="t('label.sync_activity_model_technical')"
														t-att-value="arow.advancedModel"
														t-on-input="(ev) => this.setActivityAdvancedModel(cfg, arow.key, ev.target.value)"
													/>
													<label class="breadcrumb__config-note" t-att-for="'sync-act-record-' + cfg_index + '-' + arow_index"><t t-esc="t('label.sync_activity_record')"/></label>
													<input
														type="search"
														class="breadcrumb__config-filter"
														t-att-placeholder="t('label.sync_activity_record_search')"
														t-att-aria-label="t('label.sync_activity_record_search')"
														t-att-value="arow.recordQuery"
														t-on-input="(ev) => this.searchActivityRecords(cfg, arow.key, ev.target.value)"
													/>
													<select
														class="breadcrumb__config-select"
														t-att-id="'sync-act-record-' + cfg_index + '-' + arow_index"
														t-on-change="(ev) => this.setActivityField(cfg.id, arow.key, 'recordSelection', ev.target.value)"
													>
														<option value="" t-att-selected="arow.recordSelection === ''"><t t-esc="t('label.sync_activity_record_choose')"/></option>
														<option t-if="canDeferActivityRecord(act, arow)" value="later" t-att-selected="arow.recordSelection === 'later'"><t t-esc="t('label.sync_target_later')"/></option>
														<t t-foreach="arow.records" t-as="opt" t-key="opt.value">
															<option t-att-value="opt.value" t-att-selected="arow.recordSelection === opt.value" t-esc="activityRecordLabel(act, arow, opt)"/>
														</t>
													</select>
													<p t-if="arow.recordsError" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="arow.recordsError"/>
													<p t-elif="arow.recordsFromCache and !act.offline" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_from_cache')"/></p>
													<t t-if="arow.kind === 'activity'">
													<label class="breadcrumb__config-note" t-att-for="'sync-act-type-' + cfg_index + '-' + arow_index"><t t-esc="t('label.sync_activity_type')"/></label>
													<select
														class="breadcrumb__config-select"
														t-att-id="'sync-act-type-' + cfg_index + '-' + arow_index"
														t-on-change="(ev) => this.setActivityType(cfg.id, arow.key, ev.target.value)"
													>
														<option value="" t-att-selected="arow.typeSelection === ''"><t t-esc="t('label.sync_activity_type_default')"/></option>
														<t t-foreach="activityTypeOptions(act, arow)" t-as="ty" t-key="ty.id">
															<option t-att-value="'' + ty.id" t-att-selected="arow.typeSelection === '' + ty.id" t-esc="ty.name"/>
														</t>
													</select>
													<label class="breadcrumb__config-note" t-att-for="'sync-act-deadline-' + cfg_index + '-' + arow_index"><t t-esc="t('label.sync_activity_deadline')"/></label>
													<input
														type="date"
														class="breadcrumb__config-filter"
														t-att-id="'sync-act-deadline-' + cfg_index + '-' + arow_index"
														t-att-value="arow.deadline"
														t-on-change="(ev) => this.setActivityDeadline(cfg.id, arow.key, ev.target.value)"
													/>
													<label class="breadcrumb__config-note" t-att-for="'sync-act-user-' + cfg_index + '-' + arow_index"><t t-esc="t('label.sync_activity_user')"/></label>
													<input
														type="search"
														class="breadcrumb__config-filter"
														t-att-placeholder="t('label.sync_activity_user_search')"
														t-att-aria-label="t('label.sync_activity_user_search')"
														t-att-value="arow.userQuery"
														t-on-input="(ev) => this.searchActivityUsers(cfg, arow.key, ev.target.value)"
													/>
													<select
														class="breadcrumb__config-select"
														t-att-id="'sync-act-user-' + cfg_index + '-' + arow_index"
														t-on-change="(ev) => this.setActivityField(cfg.id, arow.key, 'userSelection', ev.target.value)"
													>
														<option value="me" t-att-selected="arow.userSelection === 'me'"><t t-esc="t('label.sync_activity_user_me')"/></option>
														<t t-foreach="arow.users" t-as="opt" t-key="opt.value">
															<option t-att-value="opt.value" t-att-selected="arow.userSelection === opt.value" t-esc="opt.name"/>
														</t>
													</select>
													</t>
												</t>
												<t t-else="">
													<p class="breadcrumb__config-note" t-esc="activitySummary(act, arow)"/>
													<p t-if="arow.removed" class="breadcrumb__config-note"><t t-esc="t('label.sync_activity_status_removed')"/></p>
													<p t-elif="arow.status === 'stuck'" class="breadcrumb__config-note breadcrumb__config-note--warn"><t t-esc="t('label.sync_target_stuck')"/></p>
													<p t-else="" class="breadcrumb__config-note" t-esc="t('label.sync_' + arow.kind + '_status_' + arow.status)"/>
												</t>
												<button
													t-if="arow.status === 'draft' or arow.status === 'choose' or arow.status === 'stuck'"
													type="button"
													class="breadcrumb__config-cancel"
													t-on-click="() => this.toggleActivityRemoved(cfg.id, arow.key)"
												><t t-esc="t(arow.removed ? 'label.sync_activity_keep' : 'label.sync_activity_remove')"/></button>
											</div>
										</t>
										<button
											t-if="canAddAttached(act, 'activity')"
											type="button"
											class="breadcrumb__config-cancel"
											t-on-click="() => this.addActivity(cfg, 'activity')"
										><t t-esc="t('label.sync_activity_add')"/></button>
										<button
											t-if="canAddAttached(act, 'message')"
											type="button"
											class="breadcrumb__config-cancel"
											t-on-click="() => this.addActivity(cfg, 'message')"
										><t t-esc="t('label.sync_message_add')"/></button>
									</t>
								</div>
							</t>
							<button
								type="button"
								class="breadcrumb__config-confirm"
								t-att-disabled="state.selectedConfigIds.length === 0 or pickerLoading or state.confirming"
								t-on-click="() => this.confirmConfigSelection()"
							><t t-esc="t('button.synchronise')"/></button>
							<button
								type="button"
								class="breadcrumb__config-cancel"
								t-on-click="cancelConfigPick"
							><t t-esc="t('button.cancel')"/></button>
						</div>
					</div>
					<div class="breadcrumb__options-wrap">
						<button
							type="button"
							class="breadcrumb__options-btn"
							t-att-disabled="state.newNote"
							t-att-title="t('nav.options')"
							t-att-aria-label="t('aria.options')"
							aria-haspopup="menu"
							t-att-aria-expanded="state.showOptionsMenu ? 'true' : 'false'"
							t-on-click.stop.prevent="toggleOptionsMenu"
						>⋮</button>
						<div
							t-if="state.showOptionsMenu"
							class="breadcrumb__options-menu"
							role="menu"
						>
							<button
								type="button"
								class="breadcrumb__options-item"
								role="menuitem"
								t-on-click.stop.prevent="onMetadataClick"
							><t t-esc="t('button.sql_metadata')"/></button>
							<button
								type="button"
								class="breadcrumb__options-item"
								role="menuitem"
								t-on-click.stop.prevent="onDebugClick"
							>🐛 <t t-esc="t('button.debug')"/></button>
						</div>
					</div>
				</div>
			</nav>
			<NoteTopControlsComponent
				note="state.note"
				toggleEditMode.bind="toggleEditMode"
				onTagsClick.bind="onTagsClick"
				onArchiveClick.bind="onArchiveClick"
				onPinClick.bind="onPinClick"
				toggleDone.bind="toggleDone"
				toggleOptionMode.bind="toggleOptionMode"
				optionMode="state.optionMode"
				syncStatus="state.syncStatus"
				syncLabel="syncLabel"
				isSyncing="state.isSyncing"
				newNote="state.newNote"
				onSyncClick.bind="pushToOdoo"
			onSyncLongPress.bind="openSyncPicker"
			onOpenInAppClick.bind="onOpenInAppClick"
			onPriorityClick.bind="onPriorityClick"
			/>
			<NoteContentComponent
				note="state.note"
				editMode="state.editMode"
				saveNoteData.bind="saveNoteData"
				addText.bind="addText"
				deleteEntry.bind="deleteEntry"
			/>
			<NoteBottomControlsComponent
				addAudio.bind="addAudio"
				addLocation.bind="addLocation"
				addText.bind="addText"
				addDateEntry.bind="addDateEntry"
				addPhoto.bind="addPhoto"
				addVideo.bind="addVideo"
				addImage.bind="addImage"
			/>
		</div>
		<DatePickerComponent
			note="state.note"
			setEntryDate.bind="setEntryDate"
		/>
		<TagManagerComponent />
		<div
			t-if="state.openInApp.visible"
			class="error-dialog-overlay"
			role="presentation"
			t-on-click.stop.prevent="closeOpenInApp"
		>
			<div
				class="error-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="open-in-app-title"
				t-on-click.stop=""
			>
				<p id="open-in-app-title" class="open-in-app__title"><t t-esc="t('button.open_in_app')"/></p>
				<div class="error-dialog__actions">
					<t t-foreach="state.openInApp.apps" t-as="appItem" t-key="appItem.model + '#' + appItem.resId + '|' + appItem.appUrl + '|' + appItem.username">
						<button type="button" class="error-dialog__btn error-dialog__btn--note" t-on-click.stop.prevent="() => this.openInAppForConfig(appItem)">
							<t t-esc="appItem.label" />
						</button>
					</t>
					<button type="button" class="error-dialog__btn error-dialog__btn--close" t-on-click.stop.prevent="closeOpenInApp"><t t-esc="t('button.cancel')"/></button>
				</div>
			</div>
		</div>
		<div
			t-if="state.priorityPicker.visible"
			class="priority-picker-overlay"
			role="presentation"
			t-on-click.stop.prevent="closePriorityPicker"
		>
			<div
				class="priority-picker"
				role="dialog"
				aria-modal="true"
				aria-labelledby="priority-picker-title"
				t-on-click.stop=""
			>
				<p id="priority-picker-title" class="priority-picker__title"><t t-esc="t('section.eisenhower')"/></p>
				<div class="priority-picker__grid">
					<button type="button" class="priority-picker__btn priority-picker__btn--1" t-on-click.stop="() => this.setPriority(1)">
						<span class="priority-picker__label"><t t-esc="t('label.urgent_important')"/></span>
						<span class="priority-picker__desc"><t t-esc="t('label.do_now')"/></span>
					</button>
					<button type="button" class="priority-picker__btn priority-picker__btn--2" t-on-click.stop="() => this.setPriority(2)">
						<span class="priority-picker__label"><t t-esc="t('label.important_not_urgent')"/></span>
						<span class="priority-picker__desc"><t t-esc="t('label.schedule')"/></span>
					</button>
					<button type="button" class="priority-picker__btn priority-picker__btn--3" t-on-click.stop="() => this.setPriority(3)">
						<span class="priority-picker__label"><t t-esc="t('label.urgent_not_important')"/></span>
						<span class="priority-picker__desc"><t t-esc="t('label.delegate')"/></span>
					</button>
					<button type="button" class="priority-picker__btn priority-picker__btn--4" t-on-click.stop="() => this.setPriority(4)">
						<span class="priority-picker__label"><t t-esc="t('label.neither')"/></span>
						<span class="priority-picker__desc"><t t-esc="t('label.eliminate')"/></span>
					</button>
				</div>
				<button type="button" class="priority-picker__clear" t-on-click.stop="() => this.setPriority(undefined)"><t t-esc="t('button.clear_priority')"/></button>
				<button type="button" class="priority-picker__cancel" t-on-click.stop="closePriorityPicker"><t t-esc="t('button.cancel')"/></button>
			</div>
		</div>
		<div
			t-if="state.conflictDialog.visible"
			class="error-dialog-overlay"
			role="presentation"
		>
			<div class="error-dialog conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-dialog-title">
				<p id="conflict-dialog-title" class="conflict-dialog__title"><t t-esc="t('label.conflict_title')"/></p>
				<p class="breadcrumb__config-note"><t t-esc="t('label.conflict_hint')"/></p>
				<t t-foreach="state.conflictDialog.items" t-as="item" t-key="item.linkId">
					<p class="conflict-dialog__record" t-esc="item.label"/>
					<t t-foreach="item.rows" t-as="crow" t-key="crow.field">
						<fieldset class="conflict-dialog__field">
							<legend t-esc="t('label.conflict_field_' + crow.field)"/>
							<label class="conflict-dialog__choice">
								<input type="radio" t-att-name="item.linkId + crow.field" t-att-checked="crow.choice === 'mine'" t-on-change="() => this.setConflictChoice(item.linkId, crow.field, 'mine')"/>
								<span><t t-esc="t('label.conflict_mine')"/></span>
								<pre class="conflict-dialog__value" t-esc="crow.mine"/>
							</label>
							<label class="conflict-dialog__choice">
								<input type="radio" t-att-name="item.linkId + crow.field" t-att-checked="crow.choice === 'theirs'" t-on-change="() => this.setConflictChoice(item.linkId, crow.field, 'theirs')"/>
								<span><t t-esc="t('label.conflict_theirs')"/></span>
								<pre class="conflict-dialog__value" t-esc="crow.theirs"/>
							</label>
						</fieldset>
					</t>
				</t>
				<div class="error-dialog__actions">
					<button type="button" class="error-dialog__btn error-dialog__btn--note" t-att-disabled="state.conflictDialog.saving" t-on-click.stop.prevent="confirmConflicts"><t t-esc="t('label.conflict_apply')"/></button>
					<button type="button" class="error-dialog__btn error-dialog__btn--close" t-on-click.stop.prevent="closeConflictDialog"><t t-esc="t('button.cancel')"/></button>
				</div>
			</div>
		</div>
		<div
			t-if="state.errorDialog.visible"
			class="error-dialog-overlay"
			role="presentation"
			t-on-click.stop.prevent="closeErrorDialog"
		>
			<div
				class="error-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="error-dialog-title"
				t-on-click.stop=""
			>
				<p id="error-dialog-title" class="sr-only"><t t-esc="t('section.error_detail')"/></p>
				<pre class="error-dialog__message" t-esc="state.errorDialog.message" />
				<div class="error-dialog__actions">
					<button type="button" class="error-dialog__btn error-dialog__btn--copy" t-on-click.stop.prevent="copyErrorMessage">📋 <t t-esc="t('button.copy')"/></button>
					<button type="button" class="error-dialog__btn error-dialog__btn--note" t-on-click.stop.prevent="createErrorNote">📝 <t t-esc="t('button.create_note')"/></button>
					<button type="button" class="error-dialog__btn error-dialog__btn--close" t-on-click.stop.prevent="closeErrorDialog"><t t-esc="t('button.close')"/></button>
				</div>
			</div>
		</div>
		<div
			t-if="state.debugDialog.visible"
			class="error-dialog-overlay"
			role="presentation"
			t-on-click.stop.prevent="closeDebugDialog"
		>
			<div class="error-dialog" role="dialog" aria-modal="true" t-on-click.stop="">
				<pre class="debug-dialog__message" t-esc="state.debugDialog.message"/>
				<div class="error-dialog__actions">
					<button type="button" class="error-dialog__btn error-dialog__btn--note" t-on-click.stop.prevent="createDebugNote">📝 <t t-esc="t('button.add_note')"/></button>
					<button type="button" class="error-dialog__btn error-dialog__btn--close" t-on-click.stop.prevent="closeDebugDialog"><t t-esc="t('button.close')"/></button>
				</div>
			</div>
		</div>
	`;

	static components = {
		DatePickerComponent,
		NoteBottomControlsComponent,
		NoteContentComponent,
		NoteTopControlsComponent,
		TagManagerComponent
	};

	/** Tracks which element had focus before a dialog was opened, so we can restore it on close. */
	private _dialogTrigger: HTMLElement | null = null;
	/** Which dialog was open on the previous render cycle (for focus-in detection). */
	private _prevDialog: string | null = null;
	/** Bound escape key handler — kept for removal on destroy. */
	private _boundEscapeHandler: ((ev: KeyboardEvent) => void) | null = null;

	setup() {
		this.state = useState({
			noteId: undefined,
			note: this.noteService.getNewNote(),
			newNote: false,
			editMode: false,
			optionMode: false,
			allNoteIds: [] as string[],
			syncStatus: "local" as string,
			syncConfigId: null as string | null,
			isSyncing: false,
			isPressing: false,
			syncConfigs: [] as SyncConfig[],
			selectedConfigIds: [] as string[],
			showConfigPicker: false,
			/** The picker's choices are being recorded: Synchronise is off until done. */
			confirming: false,
			/** Per sync config id and kind: what the picker shows for the note's record there. */
			targets: {} as Record<string, Record<TargetKind, TargetRow>>,
			/** Per sync config id: the note's activities there, and those being added. */
			activities: {} as Record<string, ActivitySection>,
			/** Per sync config id: the user's companies there and the one new records go to. */
			companies: {} as Record<string, { list: Array<{ id: number; name: string }>; selection: number | null }>,
			showOptionsMenu: false,
			debugDialog: { visible: false, message: "" },
			errorDialog: { visible: false, message: "" },
			/** The note's conflicts, per link, with the user's choice per field. */
			conflictDialog: { visible: false, saving: false, items: [] as ConflictItem[] },
			openInApp: { visible: false, apps: [] as OpenInAppItem[] },
			priorityPicker: { visible: false },
			syncAnnouncement: "",
		});
		this.setParams();
		this.getNote();
		this.loadAllNoteIds();
		this.listenForEvents();
		onMounted(() => {
			this.loadSyncStatus();
			this.consumeCalendarHandoff();
			this._boundEscapeHandler = this._onKeydownEscape.bind(this);
			document.addEventListener("keydown", this._boundEscapeHandler);
		});
		onWillDestroy(() => {
			if (this._boundEscapeHandler) {
				document.removeEventListener("keydown", this._boundEscapeHandler);
			}
		});
		onPatched(() => this._manageFocusAfterPatch());
	}

	/** Focus management: move focus into dialogs when they open; restore on close. */
	private _manageFocusAfterPatch() {
		const openDialog =
			this.state.priorityPicker.visible ? "priority" :
			this.state.errorDialog.visible    ? "error" :
			this.state.openInApp.visible      ? "openInApp" :
			this.state.showConfigPicker       ? "configPicker" :
			null;

		if (openDialog !== this._prevDialog) {
			if (openDialog) {
				// Dialog just opened — save trigger, focus first button inside dialog
				this._dialogTrigger = document.activeElement as HTMLElement | null;
				const dialogEl = document.querySelector(`[role="dialog"]`);
				if (dialogEl) {
					const first = dialogEl.querySelector<HTMLElement>("button, [href], input, [tabindex]");
					first?.focus();
				}
			} else if (this._dialogTrigger) {
				// Dialog just closed — restore focus to trigger
				this._dialogTrigger.focus();
				this._dialogTrigger = null;
			}
			this._prevDialog = openDialog;
		}
	}

	get syncIcon(): string {
		if (this.state.isSyncing) return "⟳";
		switch (this.state.syncStatus) {
			case "synced":  return "✓☁";
			case "error":   return "✗☁";
			case "pending": return "☁!";
			case "conflict": return "⇄☁";
			default:        return "☁";
		}
	}

	get syncTitle(): string {
		if (this.state.isSyncing) return "Sync en cours…";
		const cfg = this.state.syncConfigs.find((c) => c.id === this.state.syncConfigId);
		const server = cfg ? ` — ${cfg.name || cfg.appUrl}` : "";
		switch (this.state.syncStatus) {
			case "synced":  return `Synchronisé${server}`;
			case "error":   return `Erreur de sync${server}`;
			case "pending": return "Modifications en attente";
			case "conflict": return "Conflit : modifiée dans l'app et sur le serveur";
			default:        return "Pousser vers Odoo";
		}
	}

	get syncLabel(): string {
		if (this.state.isSyncing) return "Sync…";
		const cfg = this.state.syncConfigs.find((c) => c.id === this.state.syncConfigId);
		switch (this.state.syncStatus) {
			case "synced":  return cfg?.name || cfg?.appUrl || "Synchronisé";
			case "error":   return "Erreur";
			case "pending": return "En attente";
			case "conflict": return "Conflit";
			default:        return "Synchroniser";
		}
	}

	_pressTimer: ReturnType<typeof setTimeout> | null = null;
	_pressTriggered = false;

	onSyncPointerDown(ev: PointerEvent) {
		if (this.state.isSyncing || this.state.newNote) return;
		ev.preventDefault();
		(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
		this.state.isPressing = true;
		this._pressTriggered = false;
		this._pressTimer = setTimeout(async () => {
			this._pressTriggered = true;
			this.state.isPressing = false;
			await this.openSyncPicker();
		}, 1000);
	}

	onSyncPointerUp() {
		if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
		if (!this.state.isPressing) return;
		this.state.isPressing = false;
		if (!this._pressTriggered) this.pushToOdoo();
	}

	onSyncPointerCancel() {
		if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
		this.state.isPressing = false;
	}

	async openSyncPicker() {
		if (this.state.showConfigPicker) return;
		const configs = await loadSyncConfigs(this.appService);
		this.state.syncConfigs = configs;
		if (configs.length === 0) {
			await Dialog.alert({ message: "Configurez la synchronisation dans les options." });
			return;
		}
		if (this.state.selectedConfigIds.length === 0) {
			this.state.selectedConfigIds = configs.map((c) => c.id);
		}
		await this.showPicker(configs);
	}

	/**
	 * Opens the picker and fills, per server and kind, the note's state and
	 * the choices, and per server its activities. The rows are reset to
	 * "loading" before the picker shows, so Synchronise stays disabled until
	 * every selected server is known.
	 */
	private async showPicker(configs: SyncConfig[]) {
		const targets: Record<string, Record<TargetKind, TargetRow>> = {};
		const activities: Record<string, ActivitySection> = {};
		for (const cfg of configs) {
			targets[cfg.id] = Object.fromEntries(PICKER_KINDS.map((k) => [k, loadingRow(k)])) as Record<TargetKind, TargetRow>;
			activities[cfg.id] = loadingSection();
		}
		this.state.targets = targets;
		this.state.activities = activities;
		this.state.showConfigPicker = true;
		await this.loadTaskTargets(configs);
	}

	/** Bumped by each loadTaskTargets: an older load's rows are dropped. */
	private _targetsLoad = 0;

	/** Whether the picker still waits for a selected server's states or choices. */
	get pickerLoading(): boolean {
		return this.state.selectedConfigIds.some((id: string) =>
			PICKER_KINDS.some((k) => this.state.targets[id]?.[k]?.loading) || this.state.activities[id]?.loading);
	}

	kindRows(configId: string): TargetRow[] {
		const rows = this.state.targets[configId];
		return rows ? PICKER_KINDS.map((k) => rows[k]) : [];
	}

	/** Whether a server can be selected: still loading, or it can receive something, an activity included. */
	isServerUsable(configId: string): boolean {
		const rows = this.state.targets[configId];
		const section = this.state.activities[configId];
		if (!rows || PICKER_KINDS.some((k) => rows[k].loading) || section?.loading) return true;
		return serverUsable(rows, sectionHasWork(section) || canAddActivity(section));
	}

	/** The i18n key naming a row's partner: an opportunity's client, an invoice's customer or vendor. */
	partnerLabel(row: TargetRow): string {
		return row.kind === "invoice" ? "label.sync_invoice_partner" : "label.sync_target_partner";
	}

	projectOptions(row: TargetRow): ProjectOption[] {
		return filteredOptions(row);
	}

	setKindChecked(configId: string, kind: TargetKind, checked: boolean) {
		const row = this.state.targets[configId]?.[kind];
		if (row && ((row.needsChoice && !row.unusable) || row.droppable)) row.checked = checked;
	}

	setRowSelection(configId: string, kind: TargetKind, value: string) {
		const row = this.state.targets[configId]?.[kind];
		if (row) row.selection = value;
	}

	setRowFilter(configId: string, kind: TargetKind, value: string) {
		const row = this.state.targets[configId]?.[kind];
		if (row) row.filter = value;
	}

	setRevenue(configId: string, value: string) {
		const row = this.state.targets[configId]?.lead;
		if (row) row.revenue = value;
	}

	setCompany(configId: string, value: string) {
		const company = this.state.companies[configId];
		if (company) company.selection = Number(value) || null;
	}

	/** Pending partner search per config id, run 300 ms after the last keystroke. */
	private _partnerSearch = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * Searches the partners of a server for the lead row, online or in the
	 * cache; a result arriving after a newer keystroke, or after the picker
	 * was rebuilt, is dropped.
	 */
	searchPartners(cfg: SyncConfig, text: string, kind: "lead" | "invoice" = "lead") {
		const row = this.state.targets[cfg.id]?.[kind];
		if (!row) return;
		row.query = text;
		const timerKey = `${cfg.id}|${kind}`;
		const pending = this._partnerSearch.get(timerKey);
		if (pending) clearTimeout(pending);
		const load = this._targetsLoad;
		this._partnerSearch.set(timerKey, setTimeout(async () => {
			this._partnerSearch.delete(timerKey);
			try {
				const online = await networkService.isOnline();
				const found = await this.syncService.partners.search(await this.credsFor(cfg), text, { online });
				const current = this.state.targets[cfg.id]?.[kind];
				if (load !== this._targetsLoad || !current || current.query !== text) return;
				this.state.targets[cfg.id][kind] = withPartners(current, found);
			} catch (e: unknown) {
				const current = this.state.targets[cfg.id]?.[kind];
				if (current) current.error = e instanceof Error ? e.message : String(e);
			}
		}, 300));
	}

	// ── Draft invoice in the picker ─────────────────────────────────────────

	private invoiceDraft(configId: string): InvoiceDraft | null {
		return this.state.targets[configId]?.invoice?.invoice ?? null;
	}

	/** The note's records an invoice can be tied to here: its task and opportunity, linked or checked. */
	invoiceTies(configId: string): Array<"task" | "lead"> {
		const rows = this.state.targets[configId];
		if (!rows) return [];
		return (["task", "lead"] as const).filter((k) => rows[k] && (rows[k].linkedResId !== null || rows[k].checked));
	}

	/** Changes the invoice type, and loads the extra fields of that type (form null meanwhile). */
	async setInvoiceMoveType(cfg: SyncConfig, value: string) {
		const draft = this.invoiceDraft(cfg.id);
		if (!draft || (value !== "out_invoice" && value !== "in_invoice")) return;
		draft.moveType = value;
		draft.form = null;
		const load = this._targetsLoad;
		try {
			const online = await networkService.isOnline();
			const form = await this.syncService.invoiceForms.load(await this.credsFor(cfg), value, { online });
			const current = this.invoiceDraft(cfg.id);
			if (load === this._targetsLoad && current && current.moveType === value) current.form = form;
		} catch (e: unknown) {
			const current = this.invoiceDraft(cfg.id);
			if (load === this._targetsLoad && current && current.moveType === value) {
				current.form = { fields: [], unsupported: [], fromCache: true, error: e instanceof Error ? e.message : String(e) };
			}
		}
	}

	setInvoiceField(configId: string, field: "invoiceDate" | "ref" | "tie", value: string) {
		const draft = this.invoiceDraft(configId);
		if (draft) draft[field] = value;
	}

	setInvoiceExtra(configId: string, name: string, value: string) {
		const draft = this.invoiceDraft(configId);
		if (draft) draft.extraValues[name] = value;
	}

	setInvoiceLine(configId: string, key: string, field: "name" | "quantity" | "price" | "productSelection", value: string) {
		const line = this.invoiceDraft(configId)?.lines.find((l) => l.key === key);
		if (line) line[field] = value;
	}

	addInvoiceLine(configId: string) {
		this.invoiceDraft(configId)?.lines.push(newInvoiceLine());
	}

	removeInvoiceLine(configId: string, key: string) {
		const draft = this.invoiceDraft(configId);
		if (draft) draft.lines = draft.lines.filter((l) => l.key !== key);
	}

	/** Pending product or extra-field search per picker field, run 300 ms after the last keystroke. */
	private _invoiceSearch = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * Searches model's records (online or in the cache) after the last
	 * keystroke and hands the options to apply; a result arriving after a
	 * newer keystroke (still(): false) or a rebuild of the picker is dropped.
	 */
	private searchInvoice(
		cfg: SyncConfig,
		timerKey: string,
		model: string,
		text: string,
		still: () => boolean,
		apply: (options: ProjectOption[]) => void
	) {
		const pending = this._invoiceSearch.get(timerKey);
		if (pending) clearTimeout(pending);
		const load = this._targetsLoad;
		this._invoiceSearch.set(timerKey, setTimeout(async () => {
			this._invoiceSearch.delete(timerKey);
			try {
				const online = await networkService.isOnline();
				const found = await this.syncService.recordSearch(model).search(await this.credsFor(cfg), text, { online });
				if (load !== this._targetsLoad || !still()) return;
				apply(found.records.map((r) => ({ value: String(r.id), name: r.name })));
			} catch {
				// The field keeps its options; the push validates on the server
			}
		}, 300));
	}

	searchInvoiceProducts(cfg: SyncConfig, key: string, text: string) {
		const line = () => this.invoiceDraft(cfg.id)?.lines.find((l) => l.key === key);
		const current = line();
		if (!current) return;
		current.productQuery = text;
		this.searchInvoice(cfg, `${cfg.id}|${key}`, INVOICE_PRODUCT_MODEL, text, () => line()?.productQuery === text, (options) => {
			const target = line()!;
			const kept = target.products.find((o) => o.value === target.productSelection);
			target.products = kept && !options.some((o) => o.value === kept.value) ? [kept, ...options] : options;
		});
	}

	searchInvoiceExtra(cfg: SyncConfig, field: FormField, text: string) {
		const draft = this.invoiceDraft(cfg.id);
		if (!draft || !field.relation) return;
		draft.extraQueries[field.name] = text;
		this.searchInvoice(cfg, `${cfg.id}|x|${field.name}`, field.relation, text,
			() => this.invoiceDraft(cfg.id)?.extraQueries[field.name] === text, (options) => {
				const target = this.invoiceDraft(cfg.id)!;
				const selected = target.extraValues[field.name];
				const kept = (target.extraOptions[field.name] ?? []).find((o) => o.value === selected);
				target.extraOptions[field.name] = kept && !options.some((o) => o.value === kept.value) ? [kept, ...options] : options;
			});
	}

	/**
	 * Fills state.targets for configs (see buildTargetRows). A server that
	 * can receive nothing (every kind unusable or failed) is unselected.
	 * Rows of a load superseded by a newer one, or of a note left
	 * meanwhile, are dropped.
	 */
	private async loadTaskTargets(configs: SyncConfig[]) {
		const load = ++this._targetsLoad;
		const noteId = this.state.noteId;
		const online = await networkService.isOnline();
		const firstDate = this.state.note.entries.find((e: NoteEntry) => e.type === "date");
		const noteDay = localDay(firstDate ? (firstDate.params as NoteEntryDateParams).date : null);
		const today = localDay(new Date().toISOString())!;
		await Promise.all(configs.map(async (cfg) => {
			const creds = () => this.credsFor(cfg);
			const [rows, section, companies] = await Promise.all([
				buildTargetRows(this.syncService, noteId, cfg.id, creds, online),
				buildActivitySection(this.syncService, noteId, cfg.id, creds, online, noteDay, today),
				creds().then((c) => this.syncService.serverCompanies(c, { online })).catch(() => ({ companies: [], last: null })),
			]);
			if (load !== this._targetsLoad || this.state.noteId !== noteId) return;
			this.state.companies[cfg.id] = {
				list: companies.companies,
				selection: companies.last ?? companies.companies[0]?.id ?? null,
			};
			this.state.targets[cfg.id] = rows;
			this.state.activities[cfg.id] = section;
			for (const row of section.rows) {
				if (row.status !== "choose") continue;
				this.searchActivityRecords(cfg, row.key, "", 0);
				if (row.kind === "activity") this.searchActivityUsers(cfg, row.key, "", 0);
			}
			if (!serverUsable(rows, sectionHasWork(section) || canAddActivity(section))) {
				this.state.selectedConfigIds = this.state.selectedConfigIds.filter((id: string) => id !== cfg.id);
			}
		}));
	}

	// ── Activities in the picker ────────────────────────────────────────────

	isActivityEditable(row: ActivityRow): boolean {
		return isEditable(row);
	}

	canDeferActivityRecord(section: ActivitySection, row: ActivityRow): boolean {
		return canDeferRecord(section, row);
	}

	activityTypeOptions(section: ActivitySection, row: ActivityRow): ActivityTypeChoice[] {
		return rowTypes(section, row);
	}

	canAddAttached(section: ActivitySection, kind: AttachedKind): boolean {
		return canAddActivity(section, kind);
	}

	/** A model's name, with why the server cannot take an activity (or a message, kind) on it. */
	activityModelLabel(option: ModelOption, kind: AttachedKind): string {
		const name = this.t(`label.sync_activity_model_${option.model.replace(/\./g, "_")}`);
		const unusable = option.unusable[kind];
		return unusable ? `${name} — ${this.t("label.sync_target_unusable_" + unusable)}` : name;
	}

	/** A record option's name; the note's own task or opportunity is named as such. */
	activityRecordLabel(section: ActivitySection, row: ActivityRow, option: ProjectOption): string {
		const own = section.shortcuts.find((s) => s.model === rowModel(row) && String(s.resId) === option.value);
		return own ? this.t(`label.sync_activity_this_${own.kind}`, { id: own.resId }) : option.name;
	}

	/** One line describing an activity the note has (type, record, deadline, user), or a message (record). */
	activitySummary(section: ActivitySection, row: ActivityRow): string {
		const t = row.target;
		const own = section.shortcuts.find((s) => s.model === t.resModel && s.resId === t.resId);
		const record = own ? this.t(`label.sync_activity_this_${own.kind}`, { id: own.resId })
			: t.resName || `${t.resModel} #${t.resId ?? "?"}`;
		if (row.kind === "message") return record;
		return [
			t.typeName || this.t("label.sync_activity_type_default"),
			record,
			t.deadline,
			t.userName || this.t("label.sync_activity_user_me"),
		].filter(Boolean).join(" · ");
	}

	private activityRow(configId: string, key: string): { section: ActivitySection; index: number } | null {
		const section = this.state.activities[configId];
		const index = section?.rows.findIndex((r) => r.key === key) ?? -1;
		return index >= 0 ? { section, index } : null;
	}

	/** Bumped by each new draft, for its key. */
	private _activityDrafts = 0;

	/**
	 * A note the calendar just created for a day (see
	 * ActivityCalendarComponent.newNoteOn) opens the sync picker with an
	 * activity due that day, on the first selected server.
	 */
	private async consumeCalendarHandoff() {
		let handoff: { noteId?: string; day?: string } | null = null;
		try {
			handoff = JSON.parse(sessionStorage.getItem(CALENDAR_HANDOFF_KEY) ?? "null");
		} catch {
			return;
		}
		if (!handoff || handoff.noteId !== this.state.noteId || !handoff.day) return;
		try { sessionStorage.removeItem(CALENDAR_HANDOFF_KEY); } catch { /* read once anyway */ }
		await this.openSyncPicker();
		const cfg = this.state.syncConfigs.find((c: SyncConfig) => this.state.selectedConfigIds.includes(c.id));
		if (!cfg || !this.state.showConfigPicker) return;
		// The note is for this activity: the kinds the picker checks by default
		// (those of the last note) and the other servers are left to the user
		for (const row of this.kindRows(cfg.id)) if (row.linkedResId === null) row.checked = false;
		this.state.selectedConfigIds = [cfg.id];
		this.addActivity(cfg, "activity");
		const rows = this.state.activities[cfg.id]?.rows ?? [];
		const draft = rows[rows.length - 1];
		if (draft?.status === "draft") {
			draft.deadline = handoff.day;
			draft.deadlineEdited = true;
		}
	}

	/** Adds a draft activity, or a draft message (kind), to a server's section. */
	addActivity(cfg: SyncConfig, kind: AttachedKind = "activity") {
		const section = this.state.activities[cfg.id];
		if (!section || section.loading || section.failed) return;
		const row = newDraftRow(section, `draft-${++this._activityDrafts}`, kind);
		section.rows.push(row);
		this.searchActivityRecords(cfg, row.key, "", 0);
		if (kind === "activity") this.searchActivityUsers(cfg, row.key, "", 0);
	}

	toggleActivityRemoved(configId: string, key: string) {
		const found = this.activityRow(configId, key);
		if (found) found.section.rows[found.index].removed = !found.section.rows[found.index].removed;
	}

	setActivityModel(cfg: SyncConfig, key: string, value: string) {
		const found = this.activityRow(cfg.id, key);
		if (!found) return;
		found.section.rows[found.index] = withModel(found.section, found.section.rows[found.index], value);
		this.searchActivityRecords(cfg, key, "", 0);
	}

	setActivityAdvancedModel(cfg: SyncConfig, key: string, value: string) {
		const found = this.activityRow(cfg.id, key);
		if (!found) return;
		const row = found.section.rows[found.index];
		found.section.rows[found.index] = withModel(found.section, { ...row, advancedModel: value }, row.model);
		this.searchActivityRecords(cfg, key, "");
	}

	setActivityType(configId: string, key: string, value: string) {
		const found = this.activityRow(configId, key);
		if (found) found.section.rows[found.index] = withType(found.section, found.section.rows[found.index], value);
	}

	setActivityDeadline(configId: string, key: string, value: string) {
		const found = this.activityRow(configId, key);
		if (!found) return;
		const row = found.section.rows[found.index];
		row.deadline = value;
		row.deadlineEdited = true;
	}

	setActivityField(configId: string, key: string, field: "recordSelection" | "userSelection", value: string) {
		const found = this.activityRow(configId, key);
		if (found) found.section.rows[found.index][field] = value;
	}

	/** Pending record or user search per picker row, run after the last keystroke. */
	private _activitySearch = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * Searches, online or in the cache, the records of a row's model (what)
	 * or the server's users, after delayMs; a result arriving after a newer
	 * keystroke, a change of model, or a rebuild of the picker is dropped.
	 */
	private searchActivity(cfg: SyncConfig, key: string, what: "records" | "users", text: string, delayMs: number) {
		const found = this.activityRow(cfg.id, key);
		if (!found) return;
		const row = found.section.rows[found.index];
		if (what === "records") row.recordQuery = text;
		else row.userQuery = text;
		const model = what === "records" ? rowModel(row) : USER_MODEL;
		if (!model) return;
		const timerKey = `${cfg.id}|${key}|${what}`;
		const pending = this._activitySearch.get(timerKey);
		if (pending) clearTimeout(pending);
		const load = this._targetsLoad;
		this._activitySearch.set(timerKey, setTimeout(async () => {
			this._activitySearch.delete(timerKey);
			const current = () => {
				const again = this.activityRow(cfg.id, key);
				if (load !== this._targetsLoad || !again) return null;
				const r = again.section.rows[again.index];
				const sameQuery = what === "records" ? r.recordQuery === text && rowModel(r) === model : r.userQuery === text;
				return sameQuery ? again : null;
			};
			try {
				const online = await networkService.isOnline();
				const result = await this.syncService.recordSearch(model).search(await this.credsFor(cfg), text, { online });
				const again = current();
				if (!again) return;
				const r = again.section.rows[again.index];
				again.section.rows[again.index] = what === "records" ? withRecords(again.section, r, result) : withUsers(r, result);
			} catch (e: unknown) {
				const again = current();
				if (again && what === "records") again.section.rows[again.index].recordsError = e instanceof Error ? e.message : String(e);
			}
		}, delayMs));
	}

	searchActivityRecords(cfg: SyncConfig, key: string, text: string, delayMs = 300) {
		this.searchActivity(cfg, key, "records", text, delayMs);
	}

	searchActivityUsers(cfg: SyncConfig, key: string, text: string, delayMs = 300) {
		this.searchActivity(cfg, key, "users", text, delayMs);
	}

	/** Credentials of a sync target, from its application. */
	private async credsFor(cfg: SyncConfig): Promise<SyncCredentials> {
		const apps = await this.appService.getApps();
		const app = apps.find((a) => a.url === cfg.appUrl && a.username === cfg.appUsername);
		if (!app) throw new Error("Application Odoo introuvable.");
		return {
			odooUrl: cfg.appUrl,
			username: app.username,
			password: app.password,
			database: cfg.database,
		};
	}

	/** Close whichever overlay is open when the user presses Escape. */
	private _onKeydownEscape(ev: KeyboardEvent) {
		if (ev.key !== "Escape") return;
		if (this.state.priorityPicker.visible) { ev.preventDefault(); this.closePriorityPicker(); }
		else if (this.state.errorDialog.visible) { ev.preventDefault(); this.closeErrorDialog(); }
		else if (this.state.openInApp.visible) { ev.preventDefault(); this.closeOpenInApp(); }
		else if (this.state.showConfigPicker) { ev.preventDefault(); this.cancelConfigPick(); }
		else if (this.state.showOptionsMenu) { ev.preventDefault(); this.state.showOptionsMenu = false; }
		else if (this.state.debugDialog.visible) { ev.preventDefault(); this.closeDebugDialog(); }
	}

	private announceSyncStatus(status: string, offline = false) {
		const messages: Record<string, string> = {
			synced:  "Note synchronisée.",
			error:   "Erreur de synchronisation.",
			pending: offline
				? "Synchronisation en attente — hors ligne."
				: "Synchronisation en attente.",
		};
		this.state.syncAnnouncement = messages[status] ?? "";
		// Clear after screen reader has time to read it
		setTimeout(() => { this.state.syncAnnouncement = ""; }, 3000);
	}

	async pushToOdoo() {
		if (this.state.isSyncing || this.state.newNote || this.state.showConfigPicker) return;
		// A conflict is settled first: nothing is sent to its server before
		if (this.state.syncStatus === "conflict" && await this.openConflictDialog()) return;

		// Configs are local: the server choice is made, and kept, even offline
		const configs = await loadSyncConfigs(this.appService);
		this.state.syncConfigs = configs;

		if (configs.length === 0) {
			await Dialog.alert({ message: "Configurez la synchronisation dans les options." });
			return;
		}

		// Use remembered selection if still valid, else the single config
		let selected = configs.filter((c) => this.state.selectedConfigIds.includes(c.id));
		if (selected.length === 0 && configs.length === 1) selected = [configs[0]];
		if (selected.length > 0) {
			this.state.selectedConfigIds = selected.map((c) => c.id);
			// A server where the note has no task yet: its project is chosen first
			if (await needsTaskTarget(this.syncService, this.state.noteId, selected.map((c) => c.id))) {
				await this.showPicker(configs);
				return;
			}
			await this.doPushSelected(selected);
			return;
		}

		// Multiple configs, no selection yet → show picker (pre-select all)
		this.state.selectedConfigIds = configs.map((c) => c.id);
		await this.showPicker(configs);
	}


	toggleConfigSelection(id: string, checked: boolean) {
		if (checked) {
			if (!this.state.selectedConfigIds.includes(id)) {
				this.state.selectedConfigIds = [...this.state.selectedConfigIds, id];
			}
		} else {
			this.state.selectedConfigIds = this.state.selectedConfigIds.filter((x) => x !== id);
		}
	}

	/**
	 * Records the picker's choices, then pushes. A second tap while they are
	 * being recorded does nothing: each draft activity would otherwise be
	 * queued twice, as two activities on the server.
	 */
	async confirmConfigSelection() {
		if (this.pickerLoading || this.state.confirming) return;
		const selected = this.state.syncConfigs.filter((c) => this.state.selectedConfigIds.includes(c.id));
		if (selected.length === 0) return;
		const ids = selected.map((c) => c.id);
		this.state.confirming = true;
		try {
			const work = (id: string) => sectionHasWork(this.state.activities[id]);
			const activities = planActivities(this.syncService, this.state.noteId, ids, this.state.activities);
			// The server's company choice first: a creation drained before the next step takes it
			for (const id of ids) {
				const company = this.state.companies[id];
				if (company && company.list.length > 1 && company.selection !== null) {
					await this.syncService.setCreationCompany(this.state.noteId, id, company.selection);
				}
			}
			await applyTaskTargets(this.syncService, this.state.noteId, ids, this.state.targets, work);
			for (const record of activities) await record();
			// The company chosen, where the user has several, goes to every new record of the note there
			for (const id of ids) {
				const company = this.state.companies[id];
				if (company && company.list.length > 1 && company.selection !== null) {
					await this.syncService.setCreationCompany(this.state.noteId, id, company.selection);
				}
			}
		} catch (e: unknown) {
			this.showErrorDialog(e instanceof Error ? e.message : String(e));
			return;
		} finally {
			this.state.confirming = false;
		}
		this.state.showConfigPicker = false;
		await this.saveSyncSelection(this.state.selectedConfigIds);
		await this.doPushSelected(selected);
	}

	cancelConfigPick() {
		this.state.showConfigPicker = false;
	}

	/**
	 * Set by doPushCore when the user agreed to recreate a task deleted on
	 * the server: the picker opens once the push is over, to choose the
	 * project it is recreated in.
	 */
	private _pickAfterSync = false;

	private async doPushSelected(configs: SyncConfig[]) {
		if (!(await networkService.isOnline())) {
			await this.queueForReconnect(configs);
			return;
		}
		if (configs.length === 1) {
			await this.doPush(configs[0]);
		} else {
			await this.doPushAll(configs);
		}
		if (this._pickAfterSync) {
			this._pickAfterSync = false;
			await this.showPicker(this.state.syncConfigs);
		}
	}

	/** Offline: the note waits, per server, for syncAll on reconnect. */
	private async queueForReconnect(configs: SyncConfig[]) {
		// A server whose task was deleted, and no recreation chosen in the
		// picker, needs the online recreate prompt, and one whose creation is
		// blocked (ambiguous) needs the user's choice online:
		// queued, either would only wait again on reconnect. A creation left
		// "incomplete" (project to choose later) is pending: the next online
		// tap opens the picker for it
		const queued: SyncConfig[] = [];
		const deleted: SyncConfig[] = [];
		const blocked: SyncConfig[] = [];
		for (const cfg of configs) {
			let pushable = false;
			for (const kind of await this.syncService.noteKinds(this.state.noteId, cfg.id)) {
				const link = await this.databaseService.findNoteLink(this.state.noteId, cfg.id, KINDS[kind].model, "create", true);
				const op = link?.remoteState === "ok"
					? null
					: await this.syncService.outbox.find(this.state.noteId, cfg.id, KINDS[kind].opKind);
				if (op?.status === "blocked") { if (!blocked.includes(cfg)) blocked.push(cfg); }
				else if (link?.remoteState === "deleted" && !op) { if (!deleted.includes(cfg)) deleted.push(cfg); }
				else pushable = true;
			}
			// An activity or message live or queued waits for the network; a blocked one for the user
			for (const activity of await this.syncService.attachedStates(this.state.noteId, cfg.id)) {
				if (activity.state === "linked" || activity.state === "choose") pushable = true;
				else if (activity.state === "queued") {
					if (activity.op.status === "blocked") { if (!blocked.includes(cfg)) blocked.push(cfg); }
					else pushable = true;
				}
			}
			if (pushable) queued.push(cfg);
		}
		if (deleted.length > 0) {
			await Dialog.alert({
				title: "Enregistrement supprimé sur le serveur",
				message: "Un enregistrement lié a été supprimé sur : "
					+ deleted.map((c) => c.name || c.appUrl).join(", ")
					+ ".\nSynchronisez en ligne pour la recréer.",
			});
		}
		if (blocked.length > 0) {
			await Dialog.alert({
				title: "Création en attente d'un choix",
				message: "Une création attend votre décision sur : "
					+ blocked.map((c) => c.name || c.appUrl).join(", ")
					+ ".\nSynchronisez en ligne pour la terminer.",
			});
		}
		if (queued.length === 0) return;
		await this.databaseService.markNotePendingForConfigs(this.state.noteId, queued.map((c) => c.id));
		this.state.syncStatus = "pending";
		this.announceSyncStatus("pending", true);
	}

	/** Reflects the global status pushNote derived from every server. */
	private async refreshSyncStatusFromDb(): Promise<string> {
		const { syncStatus } = await this.databaseService.getNoteSyncInfo(this.state.noteId);
		this.state.syncStatus = syncStatus;
		return syncStatus;
	}

	/**
	 * Pushes the note to one server on a tap and settles what needs the
	 * user: a kind left to choose later marks the server pending; an
	 * ambiguous creation asks which record to link, then pushes again with
	 * it, so the next failure is handled the same way (at most once per
	 * kind and activity); a record deleted on the server asks whether to recreate it,
	 * through the picker. Any other failure is raised. Returns whether the
	 * push ended normally (pushEach pushes only such a server again).
	 */
	private async doPushCore(cfg: SyncConfig): Promise<boolean> {
		const creds = await this.credsFor(cfg);
		let options: PushOptions = { userInitiated: true };
		const attached = (await this.syncService.attachedStates(this.state.noteId, cfg.id))
			.filter((a) => a.state === "queued" || a.state === "choose");
		for (let round = 0; round <= TARGET_KINDS.length + attached.length; round++) {
			try {
				await this.syncService.pushNote(creds, this.state.noteId, options);
				return true;
			} catch (e: unknown) {
				// Left to choose later: the creation waits, it has not failed;
				// pending, as the same choice made offline (queueForReconnect)
				if (e instanceof OutboxBlockedError && e.reason === "incomplete") {
					await this.databaseService.markNotePendingForConfigs(this.state.noteId, [cfg.id]);
					return false;
				}
				if (e instanceof OutboxBlockedError && e.reason === "ambiguous" && e.candidates.length > 0) {
					options = { userInitiated: true, adopt: await this.pickAmbiguousRecord(e) };
					continue;
				}
				// Changed in the app and on the server: the user chooses before anything is sent
				if (e instanceof SyncConflictError) {
					await this.databaseService.refreshNoteSyncStatus(this.state.noteId);
					await this.openConflictDialog();
					return false;
				}
				if (!(e instanceof RemoteRecordDeletedError)) throw e;
				// Deleted on the server: recreated only on the user's say-so, with
				// the choices the picker then asks for
				const { value } = await Dialog.confirm({
					title: "Enregistrement supprimé sur le serveur",
					message: `${e.message}\nLe recréer à partir de cette note ? Vous choisirez sa cible.`,
				});
				if (value) this._pickAfterSync = true;
				return false;
			}
		}
		throw new Error("Création toujours bloquée : plusieurs enregistrements correspondent encore.");
	}

	/**
	 * Several records carry this note's reference on the server: the user
	 * picks the one to link, by number; cancelling leaves the creation
	 * blocked and raises. The error's opKind says which kind of record (a
	 * task when unknown); for an activity or a message, its opId which
	 * creation.
	 */
	private async pickAmbiguousRecord(e: OutboxBlockedError): Promise<NonNullable<PushOptions["adopt"]>> {
		const ids = e.candidates;
		const kind = e.opKind === ACTIVITY_CREATE ? "activity"
			: e.opKind === MESSAGE_POST ? "message"
			: TARGET_KINDS.find((k) => KINDS[k].opKind === e.opKind) ?? "task";
		const { value, cancelled } = await Dialog.prompt({
			title: "Plusieurs enregistrements correspondent",
			message: `${e.message}\nNuméro de l'enregistrement à lier à cette note (${ids.map((id) => `#${id}`).join(", ")}) :`,
			inputText: String(ids[0]),
		});
		const picked = Number(String(value ?? "").replace(/^#/, "").trim());
		if (cancelled || !ids.includes(picked)) {
			throw new Error(`Création bloquée : aucun enregistrement choisi parmi ${ids.map((id) => `#${id}`).join(", ")}.`);
		}
		return { kind, resId: picked, ...(e.opId ? { opId: e.opId } : {}) };
	}

	private async doPush(cfg: SyncConfig) {
		this.state.isSyncing = true;
		try {
			await this.syncService.pushEach(this.state.noteId, [cfg.id], () => this.doPushCore(cfg));
			await this.databaseService.setNoteSyncInfo(this.state.noteId, { syncConfigId: cfg.id });
			this.state.syncConfigId = cfg.id;
			this.announceSyncStatus(await this.refreshSyncStatusFromDb());
		} catch (e: unknown) {
			await this.databaseService.setNotePerServerStatus(this.state.noteId, cfg.id, "error").catch(() => {});
			await this.databaseService.refreshNoteSyncStatus(this.state.noteId).catch(() => {});
			this.state.syncStatus = "error";
			this.announceSyncStatus("error");
			const msg = e instanceof Error ? e.message : String(e);
			this.showErrorDialog(`Erreur sync :\n${msg}`);
		} finally {
			this.state.isSyncing = false;
		}
	}

	private async doPushAll(configs: SyncConfig[]) {
		this.state.isSyncing = true;
		const errors: string[] = [];
		await this.syncService.pushEach(this.state.noteId, configs.map((c) => c.id), async (configId) => {
			const cfg = configs.find((c) => c.id === configId)!;
			try {
				return await this.doPushCore(cfg);
			} catch (e: unknown) {
				await this.databaseService.setNotePerServerStatus(this.state.noteId, cfg.id, "error").catch(() => {});
				await this.databaseService.refreshNoteSyncStatus(this.state.noteId).catch(() => {});
				errors.push(`${cfg.name || cfg.appUrl}: ${e instanceof Error ? e.message : String(e)}`);
				return false;
			}
		});
		this.state.isSyncing = false;
		if (errors.length > 0) {
			this.state.syncStatus = "error";
			this.announceSyncStatus("error");
			const msg = errors.join("\n");
			this.showErrorDialog(`Erreurs sync :\n${msg}`);
		} else {
			this.announceSyncStatus(await this.refreshSyncStatusFromDb());
		}
	}

	// ── Conflict dialog ─────────────────────────────────────────────────────

	/** Opens the conflict dialog when the note has conflicts; returns whether it did. */
	async openConflictDialog(): Promise<boolean> {
		const conflicts = await this.syncService.conflictsOf(this.state.noteId);
		if (conflicts.length === 0) return false;
		const configs = this.state.syncConfigs.length > 0 ? this.state.syncConfigs : await loadSyncConfigs(this.appService);
		this.state.conflictDialog.items = conflicts.map((c) => ({
			linkId: c.linkId,
			label: `${configs.find((cfg: SyncConfig) => cfg.id === c.configId)?.name || c.configId} — ${c.model} #${c.resId}`,
			rows: (Object.entries(c.fields) as Array<[string, { mine: any; theirs: any }]>).map(([field, v]) => ({
				field, mine: conflictText(v.mine), theirs: conflictText(v.theirs), choice: "mine" as const,
			})),
		}));
		this.state.conflictDialog.visible = true;
		return true;
	}

	setConflictChoice(linkId: string, field: string, choice: "mine" | "theirs") {
		const row = this.state.conflictDialog.items.find((i: ConflictItem) => i.linkId === linkId)
			?.rows.find((r) => r.field === field);
		if (row) row.choice = choice;
	}

	closeConflictDialog() {
		this.state.conflictDialog.visible = false;
	}

	/**
	 * Settles every conflict with the choices made, reloads the note (the
	 * server's values chosen are in it now), then pushes it: the values kept
	 * from the app reach the server.
	 */
	async confirmConflicts() {
		if (this.state.conflictDialog.saving) return;
		this.state.conflictDialog.saving = true;
		try {
			for (const item of this.state.conflictDialog.items as ConflictItem[]) {
				const choices = Object.fromEntries(item.rows.map((r) => [r.field, r.choice]));
				await this.syncService.resolveConflict(this.state.noteId, item.linkId, choices);
			}
			this.state.conflictDialog.visible = false;
			await this.reloadPulledFields();
			await this.refreshSyncStatusFromDb();
		} catch (e: unknown) {
			this.showErrorDialog(e instanceof Error ? e.message : String(e));
			return;
		} finally {
			this.state.conflictDialog.saving = false;
		}
		await this.pushToOdoo();
	}

	// ── Error dialog ────────────────────────────────────────────────────────

	showErrorDialog(message: string) {
		this.state.errorDialog.visible = true;
		this.state.errorDialog.message = message;
	}

	closeErrorDialog() {
		this.state.errorDialog.visible = false;
		this.state.errorDialog.message = "";
	}

	async copyErrorMessage() {
		try { await navigator.clipboard.writeText(this.state.errorDialog.message); } catch { /* unavailable */ }
	}

	async createErrorNote() {
		const note = this.noteService.getNewNote(this.noteService.getNewId());
		note.title = "Erreur d'exécution";
		const entry = this.noteService.entry.getNewTextEntry();
		(entry.params as NoteEntryTextParams).text = this.state.errorDialog.message;
		note.entries = [entry];
		await this.noteService.crud.add(note);
		this.closeErrorDialog();
		this.navigate(`/note/${encodeURIComponent(note.id)}`);
	}

	toggleOptionsMenu() {
		this.state.showOptionsMenu = !this.state.showOptionsMenu;
	}

	onDebugClick() {
		this.state.showOptionsMenu = false;
		const noteTitle = this.state.note?.title || "Nouvelle note";
		this.state.debugDialog = {
			visible: true,
			message: [
				`Vue       : Notes › ${noteTitle}`,
				`Composant : note_component.ts`,
				`Route     : /note/:id`,
			].join("\n"),
		};
	}

	closeDebugDialog() {
		this.state.debugDialog.visible = false;
	}

	async createDebugNote() {
		const message = this.state.debugDialog.message;
		this.state.debugDialog.visible = false;
		const note = this.noteService.getNewNote(this.noteService.getNewId());
		note.title = "Debug";
		const entry = this.noteService.entry.getNewTextEntry();
		(entry.params as NoteEntryTextParams).text = message;
		note.entries = [entry];
		await this.noteService.crud.add(note);
		this.navigate(`/note/${encodeURIComponent(note.id)}`);
	}

	async onMetadataClick() {
		this.state.showOptionsMenu = false;
		try {
			const row = await this.databaseService.getNoteRawData(this.state.noteId);
			if (!row) {
				await Dialog.alert({ title: "Métadonnées", message: "Note introuvable en base." });
				return;
			}
			const fmt = (v: any) => {
				if (v === null || v === undefined) return "(null)";
				if (typeof v === "string" && v.length > 80) return v.slice(0, 80) + "…";
				return String(v);
			};
			const lines = [
				"── Note ──",
				`id:                      ${fmt(row.id)}`,
				`title:                   ${fmt(row.title)}`,
				`date:                    ${fmt(row.date)}`,
				`done:                    ${fmt(row.done)}`,
				`archived:                ${fmt(row.archived)}`,
				`pinned:                  ${fmt(row.pinned)}`,
				`tags:                    ${fmt(row.tags)}`,
				`entries:                 ${fmt(row.entries)}`,
				"",
				"── Synchronisation ──",
				`odoo_id:                 ${fmt(row.odoo_id)}`,
				`odoo_url:                ${fmt(row.odoo_url)}`,
				`sync_status:             ${fmt(row.sync_status)}`,
				`last_synced_at:          ${fmt(row.last_synced_at)}`,
				`sync_config_id:          ${fmt(row.sync_config_id)}`,
				`selected_sync_config_ids:${fmt(row.selected_sync_config_ids)}`,
				`sync_per_server_status:  ${fmt(row.sync_per_server_status)}`,
				"",
				"── Liens distants (note_links) ──",
				...(await this.databaseService.getNoteLinks(this.state.noteId).catch(() => []))
					.map((l) => `${l.configId} → ${l.model} #${l.resId} (${l.kind}, ${l.lastSyncedAt ?? "jamais"})`),
			];
			const message = lines.join("\n");
			try { await navigator.clipboard.writeText(message); } catch { /* clipboard unavailable */ }
			await Dialog.alert({ title: "Métadonnées SQL", message });
		} catch (e: unknown) {
			await Dialog.alert({ title: "Métadonnées", message: String(e) });
		}
	}

	// ── Priority picker ──────────────────────────────────────────────────────

	onPriorityClick() {
		this.state.priorityPicker.visible = true;
	}

	closePriorityPicker() {
		this.state.priorityPicker.visible = false;
	}

	async setPriority(p: 1 | 2 | 3 | 4 | undefined) {
		this.state.note.priority = p;
		this.state.priorityPicker.visible = false;
		await this.saveNoteData();
	}

	// ── Open in app ─────────────────────────────────────────────────────────

	closeOpenInApp() {
		this.state.openInApp.visible = false;
	}

	async onOpenInAppClick() {
		const links = (await this.databaseService.getNoteLinks(this.state.noteId))
			.filter((l) => l.kind === "create" && l.remoteState === "ok");
		if (links.length === 0) {
			await Dialog.alert({ message: "Cette note n'a pas encore été synchronisée avec une application." });
			return;
		}

		const apps = await this.appService.getApps();
		const appItems = links.flatMap((link) => {
			const app = apps.find((a) => syncConfigIdFor(a.url, a.username, a.database) === link.configId);
			if (!app) return [];
			const kind = TARGET_KINDS.find((k) => KINDS[k].model === link.model);
			return [{
				label: `${kind ? this.t("label.sync_kind_" + kind) : link.model} #${link.resId} — ${app.url}`,
				appUrl: app.url, username: app.username, password: app.password,
				model: link.model, resId: link.resId,
			}];
		});

		if (appItems.length === 0) {
			await Dialog.alert({ message: "Applications introuvables dans la liste." });
			return;
		}

		if (appItems.length === 1) {
			await this.openInAppForConfig(appItems[0]);
			return;
		}

		this.state.openInApp.apps = appItems;
		this.state.openInApp.visible = true;
	}

	async openInAppForConfig(app: OpenInAppItem) {
		this.state.openInApp.visible = false;
		await openRecordInApp(app);
	}

	get currentIndex(): number {
		return this.state.allNoteIds.indexOf(this.state.noteId);
	}

	get hasPrevious(): boolean {
		return this.currentIndex > 0;
	}

	get hasNext(): boolean {
		const idx = this.currentIndex;
		return idx !== -1 && idx < this.state.allNoteIds.length - 1;
	}

	navigatePrevious() {
		if (!this.hasPrevious) return;
		const prevId = this.state.allNoteIds[this.currentIndex - 1];
		this.navigate(`/note/${encodeURIComponent(prevId)}`);
	}

	navigateNext() {
		if (!this.hasNext) return;
		const nextId = this.state.allNoteIds[this.currentIndex + 1];
		this.navigate(`/note/${encodeURIComponent(nextId)}`);
	}

	onBackToNotesClick() {
		this.navigate("/notes");
	}

	addAudio() {
		const newEntry = this.noteService.entry.getNewAudioEntry();
		this.state.note.entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
	}

	addDateEntry() {
		const newEntry = this.noteService.entry.getNewDateEntry();

		const params = newEntry.params as NoteEntryDateParams;

		params.date = (new Date()).toISOString();

		const entries: Array<NoteEntry> = this.state.note.entries;

		entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
	}

	async addLocation() {
		const permissions = await this.getGeolocationPermissions();

		if (!permissions || permissions.location === "denied") {
			return;
		}

		const currentPosition: Position = await Geolocation.getCurrentPosition();
		const newEntry = this.noteService.entry.getNewGeolocationEntry();

		newEntry.params = {
			text: "Données de géolocalisation",
			latitude: currentPosition.coords.latitude,
			longitude: currentPosition.coords.longitude,
			timestamp: currentPosition.timestamp
		};

		this.state.note.entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
	}

	async addPhoto() {
		const newEntry = this.noteService.entry.getNewPhotoEntry();
		this.state.note.entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
		await this.takePhoto(newEntry.id);
	}

	/** Pick an image from the device gallery (CameraSource.Photos) and
	 *  attach it to a fresh photo entry. Same shape as addPhoto but
	 *  skips the camera viewfinder — useful for a screenshot or an
	 *  image already on the phone. */
	async addImage() {
		const newEntry = this.noteService.entry.getNewPhotoEntry("gallery");
		this.state.note.entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
		await this.pickImage(newEntry.id);
	}

	async pickImage(entryId: string) {
		try {
			const photo = await Camera.getPhoto({
				quality: 90,
				allowEditing: false,
				resultType: CameraResultType.Uri,
				source: CameraSource.Photos,
			});
			if (!photo.path) return;
			this.eventBus.trigger(Events.SET_PHOTO, { entryId, path: photo.path });
		} catch {
			// User cancelled — nothing to do
		}
	}

	addText() {
		this.state.note.entries.push(this.noteService.entry.getNewTextEntry());
		this.saveNoteData();
		this.focusLastEntry();
	}

	addVideo() {
		const newEntry = this.noteService.entry.getNewVideoEntry();
		this.state.note.entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
		this.eventBus.trigger(Events.OPEN_CAMERA, { entryId: newEntry.id });
	}

	async deleteEntry(entryId: string) {
		const isBiometricAuthSuccessful: boolean = await BiometryUtils.authenticateIfAvailable();

		if (!isBiometricAuthSuccessful) {
			Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
			return;
		}

		const entries: Array<NoteEntry> = this.state.note.entries;
		const entryIndex = entries.findIndex(entry => entry.id === entryId);

		if (entryIndex === -1) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		entries.splice(entryIndex, 1);
		this.saveNoteData();
	}

	toggleEditMode() {
		this.state.editMode = !this.state.editMode;
	}

	toggleOptionMode() {
		this.state.optionMode = !this.state.optionMode;
	}

	onTagsClick() {
		this.eventBus.trigger(Events.TAG_MANAGER, { noteId: this.state.noteId });
	}

	onArchiveClick() {
		this.state.note.archived = !this.state.note.archived;
		this.saveNoteData();
	}

	onPinClick() {
		this.state.note.pinned = !this.state.note.pinned;
		this.saveNoteData();
	}

	setEntryDate(entryId: string, date: string) {
		let entry: NoteEntry | undefined;

		try {
			entry = this.getEntry(entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!entry) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		if (entry.type !== "date") {
			return;
		}

		const params = entry.params as NoteEntryDateParams;

		params.date = date;
		this.saveNoteData();
	}

	toggleDone() {
		this.state.note.done = !this.state.note.done;
		this.saveNoteData();
	}

	async saveNoteData() {
		try {
			if (this.state.newNote) {
				await this.noteService.crud.add(this.state.note);
				this.state.newNote = false;
			} else {
				// An edit marks the note pending on its servers: the indicator reads it back
				await this.noteService.crud.edit(this.state.noteId, this.state.note);
				await this.refreshSyncStatusFromDb();
			}
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}
	}

	private async saveSyncSelection(ids: string[]): Promise<void> {
		await this.databaseService.setNoteSyncInfo(this.state.noteId, { selectedSyncConfigIds: ids });
	}

	private async loadSyncStatus() {
		if (!this.state.noteId) return;
		const info = await this.databaseService.getNoteSyncInfo(this.state.noteId);
		this.state.syncStatus = info.syncStatus;
		this.state.syncConfigId = info.syncConfigId;
		this.state.syncConfigs = await loadSyncConfigs(this.appService);
		if (info.selectedSyncConfigIds && info.selectedSyncConfigIds.length > 0) {
			const validIds = info.selectedSyncConfigIds.filter((id) => this.state.syncConfigs.some((c) => c.id === id));
			if (validIds.length > 0) this.state.selectedConfigIds = validIds;
		}
	}

	private async loadAllNoteIds() {
		const notes = await this.noteService.getNotes();
		this.state.allNoteIds = notes.map(n => n.id);
	}

	private setParams() {
		const params = this.router.getRouteParams(window.location.pathname);
		this.state.noteId = decodeURIComponent(params?.get("id") || "");
	}

	private async getNote() {
		try {
			this.state.note = await this.noteService.getMatch(this.state.noteId);
		} catch (error: unknown) {
			if (error instanceof NoteKeyNotFoundError || error instanceof UndefinedNoteListError) {
				Dialog.alert({ message: error.message });
				return;
			} else if (error instanceof NoNoteMatchError && this.noteService.isValidId(this.state.noteId)) {
				this.state.newNote = true;
				this.state.note = this.noteService.getNewNote(this.state.noteId);
				this.state.note.date = (new Date()).toISOString();
			}
		}
	}

	/** Copies the fields a pull writes (see SyncService.pullTasks) into state. */
	private async reloadPulledFields() {
		const stored = await this.databaseService.getNoteById(this.state.noteId);
		if (!stored) return;
		this.state.note.title = stored.title;
		this.state.note.pinned = stored.pinned;
		this.state.note.archived = stored.archived;
		this.state.note.done = stored.done;
		// A pull merges text, tags and the date too
		this.state.note.tags = stored.tags;
		this.state.note.entries = stored.entries;
		await this.loadSyncStatus();
	}

	private listenForEvents() {
		const onAudio          = this.setAudioRecording.bind(this);
		const onVideo          = this.setVideoRecording.bind(this);
		const onPhoto          = this.setPhoto.bind(this);
		const onTranscription  = this.addTranscriptionText.bind(this);
		const onSetTranscript  = this.setEntryTranscription.bind(this);
		const onSetTranslation = this.setEntryTranslation.bind(this);
		const onTagsUpdated    = (e: any) => {
			if (e?.detail?.noteId === this.state.noteId) {
				this.state.note.tags = e?.detail?.tagIds ?? [];
				// The tag manager saved them, marking the note pending
				void this.refreshSyncStatusFromDb();
			}
		};
		// Stream Deck remote-add: keys 1-3 fire while a note page is
		// mounted. Reuse the same handlers the bottom-controls bar
		// uses so the deck and the on-screen buttons stay equivalent.
		// A pull changed this note: take the server's fields, so the next
		// save does not write the older copy held here back over them
		const onNotePulled      = (e: any) => {
			if (e?.detail?.noteId === this.state.noteId) void this.reloadPulledFields();
		};
		const onDeckAddVideo    = () => { void this.addVideo(); };
		const onDeckAddAudio    = () => { void this.addAudio(); };
		const onDeckAddLocation = () => { void this.addLocation(); };

		this.eventBus.addEventListener(Events.SET_AUDIO_RECORDING,    onAudio);
		this.eventBus.addEventListener(Events.SET_VIDEO_RECORDING,    onVideo);
		this.eventBus.addEventListener(Events.SET_PHOTO,              onPhoto);
		this.eventBus.addEventListener(Events.ADD_TRANSCRIPTION_TEXT, onTranscription);
		this.eventBus.addEventListener(Events.SET_ENTRY_TRANSCRIPTION, onSetTranscript);
		this.eventBus.addEventListener(Events.SET_ENTRY_TRANSLATION,   onSetTranslation);
		this.eventBus.addEventListener(Events.NOTE_TAGS_UPDATED,       onTagsUpdated);
		this.eventBus.addEventListener(Events.NOTE_PULLED,             onNotePulled);
		this.eventBus.addEventListener(Events.STREAMDECK_ADD_VIDEO,    onDeckAddVideo);
		this.eventBus.addEventListener(Events.STREAMDECK_ADD_AUDIO,    onDeckAddAudio);
		this.eventBus.addEventListener(Events.STREAMDECK_ADD_LOCATION, onDeckAddLocation);

		// Tell the StreamDeckController this page is mounted so it
		// paints keys 1-3. The matching false fires on willDestroy.
		this.eventBus.trigger(Events.STREAMDECK_NOTE_PAGE_ACTIVE, { active: true });

		onWillDestroy(() => {
			this.eventBus.removeEventListener(Events.SET_AUDIO_RECORDING,    onAudio);
			this.eventBus.removeEventListener(Events.SET_VIDEO_RECORDING,    onVideo);
			this.eventBus.removeEventListener(Events.SET_PHOTO,              onPhoto);
			this.eventBus.removeEventListener(Events.ADD_TRANSCRIPTION_TEXT, onTranscription);
			this.eventBus.removeEventListener(Events.SET_ENTRY_TRANSCRIPTION, onSetTranscript);
			this.eventBus.removeEventListener(Events.SET_ENTRY_TRANSLATION,   onSetTranslation);
			this.eventBus.removeEventListener(Events.NOTE_TAGS_UPDATED,       onTagsUpdated);
			this.eventBus.removeEventListener(Events.NOTE_PULLED,             onNotePulled);
			this.eventBus.removeEventListener(Events.STREAMDECK_ADD_VIDEO,    onDeckAddVideo);
			this.eventBus.removeEventListener(Events.STREAMDECK_ADD_AUDIO,    onDeckAddAudio);
			this.eventBus.removeEventListener(Events.STREAMDECK_ADD_LOCATION, onDeckAddLocation);
			this.eventBus.trigger(Events.STREAMDECK_NOTE_PAGE_ACTIVE, { active: false });
		});
	}

	private addTranscriptionText(event: any) {
		const { afterEntryId, text } = event?.detail ?? {};
		if (!text) return;

		const entries: NoteEntry[] = this.state.note.entries;
		const newTextEntry = this.noteService.entry.getNewTextEntry();
		(newTextEntry.params as NoteEntryTextParams).text = text;

		if (afterEntryId) {
			const idx = entries.findIndex(e => e.id === afterEntryId);
			if (idx !== -1) {
				entries.splice(idx + 1, 0, newTextEntry);
				this.saveNoteData();
				return;
			}
		}
		// fallback: append at end
		entries.push(newTextEntry);
		this.saveNoteData();
	}

	private async setEntryTranscription(event: any) {
		const { entryId, text } = event?.detail ?? {};
		if (!entryId || text == null) return;

		let entry: NoteEntry | undefined;
		try {
			entry = this.getEntry(entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
			}
			return;
		}

		if (!entry || (entry.type !== "audio" && entry.type !== "video")) return;

		(entry.params as NoteEntryAudioParams | NoteEntryVideoParams).transcription = text;
		await this.saveNoteData();
		await this.getNote();
	}

	private async setEntryTranslation(event: any) {
		const { entryId, translation, targetLang, field } = event?.detail ?? {};
		if (!entryId || translation == null) return;

		let entry: NoteEntry | undefined;
		try {
			entry = this.getEntry(entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
			}
			return;
		}
		if (!entry) return;

		if (field === "text" && entry.type === "text") {
			(entry.params as NoteEntryTextParams).translation     = translation;
			(entry.params as NoteEntryTextParams).translationLang = targetLang;
		} else if (field === "transcription" && (entry.type === "audio" || entry.type === "video")) {
			(entry.params as NoteEntryAudioParams | NoteEntryVideoParams).transcriptionTranslation     = translation;
			(entry.params as NoteEntryAudioParams | NoteEntryVideoParams).transcriptionTranslationLang = targetLang;
		} else {
			return;
		}

		await this.saveNoteData();
		await this.getNote();
	}

	private async setPhoto(event: any) {
		const details = event?.detail;

		if (!details?.entryId || !details?.path) {
			return;
		}

		let entry: NoteEntry | undefined;

		try {
			entry = this.getEntry(details.entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!entry || entry.type !== "photo") {
			return;
		}

		const params = entry.params as NoteEntryPhotoParams;
		params.path = details.path;

		await this.saveNoteData();
		await this.getNote();
	}

	private focusLastEntry() {
		this.eventBus.trigger(Events.FOCUS_LAST_ENTRY);
	}

	private scrollToLastEntry() {
		this.eventBus.trigger(Events.SCROLL_TO_LAST_ENTRY);
	}

	private getEntry(entryId: string): NoteEntry {
		const entryIndex = this.getEntryIndex(entryId);

		if (entryIndex === -1) {
			throw new NoNoteEntryMatchError();
		}

		const entries: Array<NoteEntry> = this.state.note.entries;

		const entry: NoteEntry | undefined = entries.at(entryIndex);

		if (!entry) {
			throw new NoNoteEntryMatchError();
		}

		return entry;
	}

	private getEntryIndex(entryId: string): number {
		const entries: Array<NoteEntry> = this.state.note.entries;
		return entries.findIndex(entry => entry.id === entryId);
	}

	private async getGeolocationPermissions(): Promise<PermissionStatus | undefined> {
		let permissions: PermissionStatus | undefined;

		try {
			permissions = await Geolocation.checkPermissions();
		} catch (error: unknown) {
			if (error instanceof Error) {
				return undefined;
			}
		}

		return permissions;
	}

	private async setAudioRecording(event: any) {
		const details = event?.detail;
		
		if (!details?.entryId || !details?.path) {
			return;
		}

		let entry: NoteEntry | undefined;

		try {
			entry = this.getEntry(details.entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!entry) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		if (entry.type !== "audio") {
			return;
		}

		const params = entry.params as NoteEntryAudioParams;

		params.path = details.path;
		await this.saveNoteData();
		await this.getNote();
	}

	private async setVideoRecording(event: any) {
		const details = event?.detail;

		if (!details?.entryId || !details?.path) {
			return;
		}

		let entry: NoteEntry | undefined;

		try {
			entry = this.getEntry(details.entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!entry) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		if (entry.type !== "video") {
			return;
		}

		const params = entry.params as NoteEntryVideoParams;

		params.path = details.path;
		params.thumbnailPath = await this.generateThumbnail(details.path);

		await this.saveNoteData();
		await this.getNote();
	}

	async takePhoto(entryId: string) {
		try {
			const { camera } = await Camera.requestPermissions({ permissions: ["camera"] });
			if (camera !== "granted") {
				Dialog.alert({ message: "Permission caméra refusée." });
				return;
			}

			const photo = await Camera.getPhoto({
				quality: 90,
				allowEditing: false,
				resultType: CameraResultType.Uri,
				source: CameraSource.Camera,
			});

			if (!photo.path) return;

			this.eventBus.trigger(Events.SET_PHOTO, { entryId, path: photo.path });
		} catch {
			// User cancelled — nothing to do
		}
	}

	private async generateThumbnail(videoPath: string): Promise<string | undefined> {
		try {
			const webUrl = Capacitor.convertFileSrc(videoPath);
			const base64 = await generateVideoThumbnail(webUrl);
			const filename = (videoPath.split("/").pop() ?? "video.mp4").replace(/\.[^.]+$/, ".jpg");
			const result = await Filesystem.writeFile({
				path: filename,
				data: base64,
				directory: Directory.External,
			});
			return result.uri;
		} catch {
			return undefined;
		}
	}
}

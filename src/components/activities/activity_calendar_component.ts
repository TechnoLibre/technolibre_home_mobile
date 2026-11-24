import { onMounted, useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { Events } from "../../constants/events";
import type { CalendarActivity } from "../../services/databaseService";
import type { SyncConfig } from "../../models/syncConfig";
import { loadSyncConfigs } from "../../models/syncConfig";
import type { SyncCredentials } from "../../services/odoo/odooRpcClient";
import { networkService } from "../../services/networkService";
import { CalendarUser } from "../../services/activityCalendarService";
import {
	activitiesOn,
	CALENDAR_HANDOFF_KEY,
	CalendarFilter,
	DayCell,
	monthCells,
	overdueActivities,
	shiftMonth,
	todayDay,
	visibleActivities,
} from "../../services/calendarView";
import { plannedReminders, reminderSettings, scheduleReminders } from "../../services/calendarReminders";
import { openRecordInApp } from "../../utils/openRecordInApp";


/** Colours of the servers, by their order in the sync options. */
const SERVER_COLORS = 6;

interface CalendarState {
	configs: SyncConfig[];
	activities: CalendarActivity[];
	uids: Record<string, number | null>;
	errors: Record<string, string>;
	month: string;
	selected: string;
	today: string;
	filter: CalendarFilter;
	loading: boolean;
	offline: boolean;
	/** Activity resId → note id, per config id: the note an activity came from. */
	notes: Record<string, Record<number, string>>;
	/** The day being typed for an activity's new deadline, by "configId#resId". */
	rescheduling: Record<string, string>;
	/** Some server's read was cut at its limit. */
	truncated: boolean;
	/** Activities whose change is being sent, by "configId#resId": their buttons wait. */
	busy: Record<string, boolean>;
	teamOpen: boolean;
	team: Record<string, CalendarUser[]>;
	teamQuery: Record<string, string>;
	teamFound: Record<string, CalendarUser[]>;
}

/**
 * The activity calendar: a month of the activities of every sync server,
 * the connected user's and those of the users chosen per server, coloured
 * by server, from the cache when offline. A day lists its activities, each
 * openable in the app (or as its note), markable done or reschedulable;
 * today also lists the overdue ones. "New note" creates a note dated on
 * the selected day and hands that day to the note screen, which opens the
 * sync picker on an activity due then. Each refresh reschedules the local
 * reminders (see calendarReminders).
 */
export class ActivityCalendarComponent extends EnhancedComponent {
	state!: CalendarState;

	static template = xml`
		<div id="activity-calendar-component">
			<nav class="activity-calendar__breadcrumb">
				<a href="#" t-on-click.stop.prevent="onBackClick"><t t-esc="t('nav.home')"/></a>
				<span class="activity-calendar__sep">›</span>
				<span t-esc="t('label.calendar')"/>
				<button type="button" class="activity-calendar__refresh" t-att-disabled="state.loading" t-on-click="() => this.refresh()">
					<t t-esc="state.loading ? t('label.sync_target_loading') : t('label.calendar_refresh')"/>
				</button>
			</nav>
			<p t-if="state.configs.length === 0 and !state.loading" class="activity-calendar__note"><t t-esc="t('label.calendar_no_server')"/></p>
			<p t-if="state.offline" class="activity-calendar__note"><t t-esc="t('label.calendar_offline')"/></p>
			<p t-if="state.truncated" class="activity-calendar__note activity-calendar__note--warn"><t t-esc="t('label.calendar_truncated')"/></p>
			<t t-foreach="errorLines" t-as="line" t-key="line_index">
				<p class="activity-calendar__note activity-calendar__note--warn" t-esc="line"/>
			</t>
			<div class="activity-calendar__filters">
				<label><input type="checkbox" t-att-checked="state.filter.mine" t-on-change="(ev) => this.setFilter('mine', ev.target.checked)"/> <t t-esc="t('label.calendar_mine')"/></label>
				<label><input type="checkbox" t-att-checked="state.filter.others" t-on-change="(ev) => this.setFilter('others', ev.target.checked)"/> <t t-esc="t('label.calendar_team')"/></label>
				<button type="button" class="activity-calendar__link" t-on-click="() => this.toggleTeam()"><t t-esc="t('label.calendar_team_edit')"/></button>
			</div>
			<div t-if="state.teamOpen" class="activity-calendar__team">
				<t t-foreach="state.configs" t-as="cfg" t-key="cfg.id">
					<p class="activity-calendar__section" t-esc="cfg.name or cfg.appUrl"/>
					<t t-foreach="state.team[cfg.id] or []" t-as="user" t-key="user.id">
						<div class="activity-calendar__team-user">
							<span t-esc="user.name"/>
							<button type="button" class="activity-calendar__link" t-on-click="() => this.removeTeamUser(cfg, user.id)"><t t-esc="t('label.sync_activity_remove')"/></button>
						</div>
					</t>
					<input
						type="search"
						class="activity-calendar__input"
						t-att-placeholder="t('label.sync_activity_user_search')"
						t-att-aria-label="t('label.sync_activity_user_search')"
						t-att-value="state.teamQuery[cfg.id] or ''"
						t-on-input="(ev) => this.searchTeam(cfg, ev.target.value)"
					/>
					<t t-foreach="state.teamFound[cfg.id] or []" t-as="user" t-key="user.id">
						<button type="button" class="activity-calendar__link" t-on-click="() => this.addTeamUsers(cfg, [user])" t-esc="'+ ' + user.name"/>
					</t>
					<button type="button" class="activity-calendar__link" t-on-click="() => this.addSalesTeam(cfg)"><t t-esc="t('label.calendar_sales_team')"/></button>
				</t>
			</div>
			<div class="activity-calendar__month">
				<button type="button" class="activity-calendar__nav" t-att-aria-label="t('label.calendar_previous')" t-on-click="() => this.moveMonth(-1)">‹</button>
				<span class="activity-calendar__month-name" t-esc="monthName"/>
				<button type="button" class="activity-calendar__nav" t-att-aria-label="t('label.calendar_next')" t-on-click="() => this.moveMonth(1)">›</button>
			</div>
			<div class="activity-calendar__grid" role="grid">
				<t t-foreach="weekDays" t-as="wd" t-key="wd_index">
					<span class="activity-calendar__weekday" t-esc="wd"/>
				</t>
				<t t-foreach="cells" t-as="cell" t-key="cell.day">
					<button
						type="button"
						t-att-class="dayClass(cell)"
						t-att-aria-label="cell.day"
						t-att-aria-pressed="cell.day === state.selected ? 'true' : 'false'"
						t-on-click="() => this.selectDay(cell.day)"
					>
						<span class="activity-calendar__day-number" t-esc="cell.day.slice(8)"/>
						<span t-if="cell.overdue" class="activity-calendar__count activity-calendar__count--overdue" t-esc="cell.overdue"/>
						<span t-if="cell.open" class="activity-calendar__count" t-esc="cell.open"/>
						<span t-if="cell.done" class="activity-calendar__count activity-calendar__count--done" t-esc="cell.done"/>
					</button>
				</t>
			</div>
			<div class="activity-calendar__day">
				<p class="activity-calendar__section" t-esc="state.selected"/>
				<button type="button" class="activity-calendar__new" t-on-click="() => this.newNoteOn(state.selected)"><t t-esc="t('label.calendar_new_note')"/></button>
				<p t-if="dayActivities.length === 0" class="activity-calendar__note"><t t-esc="t('label.calendar_empty_day')"/></p>
				<t t-foreach="listed" t-as="row" t-key="(row.overdue ? 'o#' : 'd#') + activityKey(row.a)">
					<p t-if="row.first" t-att-class="'activity-calendar__section' + (row.overdue ? ' activity-calendar__section--warn' : '')"
						t-esc="row.overdue ? t('label.calendar_overdue') : t('label.calendar_of_day')"/>
					<t t-set="a" t-value="row.a"/>
					<div t-att-class="serverClass(a) + (a.done ? ' activity-calendar__item--done' : '')">
						<p class="activity-calendar__item-title" t-esc="(a.summary or a.typeName or t('label.sync_attached_activity')) + (a.done ? ' ✓' : '')"/>
						<p class="activity-calendar__note" t-esc="activityLine(a)"/>
						<p t-if="a.pending" class="activity-calendar__note"><t t-esc="t('label.calendar_pending')"/></p>
						<p t-if="a.lastError" class="activity-calendar__note activity-calendar__note--warn" t-esc="t('label.calendar_refused', { reason: a.lastError })"/>
						<div t-if="!state.busy[activityKey(a)]" class="activity-calendar__actions">
							<button type="button" class="activity-calendar__link" t-on-click="() => this.openActivity(a)"><t t-esc="noteOf(a) ? t('label.calendar_open_note') : t('label.calendar_open')"/></button>
							<t t-if="!a.done">
								<button type="button" class="activity-calendar__link" t-on-click="() => this.markDone(a)"><t t-esc="t('label.calendar_done')"/></button>
								<t t-if="state.rescheduling[activityKey(a)] !== undefined">
									<input
										type="date"
										class="activity-calendar__input"
										t-att-aria-label="t('label.sync_activity_deadline')"
										t-att-value="state.rescheduling[activityKey(a)]"
										t-on-change="(ev) => this.setRescheduleDay(a, ev.target.value)"
									/>
									<button type="button" class="activity-calendar__link" t-on-click="() => this.confirmReschedule(a)"><t t-esc="t('label.calendar_reschedule_ok')"/></button>
								</t>
								<button t-else="" type="button" class="activity-calendar__link" t-on-click="() => this.startReschedule(a)"><t t-esc="t('label.calendar_reschedule')"/></button>
							</t>
						</div>
					</div>
				</t>
			</div>
		</div>
	`;

	setup() {
		const today = todayDay();
		this.state = useState({
			configs: [],
			activities: [],
			uids: {},
			errors: {},
			month: today.slice(0, 7),
			selected: today,
			today,
			filter: { mine: true, others: true },
			loading: false,
			offline: false,
			notes: {},
			rescheduling: {},
			truncated: false,
			busy: {},
			teamOpen: false,
			team: {},
			teamQuery: {},
			teamFound: {},
		});
		onMounted(() => this.refresh());
	}

	get weekDays(): string[] {
		return ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => this.t(`label.calendar_day_${d}`));
	}

	get monthName(): string {
		const [y, m] = this.state.month.split("-").map(Number);
		return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
	}

	get shown(): CalendarActivity[] {
		return visibleActivities(this.state.activities, this.state.filter, this.state.uids);
	}

	get cells(): DayCell[] {
		return monthCells(this.state.month, this.shown, this.state.today);
	}

	get dayActivities(): CalendarActivity[] {
		return activitiesOn(this.shown, this.state.selected);
	}

	get overdue(): CalendarActivity[] {
		return overdueActivities(this.shown, this.state.today);
	}

	/** The rows of the day list: today's overdue activities first, then the selected day's. */
	get listed(): Array<{ a: CalendarActivity; overdue: boolean; first: boolean }> {
		const overdue = this.state.selected === this.state.today ? this.overdue : [];
		const day = this.dayActivities;
		return [
			...overdue.map((a, i) => ({ a, overdue: true, first: i === 0 })),
			...day.map((a, i) => ({ a, overdue: false, first: i === 0 && overdue.length > 0 })),
		];
	}

	get errorLines(): string[] {
		return Object.entries(this.state.errors).map(([id, message]) => `${this.serverName(id)} : ${message}`);
	}

	dayClass(cell: DayCell): string {
		return [
			"activity-calendar__cell",
			cell.inMonth ? "" : "activity-calendar__cell--outside",
			cell.isToday ? "activity-calendar__cell--today" : "",
			cell.day === this.state.selected ? "activity-calendar__cell--selected" : "",
		].filter(Boolean).join(" ");
	}

	serverName(configId: string): string {
		const cfg = this.state.configs.find((c) => c.id === configId);
		return cfg ? cfg.name || cfg.appUrl : configId;
	}

	serverClass(a: CalendarActivity): string {
		const index = Math.max(0, this.state.configs.findIndex((c) => c.id === a.configId));
		return `activity-calendar__item activity-calendar__item--srv-${index % SERVER_COLORS}`;
	}

	activityKey(a: CalendarActivity): string {
		return `${a.configId}#${a.resId}`;
	}

	noteOf(a: CalendarActivity): string | null {
		return this.state.notes[a.configId]?.[a.resId] ?? null;
	}

	/** The record, deadline, user and server of an activity, on one line. */
	activityLine(a: CalendarActivity): string {
		const user = this.isMine(a) ? this.t("label.sync_activity_user_me") : a.userName;
		return [a.recordName, a.deadline, user, this.serverName(a.configId)].filter(Boolean).join(" · ");
	}

	isMine(a: CalendarActivity): boolean {
		return a.userId !== null && a.userId === this.state.uids[a.configId];
	}

	setFilter(which: keyof CalendarFilter, value: boolean) {
		this.state.filter[which] = value;
	}

	moveMonth(n: number) {
		this.state.month = shiftMonth(this.state.month, n);
	}

	selectDay(day: string) {
		this.state.selected = day;
		if (!day.startsWith(this.state.month)) this.state.month = day.slice(0, 7);
	}

	onBackClick() {
		this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: "/" });
	}

	/** Credentials of a sync target, from its application. */
	private async credsFor(cfg: SyncConfig): Promise<SyncCredentials> {
		const apps = await this.appService.getApps();
		const app = apps.find((a) => a.url === cfg.appUrl && a.username === cfg.appUsername);
		if (!app) throw new Error("Application Odoo introuvable.");
		return { odooUrl: cfg.appUrl, username: app.username, password: app.password, database: cfg.database };
	}

	/**
	 * Reads every server's activities (online, else the cache), the notes
	 * they came from, and the users chosen per server, then reschedules the
	 * reminders of the connected user's open activities.
	 */
	async refresh() {
		this.state.loading = true;
		try {
			const configs = await loadSyncConfigs(this.appService);
			const online = await networkService.isOnline();
			const activities: CalendarActivity[] = [];
			const uids: Record<string, number | null> = {};
			const errors: Record<string, string> = {};
			const notes: Record<string, Record<number, string>> = {};
			const team: Record<string, CalendarUser[]> = {};
			let truncated = false;
			await Promise.all(configs.map(async (cfg) => {
				try {
					const read = await this.syncService.calendar.refresh(await this.credsFor(cfg), { online });
					activities.push(...read.activities);
					uids[cfg.id] = read.uid ?? this.state.uids[cfg.id] ?? null;
					truncated = truncated || read.truncated;
					if (read.error) errors[cfg.id] = read.error;
				} catch (e: unknown) {
					errors[cfg.id] = e instanceof Error ? e.message : String(e);
				}
				notes[cfg.id] = {};
				for (const link of await this.databaseService.getNoteLinksForConfig(cfg.id)) {
					if (link.kind === "activity") notes[cfg.id][link.resId] = link.noteId;
				}
				team[cfg.id] = await this.syncService.calendar.users(cfg.id);
			}));
			Object.assign(this.state, { configs, activities, uids, errors, notes, team, truncated, offline: !online });
			await this.replanReminders();
		} finally {
			this.state.loading = false;
		}
	}

	async openActivity(a: CalendarActivity) {
		const note = this.noteOf(a);
		if (note) {
			this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/note/${note}` });
			return;
		}
		const cfg = this.state.configs.find((c) => c.id === a.configId);
		if (!cfg) return;
		const creds = await this.credsFor(cfg);
		await openRecordInApp({
			label: a.recordName, appUrl: cfg.appUrl, username: creds.username, password: creds.password,
			model: a.resModel, resId: a.recordId,
		});
	}

	/**
	 * Replaces the local reminders with those of the cached activities
	 * (see calendarReminders). Left as they are while some server's user is
	 * still unknown (never read online): its activities could not be told
	 * apart, and replacing would cancel its reminders.
	 */
	private async replanReminders() {
		if (this.state.configs.some((c) => (this.state.uids[c.id] ?? null) === null)) return;
		await scheduleReminders(plannedReminders(this.state.activities, this.state.uids, reminderSettings(), new Date()))
			.catch(() => 0);
	}

	/** Runs a change of one activity, its buttons hidden meanwhile, then shows the cache and its reminders again. */
	private async change(a: CalendarActivity, run: (creds: SyncCredentials, online: boolean) => Promise<void>) {
		const key = this.activityKey(a);
		const cfg = this.state.configs.find((c) => c.id === a.configId);
		if (!cfg || this.state.busy[key]) return;
		this.state.busy[key] = true;
		try {
			await run(await this.credsFor(cfg), await networkService.isOnline());
		} catch (e: unknown) {
			await Dialog.alert({ message: e instanceof Error ? e.message : String(e) });
		} finally {
			delete this.state.busy[key];
		}
		await this.reloadCache();
	}

	async markDone(a: CalendarActivity) {
		await this.change(a, (creds, online) => this.syncService.calendar.markDone(creds, a, { online }));
	}

	startReschedule(a: CalendarActivity) {
		this.state.rescheduling[this.activityKey(a)] = a.deadline;
	}

	setRescheduleDay(a: CalendarActivity, day: string) {
		this.state.rescheduling[this.activityKey(a)] = day;
	}

	async confirmReschedule(a: CalendarActivity) {
		const day = this.state.rescheduling[this.activityKey(a)];
		delete this.state.rescheduling[this.activityKey(a)];
		if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "") || day === a.deadline) return;
		await this.change(a, (creds, online) => this.syncService.calendar.reschedule(creds, a, day, { online }));
	}

	/** Shows the cache again after a change made from the calendar, and replans the reminders. */
	private async reloadCache() {
		const activities: CalendarActivity[] = [];
		for (const cfg of this.state.configs) activities.push(...await this.syncService.calendar.cached(cfg.id));
		this.state.activities = activities;
		await this.replanReminders();
	}

	/**
	 * Creates a note dated on day (a date entry at 9:00 local time) and
	 * opens it; the note screen then offers an activity due that day.
	 */
	async newNoteOn(day: string) {
		const note = this.noteService.getNewNote(this.noteService.getNewId());
		const entry = this.noteService.entry.getNewDateEntry();
		entry.params = { date: new Date(`${day}T09:00:00`).toISOString() };
		note.entries = [entry];
		note.date = new Date().toISOString();
		await this.noteService.crud.add(note);
		try {
			sessionStorage.setItem(CALENDAR_HANDOFF_KEY, JSON.stringify({ noteId: note.id, day }));
		} catch {
			// Without it the note opens without the picker
		}
		this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/note/${note.id}` });
	}

	toggleTeam() {
		this.state.teamOpen = !this.state.teamOpen;
	}

	private _teamSearch = new Map<string, ReturnType<typeof setTimeout>>();

	searchTeam(cfg: SyncConfig, text: string) {
		this.state.teamQuery[cfg.id] = text;
		const pending = this._teamSearch.get(cfg.id);
		if (pending) clearTimeout(pending);
		this._teamSearch.set(cfg.id, setTimeout(async () => {
			this._teamSearch.delete(cfg.id);
			try {
				const found = await this.syncService.recordSearch("res.users")
					.search(await this.credsFor(cfg), text, { online: await networkService.isOnline() });
				if (this.state.teamQuery[cfg.id] !== text) return;
				this.state.teamFound[cfg.id] = found.records.map((r) => ({ id: r.id, name: r.name }));
			} catch (e: unknown) {
				this.state.errors[cfg.id] = e instanceof Error ? e.message : String(e);
			}
		}, 300));
	}

	async addTeamUsers(cfg: SyncConfig, users: CalendarUser[]) {
		const team = [...(this.state.team[cfg.id] ?? []), ...users];
		await this.syncService.calendar.setUsers(cfg.id, team);
		this.state.team[cfg.id] = await this.syncService.calendar.users(cfg.id);
		this.state.teamFound[cfg.id] = [];
		this.state.teamQuery[cfg.id] = "";
	}

	async removeTeamUser(cfg: SyncConfig, userId: number) {
		await this.syncService.calendar.setUsers(cfg.id, (this.state.team[cfg.id] ?? []).filter((u) => u.id !== userId));
		this.state.team[cfg.id] = await this.syncService.calendar.users(cfg.id);
	}

	async addSalesTeam(cfg: SyncConfig) {
		try {
			const users = await this.syncService.calendar.salesTeamUsers(await this.credsFor(cfg));
			if (users.length === 0) {
				await Dialog.alert({ message: this.t("label.calendar_no_sales_team") });
				return;
			}
			await this.addTeamUsers(cfg, users);
		} catch (e: unknown) {
			await Dialog.alert({ message: e instanceof Error ? e.message : String(e) });
		}
	}
}

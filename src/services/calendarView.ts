import type { CalendarActivity } from "./databaseService";
import { addDays, dayOf } from "./activityCalendarService";

/** sessionStorage key handing a new note's day to the note screen, which opens an activity on it. */
export const CALENDAR_HANDOFF_KEY = "calendar.newActivityDay";

/** One day of the month grid: how many activities it holds, open, overdue and done. */
export interface DayCell {
  day: string;
  inMonth: boolean;
  isToday: boolean;
  open: number;
  overdue: number;
  done: number;
}

/** Whose activities the calendar shows: the connected user's (mine), the other users' (others). */
export interface CalendarFilter {
  mine: boolean;
  others: boolean;
}

/** The month ("YYYY-MM") n months after month. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** The day an activity sits on in the calendar: its deadline, or the day it was done. */
export function dayOfActivity(a: CalendarActivity): string {
  return a.done && a.dateDone ? a.dateDone.slice(0, 10) : a.deadline;
}

/** The activities filter lets through: the connected user's on each server, the others'. */
export function visibleActivities(
  activities: CalendarActivity[],
  filter: CalendarFilter,
  uidByConfig: Record<string, number | null>
): CalendarActivity[] {
  return activities.filter((a) => {
    const mine = a.userId !== null && a.userId === uidByConfig[a.configId];
    return mine ? filter.mine : filter.others;
  });
}

/**
 * The weeks of month ("YYYY-MM"), Monday first, as full weeks around it
 * (the days of the months before and after are not inMonth), with the
 * counts of activities on each day; overdue counts the open activities
 * due on a day before today.
 */
export function monthCells(month: string, activities: CalendarActivity[], today: string): DayCell[] {
  const first = `${month}-01`;
  const firstDate = new Date(`${first}T12:00:00`);
  const start = addDays(first, -((firstDate.getDay() + 6) % 7));
  const last = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const lastDate = new Date(`${last}T12:00:00`);
  const end = addDays(last, (7 - lastDate.getDay()) % 7);
  const byDay = new Map<string, CalendarActivity[]>();
  for (const a of activities) {
    const day = dayOfActivity(a);
    byDay.set(day, [...(byDay.get(day) ?? []), a]);
  }
  const cells: DayCell[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const on = byDay.get(day) ?? [];
    cells.push({
      day,
      inMonth: day.startsWith(month),
      isToday: day === today,
      open: on.filter((a) => !a.done && day >= today).length,
      overdue: on.filter((a) => !a.done && day < today).length,
      done: on.filter((a) => a.done).length,
    });
  }
  return cells;
}

/** The activities on day, open first then done, each by type and record. */
export function activitiesOn(activities: CalendarActivity[], day: string): CalendarActivity[] {
  return activities
    .filter((a) => dayOfActivity(a) === day)
    .sort((a, b) => Number(a.done) - Number(b.done)
      || (a.typeName ?? "").localeCompare(b.typeName ?? "") || a.recordName.localeCompare(b.recordName));
}

/** The open activities due before today, the oldest first. */
export function overdueActivities(activities: CalendarActivity[], today: string): CalendarActivity[] {
  return activities.filter((a) => !a.done && a.deadline < today).sort((a, b) => a.deadline.localeCompare(b.deadline));
}

/** Today, as the calendar counts days. */
export function todayDay(now: Date = new Date()): string {
  return dayOf(now);
}

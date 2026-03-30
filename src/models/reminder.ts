export interface Reminder {
  id: string;
  message: string;
  intervalMinutes: number;
  active: boolean;
  /** Capacitor LocalNotification IDs in the current batch. */
  scheduledIds: number[];
  /** ISO date of the last notification in the current batch. */
  batchEndsAt: string | null;
}

export const INTERVAL_OPTIONS: { label: string; minutes: number }[] = [
  { label: "5 minutes", minutes: 5 },
  { label: "15 minutes", minutes: 15 },
  { label: "30 minutes", minutes: 30 },
  { label: "1 heure", minutes: 60 },
  { label: "2 heures", minutes: 120 },
  { label: "4 heures", minutes: 240 },
  { label: "8 heures", minutes: 480 },
  { label: "24 heures", minutes: 1440 },
];

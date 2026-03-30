/**
 * Mock of @capacitor/local-notifications for Vitest.
 *
 * Tracks scheduled and cancelled notification IDs so tests can assert
 * on scheduling behaviour without needing a real Android runtime.
 */

export interface MockScheduledNotification {
  id: number;
  title?: string;
  body?: string;
  scheduleAt?: Date;
}

const _scheduled: MockScheduledNotification[] = [];
const _cancelled: number[] = [];
const _listeners: Array<(notification: any) => void> = [];

export const LocalNotifications = {
  requestPermissions: vi.fn().mockResolvedValue({ display: "granted" }),

  checkPermissions: vi.fn().mockResolvedValue({ display: "granted" }),

  schedule: vi.fn().mockImplementation(
    ({ notifications }: { notifications: MockScheduledNotification[] }) => {
      notifications.forEach((n) => _scheduled.push(n));
      return Promise.resolve({ notifications });
    }
  ),

  cancel: vi.fn().mockImplementation(
    ({ notifications }: { notifications: { id: number }[] }) => {
      notifications.forEach(({ id }) => {
        _cancelled.push(id);
        const idx = _scheduled.findIndex((n) => n.id === id);
        if (idx !== -1) _scheduled.splice(idx, 1);
      });
      return Promise.resolve();
    }
  ),

  addListener: vi.fn().mockImplementation(
    (_event: string, cb: (n: any) => void) => {
      _listeners.push(cb);
      return Promise.resolve({ remove: () => {} });
    }
  ),

  getPending: vi.fn().mockResolvedValue({ notifications: _scheduled }),

  // Test helpers
  _scheduled,
  _cancelled,
  _listeners,
  _reset() {
    _scheduled.length = 0;
    _cancelled.length = 0;
    _listeners.length = 0;
    vi.clearAllMocks();
  },
};

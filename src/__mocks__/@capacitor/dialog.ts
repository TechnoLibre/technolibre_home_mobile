/**
 * Mock of @capacitor/dialog.
 *
 * Replaces native dialog popups with vitest spy functions
 * so tests can verify they were called without opening real dialogs.
 */
import { vi } from "vitest";

export const Dialog = {
  alert: vi.fn().mockResolvedValue(undefined),
  confirm: vi.fn().mockResolvedValue({ value: true }),
};

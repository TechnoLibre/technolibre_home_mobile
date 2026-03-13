/**
 * Mock of @capacitor/core.
 *
 * Returns "web" as platform for all test scenarios.
 */
export const Capacitor = {
  getPlatform: () => "web",
  isNativePlatform: () => false,
};

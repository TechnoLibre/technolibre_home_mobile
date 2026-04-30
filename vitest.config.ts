import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Exclude whisper.cpp vendor tests — they require a compiled C++ addon
    // (addon.node) that is only built when targeting desktop Node.js, not Android.
    // Also exclude bundled-source duplicates (src/public/repo/, src/public/erplibre/,
    // dist/repo/, dist/erplibre/) so vitest does not run the same suite three
    // times nor pick up unrelated JS test files (gnome-extension etc.).
    exclude: [
      "android/**",
      "node_modules/**",
      "dist/**",
      "src/public/**",
    ],
    alias: [
      {
        find: "capacitor-secure-storage-plugin",
        replacement: resolve(__dirname, "src/__mocks__/capacitor-secure-storage-plugin.ts"),
      },
      // Match both the bare `@odoo/owl` import and the full subpath
      // `@odoo/owl/dist/owl.es.js` used by owl-aot.ts to avoid an
      // alias self-loop in production. Tests target the mock for both.
      {
        find: /^@odoo\/owl(\/dist\/owl\.es\.js)?$/,
        replacement: resolve(__dirname, "src/__mocks__/@odoo/owl.ts"),
      },
      {
        find: "@capacitor/core",
        replacement: resolve(__dirname, "src/__mocks__/@capacitor/core.ts"),
      },
      {
        find: "@capacitor-community/sqlite",
        replacement: resolve(__dirname, "src/__mocks__/@capacitor-community/sqlite.ts"),
      },
      {
        find: "@capacitor/dialog",
        replacement: resolve(__dirname, "src/__mocks__/@capacitor/dialog.ts"),
      },
      {
        find: "@aparajita/capacitor-biometric-auth",
        replacement: resolve(__dirname, "src/__mocks__/@aparajita/capacitor-biometric-auth.ts"),
      },
      {
        find: "@capacitor/local-notifications",
        replacement: resolve(__dirname, "src/__mocks__/@capacitor/local-notifications.ts"),
      },
    ],
  },
});

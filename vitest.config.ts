import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Exclude whisper.cpp vendor tests — they require a compiled C++ addon
    // (addon.node) that is only built when targeting desktop Node.js, not Android.
    exclude: ["android/**", "node_modules/**"],
    alias: {
      "capacitor-secure-storage-plugin": resolve(
        __dirname,
        "src/__mocks__/capacitor-secure-storage-plugin.ts"
      ),
      "@odoo/owl": resolve(__dirname, "src/__mocks__/@odoo/owl.ts"),
      "@capacitor/core": resolve(
        __dirname,
        "src/__mocks__/@capacitor/core.ts"
      ),
      "@capacitor-community/sqlite": resolve(
        __dirname,
        "src/__mocks__/@capacitor-community/sqlite.ts"
      ),
      "@capacitor/dialog": resolve(
        __dirname,
        "src/__mocks__/@capacitor/dialog.ts"
      ),
      "@aparajita/capacitor-biometric-auth": resolve(
        __dirname,
        "src/__mocks__/@aparajita/capacitor-biometric-auth.ts"
      ),
      "@capacitor/local-notifications": resolve(
        __dirname,
        "src/__mocks__/@capacitor/local-notifications.ts"
      ),
    },
  },
});

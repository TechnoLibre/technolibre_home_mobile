import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Exclude whisper.cpp vendor tests -- they need a compiled C++ addon
    // (addon.node) built only for desktop Node.js, not Android. Also exclude
    // the bundled-source duplicates (src/public/, dist/) so vitest does not
    // run the same suite three times nor pick up unrelated JS test files.
    exclude: [
      "android/**",
      "**/github-com-ggerganov-whisper-cpp/**",
      "node_modules/**",
      "dist/**",
      "src/public/**",
    ],
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

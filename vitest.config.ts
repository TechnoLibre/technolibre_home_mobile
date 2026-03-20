import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
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
    },
  },
});

import { describe, it, expect, beforeEach } from "vitest";
import { BiometryUtils } from "../utils/biometryUtils";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { BiometricAuth } from "@aparajita/capacitor-biometric-auth";
import { StorageConstants } from "../constants/storage";
import { StorageUtils } from "../utils/storageUtils";

describe("BiometryUtils", () => {
  beforeEach(() => {
    SecureStoragePlugin._store.clear();
    (BiometricAuth as any)._reset();
  });

  // ── isEnabledByUser ──

  describe("isEnabledByUser", () => {
    it("returns false when preference is not set", async () => {
      expect(await BiometryUtils.isEnabledByUser()).toBe(false);
    });

    it("returns false when preference is explicitly false", async () => {
      await StorageUtils.setKeyValuePair(StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY, false);
      expect(await BiometryUtils.isEnabledByUser()).toBe(false);
    });

    it("returns true when preference is explicitly true", async () => {
      await StorageUtils.setKeyValuePair(StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY, true);
      expect(await BiometryUtils.isEnabledByUser()).toBe(true);
    });
  });

  // ── authenticateForDatabase ──

  describe("authenticateForDatabase", () => {
    it("returns true without prompting when biometry is disabled", async () => {
      await StorageUtils.setKeyValuePair(StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY, false);
      (BiometricAuth as any)._setShouldSucceed(false); // would fail if prompted
      expect(await BiometryUtils.authenticateForDatabase()).toBe(true);
    });

    it("returns true without prompting when preference is not set", async () => {
      (BiometricAuth as any)._setShouldSucceed(false); // would fail if prompted
      expect(await BiometryUtils.authenticateForDatabase()).toBe(true);
    });

    it("returns true without prompting when biometry is enabled but device has none", async () => {
      await StorageUtils.setKeyValuePair(StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY, true);
      (BiometricAuth as any)._setAvailable(false);
      (BiometricAuth as any)._setShouldSucceed(false); // would fail if prompted
      expect(await BiometryUtils.authenticateForDatabase()).toBe(true);
    });

    it("returns true when biometry is enabled and authentication succeeds", async () => {
      await StorageUtils.setKeyValuePair(StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY, true);
      (BiometricAuth as any)._setShouldSucceed(true);
      expect(await BiometryUtils.authenticateForDatabase()).toBe(true);
    });

    it("returns false when biometry is enabled and authentication fails", async () => {
      await StorageUtils.setKeyValuePair(StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY, true);
      (BiometricAuth as any)._setShouldSucceed(false);
      expect(await BiometryUtils.authenticateForDatabase()).toBe(false);
    });
  });
});

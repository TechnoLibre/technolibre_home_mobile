/**
 * Mock of capacitor-secure-storage-plugin.
 *
 * Uses an in-memory Map to simulate the device's secure storage.
 * Tests can access `_store` to inspect or reset state between runs.
 */
const _store = new Map<string, string>();

export const SecureStoragePlugin = {
  async get({ key }: { key: string }): Promise<{ value: string }> {
    if (!_store.has(key)) {
      throw new Error(`Key "${key}" not found`);
    }
    return { value: _store.get(key)! };
  },

  async set({
    key,
    value,
  }: {
    key: string;
    value: string;
  }): Promise<{ value: boolean }> {
    _store.set(key, value);
    return { value: true };
  },

  async remove({ key }: { key: string }): Promise<{ value: boolean }> {
    _store.delete(key);
    return { value: true };
  },

  async clear(): Promise<{ value: boolean }> {
    _store.clear();
    return { value: true };
  },

  async keys(): Promise<{ value: string[] }> {
    return { value: Array.from(_store.keys()) };
  },

  _store,
};

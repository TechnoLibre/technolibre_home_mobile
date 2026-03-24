/**
 * Mock of @aparajita/capacitor-biometric-auth.
 *
 * Tests can use _setShouldSucceed / _setAvailable / _reset to control behavior.
 */

let _shouldSucceed = true;
let _isAvailable = true;

export const BiometricAuth = {
  async checkBiometry() {
    return { isAvailable: _isAvailable };
  },

  async authenticate() {
    if (!_shouldSucceed) {
      throw new Error("Biometric authentication failed");
    }
  },

  _setAvailable(val: boolean) {
    _isAvailable = val;
  },

  _setShouldSucceed(val: boolean) {
    _shouldSucceed = val;
  },

  _reset() {
    _shouldSucceed = true;
    _isAvailable = true;
  },
};

export type CheckBiometryResult = {
  isAvailable: boolean;
};

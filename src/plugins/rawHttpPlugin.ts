import { registerPlugin } from "@capacitor/core";

export interface CertificatePinInfo {
  pin: string;
  subject: string;
  issuer: string;
  expires: string;
}

export interface RawHttpPlugin {
  post(options: {
    url: string;
    headers: Record<string, string>;
    body: string;
    /** Optional SHA-256 SPKI pin — rejects connection if cert doesn't match. */
    certPin?: string;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    data: string;
  }>;
  /** Returns the SHA-256 fingerprint of a server's leaf certificate. */
  getCertificatePin(options: { url: string }): Promise<CertificatePinInfo>;
}

/**
 * RawHttp bypasses Capacitor's CookieHandler, ensuring manually-set Cookie
 * headers reach the server untouched on HTTP connections to IP addresses.
 */
export const RawHttp = registerPlugin<RawHttpPlugin>("RawHttp");

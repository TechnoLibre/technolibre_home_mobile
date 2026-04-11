import { registerPlugin } from "@capacitor/core";

export interface RawHttpPlugin {
  post(options: {
    url: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    data: string;
  }>;
}

/**
 * RawHttp bypasses Capacitor's CookieHandler, ensuring manually-set Cookie
 * headers reach the server untouched on HTTP connections to IP addresses.
 */
export const RawHttp = registerPlugin<RawHttpPlugin>("RawHttp");

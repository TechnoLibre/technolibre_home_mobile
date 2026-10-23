import { registerPlugin } from "@capacitor/core";

interface NoteSyncPluginApi {
    /**
     * Publishes what waits for the Odoo sync (notes to send, conflicts),
     * whether the app is in the foreground, and the notification's texts
     * in the app's language, for the native NoteSyncJob: app closed, it
     * shows them and opens the app on a tap.
     */
    publish(opts: { pending: number; conflicts: number; foreground: boolean; title?: string; body?: string }): Promise<void>;
}

export const NoteSyncPlugin = registerPlugin<NoteSyncPluginApi>("NoteSyncPlugin");

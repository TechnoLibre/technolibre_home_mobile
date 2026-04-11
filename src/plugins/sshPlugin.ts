import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

export interface SshOutputEvent {
    line: string;
    stream: "stdout" | "stderr";
}

export interface SshConnectOptions {
    host: string;
    port: number;
    username: string;
    authType: "password" | "key";
    credential: string;
    passphrase?: string;
}

export interface SshExecuteOptions {
    command: string;
}

export interface SshExecuteResult {
    exitCode: number;
}

export interface SshPlugin {
    connect(options: SshConnectOptions): Promise<void>;
    execute(options: SshExecuteOptions): Promise<SshExecuteResult>;
    disconnect(): Promise<void>;
    addListener(
        event: "sshOutput",
        listenerFunc: (data: SshOutputEvent) => void
    ): Promise<PluginListenerHandle>;
}

export const SshPlugin = registerPlugin<SshPlugin>("SshPlugin");

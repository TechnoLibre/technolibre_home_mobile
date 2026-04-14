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

export interface SshConnectResult {
    hostKeyFingerprint?: string;
}

export interface SshClearKnownHostOptions {
    host: string;
}

export interface SshPlugin {
    connect(options: SshConnectOptions): Promise<SshConnectResult>;
    execute(options: SshExecuteOptions): Promise<SshExecuteResult>;
    disconnect(): Promise<void>;
    clearKnownHost(options: SshClearKnownHostOptions): Promise<void>;
    addListener(
        event: "sshOutput",
        listenerFunc: (data: SshOutputEvent) => void
    ): Promise<PluginListenerHandle>;
}

export const SshPlugin = registerPlugin<SshPlugin>("SshPlugin");

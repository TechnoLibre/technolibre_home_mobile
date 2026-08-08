import { registerPlugin } from "@capacitor/core";

export interface SmsSimInfo {
    subscriptionId: number;
    carrier: string;
    slot: number;
}

export interface SmsCapabilities {
    hasSendPermission: boolean;
    hasReceivePermission: boolean;
    androidSdk: number;
    deviceModel: string;
    /** Plafond imposé par Android : 30 segments par minute et par application. */
    segmentLimitPerMinute: number;
    isDefaultSmsApp: boolean;
    simReady: boolean;
    sims: SmsSimInfo[];
}

export interface SmsPermissionResult {
    hasSendPermission: boolean;
    hasReceivePermission: boolean;
}

export interface SmsConfigureOptions {
    /**
     * URL de l'instance Odoo que le téléphone interrogera.
     *
     * HTTPS obligatoire, sauf pour une adresse non routable — bouclage ou
     * `10.0.2.2`, l'hôte vu depuis un émulateur — tolérée pour le développement.
     */
    odooBaseUrl: string;
    /** Secret partagé avec Odoo, servant à signer les échanges. */
    hmacSecret: string;
    /** Identifiant que la fiche passerelle d'Odoo attend. */
    deviceId: string;
    /** SIM à utiliser sur un appareil multi-SIM. -1 pour la SIM par défaut. */
    subscriptionId?: number;
    /**
     * Le journal retient-il le corps des messages et les numéros complets ?
     *
     * Faux par défaut. L'activer écrit des données de membres sur un appareil
     * qui peut être perdu ou volé ; les métadonnées et les états, eux, sont
     * toujours journalisés et suffisent à presque toutes les pannes.
     */
    journalKeepsBodies?: boolean;
}

/** Catégories d'entrées du journal, telles que les écrit le service Android. */
export type SmsJournalCategory =
    | "cycle"
    | "send"
    | "receipt"
    | "inbound"
    | "network"
    | "config";

export interface SmsJournalEntry {
    id: number;
    /** Horodatage en millisecondes. */
    at: number;
    level: "info" | "warn" | "error";
    category: SmsJournalCategory;
    message: string;
    /** Envoi concerné, quand il y en a un. */
    smsUuid: string | null;
    /** Détail sensible — vide tant que `journalKeepsBodies` est faux. */
    detail: string | null;
}

export interface SmsJournalPage {
    entries: SmsJournalEntry[];
    /** Nombre total d'entrées conservées, au-delà de celles renvoyées. */
    count: number;
    /** Octets réellement occupés par la base de la passerelle. */
    usedBytes: number;
    keepsBodies: boolean;
}

export interface SmsJournalQuery {
    category?: SmsJournalCategory;
    limit?: number;
}

export interface SmsGatewayStatus {
    enabled: boolean;
    configured: boolean;
    running: boolean;
    /** Vrai tant que la dernière interrogation du serveur a abouti. */
    connected: boolean;
    /** Horodatage de la dernière interrogation réussie, en millisecondes. */
    lastPollAt: number;
    pending: number;
    spooledReports: number;
    segmentsLastMinute: number;
    segmentsPerMinute: number;
    /** Rythme d'interrogation, en secondes. Piloté par le serveur. */
    pollSeconds: number;
    hasSendPermission: boolean;
    lastError: string;
    connectionError: string;
}

export interface SmsGatewayPlugin {
    getCapabilities(): Promise<SmsCapabilities>;
    requestSmsPermissions(): Promise<SmsPermissionResult>;
    configure(options: SmsConfigureOptions): Promise<void>;
    startGateway(): Promise<void>;
    stopGateway(): Promise<void>;
    getStatus(): Promise<SmsGatewayStatus>;
    kick(): Promise<void>;
    clearLastError(): Promise<void>;
    journalEntries(query?: SmsJournalQuery): Promise<SmsJournalPage>;
    clearJournal(): Promise<{ deleted: number }>;
}

export const SmsGatewayPlugin = registerPlugin<SmsGatewayPlugin>("SmsGateway");

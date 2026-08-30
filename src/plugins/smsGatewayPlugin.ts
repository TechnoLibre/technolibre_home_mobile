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
    /**
     * L'application est-elle dispensée des optimisations de batterie ?
     *
     * C'est le facteur décisif du cadencement. Mesure sur Pixel 2 XL : sans
     * dispense, un cycle réglé à 30 s tient 30 s en régime normal mais
     * s'ouvre à plus de deux minutes dès que l'appareil s'assoupit.
     */
    dozeExempt: boolean;
    /** Android 12+ : les alarmes exactes exigent une permission. */
    canScheduleExactAlarms: boolean;
    /** Le HTTP en clair vers le réseau local est-il toléré ? */
    allowPlainLan: boolean;
    /** La mélodie de démonstration joue-t-elle pendant les appels ? */
    demoCallAudio: boolean;
    /**
     * L'application tient-elle le rôle de composeur par défaut ?
     *
     * Sonde en cours d'évaluation. Le rôle donne l'instant exact du décroché,
     * que l'état de ligne ordinaire ne signale pas — mais il fait aussi de
     * notre écran le SEUL écran d'appel du téléphone.
     */
    dialerRoleHeld: boolean;
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
    /**
     * Tolérer le HTTP en clair vers une adresse privée du réseau local.
     *
     * Faux par défaut. L'activer expose numéros et messages à quiconque
     * partage le réseau ; même activé, une adresse publique en clair reste
     * refusée.
     */
    allowPlainLan?: boolean;
    /**
     * Diffuser une mélodie pendant un appel, par couplage acoustique.
     *
     * Faux par défaut, et **démonstration uniquement**. Android n'offre aucune
     * interface pour injecter du son dans un appel cellulaire : le téléphone
     * passe sur haut-parleur et son propre microphone reprend la mélodie.
     * L'annulation d'écho combat ce montage, le rendu est étouffé. Ne pas s'en
     * servir pour une annonce à des membres.
     */
    demoCallAudio?: boolean;
}

/** Catégories d'entrées du journal, telles que les écrit le service Android. */
export type SmsJournalCategory =
    | "cycle"
    | "send"
    | "receipt"
    | "inbound"
    | "network"
    | "config"
    | "service";

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
    /**
     * Ouvre le dialogue système proposant de nous confier le rôle de composeur.
     *
     * Résout quand l'utilisatrice a répondu, avec `granted` disant ce qu'elle a
     * choisi. Le dialogue est celui d'Android : nous ne pouvons ni le
     * contourner, ni présumer de la réponse.
     */
    requestDialerRole(): Promise<{ granted: boolean }>;
    /** Conduit à l'écran système où le rôle se rend. */
    releaseDialerRole(): Promise<void>;
    kick(): Promise<void>;
    clearLastError(): Promise<void>;
    journalEntries(query?: SmsJournalQuery): Promise<SmsJournalPage>;
    requestBatteryExemption(): Promise<{ alreadyExempt: boolean; opened?: boolean }>;
    requestExactAlarms(): Promise<{ alreadyGranted: boolean; opened?: boolean }>;
    clearJournal(): Promise<{ deleted: number }>;
}

export const SmsGatewayPlugin = registerPlugin<SmsGatewayPlugin>("SmsGateway");

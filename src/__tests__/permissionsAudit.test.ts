import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_TREE, type FeatureNode } from "../data/featureCatalog";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = resolve(ROOT, "android/app/src/main/AndroidManifest.xml");

// Logical permission name (used in featureCatalog.ts) → Android
// permission strings that satisfy it. Either-or list: at least one
// must be present in the manifest (or plugin-provided).
const LOGICAL_TO_ANDROID: Record<string, string[]> = {
    camera:        ["android.permission.CAMERA"],
    microphone:    ["android.permission.RECORD_AUDIO"],
    location:      [
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
    ],
    internet:      ["android.permission.INTERNET"],
    notifications: ["android.permission.POST_NOTIFICATIONS"],
    biometric:     [
        "android.permission.USE_BIOMETRIC",
        "android.permission.USE_FINGERPRINT",
    ],
    sms:           [
        "android.permission.SEND_SMS",
        "android.permission.RECEIVE_SMS",
    ],
    // Sert uniquement a nommer les cartes SIM d'un appareil multi-SIM. Son
    // refus n'empeche pas l'envoi par la SIM par defaut, mais elle donne acces
    // a l'identite de la ligne : elle merite d'etre reclamee par une feature
    // plutot que rangee dans l'infrastructure.
    phone_state:   ["android.permission.READ_PHONE_STATE"],
    // Placer un appel engage de l'argent et sort de l'appareil : cette
    // capacite doit etre reclamee par une feature, jamais rangee en infra.
    calls:         ["android.permission.CALL_PHONE"],
    // Le journal d'appels est l'historique COMPLET des correspondants, bien
    // au-dela de l'appel en cours. Android le classe restreinte a ce titre.
    call_log:      ["android.permission.READ_CALL_LOG"],
    // Forcer le haut-parleur pendant un appel. Permission normale, mais elle
    // change ce que les gens autour entendent : elle se reclame.
    audio_routing: ["android.permission.MODIFY_AUDIO_SETTINGS"],
};

// Android perms not expected to map to any catalog logical name —
// infra (wake-lock, foreground-service, legacy storage).
const INFRA_ALLOWLIST = new Set([
    "android.permission.WAKE_LOCK",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
    // Passerelle SMS : mecanique du service, sans capacite visible de
    // l'utilisateur. Ce qui touche a ses donnees — envoi, reception, identite
    // de la ligne — est reclame par la feature, pas alloue ici.
    "android.permission.RECEIVE_BOOT_COMPLETED",
    "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.SCHEDULE_EXACT_ALARM",
    "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
]);

// Android perms merged-in by a Capacitor plugin's own AndroidManifest,
// so they don't appear in the app manifest but are present in the
// installed APK after manifest merging.
const PLUGIN_PROVIDED = new Set([
    "android.permission.CAMERA",
    "android.permission.USE_BIOMETRIC",
    "android.permission.USE_FINGERPRINT",
]);

function flatten(nodes: FeatureNode[]): FeatureNode[] {
    const out: FeatureNode[] = [];
    const walk = (n: FeatureNode) => { out.push(n); n.children?.forEach(walk); };
    nodes.forEach(walk);
    return out;
}

function manifestPerms(): string[] {
    const xml = readFileSync(MANIFEST, "utf8");
    const matches = xml.matchAll(/<uses-permission\s+android:name="([^"]+)"/g);
    return Array.from(matches, (m) => m[1]);
}

function logicalPermsUsedInCatalog(): Set<string> {
    const used = new Set<string>();
    for (const n of flatten(FEATURE_TREE)) {
        for (const p of n.permissions ?? []) used.add(p);
    }
    return used;
}

describe("permissions audit", () => {
    it("every logical perm used in the catalog has a mapping", () => {
        const unmapped: string[] = [];
        for (const p of logicalPermsUsedInCatalog()) {
            if (!LOGICAL_TO_ANDROID[p]) unmapped.push(p);
        }
        expect(unmapped, `add to LOGICAL_TO_ANDROID: ${unmapped.join(", ")}`)
            .toEqual([]);
    });

    it("every used logical perm is granted by manifest or plugin", () => {
        const declared = new Set(manifestPerms());
        const gaps: string[] = [];
        for (const p of logicalPermsUsedInCatalog()) {
            const candidates = LOGICAL_TO_ANDROID[p] ?? [];
            const ok = candidates.some(
                (a) => declared.has(a) || PLUGIN_PROVIDED.has(a),
            );
            if (!ok) gaps.push(`${p} (need one of: ${candidates.join(", ")})`);
        }
        expect(gaps, `unsatisfied logical perms: ${gaps.join("; ")}`).toEqual([]);
    });

    it("every manifest-declared perm has a feature claiming it", () => {
        const reverseMap: Record<string, string> = {};
        for (const [logical, androids] of Object.entries(LOGICAL_TO_ANDROID)) {
            for (const a of androids) reverseMap[a] = logical;
        }
        const used = logicalPermsUsedInCatalog();
        const orphans: string[] = [];
        for (const a of manifestPerms()) {
            if (INFRA_ALLOWLIST.has(a)) continue;
            const logical = reverseMap[a];
            if (!logical || !used.has(logical)) orphans.push(a);
        }
        expect(orphans, `manifest perms with no claiming feature: ${orphans.join(", ")}`)
            .toEqual([]);
    });
});

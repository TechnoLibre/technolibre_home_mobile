import { DatabaseService } from "./databaseService";

/**
 * Customizable CSS variables for the Code tool.
 *
 * Each entry has:
 *   - `cssVar`: the CSS custom property the SCSS reads (with a fallback to a
 *     base theme token, so an unset entry inherits the active theme).
 *   - `defaultValue`: the explicit hex used by SCSS as the var() fallback —
 *     shown in the picker as the "reset" target.
 *   - `prefKey`: the user_graphic_prefs row key.
 *   - `label`: human-readable French name for the Options UI.
 *
 * Adding a new customizable color: append an entry here, register it in the
 * SCSS with `var(--your-var, fallback)`, done.
 */
export interface CodeStyleEntry {
    prefKey: string;
    cssVar: string;
    label: string;
    defaultValue: string;
}

export const CODE_STYLE_ENTRIES: ReadonlyArray<CodeStyleEntry> = [
    { prefKey: "code_edit_btn_bg",       cssVar: "--code-edit-btn-bg",       label: "Bouton « Activer édition »",  defaultValue: "#2f920d" },
    { prefKey: "code_unpromote_btn_bg",  cssVar: "--code-unpromote-btn-bg",  label: "Bouton « Sortir édition »",   defaultValue: "#2a2a2a" },
    { prefKey: "code_commit_btn_bg",     cssVar: "--code-commit-btn-bg",     label: "Bouton « Commit »",           defaultValue: "#2f920d" },
    { prefKey: "code_reset_btn_bg",      cssVar: "--code-reset-btn-bg",      label: "Bouton « Tout annuler »",     defaultValue: "#8a0000" },
    { prefKey: "code_reset_file_btn_bg", cssVar: "--code-reset-file-btn-bg", label: "Bouton ↶ par fichier",        defaultValue: "#2a2a2a" },
    { prefKey: "code_baseline_btn_bg",   cssVar: "--code-baseline-btn-bg",   label: "Bouton « Réinitialiser baseline »", defaultValue: "#2151d3" },
    { prefKey: "code_warning_bg",        cssVar: "--code-warning-bg",        label: "Banner avertissement (fond)", defaultValue: "#1a1100" },
    { prefKey: "code_warning_border",    cssVar: "--code-warning-border",    label: "Banner avertissement (bord)", defaultValue: "#d97706" },
    { prefKey: "code_warning_fg",        cssVar: "--code-warning-fg",        label: "Banner avertissement (texte)", defaultValue: "#f3f3f3" },
    { prefKey: "code_git_modified_fg",   cssVar: "--code-git-modified-fg",   label: "Fichier modifié (couleur)",   defaultValue: "#d97706" },
    { prefKey: "code_git_staged_fg",     cssVar: "--code-git-staged-fg",     label: "Fichier stagé (couleur)",     defaultValue: "#2563eb" },
    { prefKey: "code_git_untracked_fg",  cssVar: "--code-git-untracked-fg",  label: "Fichier non suivi (couleur)", defaultValue: "#31d53d" },
    { prefKey: "code_git_deleted_fg",    cssVar: "--code-git-deleted-fg",    label: "Fichier supprimé (couleur)",  defaultValue: "#8a0000" },
    { prefKey: "code_git_diff_bg",       cssVar: "--code-git-diff-bg",       label: "Diff (fond)",                 defaultValue: "#0a0a0a" },
];

/**
 * Persists per-user color overrides for the Code tool and applies them as
 * CSS custom properties on document.documentElement. Loaded at app boot so
 * the user's choices take effect before the first render.
 */
export class CodeStyleService {
    constructor(private readonly db: DatabaseService) {}

    /** Read every override from SQLite and apply to the document root. */
    async loadAndApply(): Promise<void> {
        for (const entry of CODE_STYLE_ENTRIES) {
            const value = await this.db.getUserGraphicPref(entry.prefKey);
            if (value && /^#[0-9a-fA-F]{3,8}$/.test(value)) {
                document.documentElement.style.setProperty(entry.cssVar, value);
            }
        }
    }

    /** Persist + apply a single override. */
    async setColor(prefKey: string, value: string): Promise<void> {
        const entry = CODE_STYLE_ENTRIES.find((e) => e.prefKey === prefKey);
        if (!entry) throw new Error(`Unknown code style pref: ${prefKey}`);
        if (!/^#[0-9a-fA-F]{3,8}$/.test(value)) {
            throw new Error(`Invalid color: ${value} (expected hex, e.g. #ff8800)`);
        }
        await this.db.setUserGraphicPref(prefKey, value);
        document.documentElement.style.setProperty(entry.cssVar, value);
    }

    /** Drop one override → revert to the SCSS fallback (which is the theme token). */
    async resetColor(prefKey: string): Promise<void> {
        const entry = CODE_STYLE_ENTRIES.find((e) => e.prefKey === prefKey);
        if (!entry) throw new Error(`Unknown code style pref: ${prefKey}`);
        await this.db.setUserGraphicPref(prefKey, "");
        document.documentElement.style.removeProperty(entry.cssVar);
    }

    /** Drop all overrides at once. */
    async resetAll(): Promise<void> {
        for (const entry of CODE_STYLE_ENTRIES) {
            await this.db.setUserGraphicPref(entry.prefKey, "");
            document.documentElement.style.removeProperty(entry.cssVar);
        }
    }

    /** Returns the current value (override if set, default otherwise). */
    async getCurrent(prefKey: string): Promise<string> {
        const stored = await this.db.getUserGraphicPref(prefKey);
        if (stored && /^#[0-9a-fA-F]{3,8}$/.test(stored)) return stored;
        const entry = CODE_STYLE_ENTRIES.find((e) => e.prefKey === prefKey);
        return entry?.defaultValue ?? "#000000";
    }
}

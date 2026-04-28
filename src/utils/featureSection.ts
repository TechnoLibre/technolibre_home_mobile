import { onMounted } from "@odoo/owl";

/**
 * Wire an Options sub-component to the location hash. When the page
 * mounts with `#<sectionId>` matching, run `autoExpand()` (typically
 * to flip the panel's expanded flag to true) and smooth-scroll the
 * matching DOM element into view on the next frame.
 *
 * The DOM element must carry `id="<sectionId>"` for the scroll to
 * land. Pair this with the matching attribute in the template.
 */
export function useFeatureSection(sectionId: string, autoExpand: () => void): void {
    onMounted(() => {
        if (typeof window === "undefined") return;
        const hash = window.location.hash.replace(/^#/, "");
        if (hash !== sectionId) return;
        try { autoExpand(); } catch { /* swallow — scroll still useful */ }
        // Defer to next frame so expand has rendered before we scroll.
        requestAnimationFrame(() => {
            const el = document.getElementById(sectionId);
            el?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    });
}

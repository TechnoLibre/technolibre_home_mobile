/**
 * The focus of a sheet over the thread (the message menu, who reacted).
 * take() moves the focus to the sheet's panel, unless a text field holds
 * it: the composer keeps it, and the keyboard stays open. give() puts it
 * back on the element that held it, when the focus is still in the sheet
 * or nowhere (body): a choice that moved it elsewhere, as Reply to the
 * composer, keeps that place.
 */
export class SheetFocus {
    private before: HTMLElement | null = null;

    take(panel: HTMLElement | null | undefined): void {
        const active = document.activeElement;
        this.before = active instanceof HTMLElement && active !== document.body ? active : null;
        if (this.before?.matches("textarea, input, [contenteditable='true']")) return;
        panel?.focus();
    }

    give(panel: HTMLElement | null | undefined): void {
        const before = this.before;
        this.before = null;
        if (!before || !before.isConnected) return;
        const active = document.activeElement;
        if (active === null || active === document.body || (!!panel && panel.contains(active))) before.focus();
    }
}

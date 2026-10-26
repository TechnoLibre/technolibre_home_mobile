const UNITS_FR = ["o", "Ko", "Mo", "Go"];
const UNITS_EN = ["B", "KB", "MB", "GB"];

/**
 * A size for the user, by steps of 1024: o/Ko/Mo/Go in French (lang
 * starting with "fr"), B/KB/MB/GB otherwise. Bytes and KB are whole
 * numbers; from 1 MB up to one decimal, in the language's own decimal mark
 * ("1,3 Mo", "1.3 MB", "128 MB"). A value that rounds to 1024 of a unit is
 * shown in the next one. Number and unit are joined by a no-break space.
 */
export function formatBytes(bytes: number, lang: string): string {
    const french = lang.toLowerCase().startsWith("fr");
    const units = french ? UNITS_FR : UNITS_EN;
    let value = Math.max(0, bytes);
    let unit = 0;
    while (unit < units.length - 1 && value >= 1024) {
        value /= 1024;
        unit++;
    }
    const digits = (u: number) => (u >= 2 ? 1 : 0);
    const rounded = (v: number, u: number) => Math.round(v * 10 ** digits(u)) / 10 ** digits(u);
    if (unit < units.length - 1 && rounded(value, unit) >= 1024) {
        value /= 1024;
        unit++;
    }
    const number = new Intl.NumberFormat(french ? "fr" : "en", {
        maximumFractionDigits: digits(unit),
        useGrouping: false,
    }).format(rounded(value, unit));
    return number + " " + units[unit];
}

import type { Application } from "../../models/application";

/** The only Odoo major version the chat speaks. */
export const CHAT_MAJOR = 18;

/** Major number of an Odoo version string ("18.0", "18.0+e", "saas~17.4"), null when there is none. */
export function parseOdooMajor(version: string): number | null {
  const m = /(\d+)\.\d+/.exec(version) ?? /(\d+)/.exec(version);
  return m ? Number(m[1]) : null;
}

export type ChoiceMode = "unavailable" | "none" | "chips" | "dropdown";

/** How the user picks a server: nothing to pick (0, 1), chips (2 to 4), a dropdown (5 or more). */
export function serverChoiceMode(n: number): ChoiceMode {
  if (n <= 0) return "unavailable";
  if (n === 1) return "none";
  return n <= 4 ? "chips" : "dropdown";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * One short label per source, in input order, distinct from the others.
 * Each source starts with the first DNS label of its host
 * ("https://bureau.example.org" gives "bureau"). A group of sources that
 * share a label is widened, the other sources keeping theirs, one step at a
 * time and each step applied again to the groups still colliding:
 * the full host, then "host/database", then "label · user" with the first
 * DNS label (two accounts of one database).
 */
export function sourceLabels(apps: Pick<Application, "url" | "username" | "database">[]): string[] {
  const hosts = apps.map((a) => hostOf(a.url));
  const steps: ((i: number) => string)[] = [
    (i) => hosts[i].split(".")[0],
    (i) => hosts[i],
    (i) => hosts[i] + "/" + apps[i].database,
    (i) => hosts[i].split(".")[0] + " · " + apps[i].username,
  ];
  const labels = apps.map((_, i) => steps[0](i));
  let colliding = apps.map((_, i) => i);
  for (let step = 1; step < steps.length; step++) {
    const groups = new Map<string, number[]>();
    for (const i of colliding) groups.set(labels[i], [...(groups.get(labels[i]) ?? []), i]);
    colliding = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const i of group) labels[i] = steps[step](i);
      colliding.push(...group);
    }
  }
  return labels;
}

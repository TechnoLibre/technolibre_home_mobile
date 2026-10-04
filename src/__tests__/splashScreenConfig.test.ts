import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `launchAutoHide: false` fait poser au greffon un OnPreDrawListener qui
 * refuse TOUT dessin du contenu de l'activité, et désactive la minuterie qui
 * le retirerait. Seul `hide()` le retire alors, et seulement s'il le trouve
 * déjà posé — or la pose se fait sur le fil d'interface pendant que `hide()`
 * part de la première ligne du démarrage. Celui qui gagne la course décide si
 * l'application paraîtra : un lancement sur deux restait sur l'écran de
 * démarrage, JavaScript terminé, fil principal inactif, rien de peint.
 *
 * Remettre ce réglage à faux ramène la panne, et elle ne se voit ni à la
 * compilation ni aux tests de rendu. D'où ce garde-fou, qui porte sa raison.
 */
describe("Configuration de l'écran de démarrage", () => {
  const config = JSON.parse(
    readFileSync(resolve(__dirname, "../../capacitor.config.json"), "utf-8"),
  );
  const splash = config?.plugins?.SplashScreen ?? {};

  it("laisse le greffon effacer son écran de lui-même", () => {
    expect(splash.launchAutoHide).not.toBe(false);
  });

  it("borne la durée d'affichage, qui libère le dessin", () => {
    expect(typeof splash.launchShowDuration).toBe("number");
    expect(splash.launchShowDuration).toBeGreaterThan(0);
    expect(splash.launchShowDuration).toBeLessThanOrEqual(3000);
  });
});

import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { getMigrationHistory, MigrationHistoryEntry } from "../../../services/migrationService";
import { EnhancedComponent } from "../../../js/enhancedComponent";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export class OptionsMigrationHistoryComponent extends EnhancedComponent {
  static template = xml`
    <li id="migration-history" class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onShowHistoryClick">
        🗃️ Historique migrations
      </a>
    </li>
  `;

  async onShowHistoryClick() {
    let message: string;

    try {
      const history: MigrationHistoryEntry[] = await getMigrationHistory();

      if (history.length === 0) {
        message = "Aucune migration enregistrée.";
      } else {
        message = history.map((entry, i) => {
          const lines: string[] = [];
          lines.push(`${i + 1}. v${entry.fromVersion} → v${entry.version}`);
          if (entry.description) lines.push(`   ${entry.description}`);
          lines.push(`   Le ${formatDate(entry.executedAt)}`);
          lines.push(`   Durée : ${entry.durationMs} ms`);

          const countEntries = Object.entries(entry.counts);
          if (countEntries.length > 0) {
            for (const [entity, c] of countEntries) {
              const total = c.migrated + c.skipped;
              if (total > 0) {
                lines.push(`   ${entity} : ${c.migrated}/${total} migrée(s)`);
              }
            }
          }
          return lines.join("\n");
        }).join("\n\n");
      }
    } catch (error: unknown) {
      message = `Erreur lors de la lecture de l'historique:\n${error}`;
    }

    await Dialog.alert({
      title: `Historique migrations`,
      message,
    });
  }
}

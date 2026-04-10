import { onMounted, useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";

export class OptionsSQLiteTablesComponent extends EnhancedComponent {
	state: any;

	setup() {
		this.state = useState({ tables: [] as { name: string; count: number }[], loading: true });
		onMounted(this.loadTables.bind(this));
	}

	async loadTables() {
		try {
			this.state.tables = await this.databaseService.getTablesInfo();
		} catch { /* ignore */ } finally {
			this.state.loading = false;
		}
	}

	async showColumns(tableName: string) {
		try {
			const cols = await this.databaseService.getTableColumns(tableName);
			if (cols.length === 0) {
				await Dialog.alert({ title: tableName, message: "Aucune colonne trouvée." });
				return;
			}
			const lines = cols.map((c) => {
				const pk = c.pk ? " 🔑" : "";
				const nn = c.notnull ? " NOT NULL" : "";
				const def = c.dflt_value !== null && c.dflt_value !== undefined
					? ` DEFAULT ${c.dflt_value}` : "";
				return `${c.name}  [${c.type}${nn}${def}${pk}]`;
			});
			await Dialog.alert({ title: `${tableName} — colonnes`, message: lines.join("\n") });
		} catch (e: unknown) {
			await Dialog.alert({ title: tableName, message: String(e) });
		}
	}

	static template = xml`
		<li class="options-list__item options-sqlite-tables">
			<div class="options-sqlite-tables__header">Tables SQLite</div>
			<ul class="options-sqlite-tables__list">
				<li t-if="state.loading" class="options-sqlite-tables__loading">Chargement…</li>
				<li
					t-foreach="state.tables"
					t-as="tbl"
					t-key="tbl.name"
					class="options-sqlite-tables__table-btn"
					t-on-click="() => this.showColumns(tbl.name)"
				>
					<span class="options-sqlite-tables__table-name" t-esc="tbl.name" />
					<span class="options-sqlite-tables__table-count" t-esc="tbl.count + ' ligne(s)'" />
				</li>
			</ul>
		</li>
	`;
}

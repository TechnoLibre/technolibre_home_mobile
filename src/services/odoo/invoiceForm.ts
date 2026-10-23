import { DatabaseService } from "../databaseService";
import { syncConfigIdFor } from "../../models/syncConfig";
import { OdooFieldInfo, OdooRpcClient, SyncCredentials } from "./odooRpcClient";
import type { InvoiceMoveType } from "../syncService";

const INVOICE_MODEL = "account.move";

/** Fields the invoice form always has, or that the server fills from them: never asked again. */
const HANDLED_FIELDS = new Set([
  "move_type", "partner_id", "invoice_date", "ref", "invoice_line_ids", "line_ids", "narration",
]);

/** Field types the form can fill. */
const FORM_FIELD_TYPES = new Set([
  "char", "text", "integer", "float", "monetary", "date", "datetime", "boolean", "selection", "many2one",
]);

/** A field of the server the user must fill for a new invoice. */
export interface FormField {
  name: string;
  label: string;
  type: string;
  relation?: string;
  selection?: Array<[string, string]>;
}

/**
 * What a new invoice of one type needs on one server beyond the form's own
 * fields: the required fields the server neither defaults nor computes
 * (fields), and those of a kind the form cannot fill (unsupported: the
 * server will refuse the invoice until a module default covers them).
 */
export interface InvoiceForm {
  fields: FormField[];
  unsupported: string[];
  /** The form comes from the cache: offline, or the server did not answer. */
  fromCache: boolean;
  error: string | null;
}

/**
 * The required fields of account.move a user must fill: required, not
 * readonly, not computed or related (depends is empty: the server derives
 * the others, such as the journal, the currency or the date), without a
 * server default (defaults: the names default_get answered), and not one
 * of the form's own fields. Each is a FormField when its type can be
 * filled, else its label goes to unsupported.
 */
export function extraFields(
  fields: Record<string, OdooFieldInfo>,
  defaults: Set<string>
): { fields: FormField[]; unsupported: string[] } {
  const result: { fields: FormField[]; unsupported: string[] } = { fields: [], unsupported: [] };
  for (const [name, f] of Object.entries(fields)) {
    if (!f.required || f.readonly || (f.depends?.length ?? 0) > 0) continue;
    if (defaults.has(name) || HANDLED_FIELDS.has(name)) continue;
    if (!FORM_FIELD_TYPES.has(f.type)) {
      result.unsupported.push(f.string || name);
      continue;
    }
    result.fields.push({
      name, label: f.string || name, type: f.type,
      ...(f.relation ? { relation: f.relation } : {}),
      ...(f.selection ? { selection: f.selection } : {}),
    });
  }
  return result;
}

/**
 * The value sent for a form field from what was typed (a many2one: the
 * chosen id as text; a boolean: "1" or ""; a datetime: a datetime-local
 * value, in the device's time zone), or why it cannot be sent. An empty
 * required field is refused; a number must parse; a datetime is sent as
 * the server stores it, "YYYY-MM-DD HH:MM:SS" in UTC.
 */
export function fieldValue(field: FormField, text: string): { value: any } | { error: string } {
  const typed = text.trim();
  if (field.type === "boolean") return { value: typed === "1" };
  if (!typed) return { error: `${field.label} est obligatoire.` };
  if (field.type === "datetime") {
    const d = new Date(typed);
    if (Number.isNaN(d.getTime())) return { error: `${field.label} : date et heure attendues.` };
    return { value: d.toISOString().slice(0, 19).replace("T", " ") };
  }
  if (field.type === "integer" || field.type === "many2one") {
    const n = Number(typed);
    return Number.isInteger(n) ? { value: n } : { error: `${field.label} : nombre entier attendu.` };
  }
  if (field.type === "float" || field.type === "monetary") {
    const n = Number(typed.replace(",", "."));
    return Number.isFinite(n) ? { value: n } : { error: `${field.label} : nombre attendu.` };
  }
  if (field.type === "selection" && field.selection && !field.selection.some(([k]) => k === typed)) {
    return { error: `${field.label} : valeur inconnue.` };
  }
  return { value: typed };
}

/**
 * The datetime-local text (device time zone) of a datetime the server
 * stores ("YYYY-MM-DD HH:MM:SS", UTC), to show a kept value again; the text
 * itself when it does not parse.
 */
export function localDatetimeText(value: string): string {
  const d = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** sync_target_prefs kind under which the form of one invoice type is kept for offline. */
function prefKind(moveType: InvoiceMoveType): string {
  return `invoice.form.${moveType}`;
}

/**
 * The extra fields of a new invoice of one type on one server (see
 * extraFields). Online, it reads account.move's fields (fields_get, with
 * depends) and the server's defaults for the required ones (default_get
 * with default_move_type) and keeps the result in sync_target_prefs;
 * offline, or when the server does not answer, it serves the kept one,
 * none when never read.
 */
export class InvoiceFormService {
  constructor(private db: DatabaseService, private rpc: OdooRpcClient) {}

  async load(creds: SyncCredentials, moveType: InvoiceMoveType, options: { online: boolean }): Promise<InvoiceForm> {
    const configId = syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
    let error: string | null = null;
    if (options.online) {
      try {
        const fields = await this.rpc.fieldsGet(creds, INVOICE_MODEL);
        const required = Object.entries(fields).filter(([, f]) => f.required).map(([name]) => name);
        const defaults = await this.rpc.defaultGet(creds, INVOICE_MODEL, required, { default_move_type: moveType });
        const form = extraFields(fields, new Set(Object.keys(defaults ?? {})));
        await this.db.setSyncTargetPref({
          configId, kind: prefKind(moveType), params: form, updatedAt: new Date().toISOString(),
        });
        return { ...form, fromCache: false, error: null };
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const kept = await this.db.getSyncTargetPref(configId, prefKind(moveType));
    return {
      fields: kept?.params.fields ?? [],
      unsupported: kept?.params.unsupported ?? [],
      fromCache: true,
      error,
    };
  }
}

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseService } from "../services/databaseService";
import { extraFields, fieldValue, InvoiceFormService, localDatetimeText } from "../services/odoo/invoiceForm";
import { SyncCredentials } from "../services/odoo/odooRpcClient";
import { addSyncTargetTables } from "../services/migrations/addSyncTargetTables";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };

/** account.move as a server with one custom required field and the usual computed ones. */
const FIELDS: Record<string, any> = {
  journal_id: { type: "many2one", string: "Journal", required: true, relation: "account.journal", depends: ["move_type"] },
  date: { type: "date", string: "Date", required: true, depends: ["invoice_date"] },
  state: { type: "selection", string: "Status", required: true, readonly: true, depends: [] },
  move_type: { type: "selection", string: "Type", required: true, depends: [] },
  partner_id: { type: "many2one", string: "Partner", required: true, relation: "res.partner", depends: [] },
  company_id: { type: "many2one", string: "Company", required: true, relation: "res.company", depends: [] },
  x_site: { type: "many2one", string: "Site", required: true, relation: "x.site", depends: [] },
  x_region: { type: "selection", string: "Region", required: true, selection: [["n", "North"], ["s", "South"]] },
  x_tags: { type: "many2many", string: "Labels", required: true, relation: "x.tag", depends: [] },
  narration: { type: "html", string: "Terms" },
};

describe("extraFields", () => {
  it("asks only the required fields the server neither computes nor defaults, nor the form fills", () => {
    const form = extraFields(FIELDS, new Set(["company_id"]));
    expect(form.fields.map((f) => f.name)).toEqual(["x_site", "x_region"]);
    expect(form.fields[0]).toMatchObject({ type: "many2one", relation: "x.site", label: "Site" });
    expect(form.fields[1].selection).toEqual([["n", "North"], ["s", "South"]]);
    expect(form.unsupported).toEqual(["Labels"]);
  });
});

describe("fieldValue", () => {
  const field = (type: string, extra: any = {}) => ({ name: "x", label: "X", type, ...extra });

  it("converts what was typed to what the server takes", () => {
    expect(fieldValue(field("integer"), " 4 ")).toEqual({ value: 4 });
    expect(fieldValue(field("many2one"), "12")).toEqual({ value: 12 });
    expect(fieldValue(field("monetary"), "12,5")).toEqual({ value: 12.5 });
    expect(fieldValue(field("boolean"), "")).toEqual({ value: false });
    expect(fieldValue(field("char"), " a ")).toEqual({ value: "a" });
  });

  it("sends a datetime in UTC as the server stores it, and shows it back in local time", () => {
    const typed = "2026-11-05T14:30";
    const sentValue = (fieldValue(field("datetime"), typed) as any).value;
    expect(sentValue).toBe(new Date(typed).toISOString().slice(0, 19).replace("T", " "));
    expect(localDatetimeText(sentValue)).toBe(typed);
    expect(fieldValue(field("datetime"), "soon")).toHaveProperty("error");
  });

  it("refuses an empty, malformed or unknown value", () => {
    expect(fieldValue(field("char"), " ")).toHaveProperty("error");
    expect(fieldValue(field("integer"), "1.5")).toHaveProperty("error");
    expect(fieldValue(field("float"), "abc")).toHaveProperty("error");
    expect(fieldValue(field("selection", { selection: [["n", "North"]] }), "w")).toHaveProperty("error");
  });
});

describe("InvoiceFormService", () => {
  let db: DatabaseService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.initialize();
    await addSyncTargetTables(db);
  });

  function rpc(fail = false) {
    const calls: any[] = [];
    return {
      calls,
      fieldsGet: async (_c: any, model: string) => { calls.push(["fields_get", model]); if (fail) throw new TypeError("Failed to fetch"); return FIELDS; },
      defaultGet: async (_c: any, model: string, fields: string[], context: any) => {
        calls.push(["default_get", model, fields, context]);
        return { company_id: 1, move_type: "in_invoice" };
      },
    } as any;
  }

  it("reads the fields and the defaults of the type, and keeps the form for offline", async () => {
    const r = rpc();
    const form = await new InvoiceFormService(db, r).load(CREDS, "in_invoice", { online: true });
    expect(form).toMatchObject({ fromCache: false, error: null, unsupported: ["Labels"] });
    expect(form.fields.map((f) => f.name)).toEqual(["x_site", "x_region"]);
    expect(r.calls[1][3]).toEqual({ default_move_type: "in_invoice" });
    expect(r.calls[1][2]).toContain("x_site");

    const offline = await new InvoiceFormService(db, rpc(true)).load(CREDS, "in_invoice", { online: false });
    expect(offline).toMatchObject({ fromCache: true, error: null });
    expect(offline.fields.map((f) => f.name)).toEqual(["x_site", "x_region"]);
    const other = await new InvoiceFormService(db, rpc(true)).load(CREDS, "out_invoice", { online: true });
    expect(other).toMatchObject({ fromCache: true, error: "Failed to fetch", fields: [] });
  });
});

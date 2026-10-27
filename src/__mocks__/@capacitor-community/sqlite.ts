/**
 * Mock of @capacitor-community/sqlite.
 *
 * Simulates a SQLite database in memory using Maps.
 * Handles basic CREATE TABLE, INSERT, SELECT, UPDATE, DELETE. A SELECT
 * takes `col = ?`, `col != ?`, `col > ?`, `col < ?`,
 * `col LIKE ? ESCAPE '\'` and `col IS NULL` conditions joined by AND, then
 * an optional `ORDER BY col [ASC|DESC][, col [ASC|DESC]]…` (`rowid` is the row's
 * place in the table) and `LIMIT n` or `LIMIT ?`. Anything else (a
 * virtual table, a trigger, sqlite_master) is accepted and does nothing.
 */

/**
 * SQLite's LIKE with an escape character: `%` any run of characters, `_`
 * one character, the escape makes the next character literal; case is
 * folded for ASCII letters only, as SQLite does without ICU. NULL never
 * matches.
 */
function sqliteLike(value: any, pattern: string, escape: string): boolean {
  if (value === null || value === undefined) return false;
  const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let re = "";
  const chars = Array.from(lower(String(pattern)));
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === escape && i + 1 < chars.length) re += chars[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "u").test(lower(String(value)));
}

type Row = Record<string, any>;

class MockDBConnection {
  private tables: Map<string, Row[]> = new Map();
  private columns: Map<string, string[]> = new Map();

  async open() {
    return {};
  }

  async close() {
    return {};
  }

  async execute(sql: string) {
    const createMatch = sql.match(
      /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\((.+)\)/is
    );
    if (createMatch) {
      const table = createMatch[1];
      const colDefs = createMatch[2]
        .split(",")
        .map((c) => c.trim().split(/\s+/)[0]);
      if (!this.tables.has(table)) {
        this.tables.set(table, []);
        this.columns.set(table, colDefs);
      }
    }

    const alterMatch = sql.match(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)(?:.*\bDEFAULT\s+('[^']*'|-?\d+))?/i);
    if (alterMatch) {
      const table = alterMatch[1];
      const col = alterMatch[2];
      // Existing rows take the column's DEFAULT ('' or a number), else null
      const literal = alterMatch[3];
      const fill = literal === undefined ? null : literal.startsWith("'") ? literal.slice(1, -1) : Number(literal);
      const cols = this.columns.get(table) ?? [];
      if (!cols.includes(col)) {
        cols.push(col);
        this.columns.set(table, cols);
        const rows = this.tables.get(table) ?? [];
        rows.forEach((row) => { if (!(col in row)) row[col] = fill; });
      }
    }

    return { changes: { changes: 0 } };
  }

  async run(sql: string, values?: any[]) {
    const insertOrIgnoreMatch = sql.match(
      /INSERT OR IGNORE INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i
    );
    if (insertOrIgnoreMatch && values) {
      const table = insertOrIgnoreMatch[1];
      const cols = insertOrIgnoreMatch[2].split(",").map((c) => c.trim());
      const rows = this.tables.get(table) || [];
      // Ignore if a row with matching first-column value exists (PK check)
      const pkCol = cols[0];
      const pkValue = values[0];
      const exists = rows.some((r) => r[pkCol] === pkValue);
      if (!exists) {
        const row: Row = {};
        cols.forEach((col, i) => { row[col] = values[i]; });
        rows.push(row);
        this.tables.set(table, rows);
        return { changes: { changes: 1 } };
      }
      return { changes: { changes: 0 } };
    }

    const insertOrReplaceMatch = sql.match(
      /INSERT OR REPLACE INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i
    );
    if (insertOrReplaceMatch && values) {
      const table = insertOrReplaceMatch[1];
      const cols = insertOrReplaceMatch[2].split(",").map((c) => c.trim());
      const pkCol = cols[0]; // assume first column is primary key
      const pkValue = values[0];
      const rows = (this.tables.get(table) || []).filter(
        (r) => r[pkCol] !== pkValue
      );
      const row: Row = {};
      cols.forEach((col, i) => { row[col] = values[i]; });
      rows.push(row);
      this.tables.set(table, rows);
      return { changes: { changes: 1 } };
    }

    const insertMatch = sql.match(
      /INSERT INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i
    );
    if (insertMatch && values) {
      const table = insertMatch[1];
      const cols = insertMatch[2].split(",").map((c) => c.trim());
      const row: Row = {};
      cols.forEach((col, i) => {
        row[col] = values[i];
      });
      const rows = this.tables.get(table) || [];
      rows.push(row);
      this.tables.set(table, rows);
      return { changes: { changes: 1 } };
    }

    const deleteMatch = sql.match(
      /DELETE FROM\s+(\w+)\s*WHERE\s+(.+)/i
    );
    if (deleteMatch && values) {
      const table = deleteMatch[1];
      const rows = this.tables.get(table) || [];
      const whereCols = deleteMatch[2]
        .split(/\s+AND\s+/i)
        .map((c) => c.trim().split(/\s*=\s*/)[0]);
      const filtered = rows.filter((row) => {
        return !whereCols.every((col, i) => row[col] === values[i]);
      });
      const changes = rows.length - filtered.length;
      this.tables.set(table, filtered);
      return { changes: { changes } };
    }

    const updateMatch = sql.match(
      /UPDATE\s+(OR\s+REPLACE\s+)?(\w+)\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)/i
    );
    if (updateMatch && values) {
      const orReplace = !!updateMatch[1];
      const table = updateMatch[2];
      const setCols = updateMatch[3]
        .split(",")
        .map((c) => c.trim().split(/\s*=\s*/)[0]);
      const whereCols = updateMatch[4]
        .split(/\s+AND\s+/i)
        .map((c) => c.trim().split(/\s*=\s*/)[0]);
      const whereValues = values.slice(setCols.length);
      const setValues = values.slice(0, setCols.length);
      let rows = this.tables.get(table) || [];
      let changes = 0;
      // OR REPLACE: a row holding the new primary key, other than the updated one, is removed
      const idAt = setCols.indexOf("id");
      if (orReplace && idAt >= 0) {
        const kept = rows.filter(
          (row) => row.id !== setValues[idAt] || whereCols.every((col, i) => row[col] === whereValues[i])
        );
        this.tables.set(table, kept);
        rows = kept;
      }
      rows.forEach((row) => {
        const match = whereCols.every(
          (col, i) => row[col] === whereValues[i]
        );
        if (match) {
          setCols.forEach((col, i) => {
            row[col] = setValues[i];
          });
          changes++;
        }
      });
      return { changes: { changes } };
    }

    return { changes: { changes: 0 } };
  }

  /** Each statement of the set run in order, as one transaction would. */
  async executeSet(set: { statement: string; values?: any[] }[], _transaction?: boolean) {
    let changes = 0;
    for (const s of set) changes += (await this.run(s.statement, s.values ?? [])).changes.changes;
    return { changes: { changes } };
  }

  async query(sql: string, values?: any[]) {
    // PRAGMA table_info(tableName)
    const pragmaMatch = sql.match(/PRAGMA\s+table_info\((\w+)\)/i);
    if (pragmaMatch) {
      const table = pragmaMatch[1];
      const cols = this.columns.get(table) ?? [];
      return { values: cols.map((name) => ({ name })) };
    }

    // SELECT [* | col1, col2, ...] FROM table [WHERE ...]
    const selectMatch = sql.match(
      /SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i
    );
    if (selectMatch) {
      const colList = selectMatch[1].trim();
      const table = selectMatch[2];
      let rows = this.tables.get(table) ?? [];

      let where = selectMatch[3] ?? "";
      const limitMatch = where.match(/\s*\bLIMIT\s+(\d+|\?)\s*$/i);
      if (limitMatch) where = where.slice(0, limitMatch.index);
      const orderMatch = where.match(/\s*\bORDER BY\s+(\w+(?:\s+(?:ASC|DESC))?(?:\s*,\s*\w+(?:\s+(?:ASC|DESC))?)*)\s*$/i);
      if (orderMatch) where = where.slice(0, orderMatch.index);
      const conds = where.trim()
        ? where
            .split(/\s+AND\s+/i)
            .map((c) => {
              const isNull = c.trim().match(/^(\w+)\s+IS\s+NULL$/i);
              if (isNull) return { col: isNull[1], op: "IS NULL", escape: "", at: -1 };
              const m = c.trim().match(/^(\w+)\s*(!=|>|<|=|LIKE)\s*\?(?:\s+ESCAPE\s+'(.)')?$/i);
              return m ? { col: m[1], op: m[2].toUpperCase(), escape: m[3] ?? "", at: 0 } : { col: "", op: "=", escape: "", at: 0 };
            })
        : [];
      // Each `?` condition takes the next value; `IS NULL` takes none
      let bound = 0;
      for (const c of conds) if (c.at >= 0) c.at = bound++;
      if (conds.length > 0 && (values || conds.some((c) => c.at < 0))) {
        const test = (v: any, c: { op: string; escape: string }, x: any): boolean =>
          c.op === "IS NULL" ? v === null || v === undefined
            : c.op === "=" ? v === x : c.op === "!=" ? v !== x : c.op === ">" ? v > x : c.op === "<" ? v < x : sqliteLike(v, x, c.escape);
        rows = rows.filter((row) => conds.every((c) => test(row[c.col], c, c.at >= 0 ? values?.[c.at] : undefined)));
      }
      if (orderMatch) {
        const keys = orderMatch[1].split(",").map((k) => {
          const [col, dir] = k.trim().split(/\s+/);
          return { col, dir: dir?.toUpperCase() === "DESC" ? -1 : 1 };
        });
        // rowid is the place in the table: a row replaced goes last, as SQLite gives it a new rowid
        const at = new Map(rows.map((r, i) => [r, i]));
        const value = (r: Row, col: string) => (col.toLowerCase() === "rowid" ? at.get(r) : r[col]);
        rows = [...rows].sort((a, b) => {
          for (const { col, dir } of keys) {
            const x = value(a, col);
            const y = value(b, col);
            if (x < y) return -dir;
            if (x > y) return dir;
          }
          return 0;
        });
      }
      if (limitMatch) rows = rows.slice(0, Number(limitMatch[1] === "?" ? values?.[bound] : limitMatch[1]));

      if (colList === "*") {
        return { values: rows };
      }

      // COALESCE(SUM(COALESCE(a, 0) + COALESCE(b, 0)), 0) AS alias
      const sumMatch = colList.match(
        /^COALESCE\(SUM\(COALESCE\((\w+), 0\) \+ COALESCE\((\w+), 0\)\), 0\) AS (\w+)$/i
      );
      if (sumMatch) {
        const [, a, b, alias] = sumMatch;
        const total = rows.reduce((sum, row) => sum + (row[a] ?? 0) + (row[b] ?? 0), 0);
        return { values: [{ [alias]: total }] };
      }
      // COALESCE(SUM(a), 0) AS alias
      const sumOne = colList.match(/^COALESCE\(SUM\((\w+)\), 0\) AS (\w+)$/i);
      if (sumOne) {
        const [, a, alias] = sumOne;
        return { values: [{ [alias]: rows.reduce((sum, row) => sum + (row[a] ?? 0), 0) }] };
      }

      // Project specific columns
      const requestedCols = colList.split(",").map((c) => c.trim());
      return {
        values: rows.map((row) => {
          const r: Row = {};
          requestedCols.forEach((col) => { r[col] = row[col] ?? null; });
          return r;
        }),
      };
    }

    return { values: [] };
  }
}

export class SQLiteConnection {
  private connections: Map<string, MockDBConnection> = new Map();

  constructor(_capacitorSQLite: any) {}

  async setEncryptionSecret(_secret: string) {
    return {};
  }

  async checkConnectionsConsistency() {
    return { result: true };
  }

  async isConnection(database: string, _readonly: boolean) {
    return { result: this.connections.has(database) };
  }

  async retrieveConnection(database: string, _readonly: boolean) {
    return this.connections.get(database) ?? new MockDBConnection();
  }

  async createConnection(
    database: string,
    _encrypted: boolean,
    _mode: string,
    _version: number,
    _isReadOnly: boolean
  ) {
    const conn = new MockDBConnection();
    this.connections.set(database, conn);
    return conn;
  }

  async closeConnection(database: string, _isReadOnly: boolean) {
    this.connections.delete(database);
    return {};
  }
}

export const CapacitorSQLite = {};

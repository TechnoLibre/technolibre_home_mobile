/**
 * Mock of @capacitor-community/sqlite.
 *
 * Simulates a SQLite database in memory using Maps.
 * Handles basic CREATE TABLE, INSERT, SELECT, UPDATE, DELETE.
 */

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
    return { changes: { changes: 0 } };
  }

  async run(sql: string, values?: any[]) {
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
      /UPDATE\s+(\w+)\s+SET\s+(.+)\s+WHERE\s+(.+)/i
    );
    if (updateMatch && values) {
      const table = updateMatch[1];
      const setCols = updateMatch[2]
        .split(",")
        .map((c) => c.trim().split(/\s*=\s*/)[0]);
      const whereCols = updateMatch[3]
        .split(/\s+AND\s+/i)
        .map((c) => c.trim().split(/\s*=\s*/)[0]);
      const whereValues = values.slice(setCols.length);
      const setValues = values.slice(0, setCols.length);
      const rows = this.tables.get(table) || [];
      let changes = 0;
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

  async query(sql: string, values?: any[]) {
    const selectMatch = sql.match(
      /SELECT\s+\*\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i
    );
    if (selectMatch) {
      const table = selectMatch[1];
      let rows = this.tables.get(table) || [];
      if (selectMatch[2] && values) {
        const whereCols = selectMatch[2]
          .split(/\s+AND\s+/i)
          .map((c) => c.trim().split(/\s*=\s*/)[0]);
        rows = rows.filter((row) =>
          whereCols.every((col, i) => row[col] === values[i])
        );
      }
      return { values: rows };
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

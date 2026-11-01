export type SqliteValue = string | number | null | Uint8Array;

export interface SqliteStatement {
  sql: string;
  parameters: SqliteValue[][];
}

export interface SqliteTransaction {
  execute(sql: string, parameters?: SqliteValue[]): Promise<Record<string, unknown>[]>;
}

export interface SqliteConnection extends SqliteTransaction {
  transaction<T>(work: (transaction: SqliteTransaction) => Promise<T>): Promise<T>;
  executeBatch(statements: SqliteStatement[]): Promise<void>;
  close(): void;
  /** Removes the database; the WebKit driver wipes the origin's whole store. */
  delete(): void | Promise<void>;
}

export interface SqliteDriver {
  open(): SqliteConnection;
}

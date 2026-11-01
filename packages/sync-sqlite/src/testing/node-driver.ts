import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SqliteDriver, SqliteStatement, SqliteValue } from '../driver.js';

export function createNodeSqliteDriver(path: string): SqliteDriver {
  return {
    open() {
      const database = new DatabaseSync(path);
      return {
        execute(sql: string, parameters: SqliteValue[] = []) {
          return Promise.resolve(database.prepare(sql).all(...parameters));
        },
        executeBatch(statements: SqliteStatement[]) {
          database.exec('BEGIN IMMEDIATE');
          try {
            for (const { sql, parameters } of statements) {
              const statement = database.prepare(sql);
              for (const values of parameters) statement.run(...values);
            }
            database.exec('COMMIT');
            return Promise.resolve();
          } catch (error) {
            database.exec('ROLLBACK');
            return Promise.reject(new Error('SQLite batch failed', { cause: error }));
          }
        },
        async transaction(work) {
          database.exec('BEGIN IMMEDIATE');
          try {
            const value = await work({
              execute(sql, parameters = []) {
                return Promise.resolve(database.prepare(sql).all(...parameters));
              },
            });
            database.exec('COMMIT');
            return value;
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
        },
        close() {
          database.close();
        },
        delete() {
          for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
        },
      };
    },
  };
}

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { CURRENT_SCHEMA_VERSION, migrations } from './migrations/index.ts';

export type SqlRow = Record<string, unknown>;

function assertSafeDatabasePath(databasePath: string): string {
  if (!databasePath.trim()) throw new Error('databasePath is required');
  const absolute = resolve(databasePath);
  if (!isAbsolute(absolute)) throw new Error('databasePath must resolve to an absolute path');
  if (absolute === resolve(absolute, '..')) throw new Error('Refusing to use a filesystem root as a database path');
  return absolute;
}

export class LedgerDatabase {
  readonly path: string;
  readonly sqlite: DatabaseSync;
  private transactionDepth = 0;

  constructor(databasePath: string, busyTimeoutMs = 10_000) {
    this.path = assertSafeDatabasePath(databasePath);
    mkdirSync(dirname(this.path), { recursive: true });
    this.sqlite = new DatabaseSync(this.path, {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
    });
    this.sqlite.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.sqlite.exec('PRAGMA journal_mode = WAL');
    this.sqlite.exec('PRAGMA synchronous = FULL');
    this.sqlite.exec('PRAGMA wal_autocheckpoint = 1000');
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE'): void {
    this.sqlite.exec(`PRAGMA wal_checkpoint(${mode})`);
  }

  run(sql: string, values: readonly SQLInputValue[] = []): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.sqlite.prepare(sql).run(...values);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get<T extends SqlRow>(sql: string, values: readonly SQLInputValue[] = []): T | undefined {
    return this.sqlite.prepare(sql).get(...values) as T | undefined;
  }

  all<T extends SqlRow>(sql: string, values: readonly SQLInputValue[] = []): T[] {
    return this.sqlite.prepare(sql).all(...values) as T[];
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) {
      const savepoint = `ledger_nested_${this.transactionDepth}`;
      this.transactionDepth += 1;
      this.sqlite.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = operation();
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          throw new TypeError('LedgerDatabase.transaction only accepts synchronous callbacks');
        }
        this.sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        this.sqlite.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }

    this.transactionDepth = 1;
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new TypeError('LedgerDatabase.transaction only accepts synchronous callbacks');
      }
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
    const current = this.get<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
    )?.version ?? 0;
    if (current > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Ledger schema ${current} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
      );
    }
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      this.transaction(() => {
        const alreadyApplied = this.get<{ version: number }>(
          'SELECT version FROM schema_migrations WHERE version=?',
          [migration.version],
        );
        if (alreadyApplied) return;
        this.sqlite.exec(migration.sql);
        this.run(
          'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
          [migration.version, migration.name, new Date().toISOString()],
        );
      });
    }
    this.sqlite.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  }
}

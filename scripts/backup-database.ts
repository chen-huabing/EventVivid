import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
const outputDirectory = process.argv[2];
if (!connectionString || !outputDirectory) throw new Error('Usage: tsx scripts/backup-database.ts <output-directory> (DATABASE_URL required)');

const target = new URL(connectionString);
const client = new Client({ connectionString });
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

async function backup() {
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const identity = await client.query('SELECT current_database() AS database_name, current_user AS database_user');
    const tables = await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    const snapshot: Record<string, unknown[]> = {};
    for (const { tablename } of tables.rows) {
      const result = await client.query<{ row: unknown }>(`SELECT to_jsonb(t) AS row FROM public.${quoteIdentifier(tablename)} AS t`);
      snapshot[tablename] = result.rows.map((item) => item.row);
    }
    await client.query('COMMIT');

    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const directory = resolve(outputDirectory);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `eventvivid-${stamp}.json`);
    writeFileSync(path, JSON.stringify({
      format: 'EventVivid PostgreSQL table-data snapshot v1',
      capturedAt: new Date().toISOString(),
      server: target.hostname,
      database: identity.rows[0].database_name,
      databaseUser: identity.rows[0].database_user,
      tables: snapshot,
    }), { flag: 'wx' });
    console.log(JSON.stringify({ path, tables: Object.fromEntries(Object.entries(snapshot).map(([name, rows]) => [name, rows.length])) }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

void backup().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

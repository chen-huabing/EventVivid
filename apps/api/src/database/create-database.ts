import './load-env';
import { Client } from 'pg';

const databaseName = 'eventvivid';

async function createDatabase() {
  const connectionString = process.env.ADMIN_DATABASE_URL;
  if (!connectionString) throw new Error('ADMIN_DATABASE_URL is required');
  const client = new Client({ connectionString, connectionTimeoutMillis: 10000 });
  await client.connect();
  const existing = await client.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
    [databaseName],
  );
  if (!existing.rows[0]?.exists) {
    await client.query('CREATE DATABASE eventvivid ENCODING \'UTF8\' TEMPLATE template0');
    console.log('Created database: eventvivid');
  } else {
    console.log('Database already exists: eventvivid');
  }
  await client.end();
}

void createDatabase();

import './load-env';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

async function seedHqAdmin() {
  const username = process.env.HQ_ADMIN_USERNAME ?? 'admin';
  const password = process.env.HQ_ADMIN_PASSWORD;
  if (!password) throw new Error('HQ_ADMIN_PASSWORD is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const passwordHash = await bcrypt.hash(password, 12);
  await client.query(
    `INSERT INTO platform_users(id, username, display_name, password_hash, role, status)
     VALUES ($1, $2, '总部超级管理员', $3, 'super_admin', 'active')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'`,
    [randomUUID(), username, passwordHash],
  );
  await client.end();
  console.log('Headquarters administrator initialized.');
}

void seedHqAdmin();

import './load-env';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';

async function seedTenantAdmin() {
  const username = process.env.TENANT_ADMIN_USERNAME ?? 'tenantadmin';
  const password = process.env.TENANT_ADMIN_PASSWORD;
  if (!password) throw new Error('TENANT_ADMIN_PASSWORD is required');
  const passwordHash = await bcrypt.hash(password, 12);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(
    `UPDATE users SET username = $1, password_hash = $2, status = 'active'
     WHERE id = '00000000-0000-4000-8000-000000000002'`,
    [username, passwordHash],
  );
  await client.end();
  console.log('Tenant administrator initialized.');
}

void seedTenantAdmin();

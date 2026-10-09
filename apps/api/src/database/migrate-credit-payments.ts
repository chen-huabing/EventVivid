import './load-env';
import { Client } from 'pg';
import { creditPaymentsSql } from './credit-payments.sql';
async function migrate() {
 const client=new Client({connectionString:process.env.DATABASE_URL});
 await client.connect();
 try {await client.query('BEGIN');await client.query(creditPaymentsSql);await client.query('COMMIT');console.log('Credit payment tables migrated (no seeds or credit changes).');}
 catch(error){await client.query('ROLLBACK');throw error;} finally{await client.end();}
}
void migrate();

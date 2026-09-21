import './load-env';
import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './schema';

export const DATABASE = Symbol('DATABASE');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://eventvivid:eventvivid@localhost:5432/eventvivid',
  max: 10,
});
const database = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

@Injectable()
class DatabaseLifecycle implements OnModuleDestroy {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}
  async onModuleDestroy() { await this.db.destroy(); }
}

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: database }, DatabaseLifecycle], exports: [DATABASE] })
export class DatabaseModule {}

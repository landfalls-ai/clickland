import { configFromEnv, migrateClickhouse, migratePostgres } from './index.js';

const config = configFromEnv();
const ch = await migrateClickhouse(config, console.log);
const pg = await migratePostgres(config, console.log);
console.log(`Migrations: ${ch.length} ClickHouse, ${pg.length} Postgres applied.`);

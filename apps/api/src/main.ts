import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createClients } from './clients.js';
import { configFromEnv } from './config.js';
import { createServices, startBackgroundJobs } from './services.js';

const config = configFromEnv();
const clients = createClients(config);
const services = createServices(config, clients);
const viewHtmlPath =
  process.env.CLICKLAND_VIEW_HTML ?? fileURLToPath(new URL('../../views/dist/view.html', import.meta.url));
const app = await buildApp(services, { viewHtmlPath, logger: process.env.CLICKLAND_LOG !== 'off' });

const stopJobs = config.backgroundJobs
  ? startBackgroundJobs(services, (msg, err) => app.log.error({ err }, msg))
  : () => {};

const shutdown = async (signal: string) => {
  app.log.info(`${signal}: shutting down`);
  stopJobs();
  await app.close();
  await clients.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
if (config.authMode === 'dev')
  app.log.warn('CLICKLAND_AUTH=dev: calls without an API key act as an admin (local only)');

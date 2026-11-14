/**
 * `pnpm scim:token [--name Landbright] [--out ~/.config/land-family/clickland-scim.env] [--url http://127.0.0.1:4710/scim/v2]`
 *
 * Mints a SCIM token for Landbright and writes it to an env file (mode 600, its folder 700) as CLICKLAND_SCIM_URL and
 * CLICKLAND_SCIM_TOKEN. The token is never printed; Clickland keeps only its sha256.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { ScimTokens } from './scim.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string', default: 'Landbright' },
    out: { type: 'string', default: '~/.config/land-family/clickland-scim.env' },
    url: { type: 'string', default: 'http://127.0.0.1:4710/scim/v2' },
  },
});

if (positionals[0] !== 'scim-token') {
  console.error('Usage: cli scim-token [--name Landbright] [--out <env file>] [--url <SCIM base URL>]');
  process.exit(2);
}

const out = values.out.startsWith('~/') ? `${homedir()}${values.out.slice(1)}` : values.out;
const pg = postgres(process.env.CLICKLAND_PG_URL ?? 'postgres://clickland:clickland-dev@127.0.0.1:25432/clickland', {
  max: 1,
  onnotice: () => {},
});
try {
  const minted = await new ScimTokens(pg).create(values.name);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  chmodSync(dirname(out), 0o700);
  writeFileSync(out, `CLICKLAND_SCIM_URL=${values.url}\nCLICKLAND_SCIM_TOKEN=${minted.token}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`SCIM token ${minted.id} ("${minted.name}") written to ${out} (mode 600).`);
} finally {
  await pg.end();
}

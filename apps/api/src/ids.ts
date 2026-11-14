import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz';

/** A prefixed random id (`al_…`, `wh_…`, `vw_…`): 20 characters from a 54-letter alphabet, ~115 bits. */
export function newId(prefix: string): string {
  const bytes = randomBytes(20);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

import fs from 'node:fs/promises';
import path from 'node:path';

// Immutable, content-addressed review evidence: unrelated branches add distinct
// files instead of rewriting one shared stamp or every authored action contract.
// A merge's combined sources still require their own receipt; checks never mint it.
export async function syncReviewReceipt(root, kind, revision, details, check = false) {
  if (!['back', 'search'].includes(kind) || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new Error('Invalid UI review receipt identity');
  }
  const file = path.join(root, 'contracts/ui-review', kind, `${revision}.json`);
  const expected = JSON.stringify({ schema_version: 'ui.review.v1', kind, source_revision: revision, ...details }, null, 2) + '\n';
  let actual;
  try { actual = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (actual?.replace(/\r\n?/g, '\n') === expected) return;
  if (actual !== undefined) throw new Error(`Invalid immutable ${kind} review receipt: ${file}`);
  if (check) throw new Error(`${kind} source review is stale; review the combined behavior, run npm run build:ui-contracts and commit its review receipt.`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, expected, { flag: 'wx' });
}

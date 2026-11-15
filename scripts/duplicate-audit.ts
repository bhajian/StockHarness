// Read-only audit (#416): documents of a Layer 1 collection that share their dataset's upsert key. Every sync
// writes idempotent upserts on that key, so a re-run (or a resumed run) must never add a second document;
// this checks the live data says so. It never writes.
//   MONGODB_URI=... node --import tsx scripts/duplicate-audit.ts --db oh_ws_<id>
//   MONGODB_URI=... node --import tsx scripts/duplicate-audit.ts --db oh_ws_<id> --json
import { MongoClient, type Db } from 'mongodb';
import { DATASET_CATALOG } from '../packages/core/src/datasetCatalog.js';

export type DuplicateRow = {
  collection: string;
  key: string[];
  documents: number;
  /** Key values held by more than one document, and the documents beyond the first of each. */
  duplicateKeys: number;
  extraDocuments: number;
  error?: string;
};

/** One entry per collection a catalog dataset writes to (datasets sharing a collection share its key). */
export function auditTargets(): { collection: string; key: string[] }[] {
  const by = new Map<string, string[]>([
    // Side output of the universe sync.
    ['delisted_companies', ['symbol', 'delistedDate']],
  ]);
  for (const d of DATASET_CATALOG) if (!by.has(d.defaultCollection)) by.set(d.defaultCollection, d.keyFields);
  return [...by.entries()]
    .map(([collection, key]) => ({ collection, key }))
    .sort((a, b) => a.collection.localeCompare(b.collection));
}

export async function auditDuplicates(db: Db, opts: { maxTimeMS?: number } = {}): Promise<DuplicateRow[]> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const out: DuplicateRow[] = [];
  for (const { collection, key } of auditTargets()) {
    if (!existing.has(collection)) continue;
    const coll = db.collection(collection);
    const row: DuplicateRow = {
      collection,
      key,
      documents: await coll.estimatedDocumentCount(),
      duplicateKeys: 0,
      extraDocuments: 0,
    };
    try {
      const [r] = await coll
        .aggregate<{ keys: number; extra: number }>(
          [
            { $group: { _id: Object.fromEntries(key.map((k) => [k, `$${k}`])), n: { $sum: 1 } } },
            { $match: { n: { $gt: 1 } } },
            { $group: { _id: null, keys: { $sum: 1 }, extra: { $sum: { $subtract: ['$n', 1] } } } },
          ],
          { allowDiskUse: true, maxTimeMS: opts.maxTimeMS ?? 30 * 60_000 },
        )
        .toArray();
      row.duplicateKeys = r?.keys ?? 0;
      row.extraDocuments = r?.extra ?? 0;
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
    }
    out.push(row);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dbName = args[args.indexOf('--db') + 1];
  if (!args.includes('--db') || !dbName || dbName.startsWith('--'))
    throw new Error('usage: duplicate-audit.ts --db <workspace database> [--json]');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  try {
    const rows = await auditDuplicates(client.db(dbName));
    if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else {
      console.log(
        `${'collection'.padEnd(32)} ${'documents'.padStart(11)} ${'dup keys'.padStart(9)} ${'extra'.padStart(9)}  key`,
      );
      for (const r of rows)
        console.log(
          `${r.collection.padEnd(32)} ${String(r.documents).padStart(11)} ${String(r.duplicateKeys).padStart(9)} ${String(r.extraDocuments).padStart(9)}  ${r.key.join(' + ')}${r.error ? `  ERROR ${r.error}` : ''}`,
        );
      const bad = rows.filter((r) => r.duplicateKeys);
      console.log(
        bad.length
          ? `${bad.length} collection(s) hold duplicate keys: ${bad.map((r) => r.collection).join(', ')}`
          : `No duplicate keys in ${rows.length} collections.`,
      );
    }
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) await main();

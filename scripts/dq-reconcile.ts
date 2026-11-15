// One-time cleanup of a workspace's dq_issues (#386). Older pipeline versions inserted the same issue many times
// (there was no unique key) and no run ever resolved an issue whose row stopped carrying the flag, so the Health
// counts were far above the data. This script:
//   1. removes duplicates per (collection, issue_type, security_id, date), keeping the most recently seen;
//   2. resolves open issues of collections whose rows carry `dq_flags` when the row no longer has that flag
//      (or no longer exists) — resolution "not re-seen (cleanup)";
//   3. creates the unique index `oh_dq_key` the executor relies on from then on.
// Dry run by default (counts only); --apply writes.
//   MONGODB_URI=... node --import tsx scripts/dq-reconcile.ts --db oh_ws_<id>            # dry run
//   MONGODB_URI=... node --import tsx scripts/dq-reconcile.ts --db oh_ws_<id> --apply    # write
import { MongoClient, type Db, type Document, type ObjectId } from 'mongodb';

export const DQ_KEY = ['collection', 'issue_type', 'security_id', 'date'] as const;
export const DQ_INDEX = 'oh_dq_key';
/** Collections whose rows carry `dq_flags`, and the row field an issue's `date` refers to. */
export const CHECKABLE: Record<string, { dateField: string }> = { prices_daily: { dateField: 'date' } };

type Issue = {
  _id: ObjectId;
  collection: string;
  issue_type: string;
  security_id?: string | null;
  date?: string | null;
  severity?: string;
  resolved?: boolean;
};
export type ReconcileReport = {
  apply: boolean;
  before: { total: number; open: number; openBy: Record<string, number> };
  duplicateGroups: number;
  duplicatesRemoved: number;
  stale: Record<string, number>;
  staleResolved: number;
  index: 'created' | 'exists' | 'would create';
  after?: { total: number; open: number; openBy: Record<string, number> };
};

async function counts(db: Db) {
  const c = db.collection('dq_issues');
  const total = await c.countDocuments({});
  const by = await c
    .aggregate<{ _id: { c: string; t: string; s: string }; n: number }>([
      { $match: { resolved: { $ne: true } } },
      { $group: { _id: { c: '$collection', t: '$issue_type', s: '$severity' }, n: { $sum: 1 } } },
    ])
    .toArray();
  const openBy = Object.fromEntries(
    by.sort((a, b) => b.n - a.n).map((g) => [`${g._id.c} ${g._id.t} ${g._id.s}`, g.n]),
  );
  return { total, open: by.reduce((n, g) => n + g.n, 0), openBy };
}

/** Duplicate ids to delete: every member of a key group except the most recently seen (pure; tested). */
export function duplicatesToDrop(
  group: { _id: ObjectId; last_seen_at?: Date | null; detected_at?: Date | null }[],
): ObjectId[] {
  const t = (d: { last_seen_at?: Date | null; detected_at?: Date | null }) =>
    new Date(d.last_seen_at ?? d.detected_at ?? 0).getTime();
  const sorted = [...group].sort((a, b) => t(b) - t(a) || String(b._id).localeCompare(String(a._id)));
  return sorted.slice(1).map((d) => d._id);
}

export async function reconcileDqIssues(db: Db, opts: { apply: boolean }): Promise<ReconcileReport> {
  const issues = db.collection<Issue>('dq_issues');
  const report: ReconcileReport = {
    apply: opts.apply,
    before: await counts(db),
    duplicateGroups: 0,
    duplicatesRemoved: 0,
    stale: {},
    staleResolved: 0,
    index: 'would create',
  };

  // 1. Duplicates. $group treats a missing field like null, as the unique index does.
  const groups = issues.aggregate<{ ids: { _id: ObjectId; last_seen_at?: Date; detected_at?: Date }[] }>(
    [
      {
        $group: {
          _id: Object.fromEntries(DQ_KEY.map((k) => [k, `$${k}`])),
          n: { $sum: 1 },
          ids: { $push: { _id: '$_id', last_seen_at: '$last_seen_at', detected_at: '$detected_at' } },
        },
      },
      { $match: { n: { $gt: 1 } } },
    ],
    { allowDiskUse: true },
  );
  let drop: ObjectId[] = [];
  const flush = async () => {
    if (opts.apply && drop.length) await issues.deleteMany({ _id: { $in: drop } });
    drop = [];
  };
  for await (const g of groups) {
    report.duplicateGroups++;
    const ids = duplicatesToDrop(g.ids);
    report.duplicatesRemoved += ids.length;
    drop.push(...ids);
    if (drop.length >= 5000) await flush();
  }
  await flush();

  // 2. Open issues whose row no longer carries the flag. (After a dry-run dedupe the duplicates are still there;
  // they are checked too, so the count is an upper bound of what --apply resolves.)
  for (const [collection, { dateField }] of Object.entries(CHECKABLE)) {
    const rows = db.collection(collection);
    const cursor = issues.find(
      { collection, resolved: { $ne: true }, security_id: { $type: 'string' }, date: { $type: 'string' } },
      { projection: { _id: 1, issue_type: 1, security_id: 1, date: 1 } },
    );
    let batch: Issue[] = [];
    const check = async () => {
      if (!batch.length) return;
      const found = await rows
        .find(
          { $or: batch.map((i) => ({ security_id: i.security_id, [dateField]: i.date })) },
          { projection: { _id: 0, security_id: 1, [dateField]: 1, dq_flags: 1 } },
        )
        .toArray();
      const flags = new Map<string, Set<string>>();
      for (const r of found as Document[]) {
        const k = `${r.security_id}|${r[dateField]}`;
        const s = flags.get(k) ?? new Set<string>();
        for (const f of (r.dq_flags as string[] | undefined) ?? []) s.add(f);
        flags.set(k, s);
      }
      const gone = batch.filter((i) => !flags.get(`${i.security_id}|${i.date}`)?.has(i.issue_type));
      for (const i of gone) {
        const k = `${collection} ${i.issue_type}`;
        report.stale[k] = (report.stale[k] ?? 0) + 1;
      }
      if (opts.apply && gone.length) {
        const r = await issues.updateMany(
          { _id: { $in: gone.map((i) => i._id) } },
          {
            $set: {
              resolved: true,
              resolved_at: new Date(),
              resolution: 'not re-seen (cleanup)',
            } as Document,
          },
        );
        report.staleResolved += r.modifiedCount;
      } else report.staleResolved += gone.length;
      batch = [];
    };
    for await (const i of cursor) {
      batch.push(i);
      if (batch.length >= 1000) await check();
    }
    await check();
  }

  // 3. The unique index. An index on the same key without `unique` would block it: replace that one.
  const existing = (await issues.indexes().catch(() => [])) as {
    name: string;
    key: Document;
    unique?: boolean;
  }[];
  const sameKey = existing.find(
    (i) => JSON.stringify(Object.keys(i.key)) === JSON.stringify([...DQ_KEY]) && i.name !== '_id_',
  );
  if (sameKey?.unique) report.index = 'exists';
  else if (opts.apply) {
    if (sameKey) await issues.dropIndex(sameKey.name);
    await issues.createIndex(Object.fromEntries(DQ_KEY.map((k) => [k, 1])), { name: DQ_INDEX, unique: true });
    report.index = 'created';
  }
  if (opts.apply) report.after = await counts(db);
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const dbName = args[args.indexOf('--db') + 1];
  if (!args.includes('--db') || !dbName || dbName.startsWith('--'))
    throw new Error('usage: dq-reconcile.ts --db <workspace database> [--apply]');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  try {
    const report = await reconcileDqIssues(client.db(dbName), { apply: args.includes('--apply') });
    console.log(JSON.stringify(report, null, 2));
    if (!report.apply) console.log('Dry run: nothing was written. Re-run with --apply to write.');
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) await main();

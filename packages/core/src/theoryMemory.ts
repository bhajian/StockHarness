// Theory memory (#111): every theory (hypothesis + signal logic) is embedded, stored in the vector store (Weaviate
// on this deployment) for search, and kept with its vector in `theory_embeddings` for exact cosine similarity.
//
// - search_theories(text): the closest theories, failed ones included (they still count as trials).
// - The duplicate check runs when a theory is submitted for review: cosine similarity at or above the threshold
//   (research settings, default 0.9) to any other theory is a near-duplicate, unless the theory says what is
//   different (`differsFrom`).
// - Embeddings come from the workspace's embedding provider (research settings `embeddingProviderId`, else its
//   first embedding model). Without one, a local lexical vector (hashed words and word pairs) is used and
//   labelled `lexical`; it catches re-submissions but not real paraphrases.
import { createHash } from 'node:crypto';
import { collection } from './db.js';
import { config } from './config.js';
import { HttpError, safeError } from './security.js';
import { embed } from './llm.js';
import { configuredVectorStores, vectorStore } from './vectorstores/index.js';
import type { Theory } from './theories.js';

export const DEFAULT_DUPLICATE_THRESHOLD = 0.9;
const LEXICAL_DIMS = 512;
type EmbeddingRow = {
  _id: string; // theory id
  ownerId: string;
  number: number;
  method: string; // provider:model, or lexical
  vector: number[];
  text: string;
  updatedAt: Date;
};
const embeddings = () => collection<EmbeddingRow>('theory_embeddings');
const settings = () =>
  collection<{ _id: string; embeddingProviderId?: string; duplicateThreshold?: number }>('research_settings');

/** What is embedded: the claim and how it is tested, not the bookkeeping. */
export const theoryText = (t: Pick<Theory, 'title' | 'hypothesis' | 'signalLogic'>) =>
  `${t.title}\n${t.hypothesis}\n${t.signalLogic}`;

const STOP = new Set(
  'a an and are as at be by for from has have in into is it its of on or that the their them then there these this to was were will with when which who than over after before within each per our we they'.split(
    ' ',
  ),
);
const stem = (w: string) => w.replace(/(ing|ers|er|ed|es|s|ly)$/, '');
/** A deterministic bag-of-words vector (feature hashing of words and word pairs), L2-normalised. */
export function lexicalVector(text: string, dims = LEXICAL_DIMS): number[] {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map(stem);
  const v = new Array(dims).fill(0);
  const add = (token: string, weight: number) => {
    const h = createHash('md5').update(token).digest();
    v[h.readUInt32LE(0) % dims] += (h[4] & 1 ? 1 : -1) * weight;
  };
  words.forEach((w, i) => {
    add(w, 1);
    if (i) add(`${words[i - 1]} ${w}`, 0.5);
  });
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

async function embedder(ownerId: string) {
  const s = await settings().findOne({ _id: ownerId });
  const providers = collection<any>('providers');
  const p = s?.embeddingProviderId
    ? await providers.findOne({ _id: s.embeddingProviderId, ownerId })
    : await providers.findOne({ ownerId, modelType: 'embedding' }, { sort: { createdAt: 1 } });
  return {
    threshold: s?.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD,
    method: p ? `${p.name}:${p.model}` : 'lexical',
    vector: async (text: string, signal?: AbortSignal) => (p ? embed(p, text, signal) : lexicalVector(text)),
  };
}

const className = (ownerId: string, method: string, dims: number) =>
  `Theories_${createHash('sha256').update(`${ownerId}:${method}:${dims}`).digest('hex').slice(0, 20)}`;

/** Embed a theory and store it (Mongo for exact similarity, the vector store for search). */
export async function rememberTheory(t: Theory, signal?: AbortSignal) {
  const e = await embedder(t.ownerId);
  const text = theoryText(t);
  const vector = await e.vector(text, signal);
  await embeddings().updateOne(
    { _id: t._id },
    { $set: { ownerId: t.ownerId, number: t.number, method: e.method, vector, text, updatedAt: new Date() } },
    { upsert: true },
  );
  if (configuredVectorStores().includes(config.VECTOR_STORE))
    try {
      const store = vectorStore();
      const name = className(t.ownerId, e.method, vector.length);
      await store.ensureCollection(name, vector.length, signal);
      await store.deleteDocument(name, t.ownerId, t._id, signal).catch(() => undefined);
      await store.upsert(
        name,
        [
          {
            id: uuidFrom(t._id),
            vector,
            ownerId: t.ownerId,
            documentId: t._id,
            chunkIndex: 0,
            title: `T-${t.number} ${t.title}`,
            content: text,
          },
        ],
        signal,
      );
    } catch (err) {
      // Search falls back to exact similarity in MongoDB; the duplicate check never depends on the store.
      console.warn(`Theory ${t._id} not indexed in ${config.VECTOR_STORE}: ${safeError(err)}`);
    }
  return { method: e.method, dims: vector.length };
}
const uuidFrom = (id: string) => {
  const h = createHash('sha256').update(`theory:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export type SimilarTheory = { id: string; ref: string; title: string; status: string; score: number };
/** Theories closest to `text` (cosine), any status. */
export async function similarTheories(
  ownerId: string,
  text: string,
  opts: { excludeId?: string; limit?: number; signal?: AbortSignal } = {},
) {
  const e = await embedder(ownerId);
  const vector = await e.vector(text, opts.signal);
  const rows = await embeddings()
    .find({ ownerId, method: e.method, ...(opts.excludeId ? { _id: { $ne: opts.excludeId } } : {}) })
    .toArray();
  const scored = rows
    .map((r) => ({ id: r._id, score: cosine(vector, r.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 10);
  const docs = await collection<Theory>('theories')
    .find(
      { ownerId, _id: { $in: scored.map((s) => s.id) } },
      { projection: { number: 1, title: 1, status: 1 } },
    )
    .toArray();
  const byId = new Map(docs.map((d) => [d._id, d]));
  return {
    method: e.method,
    threshold: e.threshold,
    matches: scored
      .filter((s) => byId.has(s.id))
      .map((s): SimilarTheory => ({
        id: s.id,
        ref: `T-${byId.get(s.id)!.number}`,
        title: byId.get(s.id)!.title,
        status: byId.get(s.id)!.status,
        score: Math.round(s.score * 10000) / 10000,
      })),
  };
}

/**
 * search_theories(text): hybrid search in the vector store when it is available, scored by exact cosine; else
 * exact similarity alone.
 */
export async function searchTheories(ownerId: string, text: string, limit = 10, signal?: AbortSignal) {
  const exact = await similarTheories(ownerId, text, { limit: Math.max(limit, 20), signal });
  if (!configuredVectorStores().includes(config.VECTOR_STORE))
    return { ...exact, matches: exact.matches.slice(0, limit) };
  try {
    const e = await embedder(ownerId);
    const vector = await e.vector(text, signal);
    const hits = await vectorStore().search(
      className(ownerId, e.method, vector.length),
      { ownerId, vector, text, limit },
      signal,
    );
    const score = new Map(exact.matches.map((m) => [m.id, m]));
    const ordered = hits.map((h) => score.get(h.documentId)).filter(Boolean) as SimilarTheory[];
    const rest = exact.matches.filter((m) => !ordered.some((o) => o.id === m.id));
    return { ...exact, source: config.VECTOR_STORE, matches: [...ordered, ...rest].slice(0, limit) };
  } catch {
    return { ...exact, source: 'mongodb', matches: exact.matches.slice(0, limit) };
  }
}

/** Refuse a near-duplicate unless the theory says what is different. Returns the closest match. */
export async function assertNotDuplicate(t: Theory, signal?: AbortSignal) {
  const found = await similarTheories(t.ownerId, theoryText(t), { excludeId: t._id, limit: 1, signal });
  const top = found.matches[0];
  if (top && top.score >= found.threshold && !t.differsFrom?.trim())
    throw new HttpError(
      409,
      `${t.number ? `T-${t.number}` : 'This theory'} is a near-duplicate of ${top.ref} "${top.title}" (${top.status}, similarity ${top.score} ≥ ${found.threshold}, ${found.method}). Say what is different in differsFrom, or work on another idea.`,
    );
  return top;
}

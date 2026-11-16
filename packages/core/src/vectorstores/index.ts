import { config } from '../config.js';
import { vectorStoreKinds, type VectorStore, type VectorStoreKind } from './types.js';
import { weaviateStore } from './weaviate.js';

export * from './types.js';

/** Stores this deployment can reach: Weaviate, part of the default stack (#472 removed the others). */
export function configuredVectorStores(): VectorStoreKind[] {
  return [...vectorStoreKinds];
}
let store: VectorStore | undefined;
export function vectorStore(kind: VectorStoreKind = config.VECTOR_STORE): VectorStore {
  if (!configuredVectorStores().includes(kind))
    throw new Error(`The ${kind} vector store is not configured on this deployment`);
  return (store ??= weaviateStore({ url: config.WEAVIATE_URL, apiKey: config.WEAVIATE_API_KEY }));
}
/** Whether a store embeds text itself, so its knowledge bases need no embedding model (none does now). */
export const storeEmbeds = (_kind: VectorStoreKind) => false;
/** The store a knowledge base uses. */
export const storeFor = (_kb: { vectorStore?: VectorStoreKind }) => vectorStore('weaviate');

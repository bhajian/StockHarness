export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}
export const send = <T = any>(path: string, body?: unknown, method = 'POST') =>
  api<T>(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
/** The viewer's IANA timezone, sent with a request so "today" means the viewer's calendar day, not UTC. */
export function browserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
export type Entity = { id: string; name: string; [key: string]: any };
export type User = {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  enabled: boolean;
  tenantId: string;
};
export const collections = [
  'guardrails',
  'agents',
  'workflows',
  'providers',
  'connections',
  'knowledge',
  'skills',
  'datasetSyncs',
] as const;
export type Platform = 'linux' | 'windows' | 'chrome' | 'openshell';
/** Resource types in the inventory, in the order the studio offers them. */
export const platformLabels: Record<Platform, string> = {
  linux: 'Linux machine',
  openshell: 'OpenShell managed machine',
  chrome: 'Chrome',
  windows: 'Windows',
};
/** The certificate authority that signed the harness certificate, and the SHA-256 of its file. */
export type HarnessCa = { pem: string; sha256: string };
/** A registered machine as reported by the device gateway, plus its mirrored connection. */
export type Machine = {
  device_id: string;
  cluster_id?: string;
  access_mode?: 'restricted' | 'host';
  active_access_mode?: 'restricted' | 'host' | null;
  name: string;
  platform: Platform;
  online: boolean;
  disabled: boolean;
  hostname: string | null;
  connector_version: string | null;
  last_seen: string | null;
  allowed_tools: string[];
  tool_count: number | null;
  connectionId?: string;
  tools: { name: string; description?: string }[];
  /** What the connector announced; `openshell_sandbox` marks an executor confined by OpenShell. */
  capabilities?: string[];
  created_at: string;
  endpoint: string;
};
export const isSandboxed = (m: Pick<Machine, 'capabilities'>) =>
  Boolean(m.capabilities?.includes('openshell_sandbox'));
export type ToolCatalog = Record<Platform, { name: string; description: string; risky?: boolean }[]>;
export type Data = Record<(typeof collections)[number], Entity[]> & {
  /** Workspace defaults, such as the model provider new agents start with. */
  defaults: { providerId: string };
  machines: Machine[];
  gateway: {
    configured: boolean;
    publicUrl: string;
    catalog: Partial<ToolCatalog>;
    error?: string;
    /** The harness CA when the server uses a private one; install commands can embed it. */
    ca?: HarnessCa | null;
  };
};
export const emptyData: Data = {
  guardrails: [],
  agents: [],
  workflows: [],
  providers: [],
  connections: [],
  knowledge: [],
  skills: [],
  datasetSyncs: [],
  defaults: { providerId: '' },
  machines: [],
  gateway: { configured: false, publicUrl: '', catalog: {} },
};
/** The provider new agents use: the workspace default when it exists, otherwise the first provider. */
export const defaultProviderId = (data: Data) =>
  (data.providers.some((p) => p.id === data.defaults.providerId && p.modelType !== 'embedding')
    ? data.defaults.providerId
    : '') ||
  data.providers.find((p) => p.modelType !== 'embedding')?.id ||
  '';
export const timestamp = (date?: string) =>
  date ? new Date(date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong';

// --- Dataset sync (FMP -> MongoDB) -------------------------------------------
export type DatasetCatalogItem = {
  defaultHistoryPeriods?: number;
  periodParam?: string;
  incremental?: 'timeseries' | 'window' | 'snapshot';
  id: string;
  label: string;
  category: string;
  description: string;
  scope: 'market' | 'feed' | 'per-symbol';
  perSymbol: boolean;
  supportsDateRange: boolean;
  recommendedEveryMinutes: number;
  defaultCollection: string;
};
export type DatasetSyncRun = {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  trigger: 'schedule' | 'manual';
  rows?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
};
export type TickerPreset = { id: string; label: string; description: string };
export const fetchDatasetCatalog = () =>
  api<{ datasets: DatasetCatalogItem[]; presets: TickerPreset[] }>('/datasets/catalog');
export const saveDatasetSync = (body: Record<string, unknown>, id?: string) =>
  send<Entity>(`/dataset-syncs${id ? `/${id}` : ''}`, body, id ? 'PUT' : 'POST');
export const deleteDatasetSync = (id: string) => api(`/dataset-syncs/${id}`, { method: 'DELETE' });
export const runDatasetSyncNow = (id: string) => send(`/dataset-syncs/${id}/run`);
export type DatasetBulkAction = 'run' | 'enable' | 'disable' | 'reset' | 'purge' | 'delete' | 'backfill';
export type DatasetBulkResult = {
  action: DatasetBulkAction;
  matched: number;
  queued?: string[];
  alreadyRunning?: string[];
  collections?: { name: string; deleted?: number; dropped?: boolean }[];
  keptCollections?: string[];
  backfillsQueued?: string[];
  backfillsSkipped?: { id: string; reason: string }[];
};
export const bulkDatasetSyncs = (ids: string[], action: DatasetBulkAction, dropCollections = false) =>
  send<DatasetBulkResult>('/dataset-syncs/bulk', { ids, action, dropCollections });
export type DatasetImportPlan = {
  mode: 'merge' | 'replace';
  create: { name: string; dataset: string }[];
  update: { id: string; name: string; changed: string[] }[];
  unchanged: { id: string; name: string }[];
  remove: { id: string; name: string }[];
  errors: { index: number; name?: string; message: string }[];
};
/** YAML text of the selected syncs' configuration (all syncs when `ids` is empty). */
export async function exportDatasetSyncsYaml(ids: string[] = []) {
  const response = await fetch(
    `/api/dataset-syncs/export${ids.length ? `?ids=${ids.map(encodeURIComponent).join(',')}` : ''}`,
    {
      credentials: 'same-origin',
    },
  );
  if (!response.ok) throw new Error(`Export failed (${response.status})`);
  return response.text();
}
export const importDatasetSyncsYaml = (yaml: string, mode: 'merge' | 'replace', dryRun: boolean) =>
  send<{ applied: boolean; plan: DatasetImportPlan }>('/dataset-syncs/import', { yaml, mode, dryRun });
export type DepthProbe = {
  dataset: string;
  symbol: string;
  rows: number;
  earliest?: string;
  latest?: string;
  years: number;
  requested: Record<string, unknown>;
  probedAt: string;
};
export const probeDatasetDepth = (body: {
  dataset: string;
  connectionId: string;
  symbol?: string;
  statementPeriod?: 'quarter' | 'annual';
  syncId?: string;
}) => send<DepthProbe>('/dataset-syncs/probe-depth', body);
export const fetchDatasetRuns = (id: string) => api<DatasetSyncRun[]>(`/dataset-syncs/${id}/runs`);

// --- Everything is a YAML object (#152) ----------------------------------------------------------
export type ObjectKind =
  'Skill' | 'Agent' | 'Harness' | 'DatasetSync' | 'Transform' | 'CatalogEntry' | 'Pipeline';
export type ObjectImportPlan = {
  mode: 'merge' | 'replace';
  items: { kind: ObjectKind; name: string; action: 'create' | 'update' | 'unchanged' | 'remove' }[];
  errors: { kind?: ObjectKind; name?: string; message: string }[];
};
export type ObjectImportResult = {
  applied: boolean;
  plan: ObjectImportPlan;
  partial?: ObjectImportPlan['items'];
  error?: string;
};
export async function exportObjectsYaml(kinds: ObjectKind[] = [], names: string[] = [], withHistory = false) {
  const q = new URLSearchParams();
  if (kinds.length) q.set('kinds', kinds.join(','));
  if (names.length) q.set('names', names.join(','));
  if (withHistory) q.set('history', '1');
  const response = await fetch(`/api/objects/export${q.size ? `?${q}` : ''}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`Export failed (${response.status})`);
  return response.text();
}
export const importObjectsYaml = (
  yaml: string,
  mode: 'merge' | 'replace',
  dryRun: boolean,
  legacyKind?: ObjectKind,
) =>
  send<ObjectImportResult>('/objects/import', { yaml, mode, dryRun, ...(legacyKind ? { legacyKind } : {}) });
export type ConfigBackupStatus = {
  configured: boolean;
  repo?: string;
  branch: string;
  base: string;
  path: string;
  intervalMinutes: number;
  pendingChanges: boolean;
  state?: {
    lastCheckedAt?: string;
    lastChangeAt?: string;
    lastCommitSha?: string;
    lastCommitAt?: string;
    prUrl?: string;
    inSyncWithBase?: boolean;
    outOfSyncSince?: string;
    lastError?: string;
    objects?: Record<string, number>;
  } | null;
};
export const fetchConfigBackup = () => api<ConfigBackupStatus>('/config-backup');
export const runConfigBackupNow = () => send<ConfigBackupStatus>('/config-backup/run');
export type DatasetBackfill = {
  id: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  from: string;
  to: string;
  mode: string;
  rows: number;
  calls: number;
  symbolCount?: number;
  lastError?: string;
  startedAt?: string;
  finishedAt?: string;
  batches: { i: number; label: string; status: string; rows: number; errors: number; error?: string }[];
  progress: { pct: number; batchesDone: number; batchesFailed: number; batchesTotal: number; etaMs?: number };
};
export const fetchBackfill = (syncId: string) =>
  api<DatasetBackfill | null>(`/dataset-syncs/${syncId}/backfill`);
export const startBackfill = (syncId: string, body: { from?: string; to?: string }) =>
  send<DatasetBackfill>(`/dataset-syncs/${syncId}/backfill`, body);
export const backfillControl = (syncId: string, action: 'pause' | 'resume' | 'cancel' | 'retry') =>
  send<DatasetBackfill>(`/dataset-syncs/${syncId}/backfill/${action}`);

// Layer 2 transforms (#94).
import type { TransformDraft } from './transformTemplates';
export type { TransformDraft };
export type TransformRun = {
  id: string;
  transformId: string;
  transformName: string;
  version: number;
  trigger: 'manual' | 'schedule' | 'event';
  batchId?: string;
  window?: { start: string; end: string; lookback_start: string };
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  outputs?: Record<string, { written?: number; unchanged?: number; dq?: number }>;
  reads?: Record<string, number>;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};
export type Transform = TransformDraft & {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRun?: TransformRun | null;
  /** Dependency triggers (#92): upstreams completed since the last triggered run. */
  triggerState?: {
    pending?: Record<string, { at: string; date_from?: string; date_to?: string }>;
    lastEventAt?: string;
    lastFiredAt?: string;
  };
};
export const fetchTransforms = () => api<Transform[]>('/transforms');
export const fetchTransform = (id: string) => api<Transform>(`/transforms/${encodeURIComponent(id)}`);
export const saveTransform = (body: TransformDraft, id?: string) =>
  send<Transform>(id ? `/transforms/${encodeURIComponent(id)}` : '/transforms', body, id ? 'PUT' : 'POST');
export const deleteTransform = (id: string) =>
  send<void>(`/transforms/${encodeURIComponent(id)}`, undefined, 'DELETE');
export const runTransform = (
  id: string,
  body: { range: 'last_day' | 'custom' | 'full'; start?: string; end?: string },
) => send<TransformRun[]>(`/transforms/${encodeURIComponent(id)}/run`, body);
export const fetchTransformRuns = (id: string) =>
  api<TransformRun[]>(`/transforms/${encodeURIComponent(id)}/runs`);
export const fetchRecentTransformRuns = (since: Date) =>
  api<TransformRun[]>(`/transform-runs?since=${encodeURIComponent(since.toISOString())}`);
export const fetchTransformRun = (runId: string) =>
  api<TransformRun>(`/transform-runs/${encodeURIComponent(runId)}`);

// Schema catalog (#84).
export type CatalogField = {
  name: string;
  type: string;
  null_pct: number;
  description?: string;
  unit?: string;
  example?: unknown;
};
export type CatalogListItem = {
  collection: string;
  layer: 1 | 2 | null;
  description: string;
  grain: string;
  primaryKey: string[];
  fieldCount: number;
  producedBy: { type: string; name: string; id?: string }[];
  timeSemantics: { status: 'pit' | 'current_only' | 'static' | 'unknown'; text: string };
  coverage: { rows: number; symbols?: number; dateField?: string; dateMin?: string; dateMax?: string };
  freshness: { lastUpdated?: string; lastStatus?: 'ok' | 'failed'; lastError?: string };
  docCompletenessPct: number;
};
export type CatalogEntryDetail = Omit<CatalogListItem, 'fieldCount'> & { fields: CatalogField[] };
export const fetchCatalog = () => api<CatalogListItem[]>('/catalog');
export const fetchCatalogEntry = (c: string) => api<CatalogEntryDetail>(`/catalog/${encodeURIComponent(c)}`);

// Transform preview (#95): runs the code on a sample without writing.
export type PreviewCheck = { id: string; status: 'pass' | 'warn' | 'fail'; text: string };
export type PreviewOutput = {
  count: number;
  rows: Record<string, unknown>[];
  dup_keys: number;
  missing_key: number;
  missing_known_at: number;
  fields: Record<string, { type: string | null; null_pct: number }>;
  dq?: { issue_type: string; severity: string; security_id?: string; date?: string }[];
  truncated?: boolean;
  checks: PreviewCheck[];
};
export type TransformPreview = {
  id: string;
  transformName: string;
  status: 'running' | 'succeeded' | 'failed';
  window?: { start: string; end: string; lookback_start: string };
  symbols: string[];
  outputs?: Record<string, PreviewOutput>;
  reads?: Record<string, number>;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs?: number;
  createdAt: string;
};
export const startTransformPreview = (draft: TransformDraft, id?: string) =>
  send<TransformPreview>(id ? `/transforms/${encodeURIComponent(id)}/preview` : '/transforms/preview', {
    transform: draft,
  });
export const fetchTransformPreview = (id: string) =>
  api<TransformPreview>(`/transform-previews/${encodeURIComponent(id)}`);

// Transform versions and run history (#96).
export type TransformVersion = {
  id: string;
  transformId: string;
  version: number;
  note?: string;
  createdAt: string;
  createdBy?: string;
  spec?: TransformDraft;
};
export const fetchTransformVersions = (id: string) =>
  api<TransformVersion[]>(`/transforms/${encodeURIComponent(id)}/versions`);
export const fetchTransformVersion = (id: string, version: number) =>
  api<TransformVersion>(`/transforms/${encodeURIComponent(id)}/versions/${version}`);
export const restoreTransformVersion = (id: string, version: number) =>
  send<Transform>(`/transforms/${encodeURIComponent(id)}/versions/${version}/restore`, {});
export type DqIssue = {
  collection: string;
  issue_type: string;
  severity: string;
  security_id?: string | null;
  date?: string | null;
  context?: Record<string, unknown> | null;
};
export const fetchTransformRunDq = (runId: string) =>
  api<DqIssue[]>(`/transform-runs/${encodeURIComponent(runId)}/dq`);

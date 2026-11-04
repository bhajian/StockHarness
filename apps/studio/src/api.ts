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
  /** curated (edited), dictionary (built-in, auto-filled) or none (undocumented). */
  doc?: 'curated' | 'dictionary' | 'none';
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
  coverage: {
    rows: number;
    symbols?: number;
    universeCoveragePct?: number;
    dateField?: string;
    dateMin?: string;
    dateMax?: string;
  };
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

// Pipelines (#156, #157).
export type PipelineGate = {
  min_symbol_coverage?: number;
  min_rows?: number;
  max_row_drop_pct?: number;
  max_dq_error_rate?: number;
};
export type PipelineNodeSpec = {
  id: string;
  ref: string;
  after: string[];
  gate: PipelineGate;
  on_upstream_failure: 'block' | 'skip' | 'continue_with_warning';
  params: Record<string, unknown>;
  retries: number;
  timeout_minutes: number;
};
export type PipelineDraft = {
  name: string;
  description: string;
  schedule?: Record<string, unknown>;
  period: 'day' | 'week' | 'month' | 'event';
  deadline_hours?: number;
  nodes: PipelineNodeSpec[];
  enabled: boolean;
};
export type PipelineNodeStatus =
  | 'pending'
  | 'waiting'
  | 'running'
  | 'succeeded'
  | 'gate_failed'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'cancelled';
export type PipelineNodeRun = {
  status: PipelineNodeStatus;
  ref: string;
  generation: number;
  attempts?: number;
  startedAt?: string;
  finishedAt?: string;
  stats?: {
    rows?: number;
    written?: number;
    dq?: number;
    symbols_attempted?: number;
    symbols_covered?: number;
  };
  gate?: { name: string; value: number | string | null; threshold: number | string; pass: boolean }[];
  error?: string;
  reason?: string;
  warning?: string;
  external?: { type: string; ids: string[] };
};
export type PipelineRun = {
  id: string;
  pipelineId: string;
  pipelineName: string;
  version: number;
  period: { kind: string; id: string; start: string; end: string };
  trigger: 'schedule' | 'manual' | 'backfill';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  nodes: Record<string, PipelineNodeRun>;
  graph?: PipelineNodeSpec[];
  deadlineMissed?: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};
export type Pipeline = PipelineDraft & {
  id: string;
  version: number;
  nextRunAt?: string;
  updatedAt: string;
  lastRun?: PipelineRun | null;
};
export const fetchPipelines = () => api<Pipeline[]>('/pipelines');
export const savePipeline = (body: PipelineDraft, id?: string) =>
  send<Pipeline>(id ? `/pipelines/${encodeURIComponent(id)}` : '/pipelines', body, id ? 'PUT' : 'POST');
export const deletePipeline = (id: string) =>
  send<void>(`/pipelines/${encodeURIComponent(id)}`, undefined, 'DELETE');
export const validatePipeline = (body: PipelineDraft, id?: string) =>
  send<{ errors: string[]; warnings: string[] }>(
    `/pipelines/validate${id ? `?id=${encodeURIComponent(id)}` : ''}`,
    body,
  );
export const suggestPipeline = (transforms: string[] = []) =>
  api<{ nodes: PipelineNodeSpec[] }>(
    `/pipelines/suggest${transforms.length ? `?transforms=${encodeURIComponent(transforms.join(','))}` : ''}`,
  );
export const runPipeline = (id: string, period?: string) =>
  send<PipelineRun & { created: boolean }>(
    `/pipelines/${encodeURIComponent(id)}/run`,
    period ? { period } : {},
  );
export const backfillPipeline = (id: string, body: { from: string; to: string; parallelism?: number }) =>
  send<{ backfillId: string; queued: string[]; skipped: string[] }>(
    `/pipelines/${encodeURIComponent(id)}/backfill`,
    body,
  );
export const fetchPipelineRuns = (id: string) =>
  api<PipelineRun[]>(`/pipelines/${encodeURIComponent(id)}/runs`);
export const fetchPipelineRun = (runId: string) =>
  api<PipelineRun>(`/pipeline-runs/${encodeURIComponent(runId)}`);
export const pipelineNodeAction = (
  runId: string,
  node: string,
  action: 'retry' | 'rerun' | 'skip',
  reason?: string,
) =>
  send<PipelineRun>(
    `/pipeline-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(node)}/${action}`,
    reason ? { reason } : {},
  );
export const cancelPipelineRun = (runId: string) =>
  send<PipelineRun>(`/pipeline-runs/${encodeURIComponent(runId)}/cancel`, {});

// Catalog UI (#87).
export type CatalogCaveat = {
  id: string;
  severity: 'info' | 'warn' | 'blocking';
  text: string;
  source: string;
  fix?: string;
};
export type CatalogDetail = CatalogEntryDetail & {
  caveats: CatalogCaveat[];
  joins: { to: string; on: string | string[] }[];
  curated?: {
    description?: string;
    grain?: string;
    fields?: Record<string, { description?: string; unit?: string }>;
    caveats?: { id: string; severity: 'info' | 'warn' | 'blocking'; text: string }[];
    dismissedCaveats?: string[];
  };
  timeSemantics: CatalogListItem['timeSemantics'];
  refreshedAt?: string;
};
export const fetchCatalogDetail = (c: string) => api<CatalogDetail>(`/catalog/${encodeURIComponent(c)}`);
export const patchCatalogEntry = (c: string, body: NonNullable<CatalogDetail['curated']>) =>
  send<CatalogDetail>(`/catalog/${encodeURIComponent(c)}`, body, 'PATCH');
export type CatalogCoverage = {
  computing: boolean;
  dateField?: string;
  daily: { dates: string[]; series: Record<string, (number | null)[]>; downsampled?: number };
  heatmap: { years: string[]; cells: [number, number, number][]; value: 'symbols' | 'rows' };
  days: number;
  computedAt: string;
  error?: string;
};
export async function fetchCatalogCoverage(c: string, refresh = false) {
  const r = await fetch(`/api/catalog/${encodeURIComponent(c)}/coverage${refresh ? '?refresh=1' : ''}`, {
    credentials: 'same-origin',
  });
  if (r.status === 202) return null; // computing
  if (!r.ok) throw new Error(`Coverage failed (${r.status})`);
  return (await r.json()) as CatalogCoverage;
}
export const fetchAgentView = (c: string) =>
  api<{ text: string; tokens: number }>(`/catalog/${encodeURIComponent(c)}/agent-view`);
export async function exportCatalogMarkdown(collections: string[]) {
  const r = await fetch('/api/catalog/export', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collections }),
  });
  if (!r.ok) throw new Error(`Export failed (${r.status})`);
  return r.text();
}

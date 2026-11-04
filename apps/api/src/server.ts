import { attachSessionSockets } from './openharness/sessionSocket.js';
import { dispatchClusterMonitors } from '../../../packages/core/src/clusterMonitor.js';
import { dispatchGuardrailEvaluations } from './guardrails.js';
import { dispatchHumanRequests, deliverHumanNotifications } from '../../../packages/core/src/human.js';
import { app } from './app.js';
import { config } from '../../../packages/core/src/config.js';
import { collection, connectDatabase, mongo } from '../../../packages/core/src/db.js';
import { provisionMongoMcp } from '../../../packages/core/src/mongoMcp.js';
import { closeQueue } from '../../../packages/core/src/queue.js';
import { dispatchPending, dispatchSchedules, recoverStaleJobs } from '../../../packages/core/src/runs.js';
import { deliverWebhooks } from '../../../packages/core/src/harnessEvents.js';
import { dispatchReflections } from '../../../packages/core/src/experience.js';
import {
  dispatchDatasetSyncs,
  recoverInterruptedDatasetSyncRuns,
} from '../../../packages/core/src/datasetSync.js';
import { dispatchBackfills, recoverBackfills } from '../../../packages/core/src/datasetBackfill.js';
import { dispatchTransforms, recoverTransformRuns } from '../../../packages/core/src/transformRunner.js';
import { dispatchTransformTriggers } from '../../../packages/core/src/transformTriggers.js';
import { dispatchPipelines } from '../../../packages/core/src/pipelineEngine.js';
import { safeError } from '../../../packages/core/src/security.js';
import { dispatchConfigBackup } from './configBackup.js';
import { refreshAllCatalogs } from './catalog.js';

await connectDatabase();
const interrupted = await recoverInterruptedDatasetSyncRuns();
if (interrupted) console.warn(`Marked ${interrupted} interrupted dataset sync run(s) as failed`);
// Backfills are persisted: ones that were running resume from their last finished symbol (#80).
const resumed = await recoverBackfills();
if (resumed) console.warn(`Resuming ${resumed} dataset backfill(s)`);
const failedTransforms = await recoverTransformRuns();
if (failedTransforms) console.warn(`Marked ${failedTransforms} interrupted transform run(s) as failed`);
await provisionMongoMcp(
  async () =>
    (await collection('connections').distinct('ownerId', { kind: 'mongodb', builtIn: true })) as string[],
);
const server = app.listen(config.PORT, '0.0.0.0', () =>
  console.log(`OpenHarness studio listening on port ${config.PORT}`),
);
attachSessionSockets(server);
let dispatching = false;
async function tick() {
  if (dispatching) return;
  dispatching = true;
  try {
    await recoverStaleJobs();
    await dispatchHumanRequests();
    await dispatchPending();
    await dispatchSchedules();
    await dispatchDatasetSyncs();
    await dispatchBackfills();
    await dispatchTransforms();
    await dispatchTransformTriggers();
    await dispatchPipelines();
    await deliverWebhooks();
    await dispatchReflections();
    await dispatchGuardrailEvaluations();
    await dispatchClusterMonitors();
  } catch (e) {
    console.error('Dispatcher will retry:', safeError(e));
  } finally {
    dispatching = false;
  }
}
let notifying = false;
const notifications = setInterval(async () => {
  if (notifying) return;
  notifying = true;
  try {
    await deliverHumanNotifications();
  } catch (error) {
    console.warn('Human notifications will retry:', safeError(error));
  } finally {
    notifying = false;
  }
}, 3000);
const timer = setInterval(() => void tick(), 3000);
// Config backup to git (#149): first check a minute after start, then every CONFIG_BACKUP_INTERVAL_MINUTES.
const backupStart = setTimeout(() => void dispatchConfigBackup(), 60_000);
// Schema Catalog (#84): full refresh two minutes after start, then daily (each sync also refreshes its entry).
const catalogStart = setTimeout(() => void refreshAllCatalogs(), 120_000);
const catalogTimer = setInterval(() => void refreshAllCatalogs(), 24 * 3600_000);
const backupTimer = setInterval(
  () => void dispatchConfigBackup(),
  config.CONFIG_BACKUP_INTERVAL_MINUTES * 60_000,
);
void tick();
async function shutdown() {
  clearInterval(timer);
  clearTimeout(backupStart);
  clearInterval(backupTimer);
  clearTimeout(catalogStart);
  clearInterval(catalogTimer);
  clearInterval(notifications);
  server.close();
  await closeQueue();
  await mongo.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

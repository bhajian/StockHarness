import { attachSessionSockets } from './openharness/sessionSocket.js';
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
  resumeInterruptedDatasetSyncRuns,
  requeueLostDatasetSyncs,
} from '../../../packages/core/src/datasetSync.js';
import { dispatchDailyCoverage } from '../../../packages/core/src/dataHealth.js';
import { dispatchBackfills, recoverBackfills } from '../../../packages/core/src/datasetBackfill.js';
import { dispatchTransforms, recoverTransformRuns } from '../../../packages/core/src/transformRunner.js';
import { recoverEvaluations } from '../../../packages/core/src/evaluations.js';
import { relabelPromising } from '../../../packages/core/src/verdictLabels.js';
import { recoverSimulations } from '../../../packages/core/src/simulations.js';
import { dispatchTransformTriggers } from '../../../packages/core/src/transformTriggers.js';
import { dispatchPipelines } from '../../../packages/core/src/pipelineEngine.js';
import { dispatchSyncTriggers } from '../../../packages/core/src/syncTriggers.js';
import { safeError } from '../../../packages/core/src/security.js';
import { liftDailyCapPauses } from '../../../packages/core/src/spendGuard.js';
import { dispatchConfigBackup } from './configBackup.js';
import { refreshAllCatalogs } from './catalog.js';

await connectDatabase();
// Dataset sync runs the restart interrupted get a new attempt: per-symbol runs resume at their saved symbol,
// the rest start again (#416). The interruption is not a failure.
const interrupted = await resumeInterruptedDatasetSyncRuns();
if (interrupted.resumed.length)
  console.warn(
    `Resuming ${interrupted.resumed.length} interrupted dataset sync run(s): ${interrupted.resumed
      .map((r) => `${r.syncId}@${r.next}`)
      .join(', ')}`,
  );
if (interrupted.failed) console.warn(`Closed ${interrupted.failed} interrupted run(s) that cannot resume`);
// Syncs queued by the previous process that never started are due again (#439).
const lostSyncs = await requeueLostDatasetSyncs();
if (lostSyncs) console.warn(`Re-queued ${lostSyncs} dataset sync(s) the restart dropped before they started`);
// Backfills are persisted: ones that were running resume from their last finished symbol (#80).
const resumed = await recoverBackfills();
if (resumed) console.warn(`Resuming ${resumed} dataset backfill(s)`);
const failedTransforms = await recoverTransformRuns();
if (failedTransforms) console.warn(`Marked ${failedTransforms} interrupted transform run(s) as failed`);
const relabelled = await relabelPromising();
if (relabelled) console.warn(`Relabelled ${relabelled} failed verdict(s) as promising (#354)`);
const failedEvaluations = (await recoverEvaluations()) + (await recoverSimulations());
if (failedEvaluations)
  console.warn(`Marked ${failedEvaluations} interrupted evaluation / simulation run(s) as failed`);
await provisionMongoMcp(
  async () =>
    (await collection('connections').distinct('ownerId', { kind: 'mongodb', builtIn: true })) as string[],
);
const server = app.listen(config.PORT, '0.0.0.0', () =>
  console.log(`OpenHarness studio listening on port ${config.PORT}`),
);
attachSessionSockets(server);
let dispatching = false;
// #365: a daily-cap pause lifts after 00:00 UTC; checked once a minute (a cheap query when nothing is paused).
let liftCheckedAt = 0;
async function tick() {
  if (dispatching) return;
  dispatching = true;
  try {
    if (Date.now() - liftCheckedAt >= 60_000) {
      liftCheckedAt = Date.now();
      await liftDailyCapPauses();
    }
    await recoverStaleJobs();
    await dispatchHumanRequests();
    await dispatchPending();
    await dispatchSchedules();
    await dispatchDatasetSyncs();
    await dispatchBackfills();
    await dispatchTransforms();
    await dispatchTransformTriggers();
    await dispatchPipelines();
    await dispatchSyncTriggers();
    await deliverWebhooks();
    await dispatchReflections();
    await dispatchDailyCoverage();
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

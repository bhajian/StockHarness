// Simulations API (#125). Mounted under /api with requireSession; starting and deleting runs is admin-only.
import { Router } from 'express';
import { HttpError } from '../../../packages/core/src/security.js';
import {
  deleteSimulation,
  estimateSimulation,
  getSimulation,
  listSimulationConfigs,
  listSimulations,
  resolveSimulationConfig,
  simulationOrders,
  simulationPositions,
  simulationSeries,
  simulationTrade,
  simulationTrades,
  startSimulation,
} from '../../../packages/core/src/simulations.js';
import { exportObjects } from './objects.js';

export const simulationsRouter = Router();
const adminOnly = (role: string) => {
  if (role !== 'admin') throw new HttpError(403, 'Only administrators can run simulations');
};
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const int = (v: unknown) =>
  v === undefined || v === '' ? undefined : Number.parseInt(String(v), 10) || undefined;

simulationsRouter.get('/simulations', async (req, res) => {
  res.json(await listSimulations(req.principal!.tenantId));
});
simulationsRouter.get('/simulations/configs', async (req, res) => {
  res.json(
    (await listSimulationConfigs(req.principal!.tenantId)).map((c) => ({
      id: c._id,
      name: c.name,
      config: c.config,
      updatedAt: c.updatedAt,
    })),
  );
});
/** The resolved config (pinned versions, symbols) and the runtime estimate, without starting anything. */
simulationsRouter.post('/simulations/estimate', async (req, res) => {
  const config = await resolveSimulationConfig(req.principal!.tenantId, req.body?.config ?? req.body);
  res.json({ config, estimate: await estimateSimulation(req.principal!.tenantId, config) });
});
simulationsRouter.post('/simulations', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const { simulation, estimate } = await startSimulation(
    req.principal!.tenantId,
    req.body?.config ?? req.body,
    {
      userId: req.principal!.user._id,
    },
  );
  res.status(202).json({ id: simulation._id, status: simulation.status, estimate });
});
simulationsRouter.get('/simulations/:id', async (req, res) => {
  const s = await getSimulation(req.principal!.tenantId, String(req.params.id));
  const { _id, ownerId: _o, ...rest } = s;
  res.json({ id: _id, ...rest });
});
simulationsRouter.get('/simulations/:id/series', async (req, res) => {
  res.json(await simulationSeries(req.principal!.tenantId, String(req.params.id), str(req.query.metric)));
});
simulationsRouter.get('/simulations/:id/trades', async (req, res) => {
  const q = req.query;
  res.json(
    await simulationTrades(req.principal!.tenantId, String(req.params.id), {
      idea: str(q.idea),
      reason: str(q.reason),
      side: str(q.side),
      security: str(q.security),
      sort: str(q.sort),
      limit: int(q.limit),
      offset: int(q.offset),
    }),
  );
});
simulationsRouter.get('/simulations/:id/trades/:n', async (req, res) => {
  res.json(await simulationTrade(req.principal!.tenantId, String(req.params.id), Number(req.params.n)));
});
simulationsRouter.get('/simulations/:id/orders', async (req, res) => {
  const q = req.query;
  res.json(
    await simulationOrders(req.principal!.tenantId, String(req.params.id), {
      idea: str(q.idea),
      security: str(q.security),
      date: str(q.date),
      limit: int(q.limit),
      offset: int(q.offset),
    }),
  );
});
simulationsRouter.get('/simulations/:id/positions', async (req, res) => {
  res.json(await simulationPositions(req.principal!.tenantId, String(req.params.id), str(req.query.date)));
});
/** The run as YAML: its config and record (SimulationRun), and the config on its own (SimulationConfig). */
simulationsRouter.get('/simulations/:id/export', async (req, res) => {
  const ownerId = req.principal!.tenantId;
  const s = await getSimulation(ownerId, String(req.params.id));
  const { yaml } = await exportObjects(
    ownerId,
    ['SimulationConfig', 'SimulationRun'],
    [s.name, s.sourceId ?? s._id],
  );
  res
    .type('application/yaml')
    .set('Content-Disposition', `attachment; filename="simulation-${s._id.slice(0, 8)}.yaml"`)
    .send(yaml);
});
simulationsRouter.delete('/simulations/:id', async (req, res) => {
  adminOnly(req.principal!.user.role);
  await deleteSimulation(req.principal!.tenantId, String(req.params.id));
  res.status(204).end();
});

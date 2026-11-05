// The research MCP server (#108): the built-in `research` connection's tools, served by the API at
// /mcp/research (Streamable HTTP, stateless). The bearer token names the connection and proves its workspace
// (dataTools.researchToken); the session as_of comes from the connection and the holdout, never from the caller.
import { Router, type Request, type Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  DATA_TOOLS,
  callDataTool,
  dataSession,
  verifyResearchToken,
} from '../../../packages/core/src/dataTools.js';
import {
  STRATEGY_TOOLS,
  callStrategyTool,
  isStrategyTool,
} from '../../../packages/core/src/strategyTools.js';
import { HttpError, safeError } from '../../../packages/core/src/security.js';
import {
  callLifecycleTool,
  evaluateForTheory,
  isLifecycleTool,
  lifecycleToolsFor,
} from '../../../packages/core/src/lifecycleTools.js';

export const researchMcpRouter = Router();

async function handle(req: Request, res: Response) {
  const auth = req.headers.authorization ?? '';
  const conn = auth.startsWith('Bearer ') ? await verifyResearchToken(auth.slice(7).trim()) : undefined;
  if (!conn) return void res.status(401).json({ error: 'A valid research connection token is required' });
  const server = new Server(
    { name: 'stockharness-research', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...DATA_TOOLS, ...STRATEGY_TOOLS, ...lifecycleToolsFor(conn.role)] as any,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    // Who is calling, for the debate history (#112); the runtime sends it only to research connections.
    const meta = ((request.params._meta ?? {}) as Record<string, any>)['openharness/agent'] ?? {};
    try {
      const result = isLifecycleTool(name)
        ? await callLifecycleTool(conn.ownerId, conn.role, name, args, meta)
        : name === 'evaluate_strategy' && args.theory_id
          ? await evaluateForTheory(conn.ownerId, conn.role, args, meta)
          : isStrategyTool(name)
            ? await callStrategyTool(conn.ownerId, name, args)
            : await callDataTool(await dataSession(conn.ownerId, conn.asOf), name, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof HttpError ? error.message : safeError(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

researchMcpRouter.post('/mcp/research', (req, res, next) => {
  handle(req, res).catch(next);
});
// Stateless server: no standalone SSE stream and no sessions to delete.
researchMcpRouter.get('/mcp/research', (_req, res) => void res.status(405).set('Allow', 'POST').end());
researchMcpRouter.delete('/mcp/research', (_req, res) => void res.status(405).set('Allow', 'POST').end());

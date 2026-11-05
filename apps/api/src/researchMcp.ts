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
import { HttpError, safeError } from '../../../packages/core/src/security.js';

export const researchMcpRouter = Router();

/** Extra tools served on the same connection (evaluate_strategy #109, test_strategy #153). */
export type ResearchTool = {
  definition: { name: string; description: string; inputSchema: Record<string, unknown> };
  call: (ownerId: string, args: Record<string, unknown>) => Promise<unknown>;
};
export const extraResearchTools: ResearchTool[] = [];

async function handle(req: Request, res: Response) {
  const auth = req.headers.authorization ?? '';
  const conn = auth.startsWith('Bearer ') ? await verifyResearchToken(auth.slice(7).trim()) : undefined;
  if (!conn) return void res.status(401).json({ error: 'A valid research connection token is required' });
  const server = new Server(
    { name: 'stockharness-research', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...DATA_TOOLS, ...extraResearchTools.map((t) => t.definition)] as any,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      const extra = extraResearchTools.find((t) => t.definition.name === name);
      const result = extra
        ? await extra.call(conn.ownerId, args)
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

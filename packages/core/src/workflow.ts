import type { Agent, CollectionBinding, Workflow } from './schema.js';

/** Resource edges grant tools/context to an agent; they are never execution edges. */
export function agentWithResources(workflow: Workflow, nodeId: string, base: Agent): Agent {
  const connections = new Map(base.connections.map((c) => [c.connectionId, new Set(c.tools)]));
  // Collection bindings (#148) per connection, merged by collection name (a later resource refines it).
  const collections = new Map<string, Map<string, CollectionBinding>>(
    base.connections
      .filter((c) => c.collections?.length)
      .map((c) => [c.connectionId, new Map(c.collections!.map((b) => [b.name, b]))]),
  );
  const guardrails = new Set(base.guardrailIds ?? []);
  const knowledge = new Set(base.knowledgeBaseIds);
  for (const binding of workflow.bindings ?? []) {
    if (binding.agentNodeId !== nodeId) continue;
    const resource = workflow.resources?.find((r) => r.id === binding.resourceId);
    if (!resource) throw new Error('An attached workflow resource is missing');
    if (resource.type === 'knowledge') knowledge.add(resource.knowledgeBaseId);
    else if (resource.type === 'guardrail') guardrails.add(resource.policyId);
    else {
      const tools = connections.get(resource.connectionId) ?? new Set<string>();
      resource.tools.forEach((t) => tools.add(t));
      connections.set(resource.connectionId, tools);
      if (resource.collections?.length) {
        const byName = collections.get(resource.connectionId) ?? new Map<string, CollectionBinding>();
        for (const b of resource.collections) byName.set(b.name, b);
        collections.set(resource.connectionId, byName);
      }
    }
  }
  return {
    ...base,
    connections: [...connections].map(([connectionId, tools]) => ({
      connectionId,
      tools: [...tools],
      ...(collections.get(connectionId)?.size
        ? { collections: [...collections.get(connectionId)!.values()] }
        : {}),
    })),
    knowledgeBaseIds: [...knowledge],
    guardrailIds: [...guardrails],
  };
}

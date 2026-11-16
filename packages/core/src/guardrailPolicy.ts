import { z } from 'zod';
export const railStages = ['input', 'output', 'retrieval', 'tool_input', 'tool_output'] as const;
export type RailStage = (typeof railStages)[number];
export const guardrailPolicyObjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(''),
  provider: z.enum(['builtin', 'nemo']).default('nemo'),
  configId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,100}$/)
    .default('openharness'),
  stages: z
    .array(z.enum(railStages))
    .min(1)
    .default([...railStages]),
  failMode: z.enum(['closed', 'open']).default('closed'),
  timeoutMs: z.number().int().min(100).max(300_000).default(5000),
  /** Cumulative check time per run and policy; 0 means no budget. */
  latencyBudgetMs: z.number().int().min(0).max(86_400_000).default(120000),
  pii: z.boolean().default(true),
  jailbreak: z.boolean().default(true),
  contentSafety: z.boolean().default(true),
  semanticChecks: z.boolean().default(false),
  safetyModelProviderId: z.string().uuid().optional(),
  templateId: z.enum(['bias', 'toxicity', 'hallucinations', 'opacity', 'pii', 'vulnerability']).optional(),
  safetyInstructions: z.string().trim().max(4000).default(''),
  deniedTerms: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  blockedTopics: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  deniedTools: z.array(z.string().trim().min(1).max(250)).max(100).default([]),
  argumentRules: z
    .array(
      z
        .object({
          tool: z.string().min(1).max(250),
          path: z.string().regex(/^[a-zA-Z0-9_.]{1,200}$/),
          operator: z.enum(['contains', 'equals', 'missing']),
          value: z.string().max(200).default(''),
        })
        .strict(),
    )
    .max(100)
    .default([]),
  blockMessage: z
    .string()
    .min(1)
    .max(500)
    .default('This request was blocked by the configured safety policy.'),
  enabled: z.boolean().default(true),
});
export const guardrailPolicySchema = guardrailPolicyObjectSchema
  .refine((p) => p.latencyBudgetMs === 0 || p.latencyBudgetMs >= p.timeoutMs, {
    message: 'Latency budget must cover at least one check timeout (or be 0 for no budget)',
    path: ['latencyBudgetMs'],
  })
  .refine((p) => !p.semanticChecks || p.provider === 'nemo', {
    message: 'Semantic checks require NeMo',
    path: ['semanticChecks'],
  })
  .refine((p) => !p.safetyInstructions || (p.semanticChecks && p.provider === 'nemo'), {
    message: 'Safety instructions require NeMo semantic checks',
    path: ['safetyInstructions'],
  });
export type GuardrailPolicy = z.infer<typeof guardrailPolicySchema>;
export type GuardrailSnapshot = GuardrailPolicy & { id: string; revision?: number };
export type RailDecision = { decision: 'allow' | 'block' | 'modify'; content: string; reason?: string };

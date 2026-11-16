// Guardrails (#472): NeMo, Garak, classifiers and policy templates were removed from StockHarness. A run snapshots no
// policies, and checkRail passes content through unchanged (the behavior every run had with zero policies). The
// call sites stay so the runtime's control flow is untouched; GuardrailBlocked is never thrown.
import type { GuardrailSnapshot, RailStage } from './guardrailPolicy.js';
export { guardrailPolicySchema } from './guardrailPolicy.js';
export class GuardrailBlocked extends Error {}
export type GuardContext = {
  ownerId: string;
  runId: string;
  signal?: AbortSignal;
  guardrails?: GuardrailSnapshot[];
  event?: (e: { type: string; message: string; data?: unknown }) => Promise<void>;
};
/** Policies attached to a run: none (saved guardrailIds are ignored). */
export async function snapshotGuardrails(_ownerId: string, _ids: string[]): Promise<GuardrailSnapshot[]> {
  return [];
}
export async function checkRail(_ctx: GuardContext, _stage: RailStage, content: string, _tool?: string) {
  return content;
}

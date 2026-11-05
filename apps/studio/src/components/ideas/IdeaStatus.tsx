// Theory states as kit status pills (icon + text, never color alone).
import React from 'react';
import { StatusPill } from '../kit';
import { STATUS_LABEL } from './nav';

const PILL_OF: Record<string, string> = {
  pre_review: 'pending',
  post_review: 'pending',
  revise: 'warn',
  revise_code: 'warn',
  rejected_untestable: 'blocked',
  approved_for_code: 'queued',
  code_error: 'error',
  evaluated: 'evaluating',
};
export function IdeaStatus({ status }: { status: string }) {
  return <StatusPill status={PILL_OF[status] ?? status} label={STATUS_LABEL[status] ?? status} />;
}

import { after } from 'next/server';
import { getLogger } from '@/lib/logger';
import { dispatchEvent } from './dispatch';
import { makeWebhookEvent } from './events';
import { getWebhookStore } from './store';
import type { WebhookEventKind } from './types';

// ─── Route-safe webhook emission (Issue #1339) ─────────────────────────────────
//
// dispatchEvent retries with backoff (up to 15 s), so a route cannot await it.
// This helper never throws into the request, never delays the response, and
// uses `after` so delivery keeps running once the handler returns on serverless.

type WebhookEmitter = (kind: WebhookEventKind, payload: Record<string, unknown>) => void;

let emitterOverride: WebhookEmitter | null = null;

export function emitWebhookEvent(kind: WebhookEventKind, payload: Record<string, unknown>): void {
  if (emitterOverride) {
    emitterOverride(kind, payload);
    return;
  }

  // Resolved per call, not per module, so the warning carries the emitting
  // request's correlationId.
  const logger = getLogger('webhooks');
  const event = makeWebhookEvent(kind, payload);
  const task = dispatchEvent(event, getWebhookStore()).catch((err: unknown) =>
    logger.warn({ event: 'webhook_dispatch_failed', kind, error: String(err) })
  );

  try {
    after(() => task);
  } catch {
    // `after` throws outside a request scope (unit tests, scripts).
    void task;
  }
}

/** Test seam: capture emitted events instead of delivering them. */
export function _setWebhookEmitter(fn: WebhookEmitter | null): void {
  emitterOverride = fn;
}

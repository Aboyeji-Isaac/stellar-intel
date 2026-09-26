import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { after } from 'next/server';
import { InMemoryWebhookStore, _setWebhookStore } from '@/lib/webhooks/store';
import { emitWebhookEvent, _setWebhookEmitter } from '@/lib/webhooks/emit';
import type { WebhookSubscription } from '@/lib/webhooks/types';

const SUB: WebhookSubscription = {
  id: 'sub-1',
  url: 'https://example.com/webhook',
  secret: 'test-secret',
  events: ['intent.created'],
  createdAt: new Date().toISOString(),
};

let store: InMemoryWebhookStore;

beforeEach(async () => {
  store = new InMemoryWebhookStore();
  await store.saveSubscription(SUB);
  _setWebhookStore(store);
});

afterEach(() => {
  _setWebhookStore(null);
  _setWebhookEmitter(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('emitWebhookEvent', () => {
  it('delivers to a matching subscription and records one success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const record = vi.spyOn(store, 'recordDelivery');

    emitWebhookEvent('intent.created', { quoteId: 'q-1' });

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      eventKind: 'intent.created',
      subscriptionId: 'sub-1',
      status: 'success',
      attempts: 1,
    });
  });

  it('does not throw when fetch rejects, and dead-letters after the retries', async () => {
    // Fake timers: the real backoff is 1 + 2 + 4 + 8 s, the whole unit testTimeout.
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    const record = vi.spyOn(store, 'recordDelivery');

    expect(() => emitWebhookEvent('intent.created', { quoteId: 'q-1' })).not.toThrow();

    await vi.runAllTimersAsync();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ status: 'dead_letter', attempts: 5 });
  });

  it('swallows a store failure instead of leaking an unhandled rejection', async () => {
    const list = vi.spyOn(store, 'listSubscriptions').mockRejectedValue(new Error('db down'));

    expect(() => emitWebhookEvent('intent.created', {})).not.toThrow();

    // An unhandled rejection here would fail the run.
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('does not throw outside a request scope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const record = vi.spyOn(store, 'recordDelivery');

    // Proves this test exercises the fallback, not `after` itself.
    expect(() => after(() => undefined)).toThrow();
    expect(() => emitWebhookEvent('intent.created', {})).not.toThrow();

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
  });

  it('hands (kind, payload) to the test seam without delivering', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const captured = vi.fn();
    _setWebhookEmitter(captured);

    emitWebhookEvent('intent.created', { quoteId: 'q-1' });

    expect(captured).toHaveBeenCalledWith('intent.created', { quoteId: 'q-1' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

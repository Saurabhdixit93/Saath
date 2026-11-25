import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

function extractIds(payload: Record<string, unknown>): {
  partyId: string;
  holderId: string;
} {
  const party = payload.party as { id?: string } | undefined;
  const holders = payload.seat_holders as Array<{ id: string }> | undefined;
  if (!party?.id || !holders?.[0]?.id) {
    throw new Error(`Missing party/holder IDs: ${JSON.stringify(payload)}`);
  }
  return { partyId: party.id, holderId: holders[0].id };
}

async function setupMatchedPair(
  api: SaathApiClient,
  seed: string,
): Promise<{
  tokenA: string;
  tokenB: string;
  cardId: string;
}> {
  const uA = await api.loginWithOtp(uniquePhone(`${seed}-a`), 'whatsapp');
  const uB = await api.loginWithOtp(uniquePhone(`${seed}-b`), 'whatsapp');

  const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
  const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
  const a = extractIds(vA.data);
  const b = extractIds(vB.data);

  await api.setGoal(uB.access, b.partyId, {
    goal_type: 'open_to_help',
    movers: [b.holderId],
    constraints: {},
  });
  await api.setGoal(uA.access, a.partyId, {
    goal_type: 'lower',
    movers: [a.holderId],
    constraints: {},
  });

  let cardId = '';
  await expect(async () => {
    const m = await api.getMatches(uA.access, a.partyId);
    expect(m.data.items.length).toBeGreaterThanOrEqual(1);
    const first = m.data.items[0];
    if (!first) {
      throw new Error('Expected match card');
    }
    cardId = first.card_id;
  }).toPass({ timeout: 12_000 });

  return { tokenA: uA.access, tokenB: uB.access, cardId };
}

test.describe('@tier1 F16: Swap Proposal Lifecycle & Seat Locks', () => {
  test('POST /v1/swaps creates pending proposal at version 0 with valid expires_at', async () => {
    const api = new SaathApiClient();
    const { tokenA, cardId } = await setupMatchedPair(api, 'f16-create');

    const swapRes = await api.createSwap<{
      id: string;
      status: string;
      version: number;
      expires_at: string;
    }>(tokenA, cardId, 'Prefer lower for senior parent');

    expect([200, 201]).toContain(swapRes.status);
    expect(typeof swapRes.data.id).toBe('string');
    expect(swapRes.data.status).toBe('pending');
    expect(swapRes.data.version).toBe(0);
    expect(Number.isNaN(Date.parse(swapRes.data.expires_at))).toBe(false);
  });

  test('GET /v1/swaps?state=active lists pending swap without leaking partner PII pre-accept', async () => {
    const api = new SaathApiClient();
    const { tokenA, tokenB, cardId } = await setupMatchedPair(api, 'f16-active');

    const created = await api.createSwap<{ id: string }>(tokenA, cardId);
    expect(created.ok).toBe(true);

    const listB = await api.getSwaps(tokenB, 'active');
    expect(listB.status).toBe(200);
    expect(listB.data.items.some((s) => s.id === created.data.id)).toBe(true);

    const detailB = await api.getSwap(tokenB, created.data.id);
    expect(detailB.status).toBe(200);
    assertNoPiiLeak(detailB.data, 'f16-pre-accept-swap', [TEST_PNRS.cycleA]);
  });

  test('Mutual accept transitions swap to confirmed and reveals Swap Card & partner seats', async () => {
    const api = new SaathApiClient();
    const { tokenA, tokenB, cardId } = await setupMatchedPair(api, 'f16-confirm');

    const created = await api.createSwap<{ id: string; version: number }>(tokenA, cardId);
    expect(created.ok).toBe(true);

    const accA = await api.acceptSwap<{ status: string; version: number }>(
      tokenA,
      created.data.id,
      created.data.version,
    );
    const nextVersion = accA.ok ? accA.data.version : created.data.version;
    const accB = await api.acceptSwap<{ status: string; swap_card?: unknown }>(
      tokenB,
      created.data.id,
      nextVersion,
    );

    expect(accB.status).toBe(200);
    expect(accB.data.status).toBe('confirmed');

    const cardRes = await api.getSwapCard(tokenA, created.data.id, 'json');
    expect(cardRes.status).toBe(200);
    expect(cardRes.data.public_code).toBeTruthy();
  });

  test('POST /v1/swaps/{id}/decline transitions to declined and releases seat locks for re-proposal', async () => {
    const api = new SaathApiClient();
    const { tokenA, tokenB, cardId } = await setupMatchedPair(api, 'f16-decline');

    const created = await api.createSwap<{ id: string }>(tokenA, cardId);
    expect(created.ok).toBe(true);

    const dec = await api.declineSwap<{ status: string }>(tokenB, created.data.id, 'Cannot move');
    expect(dec.status).toBe(200);
    expect(dec.data.status).toBe('declined');

    const repropose = await api.createSwap<{ id: string; status: string }>(tokenA, cardId);
    expect([200, 201]).toContain(repropose.status);
    expect(repropose.data.status).toBe('pending');
  });

  test('POST /v1/swaps/{id}/cancel by initiator cancels proposal and releases seat locks', async () => {
    const api = new SaathApiClient();
    const { tokenA, cardId } = await setupMatchedPair(api, 'f16-cancel');

    const created = await api.createSwap<{ id: string }>(tokenA, cardId);
    expect(created.ok).toBe(true);

    const cancelled = await api.cancelSwap<{ status: string }>(tokenA, created.data.id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.status).toBe('cancelled');

    const repropose = await api.createSwap<{ id: string; status: string }>(tokenA, cardId);
    expect([200, 201]).toContain(repropose.status);
  });
});

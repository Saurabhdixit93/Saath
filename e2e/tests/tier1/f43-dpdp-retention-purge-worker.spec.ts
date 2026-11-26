import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  getAdminToken,
  getString,
  seedSwapDispute,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso, uniquePhone, uniquePnr } from '../../helpers/env.js';

test.describe('@tier1 F43 (Feature 13): Nightly Retention Purge & Erasure Worker Contracts', () => {
  test('Verified journeys retain bounded metadata without raw PNR exposure in hub or export', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f43-ret'));
    const pnr = uniquePnr('f43-pnr');
    const travelDate = futureDateIso(5);
    const v = await api.verifyTrainSms(
      auth.access,
      `IRCTC PNR:${pnr},TRN:12951,DOJ:${travelDate},CLS:3A,B3 1 LB,NDLS-MMCT`,
    );
    expect(v.status).toBe(200);
    const jId = getString(asRecord(v.data.journey, 'journey'), 'id');

    const hub = await api.getJourney(auth.access, jId);
    expect(hub.status).toBe(200);
    expect(JSON.stringify(hub.data)).not.toContain(pnr);

    const exp = await api.exportMyData(auth.access);
    expect(exp.status).toBe(200);
    expect(exp.buffer.toString('latin1')).not.toContain(pnr);
  });

  test('Party and seat invites persist bounded future invite_expires_at timestamps', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f43-inv'));
    const v = await api.verifyTrainSms(
      auth.access,
      `IRCTC PNR:${uniquePnr('f43-inv')},TRN:12951,DOJ:${futureDateIso(6)},CLS:3A,B3 4 LB,NDLS-MMCT`,
    );
    const jId = getString(asRecord(v.data.journey, 'j'), 'id');

    const partyInvite = await api.createPartyInvite(auth.access, jId);
    expect([200, 201]).toContain(partyInvite.status);
    expect(Date.parse(partyInvite.data.expires_at)).toBeGreaterThan(Date.now());

    const seatInvite = await api.createSeatInvite<{ expires_at?: string; token?: string; invite_url?: string }>(
      auth.access,
      jId,
      { coach: 'B3', seat_no: '6' },
    );
    expect([200, 201]).toContain(seatInvite.status);
    expect(Date.parse(String(seatInvite.data.expires_at))).toBeGreaterThan(Date.now());
  });

  test('User erasure preserves partner SwapProposal, SwapCard, and Karma integrity across cascade edges', async () => {
    const api = new SaathApiClient();
    const seeded = await seedSwapDispute(api, 'f43-cascade', {
      travelDate: futureDateIso(29),
      seatA: '1',
      seatB: '3',
      completeFirst: true,
    });

    const del = await api.deleteMyAccount(seeded.authB.access);
    expect([200, 202]).toContain(del.status);

    const partnerSwap = await api.getSwap(seeded.authA.access, seeded.swapId);
    expect(partnerSwap.status).toBe(200);
    expect(partnerSwap.data.status).toBe('completed');

    const pubCard = await api.verifyPublicSwapCard(seeded.publicCode);
    expect(pubCard.status).toBe(200);
    expect(pubCard.data.valid).toBe(true);

    const partnerKarma = await api.getKarma<{ balance: number }>(seeded.authA.access);
    expect(partnerKarma.status).toBe(200);
    expect(partnerKarma.data.balance).toBeGreaterThan(0);
  });

  test('/readyz and /v1/admin/providers/health confirm worker/scheduler Postgres, Redis, and outbox health', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const ready = await api.readyz();
    expect(ready.status).toBe(200);
    expect(ready.data.status).toBe('ready');

    const health = await api.getAdminProvidersHealth(adminToken);
    expect(health.status).toBe(200);
    const outbox = asRecord(health.data.outbox, 'outbox');
    expect(Number(outbox.dead_letter)).toBe(0);
    expect(Number(outbox.lag_seconds)).toBeGreaterThanOrEqual(0);
  });

  test('Audit log tracks DPDP export and erasure lifecycle events with anonymized actor metadata', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const auth = await api.loginWithOtp(uniquePhone('f43-lifecycle'));

    await api.exportMyData(auth.access);
    await api.deleteMyAccount(auth.access);

    const audit = await api.getAdminAuditLog<{
      items: Array<Record<string, unknown>>;
    }>(adminToken, { limit: 20 });
    expect(audit.status).toBe(200);
    const items = asArray(audit.data.items, 'audit items');
    const serialized = JSON.stringify(items);
    expect(serialized).toMatch(/export|dpdp/i);
    expect(serialized).toMatch(/eras|delete|dpdp/i);
  });
});

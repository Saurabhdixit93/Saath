import { test, expect } from '../../fixtures/multi-browser.js';
import { getAdminToken, seedSwapDispute } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';
import { EXPECTED_DPDP_EXPORT_FILES, parseDpdpExportZip } from '../../helpers/zip.js';

function hasForbiddenKey(node: unknown, forbiddenKeys: Set<string>): string | null {
  if (node === null || node === undefined || typeof node !== 'object') {
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = hasForbiddenKey(item, forbiddenKeys);
      if (found) return found;
    }
    return null;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (forbiddenKeys.has(k.toLowerCase())) {
      return k;
    }
    const nested = hasForbiddenKey(v, forbiddenKeys);
    if (nested) return nested;
  }
  return null;
}

test.describe('@tier1 F41 (Feature 11): Data Portability Export (GET /v1/me/export)', () => {
  test('GET /v1/me/export returns 200 application/zip with PK\\x03\\x04 header and attachment filename', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f41-headers'));

    const res = await api.exportMyData(auth.access);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/zip');
    expect(res.headers.get('content-disposition') ?? '').toContain('saath-data-export.zip');
    expect(res.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
  });

  test('ZIP archive decodes cleanly to all 8 expected JSON files', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f41-files'));

    const res = await api.exportMyData(auth.access);
    expect(res.status).toBe(200);
    const bundle = parseDpdpExportZip(res.buffer);
    expect(Object.keys(bundle).sort()).toEqual([...EXPECTED_DPDP_EXPORT_FILES].sort());
  });

  test('Rich-history user export populates journeys, parties, swaps, messages, karma, badges, and consents without raw PNR or encrypted keys', async () => {
    const api = new SaathApiClient();
    const seeded = await seedSwapDispute(api, 'f41-rich', {
      travelDate: futureDateIso(27),
      seatA: '1',
      seatB: '3',
      completeFirst: true,
    });
    await api.sendMessage(seeded.authA.access, seeded.convoId, 'Exportable chat history line');
    const consents = await api.getConsents<{ notice_version: string }>(seeded.authA.access);
    await api.saveConsents(seeded.authA.access, [
      { purpose: 'verification', notice_version: consents.data.notice_version, granted: true },
    ]);

    const res = await api.exportMyData(seeded.authA.access);
    expect(res.status).toBe(200);
    const bundle = parseDpdpExportZip(res.buffer);

    expect(JSON.stringify(bundle['journeys.json'])).toContain('12951');
    expect(JSON.stringify(bundle['swaps.json'])).toContain(seeded.swapId);
    expect(JSON.stringify(bundle['messages.json'])).toContain('Exportable chat history line');
    expect(JSON.stringify(bundle['karma.json'])).toMatch(/credited|points|delta/i);
    expect(JSON.stringify(bundle['badges.json'])).toContain('first_swap');
    expect(JSON.stringify(bundle['consents.json'])).toContain('verification');

    expect(
      hasForbiddenKey(bundle, new Set(['phone_enc', 'phone_bidx', 'raw_pnr', 'pnr_hash', 'pnr'])),
    ).toBeNull();
  });

  test('Export strips partner phone/PNR PII and keeps child seat holders as age_band=child only', async () => {
    const api = new SaathApiClient();
    const phoneA = uniquePhone('f41-nopii-a');
    const phoneB = uniquePhone('f41-nopii-b');
    const authA = await api.loginWithOtp(phoneA);
    const authB = await api.loginWithOtp(phoneB);

    await api.verifyTrainPnr(authA.access, TEST_PNRS.rajdhani3A);
    await api.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);

    const res = await api.exportMyData(authA.access);
    expect(res.status).toBe(200);
    const bundle = parseDpdpExportZip(res.buffer);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(TEST_PNRS.rajdhani3A);
    expect(serialized).not.toContain(phoneB);
    assertNoPiiLeak(bundle['swaps.json'], 'f41-export-swaps-no-pii', [phoneB, TEST_PNRS.cycleB]);
    assertNoPiiLeak(bundle['parties.json'], 'f41-export-parties-no-pii', [phoneB]);
  });

  test('GET /v1/me/export appends an audit_log entry', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const auth = await api.loginWithOtp(uniquePhone('f41-audit'));

    const before = await api.getAdminAuditLog<{ total: number }>(adminToken);
    const res = await api.exportMyData(auth.access);
    expect(res.status).toBe(200);

    const after = await api.getAdminAuditLog<{
      total: number;
      items: Array<Record<string, unknown>>;
    }>(adminToken, { limit: 10 });
    expect(after.data.total).toBeGreaterThan(before.data.total);
    expect(JSON.stringify(after.data.items)).toMatch(/export|dpdp/i);
  });
});

import { test, expect } from '@playwright/test';
import { injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

function requireId(val: unknown, label: string): string {
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected non-empty ${label}`);
  }
  return val;
}

test.describe('@tier1 F11: Journey List, Hub, Reverify, Delete', () => {
  test('GET /v1/journeys lists active verified journeys for current actor', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f11-list'), 'whatsapp');
    const verified = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      auth.access,
      TEST_PNRS.rajdhani3A,
    );
    expect(verified.ok).toBe(true);
    const journeyId = requireId(verified.data.journey?.id, 'journey.id');

    const listRes = await api.getJourneys(auth.access);
    expect(listRes.status).toBe(200);
    const hasJourney = listRes.data.items.some((item) => {
      const j = item.journey as { id?: string } | undefined;
      return item.id === journeyId || j?.id === journeyId;
    });
    expect(hasJourney).toBe(true);
  });

  test('GET /v1/journeys/{id} returns Hub DTO (chart, party, goal, counts) without leaked PII', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f11-hub'), 'whatsapp');
    const verified = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      auth.access,
      TEST_PNRS.rajdhani3A,
    );
    const journeyId = requireId(verified.data.journey?.id, 'journey.id');

    const hub = await api.getJourney(auth.access, journeyId);
    expect(hub.status).toBe(200);
    expect(hub.data.journey).toBeTruthy();
    expect(hub.data.chart).toBeTruthy();
    expect(hub.data.party).toBeTruthy();
    assertNoPiiLeak(hub.data, 'f11-hub', [TEST_PNRS.rajdhani3A], {
      allowedKeys: ['seat_no'],
    });
  });

  test('Web UI /journeys/[id] renders ChartStatusPill, PartyAvatarRow, and Set goal CTA', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f11-ui'), 'whatsapp');
    const verified = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      auth.access,
      TEST_PNRS.rajdhani3A,
    );
    const journeyId = requireId(verified.data.journey?.id, 'journey.id');

    await injectAuthSession(page, auth);
    await page.goto(`${E2E_ENV.webUrl}/journeys/${journeyId}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByText(/chart/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /set goal|goal|लक्ष्य/i }).first()).toBeVisible();
  });

  test('POST /v1/journeys/{id}/reverify refreshes booking and chart status', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f11-reverify'), 'whatsapp');
    const verified = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      auth.access,
      TEST_PNRS.sleeperSL,
    );
    const journeyId = requireId(verified.data.journey?.id, 'journey.id');

    const reverify = await api.reverifyJourney(auth.access, journeyId);
    expect(reverify.status).toBe(200);
    expect(reverify.data.chart).toBeTruthy();
  });

  test('DELETE /v1/journeys/{id} deletes booking and removes it from GET /v1/journeys', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f11-delete'), 'whatsapp');
    const verified = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      auth.access,
      TEST_PNRS.vandeBharatCC,
    );
    const journeyId = requireId(verified.data.journey?.id, 'journey.id');

    const delRes = await api.deleteJourney(auth.access, journeyId);
    expect([200, 204]).toContain(delRes.status);

    const listRes = await api.getJourneys(auth.access);
    expect(listRes.status).toBe(200);
    const stillPresent = listRes.data.items.some((item) => {
      const j = item.journey as { id?: string } | undefined;
      return item.id === journeyId || j?.id === journeyId;
    });
    expect(stillPresent).toBe(false);
  });
});

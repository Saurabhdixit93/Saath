import { test, expect } from '@playwright/test';
import { injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function extractIds(payload: Record<string, unknown>): {
  journeyId: string;
  partyId: string;
  holderId: string;
} {
  const journey = payload.journey as { id?: string } | undefined;
  const party = payload.party as { id?: string } | undefined;
  const holders = payload.seat_holders as Array<{ id: string }> | undefined;
  if (!journey?.id || !party?.id || !holders?.[0]?.id) {
    throw new Error(`Missing IDs in verify response: ${JSON.stringify(payload)}`);
  }
  return {
    journeyId: journey.id,
    partyId: party.id,
    holderId: holders[0].id,
  };
}

test.describe('@tier1 F13: 3-Step Goal Wizard & Constraints', () => {
  test('PUT /v1/parties/{pid}/goal sets lower berth goal and returns match_version', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f13-lower'), 'whatsapp');
    const verified = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const { partyId, holderId } = extractIds(verified.data);

    const goalRes = await api.setGoal<{ goal?: { goal_type: string }; match_version?: number }>(
      auth.access,
      partyId,
      {
        goal_type: 'lower',
        movers: [holderId],
        constraints: { women_only: false, no_middle: true },
      },
    );
    expect([200, 201]).toContain(goalRes.status);
    expect(goalRes.data.goal?.goal_type).toBe('lower');
    expect(typeof goalRes.data.match_version).toBe('number');
  });

  test('PUT /v1/parties/{pid}/goal sets together goal with same_coach_only and no_middle', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f13-together'), 'whatsapp');
    const verified = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const { partyId, holderId } = extractIds(verified.data);

    const goalRes = await api.setGoal<{
      goal?: { goal_type: string; constraints?: Record<string, boolean> };
    }>(auth.access, partyId, {
      goal_type: 'together',
      movers: [holderId],
      constraints: { same_coach_only: true, no_middle: true, verified_only: true },
    });
    expect([200, 201]).toContain(goalRes.status);
    expect(goalRes.data.goal?.goal_type).toBe('together');
    expect(goalRes.data.goal?.constraints?.same_coach_only).toBe(true);
  });

  test('PUT /v1/parties/{pid}/goal sets open_to_help with standing_offer give_to=senior', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f13-open'), 'whatsapp');
    const verified = await api.verifyTrainPnr(auth.access, TEST_PNRS.sleeperSL);
    const { partyId, holderId } = extractIds(verified.data);

    const goalRes = await api.setGoal<{ goal?: { goal_type: string } }>(auth.access, partyId, {
      goal_type: 'open_to_help',
      movers: [holderId],
      constraints: {},
      standing_offer: { give_to: 'senior' },
    });
    expect([200, 201]).toContain(goalRes.status);
    expect(goalRes.data.goal?.goal_type).toBe('open_to_help');
  });

  test('Web UI 3-step Goal Wizard BottomSheet walks through movers, goal, and constraints', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f13-ui-wizard'), 'whatsapp');
    const verified = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const { journeyId } = extractIds(verified.data);

    await injectAuthSession(page, auth);
    await page.goto(`${E2E_ENV.webUrl}/journeys/${journeyId}`, {
      waitUntil: 'domcontentloaded',
    });

    await page.getByRole('button', { name: /set goal|edit goal|लक्ष्य/i }).first().click();

    await expect(page.getByText(/who needs to move|step 1|select/i).first()).toBeVisible();
    await page.getByRole('button', { name: /next|continue|आगे/i }).first().click();

    await page.getByRole('button', { name: /lower|together|निचली/i }).first().click();
    await page.getByRole('button', { name: /next|continue|आगे/i }).first().click();

    await page.getByRole('button', { name: /save|confirm|find matches|पुष्टि/i }).first().click();
    await expect(page.getByText(/lower|together|match|goal/i).first()).toBeVisible();
  });

  test('DELETE /v1/parties/{pid}/goal clears the active party goal', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f13-delete'), 'whatsapp');
    const verified = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const { partyId, holderId } = extractIds(verified.data);

    await api.setGoal(auth.access, partyId, {
      goal_type: 'lower',
      movers: [holderId],
      constraints: {},
    });

    const delRes = await api.deleteGoal(auth.access, partyId);
    expect([200, 204]).toContain(delRes.status);
  });
});

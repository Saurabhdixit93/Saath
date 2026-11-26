import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  getAdminToken,
  seedSwapDispute,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso } from '../../helpers/env.js';

test.describe('@tier1 F32 (Feature 2): Route & Conversion Funnel Analytics', () => {
  test('GET /v1/admin/analytics/funnel returns all funnel steps, match_rate, notification_delivery, and routes', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const funnel = await api.getAdminFunnel(adminToken);
    expect(funnel.status).toBe(200);

    for (const key of [
      'verified',
      'goal_set',
      'matched',
      'swap_created',
      'swap_confirmed',
      'swap_completed',
    ]) {
      expect(typeof funnel.data[key]).toBe('number');
      expect(Number(funnel.data[key])).toBeGreaterThanOrEqual(0);
    }
    expect(typeof funnel.data.match_rate).toBe('number');
    expect(Array.isArray(funnel.data.routes)).toBe(true);
    expect(typeof funnel.data.notification_delivery).toBe('object');
  });

  test('Completing a journey -> goal -> match -> swap -> confirm increments funnel metrics', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const travelDate = futureDateIso(27);

    const before = await api.getAdminFunnel(adminToken, { route: '12951' });
    expect(before.status).toBe(200);
    const beforeVerified = Number(before.data.verified);
    const beforeGoals = Number(before.data.goal_set);
    const beforeSwaps = Number(before.data.swap_created);
    const beforeCompleted = Number(before.data.swap_completed);

    await seedSwapDispute(api, 'f32-funnel-inc', {
      travelDate,
      seatA: '1',
      seatB: '3',
      completeFirst: true,
    });

    const after = await api.getAdminFunnel(adminToken, { route: '12951' });
    expect(after.status).toBe(200);
    expect(Number(after.data.verified)).toBeGreaterThanOrEqual(beforeVerified + 2);
    expect(Number(after.data.goal_set)).toBeGreaterThanOrEqual(beforeGoals + 2);
    expect(Number(after.data.swap_created)).toBeGreaterThanOrEqual(beforeSwaps + 1);
    expect(Number(after.data.swap_completed)).toBeGreaterThanOrEqual(beforeCompleted + 1);
  });

  test('routes[] entries include RouteFunnelItem breakdown fields', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    await seedSwapDispute(api, 'f32-funnel-routes', {
      travelDate: futureDateIso(28),
      seatA: '4',
      seatB: '6',
      completeFirst: true,
    });

    const funnel = await api.getAdminFunnel(adminToken, { route: '12951' });
    expect(funnel.status).toBe(200);
    const routes = asArray(funnel.data.routes, 'routes');
    expect(routes.length).toBeGreaterThanOrEqual(1);
    const firstRoute = asRecord(routes[0], 'first route item');
    expect(typeof firstRoute.route).toBe('string');
    expect(firstRoute.service_no).toBe('12951');
    expect(typeof firstRoute.mode).toBe('string');
    expect(typeof firstRoute.carrier_code).toBe('string');
    expect(Number(firstRoute.journeys)).toBeGreaterThanOrEqual(1);
    expect(Number(firstRoute.match_rate)).toBeGreaterThanOrEqual(0);
  });

  test('notification_delivery exposes queued, sent, dead_letter, total, and bounded delivery_rate', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const funnel = await api.getAdminFunnel(adminToken);
    expect(funnel.status).toBe(200);
    const delivery = asRecord(funnel.data.notification_delivery, 'notification_delivery');
    for (const key of ['total', 'queued', 'sent', 'dead_letter']) {
      expect(typeof delivery[key]).toBe('number');
      expect(Number(delivery[key])).toBeGreaterThanOrEqual(0);
    }
    expect(typeof delivery.delivery_rate).toBe('number');
    expect(Number(delivery.delivery_rate)).toBeGreaterThanOrEqual(0);
    expect(Number(delivery.delivery_rate)).toBeLessThanOrEqual(1);
  });

  test('Funnel supports route (service_no and O-D pair) and date range filters', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const byTrain = await api.getAdminFunnel(adminToken, {
      route: '12951',
      from_date: '2026-01-01',
      to_date: '2028-12-31',
    });
    expect(byTrain.status).toBe(200);
    expect(byTrain.data.route).toBe('12951');
    expect(byTrain.data.from_date).toBe('2026-01-01');
    expect(byTrain.data.to_date).toBe('2028-12-31');

    const byOdPair = await api.getAdminFunnel(adminToken, { route: 'NDLS-MMCT' });
    expect(byOdPair.status).toBe(200);
    expect(byOdPair.data.route).toBe('NDLS-MMCT');
  });
});

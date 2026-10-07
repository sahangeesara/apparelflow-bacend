import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

let server: Server, base: string;
beforeAll(() => { server = createApp(openDb(':memory:')).listen(0); base = `http://localhost:${(server.address() as { port: number }).port}`; });
afterAll(() => { server.close(); });

const login = async (email: string, password: string) =>
  (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).headers.get('set-cookie')!.split(';')[0];
const post = (cookie: string | null, path: string, body?: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });

describe('HTTP layer', () => {
  it('direct POST approve: anonymous 401, supervisor 403, verifier on empty order 422', async () => {
    const sup = await login('supervisor@apparelflow.test', 'Supervisor@123'), ver = await login('verifier@apparelflow.test', 'Verifier@123');
    const created = await post(sup, '/api/orders', { recipe_id: 1, target_qty: 10, fabric_roll_id: 'FAB-ROLL-882', actual_fabric_yds: 19 });
    expect(created.status).toBe(201);
    const { order } = await created.json();
    expect((await post(null, `/api/orders/${order.id}/approve`)).status).toBe(401);
    expect((await post(sup, `/api/orders/${order.id}/approve`)).status).toBe(403);
    expect((await post(ver, `/api/orders/${order.id}/approve`)).status).toBe(422);
  });
  it('sewing queue is inaccessible to supervisor and bad JSON gives 400', async () => {
    const sup = await login('supervisor@apparelflow.test', 'Supervisor@123');
    expect((await fetch(base + '/api/sewing/queue', { headers: { cookie: sup } })).status).toBe(403);
    expect((await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status).toBe(400);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db';
import { approve, createOrder, HttpError, reject, saveCounts, sewingQueue } from '../src/service';
import type { User } from '../src/types';

let db: ReturnType<typeof openDb>, sup: User, ver: User, sew: User;
const user = (email: string) => db.prepare('SELECT id,email,role,full_name FROM users WHERE email=?').get(email) as User;
const newOrder = () => createOrder(db, sup, { recipe_id: 1, target_qty: 10, fabric_roll_id: 'FAB-ROLL-882', actual_fabric_yds: 19 });
const parts = (id: number) => db.prepare(`SELECT c.id component_id,c.pieces_per_garment*o.target_qty expected_qty FROM cutting_orders o JOIN recipe_components c ON c.recipe_id=o.recipe_id WHERE o.id=?`).all(id) as { component_id: number; expected_qty: number }[];
const countAll = (id: number, delta: Record<number, number> = {}) =>
  saveCounts(db, ver, id, { counts: Object.fromEntries(parts(id).map(c => [c.component_id, c.expected_qty + (delta[c.component_id] ?? 0)])) });
const status = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as HttpError).status; } return 200; };

beforeEach(() => { db = openDb(':memory:'); sup = user('supervisor@apparelflow.test'); ver = user('verifier@apparelflow.test'); sew = user('sewing@apparelflow.test'); });

describe('Cutting gatekeeper', () => {
  it('1. all GREEN order is approved by verifier and reaches the sewing queue', () => {
    const o = newOrder(); countAll(o.id);
    const done = approve(db, ver, o.id);
    expect(done.status).toBe('VERIFIED');
    expect(done.last_log?.wastage_pct).toBe(5.56);
    expect(sewingQueue(db, sew).map(x => x.id)).toContain(o.id);
  });
  it('2. a RED (shortage) component blocks approval with 422', () => {
    const o = newOrder(); const first = parts(o.id)[0].component_id;
    countAll(o.id, { [first]: -1 });
    expect(status(() => approve(db, ver, o.id))).toBe(422);
    expect(sewingQueue(db, sew)).toHaveLength(0);
  });
  it('2b. uncounted components also block approval', () => { expect(status(() => approve(db, ver, newOrder().id))).toBe(422); });
  it('3. rejecting without a reason note fails validation', () => {
    const o = newOrder();
    expect(status(() => reject(db, ver, o.id, { note: '   ' }))).toBe(422);
    expect(status(() => reject(db, ver, o.id, {}))).toBe(422);
    expect(reject(db, ver, o.id, { note: 'Collar shortage, re-cut' }).status).toBe('REJECTED');
  });
  it('4. non-verifier roles get 403; anonymous gets 401', () => {
    const o = newOrder();
    for (const u of [sup, sew]) {
      expect(status(() => approve(db, u, o.id))).toBe(403);
      expect(status(() => reject(db, u, o.id, { note: 'nope nope' }))).toBe(403);
      expect(status(() => saveCounts(db, u, o.id, { counts: { 1: 1 } }))).toBe(403);
    }
    expect(status(() => approve(db, null, o.id))).toBe(401);
    expect(status(() => createOrder(db, ver, {}))).toBe(403);
    expect(status(() => sewingQueue(db, sup))).toBe(403);
  });
  it('5. unapproved orders never appear in the sewing queue', () => {
    const pending = newOrder(), rejected = newOrder();
    reject(db, ver, rejected.id, { note: 'Fabric defects found' });
    const ids = sewingQueue(db, sew).map(x => x.id);
    expect(ids).not.toContain(pending.id); expect(ids).not.toContain(rejected.id);
  });
  it('6. input guards reject negatives, decimals, strings and empty payloads', () => {
    const o = newOrder(), id = parts(o.id)[0].component_id;
    for (const bad of [-1, 1.5, 'abc', null]) expect(status(() => saveCounts(db, ver, o.id, { counts: { [id]: bad } }))).toBe(400);
    expect(status(() => saveCounts(db, ver, o.id, {}))).toBe(400);
    for (const body of [{}, { recipe_id: 1, target_qty: -5, fabric_roll_id: 'FAB-1', actual_fabric_yds: 10 }, { recipe_id: 1, target_qty: 2.5, fabric_roll_id: 'FAB-1', actual_fabric_yds: 10 }])
      expect(status(() => createOrder(db, sup, body))).toBe(400);
  });
});

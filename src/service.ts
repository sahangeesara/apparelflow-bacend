// All business rules live here (framework-free) so route handlers stay thin and tests can call them directly.
import crypto from 'crypto';
import { type DB, supabase } from './db.ts';
import type { Flag, Order, Recipe, Role, User } from './types.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}
type Body = Record<string, unknown> | null | undefined;
const flag = (a: number, e: number): Flag => (a === e ? 'GREEN' : a > e ? 'YELLOW' : 'RED');

export function requireRole(u: User | null, ...roles: Role[]): User {
  if (!u) throw new HttpError(401, 'Not authenticated');
  if (!roles.includes(u.role)) throw new HttpError(403, `Forbidden for role ${u.role}`);
  return u;
}
export function userFromToken(db: DB, token?: string): User | null {
  if (!token || !/^[a-f0-9]+$/.test(token)) return null;
  return (db.prepare('SELECT u.id,u.email,u.role,u.full_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?').get(token, Date.now()) as User) ?? null;
}
export async function login(db: DB, body: Body) {
  const { email, password } = body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new HttpError(401, 'Invalid email or password');
  }
  const normalizedEmail = email.trim().toLowerCase();
  const { error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
  if (error) throw new HttpError(401, 'Invalid email or password');

  const u = db.prepare('SELECT id,email,role,full_name FROM users WHERE email=?')
    .get(normalizedEmail) as User | undefined;
  if (!u) {
    throw new HttpError(403, 'Account profile is not configured');
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, u.id, Date.now() + 8 * 3600e3);
  return { token, user: u };
}

export async function signup(db: DB, body: Body) {
  const { email, password, full_name, role } = body ?? {};
  const roles: Role[] = ['cutting_supervisor', 'cutting_verifier', 'sewing_supervisor'];
  if (typeof email !== 'string' || typeof password !== 'string' || typeof full_name !== 'string' ||
      !roles.includes(role as Role) || password.length < 8 || full_name.trim().length < 2) {
    throw new HttpError(400, 'email, password (min 8 characters), full_name and a valid role are required');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(normalizedEmail);
  if (existing) throw new HttpError(409, 'An account with this email already exists');

  const { data, error } = await supabase.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    if (error?.message.toLowerCase().includes('already')) throw new HttpError(409, 'An account with this email already exists');
    throw new HttpError(400, error?.message ?? 'Unable to create account');
  }

  try {
    const result = db.prepare(
      'INSERT INTO users(email,password_hash,role,full_name) VALUES(?,?,?,?)',
    ).run(normalizedEmail, 'managed-by-supabase-auth', role, full_name.trim());
    const user = db.prepare('SELECT id,email,role,full_name FROM users WHERE id=?').get(result.lastInsertRowid) as User;
    return { user };
  } catch (error) {
    await supabase.auth.admin.deleteUser(data.user.id);
    if (error instanceof Error && error.message.includes('UNIQUE')) {
      throw new HttpError(409, 'An account with this email already exists');
    }
    throw error;
  }
}
export const logout = (db: DB, token?: string) => { if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token); };

export function getOrder(db: DB, id: number): Order | null {
  const o = db.prepare(`SELECT o.*,r.name recipe_name,r.recipe_code,r.std_fabric_yards,r.wastage_cap,u.full_name created_by_name
    FROM cutting_orders o JOIN recipes r ON r.id=o.recipe_id JOIN users u ON u.id=o.created_by WHERE o.id=?`).get(id) as Order | undefined;
  if (!o) return null;
  o.expected_fabric = +(o.target_qty * o.std_fabric_yards).toFixed(2);
  o.components = (db.prepare(`SELECT c.id component_id,c.component_name,c.pieces_per_garment,c.pieces_per_garment*? expected_qty,i.actual_qty
    FROM recipe_components c LEFT JOIN verification_items i ON i.component_id=c.id AND i.order_id=? WHERE c.recipe_id=? ORDER BY c.id`).all(o.target_qty, id, o.recipe_id) as Order['components'])
    .map(c => ({ ...c, status: c.actual_qty == null ? null : flag(c.actual_qty, c.expected_qty) }));
  o.last_log = (db.prepare(`SELECT l.decision,l.rejection_note,l.wastage_pct,l.timestamp,u.full_name verifier_name FROM verification_logs l JOIN users u ON u.id=l.verifier_id WHERE order_id=? ORDER BY l.id DESC LIMIT 1`).get(id) as Order['last_log']) ?? null;
  return o;
}
const wastage = (o: Order) => +(((o.actual_fabric_yds - o.expected_fabric) / o.expected_fabric) * 100).toFixed(2);

export function listRecipes(db: DB, u: User | null): Recipe[] {
  requireRole(u, 'cutting_supervisor', 'cutting_verifier');
  const rs = db.prepare('SELECT id,recipe_code,name,std_fabric_yards,wastage_cap FROM recipes').all() as Recipe[];
  for (const r of rs) r.components = db.prepare('SELECT id,component_name,pieces_per_garment FROM recipe_components WHERE recipe_id=?').all(r.id) as Recipe['components'];
  return rs;
}
export function createOrder(db: DB, u: User | null, body: Body): Order {
  const user = requireRole(u, 'cutting_supervisor');
  const { recipe_id, target_qty, fabric_roll_id, actual_fabric_yds } = body ?? {};
  const f: Record<string, string> = {};
  if (!Number.isInteger(recipe_id) || !db.prepare('SELECT 1 FROM recipes WHERE id=?').get(recipe_id as number)) f.recipe_id = 'Choose a valid recipe';
  if (!Number.isInteger(target_qty) || (target_qty as number) <= 0 || (target_qty as number) > 100000) f.target_qty = 'Whole number greater than 0 required';
  if (typeof fabric_roll_id !== 'string' || !/^[A-Za-z0-9-]{3,40}$/.test(fabric_roll_id.trim())) f.fabric_roll_id = 'Letters, digits and dashes only (e.g. FAB-ROLL-882)';
  if (typeof actual_fabric_yds !== 'number' || !isFinite(actual_fabric_yds) || actual_fabric_yds <= 0) f.actual_fabric_yds = 'Positive number of yards required';
  if (Object.keys(f).length) throw new HttpError(400, 'Validation failed', { fields: f });
  const id = db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO cutting_orders(recipe_id,target_qty,fabric_roll_id,actual_fabric_yds,status,created_by) VALUES(?,?,?,?,?,?)')
      .run(recipe_id, target_qty, (fabric_roll_id as string).trim(), actual_fabric_yds, 'PENDING_VERIFICATION', user.id).lastInsertRowid);
    db.prepare('UPDATE cutting_orders SET order_no=? WHERE id=?').run('CUT-' + String(id).padStart(4, '0'), id);
    return id;
  })();
  return getOrder(db, id)!;
}
export function listOrders(db: DB, u: User | null): Order[] {
  const user = requireRole(u, 'cutting_supervisor', 'cutting_verifier');
  const where = user.role === 'cutting_verifier' ? "WHERE status='PENDING_VERIFICATION'" : '';
  return (db.prepare(`SELECT id FROM cutting_orders ${where} ORDER BY id DESC`).all() as { id: number }[]).map(r => getOrder(db, r.id)!);
}
export function getOrderFor(db: DB, u: User | null, id: number): Order {
  const user = requireRole(u, 'cutting_supervisor', 'cutting_verifier');
  const o = getOrder(db, id);
  if (!o || (user.role === 'cutting_verifier' && o.status !== 'PENDING_VERIFICATION')) throw new HttpError(404, 'Order not found');
  return o;
}
export function resubmit(db: DB, u: User | null, id: number): Order {
  requireRole(u, 'cutting_supervisor');
  const o = getOrder(db, id);
  if (!o) throw new HttpError(404, 'Order not found');
  if (o.status !== 'REJECTED') throw new HttpError(409, 'Only REJECTED orders can be resubmitted');
  db.transaction(() => {
    db.prepare('DELETE FROM verification_items WHERE order_id=?').run(id);
    db.prepare("UPDATE cutting_orders SET status='PENDING_VERIFICATION',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='REJECTED'").run(id);
  })();
  return getOrder(db, id)!;
}

function pendingOrder(db: DB, id: number): Order {
  const o = getOrder(db, id);
  if (!o) throw new HttpError(404, 'Order not found');
  if (o.status !== 'PENDING_VERIFICATION') throw new HttpError(409, `Order is ${o.status}, not PENDING_VERIFICATION`);
  return o;
}
export function saveCounts(db: DB, u: User | null, id: number, body: Body): Order {
  requireRole(u, 'cutting_verifier');
  const o = pendingOrder(db, id), counts = body?.counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) || !Object.keys(counts).length) throw new HttpError(400, 'counts payload required');
  const byId = new Map(o.components.map(c => [String(c.component_id), c])), f: Record<string, string> = {};
  for (const [k, v] of Object.entries(counts as Record<string, unknown>)) {
    if (!byId.has(k)) f[k] = 'Unknown component';
    else if (!Number.isInteger(v) || (v as number) < 0) f[k] = 'Whole number 0 or greater required';
  }
  if (Object.keys(f).length) throw new HttpError(400, 'Invalid counts', { fields: f });
  db.transaction(() => {
    for (const [k, v] of Object.entries(counts as Record<string, number>)) {
      const c = byId.get(k)!;
      db.prepare(`INSERT INTO verification_items(order_id,component_id,expected_qty,actual_qty,status) VALUES(?,?,?,?,?)
        ON CONFLICT(order_id,component_id) DO UPDATE SET actual_qty=excluded.actual_qty,status=excluded.status,expected_qty=excluded.expected_qty`).run(id, c.component_id, c.expected_qty, v, flag(v, c.expected_qty));
    }
  })();
  return getOrder(db, id)!;
}
export function approve(db: DB, u: User | null, id: number): Order {
  const user = requireRole(u, 'cutting_verifier');
  const o = pendingOrder(db, id);
  // Hard stop: recomputed from stored counts on the server; client-side state is never trusted.
  const blocked = o.components.filter(c => c.actual_qty == null || c.actual_qty < c.expected_qty).map(c => c.component_name);
  if (blocked.length) throw new HttpError(422, 'Hard stop: shortage or uncounted components block approval', { blocked });
  const variances = JSON.stringify(o.components.map(c => ({ component: c.component_name, expected: c.expected_qty, actual: c.actual_qty, variance: (c.actual_qty ?? 0) - c.expected_qty })));
  const ok = db.transaction(() => {
    const r = db.prepare("UPDATE cutting_orders SET status='VERIFIED',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='PENDING_VERIFICATION'").run(id);
    if (!r.changes) return false;
    db.prepare("INSERT INTO verification_logs(order_id,verifier_id,decision,wastage_pct,variances,timestamp) VALUES(?,?,'APPROVED',?,?,?)").run(id, user.id, wastage(o), variances, new Date().toISOString());
    return true;
  })();
  if (!ok) throw new HttpError(409, 'Order state changed');
  return getOrder(db, id)!;
}
export function reject(db: DB, u: User | null, id: number, body: Body): Order {
  const user = requireRole(u, 'cutting_verifier');
  const o = pendingOrder(db, id);
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (note.length < 5) throw new HttpError(422, 'A rejection reason (min 5 characters) is mandatory', { fields: { note: 'Reason required' } });
  db.transaction(() => {
    db.prepare("UPDATE cutting_orders SET status='REJECTED',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='PENDING_VERIFICATION'").run(id);
    db.prepare("INSERT INTO verification_logs(order_id,verifier_id,decision,rejection_note,wastage_pct,timestamp) VALUES(?,?,'REJECTED',?,?,?)").run(id, user.id, note, wastage(o), new Date().toISOString());
  })();
  return getOrder(db, id)!;
}
// Query isolation: status filter is hard-coded in SQL, no caller input can widen it.
export function sewingQueue(db: DB, u: User | null): Order[] {
  requireRole(u, 'sewing_supervisor');
  return (db.prepare("SELECT id FROM cutting_orders WHERE status = 'VERIFIED' ORDER BY updated_at DESC").all() as { id: number }[]).map(r => getOrder(db, r.id)!);
}
export function startSewing(db: DB, u: User | null, id: number): Order {
  const user = requireRole(u, 'sewing_supervisor');
  const r = db.prepare("UPDATE cutting_orders SET sewing_started_at=?,sewing_started_by=? WHERE id=? AND status='VERIFIED' AND sewing_started_at IS NULL").run(new Date().toISOString(), user.id, id);
  if (!r.changes) throw new HttpError(409, 'Order not in queue or already started');
  return getOrder(db, id)!;
}

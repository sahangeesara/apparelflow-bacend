import { supabase } from './db.ts';
import type { Component, Flag, Log, Order, Recipe, Role, User } from './types.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}
type Body = Record<string, unknown> | null | undefined;
const flag = (actual: number, expected: number): Flag => actual === expected ? 'GREEN' : actual > expected ? 'YELLOW' : 'RED';
const fail = (error: { message: string } | null, status = 400) => { if (error) throw new HttpError(status, `Supabase: ${error.message}`); };
const table = (name: string) => supabase.from(name);

export const ADMIN_TABLES = ['cutting_orders', 'profiles', 'recipe_components', 'recipes', 'sessions', 'verification_items', 'verification_logs'] as const;
type AdminTable = typeof ADMIN_TABLES[number];
type AdminColumn = { name: string; type: string; pk: number; notnull: number; dflt_value: unknown };
const GENERATED_ID_TABLES = new Set<AdminTable>([
  'recipes',
  'recipe_components',
  'cutting_orders',
  'verification_items',
  'verification_logs',
]);
const schemas: Record<AdminTable, AdminColumn[]> = {
  recipes: [{ name: 'id', type: 'bigint', pk: 1, notnull: 1, dflt_value: 'GENERATED ALWAYS AS IDENTITY' }, { name: 'recipe_code', type: 'text', pk: 0, notnull: 1, dflt_value: null }, { name: 'name', type: 'text', pk: 0, notnull: 1, dflt_value: null }, { name: 'category', type: 'text', pk: 0, notnull: 1, dflt_value: null }, { name: 'std_fabric_yards', type: 'numeric', pk: 0, notnull: 1, dflt_value: null }, { name: 'wastage_cap', type: 'numeric', pk: 0, notnull: 1, dflt_value: null }],
  profiles: [{ name: 'id', type: 'uuid', pk: 1, notnull: 1, dflt_value: null }, { name: 'full_name', type: 'text', pk: 0, notnull: 1, dflt_value: null }, { name: 'role', type: 'text', pk: 0, notnull: 1, dflt_value: null }],
  recipe_components: [{ name: 'id', type: 'bigint', pk: 1, notnull: 1, dflt_value: 'GENERATED ALWAYS AS IDENTITY' }, { name: 'recipe_id', type: 'bigint', pk: 0, notnull: 1, dflt_value: null }, { name: 'component_name', type: 'text', pk: 0, notnull: 1, dflt_value: null }, { name: 'pieces_per_garment', type: 'int', pk: 0, notnull: 1, dflt_value: null }, { name: 'image_url', type: 'text', pk: 0, notnull: 0, dflt_value: null }],
  cutting_orders: [{ name: 'id', type: 'bigint', pk: 1, notnull: 1, dflt_value: 'GENERATED ALWAYS AS IDENTITY' }, { name: 'order_no', type: 'text', pk: 0, notnull: 0, dflt_value: null }, { name: 'recipe_id', type: 'bigint', pk: 0, notnull: 1, dflt_value: null }, { name: 'target_qty', type: 'int', pk: 0, notnull: 1, dflt_value: null }, { name: 'fabric_roll_id', type: 'text', pk: 0, notnull: 1, dflt_value: null }, { name: 'actual_fabric_yds', type: 'numeric', pk: 0, notnull: 1, dflt_value: null }, { name: 'status', type: 'text', pk: 0, notnull: 1, dflt_value: "'PENDING_VERIFICATION'" }, { name: 'created_by', type: 'uuid', pk: 0, notnull: 1, dflt_value: null }, { name: 'sewing_started_at', type: 'timestamptz', pk: 0, notnull: 0, dflt_value: null }, { name: 'sewing_started_by', type: 'uuid', pk: 0, notnull: 0, dflt_value: null }, { name: 'created_at', type: 'timestamptz', pk: 0, notnull: 1, dflt_value: 'now()' }, { name: 'updated_at', type: 'timestamptz', pk: 0, notnull: 1, dflt_value: 'now()' }],
  sessions: [{ name: 'token', type: 'text', pk: 1, notnull: 1, dflt_value: null }, { name: 'user_id', type: 'uuid', pk: 0, notnull: 1, dflt_value: null }, { name: 'expires_at', type: 'bigint', pk: 0, notnull: 1, dflt_value: null }],
  verification_items: [{ name: 'id', type: 'bigint', pk: 1, notnull: 1, dflt_value: 'GENERATED ALWAYS AS IDENTITY' }, { name: 'order_id', type: 'bigint', pk: 0, notnull: 1, dflt_value: null }, { name: 'component_id', type: 'bigint', pk: 0, notnull: 1, dflt_value: null }, { name: 'expected_qty', type: 'int', pk: 0, notnull: 1, dflt_value: null }, { name: 'actual_qty', type: 'int', pk: 0, notnull: 1, dflt_value: null }, { name: 'status', type: 'text', pk: 0, notnull: 1, dflt_value: null }],
  verification_logs: [{ name: 'id', type: 'bigint', pk: 1, notnull: 1, dflt_value: 'GENERATED ALWAYS AS IDENTITY' }, { name: 'order_id', type: 'bigint', pk: 0, notnull: 1, dflt_value: null }, { name: 'verifier_id', type: 'uuid', pk: 0, notnull: 1, dflt_value: null }, { name: 'decision', type: 'text', pk: 0, notnull: 1, dflt_value: null }, { name: 'rejection_note', type: 'text', pk: 0, notnull: 0, dflt_value: null }, { name: 'wastage_pct', type: 'numeric', pk: 0, notnull: 0, dflt_value: null }, { name: 'variances', type: 'jsonb', pk: 0, notnull: 0, dflt_value: null }, { name: 'timestamp', type: 'timestamptz', pk: 0, notnull: 1, dflt_value: 'now()' }],
};
function definition(name: string) { if (!ADMIN_TABLES.includes(name as AdminTable)) throw new HttpError(400, 'Unsupported admin table'); return { name: name as AdminTable, columns: schemas[name as AdminTable] }; }
function keyValues(key: string, keys: AdminColumn[]) { try { const parsed = JSON.parse(key) as Record<string, unknown>; if (keys.every(k => parsed[k.name] !== undefined)) return parsed; } catch { /* single key fallback */ } if (keys.length === 1) return { [keys[0].name]: key }; throw new HttpError(400, `Composite key required: ${keys.map(k => k.name).join(', ')}`); }

export function requireRole(user: User | null, ...roles: Role[]) { if (!user) throw new HttpError(401, 'Not authenticated'); if (!roles.includes(user.role)) throw new HttpError(403, `Forbidden for role ${user.role}`); return user; }
const validRole = (value: unknown): value is Role => value === 'cutting_supervisor' || value === 'cutting_verifier' || value === 'sewing_supervisor';
async function profileForAuthUser(authUser: { id: string; email?: string; user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown> }) {
  const { data: profile, error: profileError } = await table('profiles').select('id,full_name,role').eq('id', authUser.id).maybeSingle();
  fail(profileError);
  if (profile) return { id: profile.id, email: authUser.email ?? '', full_name: profile.full_name, role: profile.role as Role };

  const metadata = { ...(authUser.app_metadata ?? {}), ...(authUser.user_metadata ?? {}) };
  const email = authUser.email?.toLowerCase() ?? '';
  const demoRole: Role | undefined = email.startsWith('supervisor@') ? 'cutting_supervisor'
    : email.startsWith('verifier@') ? 'cutting_verifier'
      : email.startsWith('sewing@') ? 'sewing_supervisor' : undefined;
  const role = validRole(metadata.role) ? metadata.role : demoRole;
  const fullName = typeof metadata.full_name === 'string'
    ? metadata.full_name.trim()
    : typeof metadata.name === 'string' ? metadata.name.trim()
      : demoRole ? (demoRole === 'cutting_supervisor' ? 'Cutting Supervisor' : demoRole === 'cutting_verifier' ? 'Cutting Verifier' : 'Sewing Supervisor') : '';
  if (!validRole(role) || fullName.length < 2) {
    throw new HttpError(403, 'Account profile is not configured. Add role and full_name metadata to this Supabase Auth user, or sign up again.');
  }
  const virtualProfile = { id: authUser.id, email: authUser.email ?? '', full_name: fullName, role };
  const { data: created, error: createError } = await table('profiles')
    .upsert({ id: authUser.id, full_name: fullName, role }, { onConflict: 'id' })
    .select('id,full_name,role')
    .single();
  if (createError?.message.toLowerCase().includes('row-level security')) return virtualProfile;
  fail(createError);
  if (!created) throw new HttpError(403, 'Account profile is not configured');
  return { id: created.id, email: authUser.email ?? '', full_name: created.full_name, role: created.role as Role };
}
export async function userFromToken(token?: string): Promise<User | null> {
  if (!token) return null;
  const { data: authUser, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authUser.user) return null;
  return profileForAuthUser(authUser.user);
}
export async function login(body: Body) {
  const { email, password } = body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') throw new HttpError(401, 'Invalid email or password');
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error || !data.user) throw new HttpError(401, 'Invalid email or password');
  const profile = await profileForAuthUser(data.user);
  const token = data.session?.access_token;
  if (!token) throw new HttpError(401, 'Supabase did not return an access token');
  return { token, user: { id: profile.id, email: data.user.email ?? '', full_name: profile.full_name, role: profile.role as Role } };
}
export async function signup(body: Body) {
  const { email, password, full_name, role } = body ?? {};
  const roles: Role[] = ['cutting_supervisor', 'cutting_verifier', 'sewing_supervisor'];
  if (typeof email !== 'string' || typeof password !== 'string' || typeof full_name !== 'string' || !roles.includes(role as Role) || password.length < 8 || full_name.trim().length < 2) throw new HttpError(400, 'email, password (min 8 characters), full_name and a valid role are required');
  const { data, error } = await supabase.auth.admin.createUser({ email: email.trim().toLowerCase(), password, email_confirm: true });
  if (error || !data.user) throw new HttpError(error?.message.toLowerCase().includes('already') ? 409 : 400, error?.message ?? 'Unable to create account');
  const { error: profileError } = await table('profiles').insert({ id: data.user.id, full_name: full_name.trim(), role });
  if (profileError?.message.toLowerCase().includes('row-level security')) {
    const { error: metadataError } = await supabase.auth.admin.updateUserById(data.user.id, { user_metadata: { full_name: full_name.trim(), role } });
    fail(metadataError);
  } else if (profileError) {
    await supabase.auth.admin.deleteUser(data.user.id);
    fail(profileError);
  }
  return { user: { id: data.user.id, email: data.user.email ?? '', full_name: full_name.trim(), role: role as Role } };
}
export async function logout(_token?: string) { return; }

export async function listAdminTables() { return Promise.all(ADMIN_TABLES.map(async name => { const { error } = await table(name).select('*', { head: true, count: 'exact' }); return { name, available: !error, columns: schemas[name] }; })); }
export async function listAdminRows(name: string) { const d = definition(name); const { data, error } = await table(d.name).select('*').limit(500); fail(error); return { ...d, rows: data ?? [] }; }
export async function createAdminRow(name: string, body: Body) { const d = definition(name); const values = Object.fromEntries(Object.entries(body ?? {}).filter(([key, value]) => d.columns.some(c => c.name === key) && !(key === 'id' && GENERATED_ID_TABLES.has(d.name)) && value !== undefined && value !== '')); if (!Object.keys(values).length) throw new HttpError(400, 'At least one valid field is required'); const { data, error } = await table(d.name).insert(values).select().single(); fail(error); return data; }
export async function updateAdminRow(name: string, key: string, body: Body) { const d = definition(name); const keys = d.columns.filter(c => c.pk > 0); const values = Object.fromEntries(Object.entries(body ?? {}).filter(([n, v]) => !keys.some(k => k.name === n) && d.columns.some(c => c.name === n) && v !== undefined)); if (!Object.keys(values).length) throw new HttpError(400, 'At least one editable field is required'); let q = table(d.name).update(values); const kv = keyValues(key, keys); for (const k of keys) q = q.eq(k.name, kv[k.name]); const { data, error } = await q.select().single(); fail(error); return data; }
export async function deleteAdminRow(name: string, key: string) { const d = definition(name); const keys = d.columns.filter(c => c.pk > 0); let q = table(d.name).delete(); const kv = keyValues(key, keys); for (const k of keys) q = q.eq(k.name, kv[k.name]); const { error } = await q; fail(error); return { deleted: true }; }

async function getOrder(id: number): Promise<Order | null> {
  const { data: row, error } = await table('cutting_orders').select('*, recipes(name,recipe_code,std_fabric_yards,wastage_cap)').eq('id', id).maybeSingle();
  fail(error); if (!row) return null;
  const recipe = row.recipes as { name: string; recipe_code: string; std_fabric_yards: number; wastage_cap: number };
  const { data: creator, error: creatorError } = await table('profiles').select('full_name').eq('id', row.created_by).maybeSingle();
  fail(creatorError);
  const { data: components, error: componentError } = await table('recipe_components').select('id,component_name,pieces_per_garment,verification_items(actual_qty)').eq('recipe_id', row.recipe_id).eq('verification_items.order_id', id);
  fail(componentError);
  const mapped = (components ?? []).map((c: Record<string, unknown>) => { const item = (c.verification_items as { actual_qty: number }[] | null)?.[0]; const expected = Number(c.pieces_per_garment) * Number(row.target_qty); return { component_id: Number(c.id), component_name: String(c.component_name), pieces_per_garment: Number(c.pieces_per_garment), expected_qty: expected, actual_qty: item?.actual_qty ?? null, status: item ? flag(item.actual_qty, expected) : null }; });
  const { data: logs, error: logError } = await table('verification_logs').select('decision,rejection_note,wastage_pct,timestamp,verifier_id').eq('order_id', id).order('id', { ascending: false }).limit(1);
  fail(logError);
  const log = logs?.[0] as (Log & { verifier_id: string }) | undefined;
  const { data: verifier, error: verifierError } = log
    ? await table('profiles').select('full_name').eq('id', log.verifier_id).maybeSingle()
    : { data: null, error: null };
  fail(verifierError);
  return { ...row, recipe_name: recipe.name, recipe_code: recipe.recipe_code, std_fabric_yards: recipe.std_fabric_yards, wastage_cap: recipe.wastage_cap, created_by_name: creator?.full_name ?? '', expected_fabric: +(Number(row.target_qty) * Number(recipe.std_fabric_yards)).toFixed(2), components: mapped, last_log: log ? { decision: log.decision, rejection_note: log.rejection_note, wastage_pct: log.wastage_pct, timestamp: log.timestamp, verifier_name: verifier?.full_name ?? '' } : null } as Order;
}
const wastage = (o: Order) => +(((o.actual_fabric_yds - o.expected_fabric) / o.expected_fabric) * 100).toFixed(2);
export async function listRecipes(u: User | null): Promise<Recipe[]> { requireRole(u, 'cutting_supervisor', 'cutting_verifier'); const { data, error } = await table('recipes').select('id,recipe_code,name,std_fabric_yards,wastage_cap,recipe_components(id,component_name,pieces_per_garment)'); fail(error); return (data ?? []).map((r: Record<string, unknown>) => ({ ...r, components: r.recipe_components ?? [] })) as Recipe[]; }
export async function createOrder(u: User | null, body: Body): Promise<Order> { const user = requireRole(u, 'cutting_supervisor'); const { recipe_id, target_qty, fabric_roll_id, actual_fabric_yds } = body ?? {}; const f: Record<string, string> = {}; const { data: recipe, error } = await table('recipes').select('id').eq('id', recipe_id as number).maybeSingle(); fail(error); if (!Number.isInteger(recipe_id) || !recipe) f.recipe_id = 'Choose a valid recipe'; if (!Number.isInteger(target_qty) || Number(target_qty) <= 0 || Number(target_qty) > 100000) f.target_qty = 'Whole number greater than 0 required'; if (typeof fabric_roll_id !== 'string' || !/^[A-Za-z0-9-]{3,40}$/.test(fabric_roll_id.trim())) f.fabric_roll_id = 'Letters, digits and dashes only'; if (typeof actual_fabric_yds !== 'number' || !Number.isFinite(actual_fabric_yds) || actual_fabric_yds <= 0) f.actual_fabric_yds = 'Positive number of yards required'; if (Object.keys(f).length) throw new HttpError(400, 'Validation failed', { fields: f }); const { data: created, error: insertError } = await table('cutting_orders').insert({ recipe_id, target_qty, fabric_roll_id: (fabric_roll_id as string).trim(), actual_fabric_yds, status: 'PENDING_VERIFICATION', created_by: user.id }).select('id').single(); fail(insertError); if (!created) throw new HttpError(500, 'Supabase did not return the created order'); const { error: orderError } = await table('cutting_orders').update({ order_no: `CUT-${String(created.id).padStart(4, '0')}` }).eq('id', created.id); fail(orderError); return (await getOrder(Number(created.id)))!; }
export async function listOrders(u: User | null): Promise<Order[]> { const user = requireRole(u, 'cutting_supervisor', 'cutting_verifier'); let q = table('cutting_orders').select('id').order('id', { ascending: false }); if (user.role === 'cutting_verifier') q = q.eq('status', 'PENDING_VERIFICATION'); const { data, error } = await q; fail(error); return Promise.all((data ?? []).map((r: { id: number }) => getOrder(r.id))).then(rows => rows.filter((r): r is Order => !!r)); }
export async function getOrderFor(u: User | null, id: number) { const user = requireRole(u, 'cutting_supervisor', 'cutting_verifier'); const o = await getOrder(id); if (!o || (user.role === 'cutting_verifier' && o.status !== 'PENDING_VERIFICATION')) throw new HttpError(404, 'Order not found'); return o; }
async function pendingOrder(id: number) { const o = await getOrder(id); if (!o) throw new HttpError(404, 'Order not found'); if (o.status !== 'PENDING_VERIFICATION') throw new HttpError(409, `Order is ${o.status}, not PENDING_VERIFICATION`); return o; }
export async function resubmit(u: User | null, id: number) { requireRole(u, 'cutting_supervisor'); const o = await getOrder(id); if (!o) throw new HttpError(404, 'Order not found'); if (o.status !== 'REJECTED') throw new HttpError(409, 'Only REJECTED orders can be resubmitted'); const { error: deleteError } = await table('verification_items').delete().eq('order_id', id); fail(deleteError); const { error } = await table('cutting_orders').update({ status: 'PENDING_VERIFICATION', updated_at: new Date().toISOString() }).eq('id', id); fail(error); return (await getOrder(id))!; }
export async function saveCounts(u: User | null, id: number, body: Body) { requireRole(u, 'cutting_verifier'); const o = await pendingOrder(id); const counts = body?.counts; if (!counts || typeof counts !== 'object' || Array.isArray(counts) || !Object.keys(counts).length) throw new HttpError(400, 'counts payload required'); const byId = new Map(o.components.map(c => [String(c.component_id), c])); const rows = Object.entries(counts as Record<string, unknown>).map(([k, v]) => { const c = byId.get(k); if (!c) throw new HttpError(400, 'Invalid component'); if (!Number.isInteger(v) || Number(v) < 0) throw new HttpError(400, 'Counts must be whole numbers'); return { order_id: id, component_id: c.component_id, expected_qty: c.expected_qty, actual_qty: Number(v), status: flag(Number(v), c.expected_qty) }; }); const { error } = await table('verification_items').upsert(rows, { onConflict: 'order_id,component_id' }); fail(error); return (await getOrder(id))!; }
export async function approve(u: User | null, id: number) { const user = requireRole(u, 'cutting_verifier'); const o = await pendingOrder(id); const blocked = o.components.filter(c => c.actual_qty == null || c.actual_qty < c.expected_qty).map(c => c.component_name); if (blocked.length) throw new HttpError(422, 'Hard stop: shortage or uncounted components block approval', { blocked }); const { error } = await table('cutting_orders').update({ status: 'VERIFIED', updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'PENDING_VERIFICATION'); fail(error); const { error: logError } = await table('verification_logs').insert({ order_id: id, verifier_id: user.id, decision: 'APPROVED', wastage_pct: wastage(o), variances: o.components.map(c => ({ component: c.component_name, expected: c.expected_qty, actual: c.actual_qty, variance: (c.actual_qty ?? 0) - c.expected_qty })) }); fail(logError); return (await getOrder(id))!; }
export async function reject(u: User | null, id: number, body: Body) { const user = requireRole(u, 'cutting_verifier'); const o = await pendingOrder(id); const note = typeof body?.note === 'string' ? body.note.trim() : ''; if (note.length < 5) throw new HttpError(422, 'A rejection reason (min 5 characters) is mandatory', { fields: { note: 'Reason required' } }); const { error } = await table('cutting_orders').update({ status: 'REJECTED', updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'PENDING_VERIFICATION'); fail(error); const { error: logError } = await table('verification_logs').insert({ order_id: id, verifier_id: user.id, decision: 'REJECTED', rejection_note: note, wastage_pct: wastage(o) }); fail(logError); return (await getOrder(id))!; }
export async function sewingQueue(u: User | null) { requireRole(u, 'sewing_supervisor'); const { data, error } = await table('cutting_orders').select('id').eq('status', 'VERIFIED').order('updated_at', { ascending: false }); fail(error); return Promise.all((data ?? []).map((r: { id: number }) => getOrder(r.id))).then(rows => rows.filter((r): r is Order => !!r)); }
export async function startSewing(u: User | null, id: number) { const user = requireRole(u, 'sewing_supervisor'); const { data, error } = await table('cutting_orders').update({ sewing_started_at: new Date().toISOString(), sewing_started_by: user.id }).eq('id', id).eq('status', 'VERIFIED').is('sewing_started_at', null).select('id').maybeSingle(); fail(error); if (!data) throw new HttpError(409, 'Order not in queue or already started'); return (await getOrder(id))!; }

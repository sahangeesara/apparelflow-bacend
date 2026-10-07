import express, { type NextFunction, type Request, type Response } from 'express';
import * as svc from './service.ts';
import { HttpError } from './service.ts';
import type { User } from './types.ts';

type Authed = Request & { user: User | null };
const ALL = ['cutting_supervisor', 'cutting_verifier', 'sewing_supervisor'] as const;
const sessionToken = (cookie = '') => /(?:^|;\s*)sid=([^;]+)/.exec(cookie)?.[1];

export function createApp() {
  const app = express();
  const allowedOrigins = new Set(
    (process.env.FRONTEND_ORIGINS ?? process.env.FRONTEND_ORIGIN ?? '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
  );

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.size === 0 || allowedOrigins.has(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '10kb' }));
  app.get('/', (_req, res) => res.json({ message: 'ApparelFlow API is working!' }));

  // Identity comes ONLY from the HttpOnly session cookie, never from the request body.
  app.use((req, _res, next) => {
    svc.userFromToken(sessionToken(req.headers.cookie)).then(user => {
      (req as Authed).user = user;
      next();
    }).catch(next);
  });
  const user = (req: Request) => (req as Authed).user;
  const route = (fn: (req: Request, res: Response) => unknown | Promise<unknown>, status = 200) =>
    (req: Request, res: Response, next: NextFunction) => {
      try { Promise.resolve(fn(req, res)).then(body => res.status(status).json(body)).catch(next); } catch (e) { next(e); }
    };
  const id = (req: Request) => Number(req.params.id);
  const table = (req: Request) => typeof req.params.table === 'string' ? req.params.table : '';

  // ---- auth
  app.post('/api/login', route(async (req, res) => {
    const { token, user } = await svc.login(req.body);
      res.cookie('sid', token, {
        httpOnly: true,
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
        path: '/',
        maxAge: 8 * 3600e3,
        secure: process.env.NODE_ENV === 'production',
      });
      return { user };
  }));
  app.post('/api/signup', route((req, res) => svc.signup(req.body), 201));
  app.post('/api/logout', route((req, res) => {
    return svc.logout(sessionToken(req.headers.cookie)).then(() => {
      res.clearCookie('sid', { path: '/' });
      return { ok: true };
    });
  }));
  app.get('/api/me', route(req => ({ user: svc.requireRole(user(req), ...ALL) })));

  // ---- supervisor admin CRUD
  app.get('/api/admin/tables', route(async req => { svc.requireRole(user(req), 'cutting_supervisor'); return { tables: await svc.listAdminTables() }; }));
  app.get('/api/admin/:table', route(async req => { svc.requireRole(user(req), 'cutting_supervisor'); return svc.listAdminRows(table(req)); }));
  app.post('/api/admin/:table', route(async (req) => { svc.requireRole(user(req), 'cutting_supervisor'); return svc.createAdminRow(table(req), req.body); }, 201));
  app.patch('/api/admin/:table/:key', route(async req => { svc.requireRole(user(req), 'cutting_supervisor'); return svc.updateAdminRow(table(req), String(req.params.key), req.body); }));
  app.delete('/api/admin/:table/:key', route(async req => { svc.requireRole(user(req), 'cutting_supervisor'); return svc.deleteAdminRow(table(req), String(req.params.key)); }));

  // ---- cutting supervisor / verifier
  app.get('/api/recipes', route(async req => ({ recipes: await svc.listRecipes(user(req)) })));
  app.get('/api/orders', route(async req => ({ orders: await svc.listOrders(user(req)) })));
  app.post('/api/orders', route(async req => ({ order: await svc.createOrder(user(req), req.body) }), 201));
  app.get('/api/orders/:id', route(async req => ({ order: await svc.getOrderFor(user(req), id(req)) })));
  app.post('/api/orders/:id/resubmit', route(async req => ({ order: await svc.resubmit(user(req), id(req)) })));
  app.post('/api/orders/:id/counts', route(async req => ({ order: await svc.saveCounts(user(req), id(req), req.body) })));
  app.post('/api/orders/:id/verification', route(async req => ({ order: await svc.saveCounts(user(req), id(req), req.body) })));
  app.post('/api/orders/:id/submit-verification', route(async req => ({ order: await svc.saveCounts(user(req), id(req), req.body) })));
  app.post('/api/orders/:id/verification/submit', route(async req => ({ order: await svc.saveCounts(user(req), id(req), req.body) })));
  app.post('/api/orders/:id/approve', route(async req => ({ order: await svc.approve(user(req), id(req)) })));
  app.post('/api/orders/:id/reject', route(async req => ({ order: await svc.reject(user(req), id(req), req.body) })));

  // ---- sewing (queue query is hard-coded to status='VERIFIED' inside the service)
  app.get('/api/sewing/queue', route(async req => ({ orders: await svc.sewingQueue(user(req)) })));
  app.post('/api/sewing/:id/start', route(async req => ({ order: await svc.startSewing(user(req), id(req)) })));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });
  return app;
}

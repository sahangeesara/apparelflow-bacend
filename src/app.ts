import express, { type NextFunction, type Request, type Response } from 'express';
import type { DB } from './db.ts';
import * as svc from './service.ts';
import { HttpError } from './service.ts';
import type { User } from './types.ts';

type Authed = Request & { user: User | null };
const ALL = ['cutting_supervisor', 'cutting_verifier', 'sewing_supervisor'] as const;

export function createApp(db: DB) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));

  // Identity comes ONLY from the HttpOnly session cookie, never from the request body.
  app.use((req, _res, next) => {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
    (req as Authed).user = svc.userFromToken(db, m?.[1]);
    next();
  });
  const user = (req: Request) => (req as Authed).user;
  const route = (fn: (req: Request, res: Response) => unknown | Promise<unknown>, status = 200) =>
    (req: Request, res: Response, next: NextFunction) => {
      try { Promise.resolve(fn(req, res)).then(body => res.status(status).json(body)).catch(next); } catch (e) { next(e); }
    };
  const id = (req: Request) => Number(req.params.id);

  // ---- auth
  app.post('/api/login', route((req, res) => {
    return svc.login(db, req.body).then(({ token, user }) => {
      res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 8 * 3600e3, secure: process.env.NODE_ENV === 'production' });
      return { user };
    });
  }));
  app.post('/api/signup', route((req, res) => svc.signup(db, req.body), 201));
  app.post('/api/logout', route((req, res) => {
    svc.logout(db, /sid=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1]);
    res.clearCookie('sid', { path: '/' });
    return { ok: true };
  }));
  app.get('/api/me', route(req => ({ user: svc.requireRole(user(req), ...ALL) })));

  // ---- cutting supervisor / verifier
  app.get('/api/recipes', route(req => ({ recipes: svc.listRecipes(db, user(req)) })));
  app.get('/api/orders', route(req => ({ orders: svc.listOrders(db, user(req)) })));
  app.post('/api/orders', route(req => ({ order: svc.createOrder(db, user(req), req.body) }), 201));
  app.get('/api/orders/:id', route(req => ({ order: svc.getOrderFor(db, user(req), id(req)) })));
  app.post('/api/orders/:id/resubmit', route(req => ({ order: svc.resubmit(db, user(req), id(req)) })));
  app.post('/api/orders/:id/counts', route(req => ({ order: svc.saveCounts(db, user(req), id(req), req.body) })));
  app.post('/api/orders/:id/approve', route(req => ({ order: svc.approve(db, user(req), id(req)) })));
  app.post('/api/orders/:id/reject', route(req => ({ order: svc.reject(db, user(req), id(req), req.body) })));

  // ---- sewing (queue query is hard-coded to status='VERIFIED' inside the service)
  app.get('/api/sewing/queue', route(req => ({ orders: svc.sewingQueue(db, user(req)) })));
  app.post('/api/sewing/:id/start', route(req => ({ order: svc.startSewing(db, user(req), id(req)) })));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });
  return app;
}

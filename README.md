# ApparelFlow Backend

Express API for the ApparelFlow cutting, verification, and sewing workflow.

## Requirements

- Node.js 20+
- A Supabase project

## Local development

```powershell
npm install
npm run dev
```

The API listens on `http://localhost:4000` by default. Set `PORT` to use a
different port.

### Environment variables

Create a `.env` file (do not commit it):

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
NODE_ENV=development
FRONTEND_ORIGIN=http://localhost:3000
```

`SUPABASE_SERVICE_ROLE_KEY` is server-only. Never expose it in the frontend or
commit it to source control.

## Database setup

Run [apparelFlow .sql](./apparelFlow%20.sql) in the Supabase SQL Editor. The
script creates the tables, indexes, workflow constraints, RLS configuration,
and CRUD policies.

RLS remains enabled. The backend uses the service-role key, while direct
Supabase clients are covered by the configured `anon`/`authenticated` policies.

If `verification_logs` was created manually in the Supabase dashboard, confirm
that `verifier_id` is `uuid`, not `int8`:

```sql
select column_name, data_type
from information_schema.columns
where table_name = 'verification_logs'
  and column_name = 'verifier_id';
```

## Workflow data ownership

| Action | Endpoint | Table(s) |
| --- | --- | --- |
| Submit cutting order | `POST /api/orders` | `cutting_orders` |
| Save/submit verification counts | `POST /api/orders/:id/counts` | `verification_items` |
| Approve verification | `POST /api/orders/:id/approve` | `verification_logs`, then `cutting_orders.status = VERIFIED` |
| Reject verification | `POST /api/orders/:id/reject` | `verification_logs`, then `cutting_orders.status = REJECTED` |
| Resubmit rejected order | `POST /api/orders/:id/resubmit` | Clears `verification_items`, resets `cutting_orders` |
| Start sewing | `POST /api/sewing/:id/start` | `cutting_orders` |

Verification counts accept either format:

```json
{
  "counts": {
    "1": 20,
    "2": 18
  }
}
```

or:

```json
{
  "items": [
    { "component_id": 1, "actual_qty": 20 },
    { "component_id": 2, "actual_qty": 18 }
  ]
}
```

## API

Health check:

```text
GET /
```

Authentication:

```text
POST /api/login
POST /api/signup
POST /api/logout
GET  /api/me
```

The API stores the Supabase access token in an HTTP-only `sid` cookie. Browser
clients must send requests with credentials enabled:

```ts
fetch(`${BACKEND_URL}/api/recipes`, {
  credentials: 'include'
});
```

For production, set `FRONTEND_ORIGIN` to the exact frontend origin, for example:

```env
FRONTEND_ORIGIN=https://apparelflow-frantend.netlify.app
```

## Verification

```powershell
npm run typecheck
npm run build
```

## Deployment on Render

Recommended Render settings:

- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Environment:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `FRONTEND_ORIGIN`, `NODE_ENV=production`

The deployed backend is:

```text
https://apparelflow-bacend.onrender.com
```

# Absensi Siswa — Vercel + Neon

## Deploy
1. Upload the project contents to GitHub (do not upload `.env`).
2. Import the repository in Vercel.
3. Add required environment variables in Vercel Project Settings → Environment Variables → Production.
4. Redeploy after changing variables.

## Environment variables
- `DATABASE_URL`: complete Neon PostgreSQL connection string; rotate any credential previously shared.
- `NODE_ENV=production`
- `TRUST_PROXY=true`
- `APP_NAME`, `LEMBAGA`, `TAHUN_PELAJARAN`, `TZ`
- `SESSION_DURATION_MS=86400000` (24 hours)
- `APP_CRON_SECRET`: random secret used by the cron endpoint. The server accepts the older `CRON_SECRET` name too.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_NAME`: used only when the database has no users; changing them does not automatically reset an existing admin password.

`SESSION_SECRET` is listed only as a template if the code uses it; this server's database-backed sessions currently use random session tokens and do not require it.

## Notes
- Vercel runs serverless functions. Neon is the persistent database; don't rely on in-memory state for sessions or rate limiting.
- Dashboard counts are aggregated in PostgreSQL to avoid downloading full tables for every dashboard request.
- The schema initializer still runs on a cold function instance; deploy-time migrations are preferable for larger production systems.
- Test login, roles, attendance, savings, and all writes after deployment. This package has not been tested against your live Neon database or Vercel account.


## Optional Vercel cold-start optimization
After confirming the Neon database already contains all tables/indexes from `SCHEMA_SQL`, set `SKIP_SCHEMA_INIT=true` in Vercel Production to avoid running DDL on every serverless cold start. Do not set it on a fresh database or before schema updates have been applied.

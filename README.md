# Absensi Siswa — Vercel + Neon

## Deploy ke Vercel
1. Rotasi password Neon lama terlebih dahulu jika pernah dibagikan atau masuk ke arsip Git.
2. Upload isi project ke GitHub. Jangan upload `.env`.
3. Import repository di Vercel.
4. Di **Project Settings → Environment Variables**, isi `DATABASE_URL`, `NODE_ENV=production`, `TRUST_PROXY=true`, `APP_NAME`, `LEMBAGA`, `TAHUN_PELAJARAN`, `TZ`, `SESSION_DURATION_MS`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_NAME`, dan `CRON_SECRET`.
5. `DATABASE_URL` harus memakai URL Neon baru dengan TLS aktif. Buat `CRON_SECRET` acak yang panjang; Vercel Cron mengirimkannya sebagai `Authorization: Bearer ...` ketika variabel bernama `CRON_SECRET` diset.
6. Deploy ulang setelah menambahkan/mengubah Variables.

## Lokal
Gunakan Node.js 20+, salin `.env.example` menjadi `.env`, isi kredensial yang benar, lalu jalankan `npm install` dan `npm start`.

## Keamanan dan arsitektur
- `.env` dikecualikan melalui `.gitignore`; jangan pernah memasukkan kredensial ke HTML/JavaScript frontend atau GitHub.
- Sesi disimpan sebagai hash token di tabel PostgreSQL `app_sessions`, sehingga sesi bisa dipakai lintas instance serverless dan memiliki masa berlaku.
- Pembatasan percobaan login disimpan di PostgreSQL `login_attempts` agar berlaku lintas instance.
- Tabel/kolom yang belum ada dibuat melalui `CREATE TABLE IF NOT EXISTS` dan `ADD COLUMN IF NOT EXISTS`; jangan menghapus data lama.
- Auto-alpha dijalankan oleh Vercel Cron sekali sehari pada 00:00 UTC (07:00 WIB). Frekuensi Cron bergantung pada paket Vercel.
- `SESSION_DURATION_MS` mengatur masa berlaku sesi yang disimpan di PostgreSQL.
- Jalankan `npm audit` dan uji semua alur login/role/API sebelum dipakai di produksi. Pengujian sintaks lokal tidak menggantikan tes deploy dengan Neon.

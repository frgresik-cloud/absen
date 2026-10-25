import 'dotenv/config';

const config = {
  port: Number(process.env.PORT || 2002),
  host: process.env.HOST || '0.0.0.0',
  adminDefault: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
    nama: process.env.ADMIN_NAME || 'Administrator'
  },
  appName: process.env.APP_NAME || 'Absensi Siswa',
  lembaga: process.env.LEMBAGA || 'SMP',
  tahunPelajaran: process.env.TAHUN_PELAJARAN || '2026/2027',
  sessionDuration: Number(process.env.SESSION_DURATION_MS || 86400000),
  timezone: process.env.TZ || 'Asia/Jakarta',
  databaseUrl: process.env.DATABASE_URL || ''
};
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, 'public');

const TZ = config.timezone || 'Asia/Jakarta';
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const dateStrOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: TZ }); };
const dayOfWeek = (s) => new Date(s + 'T12:00:00Z').getUTCDay();
const timeNow = () => new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }).slice(0, 5);

/* ============ PG TYPE PARSERS ============ */
pg.types.setTypeParser(20, (v) => v === null ? null : parseInt(v, 10));      // BIGINT
pg.types.setTypeParser(21, (v) => v === null ? null : parseInt(v, 10));      // INT2
pg.types.setTypeParser(23, (v) => v === null ? null : parseInt(v, 10));      // INT4
pg.types.setTypeParser(1700, (v) => v === null ? null : parseFloat(v));      // NUMERIC
pg.types.setTypeParser(1082, (v) => v);                                      // DATE → string

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL belum diatur. Isi Environment Variables sebelum menjalankan aplikasi.');
}

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: true },
  max: process.env.VERCEL ? 3 : 20, min: 0,
  idleTimeoutMillis: 60000, connectionTimeoutMillis: 10000,
  keepAlive: true, keepAliveInitialDelayMillis: 10000,
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL, nama TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'guru', permissions TEXT[], created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'guru';
CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_sessions_expiry ON app_sessions(expires_at);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash TEXT PRIMARY KEY, attempt_count INT NOT NULL DEFAULT 0, window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_updated ON login_attempts(updated_at);
CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT, username TEXT NOT NULL, nama TEXT,
  action TEXT NOT NULL, method TEXT NOT NULL, route TEXT NOT NULL, detail TEXT,
  status_code INT NOT NULL DEFAULT 200, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS kelas (
  id BIGSERIAL PRIMARY KEY, nama TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS mapel (
  id BIGSERIAL PRIMARY KEY, nama TEXT NOT NULL, kode TEXT,
  kelas_id BIGINT REFERENCES kelas(id) ON DELETE SET NULL,
  guru_ids BIGINT[] DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE mapel ADD COLUMN IF NOT EXISTS guru_ids BIGINT[] DEFAULT '{}';
CREATE TABLE IF NOT EXISTS siswa (
  id BIGSERIAL PRIMARY KEY, nis TEXT UNIQUE NOT NULL, nisn TEXT, nama TEXT NOT NULL,
  kelas_id BIGINT REFERENCES kelas(id) ON DELETE SET NULL,
  rfid TEXT, foto TEXT, no_induk TEXT, no_rekening TEXT,
  tempat_lahir TEXT, tanggal_lahir DATE, jenis_kelamin TEXT,
  no_hp TEXT, no_hp_ayah TEXT, no_hp_ibu TEXT,
  aktif SMALLINT DEFAULT 1, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS absensi (
  id BIGSERIAL PRIMARY KEY,
  siswa_id BIGINT REFERENCES siswa(id) ON DELETE CASCADE NOT NULL,
  tanggal DATE NOT NULL, status CHAR(1) NOT NULL, status_masuk TEXT,
  jam TEXT, jam_pulang TEXT, keterangan TEXT, user_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(siswa_id, tanggal)
);
CREATE TABLE IF NOT EXISTS absensi_pelajaran (
  id BIGSERIAL PRIMARY KEY,
  siswa_id BIGINT REFERENCES siswa(id) ON DELETE CASCADE NOT NULL,
  mapel_id BIGINT REFERENCES mapel(id) ON DELETE CASCADE NOT NULL,
  tanggal DATE NOT NULL, status CHAR(1) NOT NULL, user_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ,
  UNIQUE(siswa_id, mapel_id, tanggal)
);
CREATE TABLE IF NOT EXISTS ekstra (
  id BIGSERIAL PRIMARY KEY, nama TEXT UNIQUE NOT NULL,
  hari BIGINT[] DEFAULT '{}', warna TEXT DEFAULT '#0284c7',
  siswa_ids BIGINT[] DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS absensi_extra (
  id BIGSERIAL PRIMARY KEY,
  siswa_id BIGINT REFERENCES siswa(id) ON DELETE CASCADE NOT NULL,
  ekstra_id BIGINT REFERENCES ekstra(id) ON DELETE CASCADE NOT NULL,
  tanggal DATE NOT NULL, jam_masuk TEXT, jam_pulang TEXT,
  status_masuk TEXT, user_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(siswa_id, ekstra_id, tanggal)
);
CREATE TABLE IF NOT EXISTS izin (
  id BIGSERIAL PRIMARY KEY,
  siswa_id BIGINT REFERENCES siswa(id) ON DELETE CASCADE NOT NULL,
  tanggal DATE NOT NULL, jenis TEXT NOT NULL, keterangan TEXT,
  status TEXT NOT NULL, user_id BIGINT, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS jenis_pelanggaran (
  id BIGSERIAL PRIMARY KEY, kode TEXT, nama TEXT NOT NULL,
  kategori TEXT DEFAULT 'Ringan', poin INT DEFAULT 5
);
CREATE TABLE IF NOT EXISTS pelanggaran (
  id BIGSERIAL PRIMARY KEY,
  siswa_id BIGINT REFERENCES siswa(id) ON DELETE CASCADE NOT NULL,
  jenis_id BIGINT, jenis TEXT NOT NULL, tanggal DATE NOT NULL,
  poin INT DEFAULT 0, keterangan TEXT, user_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tabungan (
 id BIGSERIAL PRIMARY KEY, nama TEXT NOT NULL,
 kelas_id BIGINT NOT NULL REFERENCES kelas(id) ON DELETE RESTRICT,
 nominal BIGINT NOT NULL CHECK(nominal > 0), tanggal DATE NOT NULL,
 created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tabungan_tanggal ON tabungan(tanggal);
CREATE INDEX IF NOT EXISTS idx_tabungan_kelas ON tabungan(kelas_id);
CREATE TABLE IF NOT EXISTS nilai (
  id BIGSERIAL PRIMARY KEY,
  siswa_id BIGINT REFERENCES siswa(id) ON DELETE CASCADE NOT NULL,
  mapel_id BIGINT REFERENCES mapel(id) ON DELETE CASCADE NOT NULL,
  nilai NUMERIC NOT NULL, jenis TEXT DEFAULT 'harian', tanggal DATE NOT NULL,
  keterangan TEXT, guru_id BIGINT, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS informasi (
  id BIGSERIAL PRIMARY KEY, judul TEXT NOT NULL, deskripsi TEXT, foto TEXT,
  tanggal DATE, user_id BIGINT, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS hari_libur (
  id BIGSERIAL PRIMARY KEY, tanggal DATE UNIQUE NOT NULL, keterangan TEXT
);
CREATE TABLE IF NOT EXISTS wali_murid (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  siswa_id BIGINT REFERENCES siswa(id) ON DELETE CASCADE NOT NULL,
  hubungan TEXT DEFAULT 'Wali'
);
CREATE TABLE IF NOT EXISTS setting (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  jam_masuk TEXT DEFAULT '07:00', batas_telat TEXT DEFAULT '08:00',
  jam_pulang TEXT DEFAULT '13:00', batas_pulang TEXT DEFAULT '16:00',
  jam_extra_masuk TEXT DEFAULT '14:00', jam_extra_pulang TEXT DEFAULT '16:00',
  batas_extra_pulang TEXT DEFAULT '18:00',
  hari_libur_mingguan BIGINT[] DEFAULT '{0,6}'
);
INSERT INTO setting (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS jenis_izin (
  id BIGSERIAL PRIMARY KEY, nama TEXT UNIQUE NOT NULL
);
ALTER TABLE setting ADD COLUMN IF NOT EXISTS batas_pulang TEXT DEFAULT '16:00';
ALTER TABLE setting ADD COLUMN IF NOT EXISTS batas_extra_pulang TEXT DEFAULT '18:00';
ALTER TABLE setting ADD COLUMN IF NOT EXISTS jam_extra_masuk TEXT DEFAULT '14:00';
ALTER TABLE setting ADD COLUMN IF NOT EXISTS jam_extra_pulang TEXT DEFAULT '16:00';
CREATE INDEX IF NOT EXISTS idx_absensi_tanggal ON absensi(tanggal);
CREATE INDEX IF NOT EXISTS idx_absensi_siswa ON absensi(siswa_id);
CREATE INDEX IF NOT EXISTS idx_siswa_kelas ON siswa(kelas_id);
CREATE INDEX IF NOT EXISTS idx_siswa_rfid ON siswa(rfid);
CREATE INDEX IF NOT EXISTS idx_siswa_nis ON siswa(nis);
CREATE INDEX IF NOT EXISTS idx_izin_tanggal ON izin(tanggal);
CREATE INDEX IF NOT EXISTS idx_izin_siswa ON izin(siswa_id);
CREATE INDEX IF NOT EXISTS idx_pelanggaran_siswa ON pelanggaran(siswa_id);
CREATE INDEX IF NOT EXISTS idx_nilai_siswa ON nilai(siswa_id);
CREATE INDEX IF NOT EXISTS idx_absensi_extra_tanggal ON absensi_extra(tanggal);
CREATE INDEX IF NOT EXISTS idx_wali_murid_user ON wali_murid(user_id);
CREATE INDEX IF NOT EXISTS idx_wali_murid_siswa ON wali_murid(siswa_id);
`;

const SEED_JENIS_IZIN = `
INSERT INTO jenis_izin (nama) VALUES
  ('Sakit'),('Izin Keluarga'),('Izin Sekolah'),('Sholat / Ibadah'),
  ('Ke Toilet'),('Ke UKS'),('Pulang Cepat')
ON CONFLICT (nama) DO NOTHING;
`;

const SEED_JENIS_PELANGGARAN = `
INSERT INTO jenis_pelanggaran (kode, nama, kategori, poin)
SELECT * FROM (VALUES
  ('01', 'Terlambat masuk kelas', 'Ringan', 5),
  ('02', 'Tidak memakai atribut lengkap', 'Ringan', 5),
  ('03', 'Rambut panjang (putra)', 'Ringan', 5),
  ('04', 'Tidak mengerjakan tugas', 'Ringan', 3),
  ('05', 'Bolos sekolah', 'Sedang', 20),
  ('06', 'Berkelahi', 'Sedang', 25),
  ('07', 'Merokok', 'Sedang', 25),
  ('08', 'Membawa/mengedarkan narkoba', 'Berat', 100)
) AS v(kode, nama, kategori, poin)
WHERE NOT EXISTS (SELECT 1 FROM jenis_pelanggaran LIMIT 1);
`;

async function initSchema() {
  const client = await pool.connect();
  try {
    console.log('🔧 Cek & buat tabel di Neon...');
    await client.query(SCHEMA_SQL);
    await client.query(SEED_JENIS_IZIN);
    await client.query(SEED_JENIS_PELANGGARAN);
    console.log('✅ Schema Neon siap.');
  } catch (e) {
    console.error('Gagal menyiapkan schema database');
    throw e;
  } finally { client.release(); }
}

/* ============ CRUD ============ */
const DB_TABLES = new Set(['users','activity_logs','kelas','mapel','siswa','absensi','absensi_pelajaran','ekstra','absensi_extra','izin','jenis_pelanggaran','pelanggaran','tabungan','nilai','informasi','hari_libur','wali_murid','setting','jenis_izin']);
function safeIdentifier(name) {
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error('Identifier database tidak valid');
  return name;
}
function safeTable(table) {
  safeIdentifier(table);
  if (!DB_TABLES.has(table)) throw new Error('Tabel database tidak diizinkan');
  return table;
}
async function sel(table, filter = {}) {
  safeTable(table);
  let query = `SELECT * FROM ${table}`;
  const cond = []; const vals = []; let i = 1;
  for (const [k, v] of Object.entries(filter)) {
    safeIdentifier(k);
    if (v === null) cond.push(`${k} IS NULL`);
    else { cond.push(`${k} = $${i}`); vals.push(v); i++; }
  }
  if (cond.length) query += ' WHERE ' + cond.join(' AND ');
  const { rows } = await pool.query(query, vals);
  return rows;
}
async function selOne(table, filter = {}) { return (await sel(table, filter))[0] || null; }
async function ins(table, row) {
  safeTable(table);
  const keys = Object.keys(row).map(safeIdentifier);
  if (!keys.length) throw new Error('Data kosong');
  const vals = Object.values(row);
  const ph = keys.map((_, idx) => `$${idx + 1}`).join(', ');
  const { rows } = await pool.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${ph}) RETURNING *`, vals);
  return rows[0];
}
async function upd(table, id, patch) {
  safeTable(table);
  const keys = Object.keys(patch).map(safeIdentifier);
  if (!keys.length) throw new Error('Data perubahan kosong');
  const vals = Object.values(patch);
  const sets = keys.map((k, idx) => `${k} = $${idx + 1}`).join(', ');
  const { rows } = await pool.query(`UPDATE ${table} SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`, [...vals, id]);
  return rows[0];
}
async function del(table, id) { safeTable(table); await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]); }

function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pwd, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const cek = crypto.scryptSync(pwd, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(cek, 'hex'));
  } catch { return false; }
}

const hashSessionToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
async function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionDuration);
  await pool.query('INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [hashSessionToken(token), Number(userId), expiresAt]);
  return token;
}
async function revokeUserSessions(userId, exceptToken = null) {
  if (exceptToken) {
    await pool.query('DELETE FROM app_sessions WHERE user_id = $1 AND token_hash <> $2', [Number(userId), hashSessionToken(exceptToken)]);
  } else {
    await pool.query('DELETE FROM app_sessions WHERE user_id = $1', [Number(userId)]);
  }
}
async function getUser(req) {
  const token = req.cookies?.sid;
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const { rows } = await pool.query('SELECT user_id FROM app_sessions WHERE token_hash = $1 AND expires_at > NOW() LIMIT 1', [tokenHash]);
  if (!rows.length) {
    await pool.query('DELETE FROM app_sessions WHERE token_hash = $1 OR expires_at <= NOW()', [tokenHash]).catch(() => {});
    return null;
  }
  return await selOne('users', { id: rows[0].user_id });
}

async function getKelasMap() {
  const list = await sel('kelas');
  return new Map(list.map(k => [k.id, k.nama]));
}
async function getIzinAktif(sid, tgl) {
  const list = (await sel('izin', { siswa_id: +sid, tanggal: tgl }))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  if (!list.length) return null;
  return list[list.length - 1].status === 'pergi' ? list[list.length - 1] : null;
}
async function getIzinAktifMap(tgl) {
  const rows = await sel('izin', { tanggal: tgl });
  const bySid = {};
  rows.forEach(z => { (bySid[z.siswa_id] = bySid[z.siswa_id] || []).push(z); });
  const map = new Map();
  for (const [sid, list] of Object.entries(bySid)) {
    list.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const last = list[list.length - 1];
    if (last.status === 'pergi') map.set(+sid, last);
  }
  return map;
}
async function getSetting() {
  const st = await selOne('setting', { id: 1 });
  if (!st) return { jam_masuk: '07:00', batas_telat: '08:00', jam_pulang: '13:00', batas_pulang: '16:00', jam_extra_masuk: '14:00', jam_extra_pulang: '16:00', batas_extra_pulang: '18:00', hari_libur_mingguan: [0, 6] };
  if (!st.batas_pulang) st.batas_pulang = '16:00';
  if (!st.batas_extra_pulang) st.batas_extra_pulang = '18:00';
  return st;
}

let _autoAlphaRunning = false;
async function autoAlpha() {
  if (_autoAlphaRunning) return { skipped: true };
  _autoAlphaRunning = true;
  try {
    const st = await getSetting();
    const liburMingguan = Array.isArray(st.hari_libur_mingguan) ? st.hari_libur_mingguan : [];
    const siswaList = (await sel('siswa')).filter(s => s.aktif !== 0);
    if (!siswaList.length) return { inserted: 0 };
    const mulai = dateStrOffset(-30), akhir = dateStrOffset(-1);
    const hariLibur = await sel('hari_libur');
    const liburSet = new Set(hariLibur.map(h => h.tanggal));
    const { rows: existing } = await pool.query(`SELECT siswa_id, tanggal::text FROM absensi WHERE tanggal >= $1 AND tanggal <= $2`, [mulai, akhir]);
    const existSet = new Set(existing.map(a => a.siswa_id + '|' + a.tanggal));
    const { rows: izinRows } = await pool.query(`SELECT siswa_id, tanggal::text, status FROM izin WHERE tanggal >= $1 AND tanggal <= $2 ORDER BY created_at ASC`, [mulai, akhir]);
    const izinMap = new Map();
    izinRows.forEach(z => {
      const k = z.siswa_id + '|' + z.tanggal;
      if (z.status === 'pergi') izinMap.set(k, z);
      else if (z.status === 'kembali') izinMap.delete(k);
    });
    const toInsert = [];
    for (let i = 1; i <= 30; i++) {
      const tgl = dateStrOffset(-i);
      if (liburMingguan.includes(dayOfWeek(tgl))) continue;
      if (liburSet.has(tgl)) continue;
      for (const s of siswaList) {
        const k = s.id + '|' + tgl;
        if (existSet.has(k) || izinMap.has(k)) continue;
        toInsert.push([s.id, tgl, 'A', 'Auto-alpa']);
      }
    }
    let inserted = 0;
    for (let i = 0; i < toInsert.length; i += 500) {
      const chunk = toInsert.slice(i, i + 500);
      const values = chunk.map((_, idx) => `($${idx * 4 + 1}, $${idx * 4 + 2}, $${idx * 4 + 3}, $${idx * 4 + 4})`).join(',');
      try {
        await pool.query(`INSERT INTO absensi (siswa_id, tanggal, status, keterangan) VALUES ${values} ON CONFLICT (siswa_id, tanggal) DO NOTHING`, chunk.flat());
        inserted += chunk.length;
      } catch (e) { console.error('chunk:', e.message); }
    }
    console.log(`✅ Auto-alpha: ${inserted} record`);
    return { inserted };
  } catch (e) { console.error('❌ autoAlpha:', e.message); return { error: e.message }; }
  finally { _autoAlphaRunning = false; }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : 1); // Railway/reverse proxy; set TRUST_PROXY=false jika tanpa proxy
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'private, no-cache');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use((req, res, next) => {
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return res.status(403).json({ error: 'Permintaan ditolak' });
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Permintaan ditolak' }); }
    catch { return res.status(403).json({ error: 'Permintaan ditolak' }); }
  }
  next();
});
app.use(express.json({ limit: '2mb', strict: true }));
app.use(cookieParser());
app.use(express.static(PUB, { index: false, dotfiles: 'deny', fallthrough: true }));
// Catat perubahan yang berhasil ke Neon. Isi password/token tidak pernah disimpan ke log.
app.use((req, res, next) => {
  const mutating = ['POST','PUT','PATCH','DELETE'].includes(req.method) && req.path.startsWith('/api/') && !req.path.includes('/auth/login') && !req.path.includes('/auth/logout');
  if (!mutating) return next();
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 400 || !req.user) return;
    const verbs = { POST: 'Menambahkan data', PUT: 'Mengubah data', PATCH: 'Memperbarui data', DELETE: 'Menghapus data' };
    const fieldLabels = { nama:'Nama', judul:'Judul', deskripsi:'Deskripsi', nominal:'Nominal', nilai:'Nilai', jenis:'Jenis', tanggal:'Tanggal', status:'Status', keterangan:'Keterangan', username:'Username', role:'Peran', jam_masuk:'Jam masuk', jam_pulang:'Jam pulang', batas_telat:'Batas keterlambatan', kode:'Kode', poin:'Poin', hubungan:'Hubungan', warna:'Warna' };
    const safeEntries = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.entries(req.body).filter(([k]) => fieldLabels[k] && !/(password|token|secret|foto|base64|(^id$)|_id$)/i.test(k)).slice(0, 6) : [];
    const detail = safeEntries.length ? safeEntries.map(([k,v]) => fieldLabels[k] + ': ' + String(Array.isArray(v) ? v.map(x => typeof x === 'object' ? '[data]' : String(x)).join(', ') : (v && typeof v === 'object' ? '[data]' : v)).slice(0, 60)).join(' · ').slice(0, 300) : (req.method === 'DELETE' ? 'Data dihapus' : 'Data disimpan');
    pool.query('INSERT INTO activity_logs (user_id, username, nama, action, method, route, detail, status_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [req.user.id, req.user.username, req.user.nama, verbs[req.method] || 'Aktivitas', req.method, req.path, detail, res.statusCode]).catch(() => {});
  });
  next();
});

const ALL_MENU_PERMISSIONS = ['absensi','absen-pelajaran','absensi-extra','perizinan','pelanggaran','tabungan','nilai','siswa','kelas','mata-pelajaran','pengaturan','pengguna','wali'];
function permissionForApi(pathname, method = 'GET') {
  if (pathname === '/api/users/guru') return 'mata-pelajaran';
  if (pathname.startsWith('/api/mapel') && method === 'GET') return ['mata-pelajaran','absen-pelajaran','nilai'];
  if (pathname.startsWith('/api/kelas') && method === 'GET') return ['kelas','siswa','tabungan','absensi','absen-pelajaran','absensi-extra','perizinan','pelanggaran','nilai','mata-pelajaran'];
  if (pathname.startsWith('/api/siswa') && method === 'GET') return ['siswa','nilai','pelanggaran','perizinan','absensi','absen-pelajaran','absensi-extra','tabungan'];
  if (/^\/api\/(auth|config|dashboard)(\/|$)/.test(pathname)) return 'dashboard';
  if (pathname.startsWith('/api/wali/anak/') || pathname === '/api/wali/saya' || pathname === '/api/wali/informasi') return null;
  if (pathname.startsWith('/api/tabungan')) return 'tabungan';
  if (pathname.startsWith('/api/nilai')) return 'nilai';
  if (pathname.startsWith('/api/pelanggaran') || pathname.startsWith('/api/jenis-pelanggaran')) return 'pelanggaran';
  if (pathname.startsWith('/api/absen-pelajaran') || pathname.startsWith('/api/mapel')) return pathname.startsWith('/api/mapel') ? 'mata-pelajaran' : 'absen-pelajaran';
  if (pathname.startsWith('/api/absen-extra') || pathname.startsWith('/api/ekstra')) return 'absensi-extra';
  if (pathname.startsWith('/api/izin') || pathname.startsWith('/api/jenis-izin')) return 'perizinan';
  if (pathname.startsWith('/api/siswa')) return 'siswa';
  if (pathname.startsWith('/api/kelas')) return 'kelas';
  if (pathname.startsWith('/api/users')) return 'pengguna';
  if (pathname.startsWith('/api/wali')) return 'wali';
  if (pathname.startsWith('/api/setting') || pathname.startsWith('/api/hari-libur')) return 'pengaturan';
  if (pathname.startsWith('/api/informasi')) return 'pengaturan';
  if (pathname.startsWith('/api/absen') || pathname.startsWith('/api/rekap')) return 'absensi';
  return null;
}
const auth = async (req, res, next) => {
  try {
    const u = await getUser(req);
    if (!u) return res.status(401).json({ error: 'Belum login' });
    req.user = u;
    // Hak akses menu tidak lagi dipilih per akun. Staf mendapat akses menu aplikasi;
    // endpoint portal wali tetap memvalidasi role dan hubungan anak secara terpisah.
    next();
  } catch (e) { next(e); }
};
const roleCheck = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Akses ditolak' });
const adminGuru = roleCheck('admin', 'guru', 'operator');
const adminOnly = roleCheck('admin');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Endpoint cron Vercel: lindungi dengan CRON_SECRET dan jalankan hanya dari scheduler tepercaya.
app.get('/api/cron/auto-alpha', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.get('authorization') || '';
  if (!secret || authHeader !== `Bearer ${secret}`) return res.status(401).json({ error: 'Tidak diizinkan' });
  const result = await autoAlpha();
  return res.json({ ok: true, result });
}));

// Deny-by-default API boundary: portal wali hanya boleh membaca informasi umum,
// akun sendiri, mengganti password sendiri, serta data anak yang terhubung.
app.use('/api', async (req, res, next) => {
  if (['/auth/login','/auth/logout','/config'].includes(req.path) || req.path === '/cron/auto-alpha') return next();
  try {
    const u = await getUser(req);
    if (!u) return res.status(401).json({ error: 'Sesi berakhir. Silakan masuk kembali.' });
    req.user = u;
    if (u.role === 'wali') {
      const allowed = req.path === '/auth/me' || req.path === '/auth/ganti-password' || req.path === '/wali/saya' || req.path === '/wali/informasi' || /^\/wali\/anak\/\d+\/(absensi|nilai|pelanggaran|izin|extra|pelajaran)$/.test(req.path);
      if (!allowed) return res.status(403).json({ error: 'Akses tidak diizinkan' });
    }
    if (u.role !== 'admin' && (req.path === '/aktivitas' || (req.path.startsWith('/users') && req.path !== '/users/guru') || req.path.startsWith('/wali') && !req.path.startsWith('/wali/anak/') && req.path !== '/wali/saya' && req.path !== '/wali/informasi')) {
      if (!(u.role === 'wali' && (req.path === '/wali/saya' || req.path === '/wali/informasi'))) return res.status(403).json({ error: 'Akses tidak diizinkan' });
    }
    next();
  } catch { res.status(401).json({ error: 'Sesi tidak valid' }); }
});

/* ============ AUTH ============ */
// Rate limit disimpan di PostgreSQL agar berlaku lintas instance Vercel.
app.use('/api/auth/login', wrap(async (req, res, next) => {
  const rawIp = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const key = crypto.createHash('sha256').update(rawIp).digest('hex');
  const { rows } = await pool.query(`
    INSERT INTO login_attempts (ip_hash, attempt_count, window_start, updated_at)
    VALUES ($1, 1, NOW(), NOW())
    ON CONFLICT (ip_hash) DO UPDATE SET
      attempt_count = CASE WHEN login_attempts.window_start < NOW() - INTERVAL '15 minutes' THEN 1 ELSE login_attempts.attempt_count + 1 END,
      window_start = CASE WHEN login_attempts.window_start < NOW() - INTERVAL '15 minutes' THEN NOW() ELSE login_attempts.window_start END,
      updated_at = NOW()
    RETURNING attempt_count`, [key]);
  if (Number(rows[0]?.attempt_count || 0) > 10) return res.status(429).json({ error: 'Terlalu banyak percobaan masuk. Coba lagi beberapa menit.' });
  req.loginRateKey = key;
  next();
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 120) : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const u = username ? await selOne('users', { username }) : null;
  if (!u || !verifyPassword(password, u.password)) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }
  await pool.query('DELETE FROM login_attempts WHERE ip_hash = $1', [req.loginRateKey]);
  const token = await newSession(u.id);
  res.cookie('sid', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: config.sessionDuration });
  res.json({ ok: true, user: { id: u.id, nama: u.nama, role: u.role, username: u.username } });
}));
app.post('/api/auth/logout', async (req, res) => {
  const t = req.cookies?.sid; if (t) await pool.query('DELETE FROM app_sessions WHERE token_hash = $1', [hashSessionToken(t)]).catch(() => {});
  res.clearCookie('sid', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' }); res.json({ ok: true });
});
app.get('/api/auth/me', auth, (req, res) =>
  res.json({ id: req.user.id, username: req.user.username, nama: req.user.nama, role: req.user.role, permissions: req.user.permissions ?? null }));
app.post('/api/auth/ganti-password', auth, wrap(async (req, res) => {
  const pwd = String(req.body?.password_baru || '').trim();
  if (!pwd || pwd.length < 8) return res.status(400).json({ error: 'Gunakan password baru minimal 8 karakter agar akun lebih aman.' });
  await upd('users', req.user.id, { password: hashPassword(pwd) });
  await revokeUserSessions(req.user.id, req.cookies?.sid || null);
  res.json({ ok: true });
}));
app.get('/api/config', (req, res) => res.json({
  appName: config.appName, lembaga: config.lembaga,
  tahunPelajaran: config.tahunPelajaran, timezone: TZ,
  serverToday: todayStr(), serverTime: timeNow(),
}));
app.post('/api/admin/auto-alpha', auth, adminGuru, wrap(async (req, res) => {
  const result = await autoAlpha();
  res.json({ ok: true, ...result });
}));


/* ============ TABUNGAN ============ */
const tabunganInput = async (body) => {
 const nama=String(body?.nama||'').trim(),nominal=Number(body?.nominal),kelas_id=Number(body?.kelas_id);
 if(!nama||nama.length>120||!Number.isSafeInteger(nominal)||nominal<=0||!Number.isSafeInteger(kelas_id)||kelas_id<=0)throw Object.assign(new Error('Nama, kelas, dan nominal rupiah positif wajib diisi'),{status:400});
 if(!await selOne('kelas',{id:kelas_id}))throw Object.assign(new Error('Kelas tidak ditemukan'),{status:400});
 return {nama,nominal,kelas_id};
};
app.get('/api/tabungan',auth,adminGuru,wrap(async(req,res)=>{
 const {rows}=await pool.query(`SELECT t.id,t.nama,t.nominal,t.kelas_id,t.tanggal::text AS tanggal,k.nama AS kelas FROM tabungan t JOIN kelas k ON k.id=t.kelas_id ORDER BY t.tanggal DESC,t.id DESC`);
 res.json(rows);
}));
app.get('/api/tabungan/rekap',auth,adminGuru,wrap(async(req,res)=>{
 const mode=String(req.query.mode||'kelas');let sql;
 if(mode==='kelas')sql=`SELECT k.nama AS kelas,COUNT(*)::int AS jumlah,COALESCE(SUM(t.nominal),0)::bigint AS total FROM tabungan t JOIN kelas k ON k.id=t.kelas_id GROUP BY k.id,k.nama ORDER BY total DESC,k.nama`;
 else if(mode==='harian')sql=`SELECT tanggal::text AS periode,SUM(nominal)::bigint AS total FROM tabungan WHERE tanggal >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date - INTERVAL '29 days' GROUP BY tanggal ORDER BY tanggal`;
 else if(mode==='mingguan')sql=`SELECT TO_CHAR(DATE_TRUNC('week',tanggal),'YYYY-MM-DD') AS periode,SUM(nominal)::bigint AS total FROM tabungan WHERE tanggal >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date - INTERVAL '364 days' GROUP BY 1 ORDER BY 1`;
 else if(mode==='bulanan')sql=`SELECT TO_CHAR(tanggal,'YYYY-MM') AS periode,SUM(nominal)::bigint AS total FROM tabungan WHERE tanggal >= DATE_TRUNC('month',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta') - INTERVAL '11 months' GROUP BY 1 ORDER BY 1`;
 else if(mode==='tahunan')sql=`SELECT TO_CHAR(tanggal,'YYYY') AS periode,SUM(nominal)::bigint AS total FROM tabungan GROUP BY 1 ORDER BY 1`;
 else if(['kelas-harian','kelas-mingguan','kelas-bulanan','kelas-tahunan'].includes(mode)) { const trunc=mode==='kelas-harian'?'day':mode==='kelas-mingguan'?'week':mode==='kelas-bulanan'?'month':'year'; sql=`SELECT k.nama AS kelas,TO_CHAR(DATE_TRUNC('${trunc}',t.tanggal),'YYYY-MM-DD') AS periode,COUNT(*)::int AS jumlah,SUM(t.nominal)::bigint AS total FROM tabungan t JOIN kelas k ON k.id=t.kelas_id GROUP BY k.id,k.nama,DATE_TRUNC('${trunc}',t.tanggal) ORDER BY DATE_TRUNC('${trunc}',t.tanggal) DESC,k.nama`; }
 else return res.status(400).json({error:'Mode rekap tidak valid'});
 const {rows}=await pool.query(sql);res.json({mode,rows});
}));
app.post('/api/tabungan',auth,adminGuru,wrap(async(req,res)=>{
 const data=await tabunganInput(req.body);const row=await ins('tabungan',{...data,tanggal:todayStr()});res.json({ok:true,id:row.id});
}));
app.put('/api/tabungan/:id',auth,adminGuru,wrap(async(req,res)=>{
 const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'ID tidak valid'});
 const data=await tabunganInput(req.body);const row=await upd('tabungan',id,{...data,updated_at:new Date()});if(!row)return res.status(404).json({error:'Data tidak ditemukan'});res.json({ok:true});
}));
app.delete('/api/tabungan/:id',auth,adminGuru,wrap(async(req,res)=>{
 const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'ID tidak valid'});
 const {rowCount}=await pool.query('DELETE FROM tabungan WHERE id=$1',[id]);if(!rowCount)return res.status(404).json({error:'Data tidak ditemukan'});res.json({ok:true});
}));

/* ============ KELAS ============ */
app.get('/api/kelas', auth, wrap(async (req, res) => {
  const list = await sel('kelas');
  const siswaAll = await sel('siswa');
  res.json(list.map(k => ({ ...k, jumlah: siswaAll.filter(s => s.kelas_id === k.id && s.aktif !== 0).length })));
}));
app.post('/api/kelas', auth, adminGuru, wrap(async (req, res) => {
  const nama = String(req.body?.nama || '').trim();
  if (!nama) return res.status(400).json({ error: 'Nama kelas wajib' });
  if (await selOne('kelas', { nama })) return res.status(400).json({ error: 'Kelas sudah ada' });
  const row = await ins('kelas', { nama });
  res.json({ ok: true, id: row.id });
}));
app.put('/api/kelas/:id', auth, adminGuru, wrap(async (req, res) => {
  const nama = String(req.body?.nama || '').trim();
  if (!nama) return res.status(400).json({ error: 'Nama wajib' });
  await upd('kelas', +req.params.id, { nama });
  res.json({ ok: true });
}));
app.delete('/api/kelas/:id', auth, adminGuru, wrap(async (req, res) => {
  const list = await sel('siswa', { kelas_id: +req.params.id });
  if (list.length > 0) return res.status(400).json({ error: `Masih ada ${list.length} siswa` });
  await del('kelas', +req.params.id);
  res.json({ ok: true });
}));
app.post('/api/kelas/:id/anggota', auth, adminGuru, wrap(async (req, res) => {
  const kid = +req.params.id;
  const ids = Array.isArray(req.body?.siswa_ids) ? req.body.siswa_ids.map(Number) : [];
  const inClass = await sel('siswa', { kelas_id: kid });
  for (const s of inClass) if (!ids.includes(s.id)) await upd('siswa', s.id, { kelas_id: null });
  for (const id of ids) await upd('siswa', id, { kelas_id: kid });
  res.json({ ok: true, total: ids.length });
}));

/* ============ SISWA ============ */
app.get('/api/siswa/cari', auth, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const ql = q.toLowerCase();
  const all = await sel('siswa');
  const kmap = await getKelasMap();
  const exact = all.find(s => (s.rfid || '').toLowerCase() === ql || (s.nis || '').toLowerCase() === ql || (s.nisn || '').toLowerCase() === ql);
  if (exact && exact.aktif !== 0)
    return res.json([{ ...exact, kelas: kmap.get(exact.kelas_id) || '-', exact: true }]);
  res.json(all.filter(s => s.aktif !== 0 && (s.nama || '').toLowerCase().includes(ql))
    .slice(0, 50).map(s => ({ ...s, kelas: kmap.get(s.kelas_id) || '-' })));
}));
app.get('/api/siswa', auth, wrap(async (req, res) => {
  const { kelas_id, q, hanya_aktif, tanpa_kelas } = req.query;
  let list = await sel('siswa');
  const kmap = await getKelasMap();
  list = list.map(s => ({ ...s, kelas: kmap.get(s.kelas_id) || '-' }));
  if (kelas_id) list = list.filter(s => s.kelas_id === +kelas_id);
  if (hanya_aktif === '1') list = list.filter(s => s.aktif !== 0);
  if (tanpa_kelas === '1') list = list.filter(s => !s.kelas_id && s.aktif !== 0);
  if (q) {
    const ql = q.toLowerCase();
    list = list.filter(s => (s.nama || '').toLowerCase().includes(ql) || (s.nis || '').toLowerCase().includes(ql) || (s.nisn || '').toLowerCase().includes(ql) || (s.rfid || '').toLowerCase().includes(ql));
  }
  res.json(list);
}));
app.get('/api/siswa/:id', auth, wrap(async (req, res) => {
  const s = await selOne('siswa', { id: +req.params.id });
  if (!s) return res.status(404).json({ error: 'Tidak ditemukan' });
  const kmap = await getKelasMap();
  res.json({ ...s, kelas: kmap.get(s.kelas_id) || '-' });
}));
function validateSiswa(b) {
  const c = {
    nis: String(b.nis || '').trim(), nisn: String(b.nisn || '').trim() || null,
    nama: String(b.nama || '').trim(), kelas_id: b.kelas_id ? +b.kelas_id : null,
    rfid: String(b.rfid || '').trim() || null, foto: b.foto ? String(b.foto) : null,
    no_induk: String(b.no_induk || '').trim() || null, no_rekening: String(b.no_rekening || '').trim() || null,
    tempat_lahir: String(b.tempat_lahir || '').trim() || null, tanggal_lahir: String(b.tanggal_lahir || '').trim() || null,
    jenis_kelamin: String(b.jenis_kelamin || '').trim() || null,
    no_hp: String(b.no_hp || '').trim() || null, no_hp_ayah: String(b.no_hp_ayah || '').trim() || null,
    no_hp_ibu: String(b.no_hp_ibu || '').trim() || null,
    aktif: b.aktif === undefined ? 1 : (b.aktif ? 1 : 0),
  };
  if (!c.nis || !c.nama) throw new Error('NIS dan Nama wajib');
  if (c.foto && !/^data:image\/(jpeg|jpg|png);base64,/i.test(c.foto)) throw new Error('Foto harus JPG/JPEG/PNG');
  if (c.foto && c.foto.length > 900000) throw new Error('Foto terlalu besar');
  return c;
}
app.post('/api/siswa', auth, adminGuru, wrap(async (req, res) => {
  try {
    const c = validateSiswa(req.body);
    if (await selOne('siswa', { nis: c.nis })) return res.status(400).json({ error: 'NIS sudah dipakai' });
    if (c.nisn && await selOne('siswa', { nisn: c.nisn })) return res.status(400).json({ error: 'NISN sudah dipakai' });
    if (!c.rfid) c.rfid = 'RF' + c.nis;
    const row = await ins('siswa', c);
    res.json({ ok: true, id: row.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.put('/api/siswa/:id', auth, adminGuru, wrap(async (req, res) => {
  try {
    const c = validateSiswa(req.body);
    await upd('siswa', +req.params.id, c);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/siswa/:id', auth, adminGuru, wrap(async (req, res) => {
  await del('siswa', +req.params.id);
  res.json({ ok: true });
}));
app.post('/api/siswa/import', auth, adminGuru, wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Data kosong' });
  let sukses = 0, gagal = 0; const errors = [];
  const kelasAll = await sel('kelas');
  const kelasMap = new Map(kelasAll.map(k => [k.nama.toLowerCase(), k.id]));
  const nisSet = new Set((await sel('siswa')).map(s => s.nis));
  for (let i = 0; i < rows.length; i++) {
    try {
      const r = rows[i];
      const nis = String(r.nis || '').trim(), nama = String(r.nama || '').trim();
      const kelasNama = String(r.kelas || '').trim();
      if (!nis || !nama) throw new Error('NIS/Nama kosong');
      if (nisSet.has(nis)) throw new Error('NIS sudah ada');
      let kid = null;
      if (kelasNama) {
        const k = kelasMap.get(kelasNama.toLowerCase());
        if (k) kid = k;
        else { const newK = await ins('kelas', { nama: kelasNama }); kelasMap.set(kelasNama.toLowerCase(), newK.id); kid = newK.id; }
      }
      await ins('siswa', { nis, nisn: r.nisn || null, nama, kelas_id: kid, rfid: r.rfid || ('RF' + nis), foto: null, no_induk: r.no_induk || null, no_rekening: r.no_rekening || null, tempat_lahir: r.tempat_lahir || null, tanggal_lahir: r.tanggal_lahir || null, jenis_kelamin: r.jenis_kelamin || null, no_hp: r.no_hp || null, no_hp_ayah: r.no_hp_ayah || null, no_hp_ibu: r.no_hp_ibu || null, aktif: 1 });
      nisSet.add(nis); sukses++;
    } catch (e) { gagal++; errors.push(`Baris ${i + 2}: ${e.message}`); }
  }
  res.json({ ok: true, sukses, gagal, errors: errors.slice(0, 20) });
}));

/* ============ ABSEN PELAJARAN ============ */
app.get('/api/absen-pelajaran', auth, wrap(async (req, res) => {
  const { mapel_id, kelas_id, tanggal, siswa_id } = req.query;
  let list = await sel('absensi_pelajaran');
  const kmap = await getKelasMap();
  const smap = new Map((await sel('siswa')).map(s => [s.id, s]));
  const mmap = new Map((await sel('mapel')).map(m => [m.id, m.nama]));
  list = list.map(a => {
    const s = smap.get(a.siswa_id) || {};
    return { ...a, nama_siswa: s.nama || '-', nis: s.nis || '-', kelas: kmap.get(s.kelas_id) || '-', kelas_id: s.kelas_id, mapel: mmap.get(a.mapel_id) || '-' };
  });
  if (mapel_id) list = list.filter(a => a.mapel_id === +mapel_id);
  if (kelas_id) list = list.filter(a => a.kelas_id === +kelas_id);
  if (tanggal) list = list.filter(a => a.tanggal === tanggal);
  if (siswa_id) list = list.filter(a => a.siswa_id === +siswa_id);
  list.sort((a, b) => String(b.tanggal + (b.created_at || '')).localeCompare(String(a.tanggal + (a.created_at || ''))));
  res.json(list);
}));
app.post('/api/absen-pelajaran', auth, adminGuru, wrap(async (req, res) => {
  const { mapel_id, tanggal, items } = req.body || {};
  if (!mapel_id || !tanggal || !Array.isArray(items)) return res.status(400).json({ error: 'Data kurang' });
  let saved = 0;
  for (const it of items) {
    const sid = +it.siswa_id;
    if (!sid || !it.status) continue;
    if (!['H', 'S', 'I', 'A'].includes(it.status)) continue;
    await pool.query(`INSERT INTO absensi_pelajaran (siswa_id, mapel_id, tanggal, status, user_id, updated_at) VALUES ($1, $2, $3, $4, $5, NOW()) ON CONFLICT (siswa_id, mapel_id, tanggal) DO UPDATE SET status = EXCLUDED.status, user_id = EXCLUDED.user_id, updated_at = NOW()`, [sid, +mapel_id, tanggal, it.status, req.user.id]);
    saved++;
  }
  res.json({ ok: true, saved });
}));
app.delete('/api/absen-pelajaran/:id', auth, adminGuru, wrap(async (req, res) => {
  await del('absensi_pelajaran', +req.params.id);
  res.json({ ok: true });
}));

/* ============ MAPEL ============ */
app.get('/api/mapel', auth, wrap(async (req, res) => {
  const list = await sel('mapel');
  const kmap = await getKelasMap();
  const umap = new Map((await sel('users')).map(u => [Number(u.id), u.nama]));
  res.json(list.map(m => {
    // PostgreSQL BIGINT[] is commonly parsed as strings; normalize IDs for the UI Set/checkboxes.
    const guruIds = Array.isArray(m.guru_ids) ? m.guru_ids.map(Number).filter(Number.isFinite) : [];
    return { ...m, guru_ids: guruIds, guru_nama: guruIds.map(id => umap.get(Number(id))).filter(Boolean), kelas: kmap.get(Number(m.kelas_id)) || null };
  }));
}));
app.post('/api/mapel', auth, adminGuru, wrap(async (req, res) => {
  const { nama, kode, kelas_id } = req.body;
  if (!nama) return res.status(400).json({ error: 'Nama wajib' });
  let guru_ids = Array.isArray(req.body.guru_ids) ? req.body.guru_ids.map(Number).filter(Boolean) : [];
  if (req.user.role === 'guru') guru_ids = [req.user.id];
  const row = await ins('mapel', { nama, kode: kode || null, kelas_id: kelas_id ? +kelas_id : null, guru_ids });
  res.json({ ok: true, id: row.id });
}));
app.put('/api/mapel/:id', auth, adminGuru, wrap(async (req, res) => {
  const m = await selOne('mapel', { id: +req.params.id });
  if (!m) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (req.user.role === 'guru' && !(m.guru_ids || []).includes(req.user.id)) return res.status(403).json({ error: 'Bukan mapel Anda' });
  const { nama, kode, kelas_id } = req.body;
  let guru_ids = Array.isArray(req.body.guru_ids) ? req.body.guru_ids.map(Number).filter(Boolean) : [];
  if (req.user.role === 'guru') guru_ids = [req.user.id];
  await upd('mapel', m.id, { nama, kode: kode || null, kelas_id: kelas_id ? +kelas_id : null, guru_ids });
  res.json({ ok: true });
}));
app.delete('/api/mapel/:id', auth, adminGuru, wrap(async (req, res) => {
  const m = await selOne('mapel', { id: +req.params.id });
  if (!m) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (req.user.role === 'guru' && !(m.guru_ids || []).includes(req.user.id)) return res.status(403).json({ error: 'Bukan mapel Anda' });
  await del('mapel', m.id);
  res.json({ ok: true });
}));

/* ============ EKSTRA ============ */
app.get('/api/ekstra', auth, wrap(async (req, res) => {
  const list = await sel('ekstra');
  const siswaAll = await sel('siswa');
  res.json(list.map(e => ({ ...e, jumlah: (e.siswa_ids || []).filter(id => siswaAll.some(s => s.id === id && s.aktif !== 0)).length })));
}));
app.post('/api/ekstra', auth, adminGuru, wrap(async (req, res) => {
  const { nama, hari, warna, siswa_ids } = req.body || {};
  if (!nama) return res.status(400).json({ error: 'Nama ekstra wajib' });
  if (await selOne('ekstra', { nama })) return res.status(400).json({ error: 'Nama ekstra sudah ada' });
  const row = await ins('ekstra', { nama: String(nama).trim(), hari: Array.isArray(hari) ? hari.map(Number) : [], warna: warna || '#0284c7', siswa_ids: Array.isArray(siswa_ids) ? siswa_ids.map(Number) : [] });
  res.json({ ok: true, id: row.id });
}));
app.put('/api/ekstra/:id', auth, adminGuru, wrap(async (req, res) => {
  const e = await selOne('ekstra', { id: +req.params.id });
  if (!e) return res.status(404).json({ error: 'Tidak ditemukan' });
  const patch = {};
  if (req.body.nama) patch.nama = String(req.body.nama).trim();
  if (Array.isArray(req.body.hari)) patch.hari = req.body.hari.map(Number);
  if (req.body.warna) patch.warna = req.body.warna;
  if (Array.isArray(req.body.siswa_ids)) patch.siswa_ids = req.body.siswa_ids.map(Number);
  await upd('ekstra', e.id, patch);
  res.json({ ok: true });
}));
app.delete('/api/ekstra/:id', auth, adminGuru, wrap(async (req, res) => {
  await del('ekstra', +req.params.id);
  res.json({ ok: true });
}));

/* ============ ABSEN EXTRA ============ */
app.get('/api/absen-extra/hari-ini', auth, wrap(async (req, res) => {
  const tgl = req.query.tanggal || todayStr();
  const ekstraId = req.query.ekstra_id ? +req.query.ekstra_id : null;
  let list = await sel('absensi_extra', { tanggal: tgl });
  if (ekstraId) list = list.filter(a => a.ekstra_id === ekstraId);
  const kmap = await getKelasMap();
  const smap = new Map((await sel('siswa')).map(s => [s.id, s]));
  const emap = new Map((await sel('ekstra')).map(e => [e.id, e.nama]));
  res.json(list.map(a => {
    const s = smap.get(a.siswa_id) || {};
    return { ...a, nis: s.nis, nama: s.nama, foto: s.foto, kelas: kmap.get(s.kelas_id) || '-', ekstra_nama: emap.get(a.ekstra_id) || '-' };
  }).sort((a, b) => String(b.jam_masuk || '').localeCompare(String(a.jam_masuk || ''))));
}));
app.post('/api/absen-extra/scan', auth, wrap(async (req, res) => {
  const { kode, ekstra_id, tanggal } = req.body || {};
  if (!kode || !ekstra_id) return res.status(400).json({ error: 'Kode & ekstra wajib' });
  const ql = String(kode).toLowerCase();
  const { rows: siswaRows } = await pool.query(`SELECT * FROM siswa WHERE (LOWER(rfid) = $1 OR LOWER(nis) = $1 OR LOWER(nisn) = $1) AND aktif != 0 LIMIT 1`, [ql]);
  const s = siswaRows[0];
  if (!s) return res.status(404).json({ ok: false, error: 'Murid tidak ditemukan', kode });
  const e = await selOne('ekstra', { id: +ekstra_id });
  if (!e) return res.status(400).json({ error: 'Ekstra tidak ditemukan' });
  const tgl = tanggal || todayStr();
  const st = await getSetting();
  const jamNow = timeNow();
  if (st.jam_extra_masuk && jamNow < st.jam_extra_masuk) return res.status(403).json({ ok: false, closed: true, error: 'Absen ekstra belum dibuka. Mulai jam ' + st.jam_extra_masuk });
  if (st.batas_extra_pulang && jamNow > st.batas_extra_pulang) return res.status(403).json({ ok: false, closed: true, error: 'Absen ekstra sudah ditutup. Batas jam ' + st.batas_extra_pulang });
  const kelas = (await getKelasMap()).get(s.kelas_id) || '-';
  const ex = await selOne('absensi_extra', { siswa_id: s.id, ekstra_id: e.id, tanggal: tgl });
  if (!ex) {
    const rec = await ins('absensi_extra', { siswa_id: s.id, ekstra_id: e.id, tanggal: tgl, jam_masuk: st.jam_extra_masuk || timeNow(), jam_pulang: st.jam_extra_pulang || null, status_masuk: 'tepat', user_id: req.user.id });
    return res.json({ ok: true, status: 'baru', siswa: { ...s, kelas }, jam: rec.jam_masuk, ekstra: e.nama });
  }
  res.json({ ok: true, status: 'sudah', siswa: { ...s, kelas }, jam: ex.jam_masuk, ekstra: e.nama });
}));
app.post('/api/absen-extra/manual', auth, adminGuru, wrap(async (req, res) => {
  const { siswa_id, ekstra_id, tanggal } = req.body || {};
  if (!siswa_id || !ekstra_id) return res.status(400).json({ error: 'Data kurang' });
  const tgl = tanggal || todayStr();
  const st = await getSetting();
  const ex = await selOne('absensi_extra', { siswa_id: +siswa_id, ekstra_id: +ekstra_id, tanggal: tgl });
  if (!ex) await ins('absensi_extra', { siswa_id: +siswa_id, ekstra_id: +ekstra_id, tanggal: tgl, jam_masuk: st.jam_extra_masuk || timeNow(), jam_pulang: st.jam_extra_pulang || null, status_masuk: 'tepat', user_id: req.user.id });
  res.json({ ok: true });
}));
app.delete('/api/absen-extra/:id', auth, adminGuru, wrap(async (req, res) => {
  await del('absensi_extra', +req.params.id); res.json({ ok: true });
}));
app.get('/api/rekap/extra', auth, wrap(async (req, res) => {
  const { dari, sampai, ekstra_id } = req.query;
  const d1 = dari || dateStrOffset(-30), d2 = sampai || todayStr();
  let list = (await sel('absensi_extra')).filter(a => a.tanggal >= d1 && a.tanggal <= d2);
  if (ekstra_id) list = list.filter(a => a.ekstra_id === +ekstra_id);
  const kmap = await getKelasMap();
  const smap = new Map((await sel('siswa')).map(s => [s.id, s]));
  const emap = new Map((await sel('ekstra')).map(e => [e.id, e.nama]));
  res.json(list.map(a => {
    const s = smap.get(a.siswa_id) || {};
    return { ...a, nis: s.nis, nama: s.nama, kelas: kmap.get(s.kelas_id) || '-', ekstra_nama: emap.get(a.ekstra_id) || '-' };
  }).sort((a, b) => String(b.tanggal + (b.jam_masuk || '')).localeCompare(String(a.tanggal + (a.jam_masuk || '')))));
}));

/* ============ PERIZINAN ============ */
app.get('/api/izin', auth, wrap(async (req, res) => {
  const { dari, sampai, siswa_id, status } = req.query;
  let list = await sel('izin');
  const kmap = await getKelasMap();
  const smap = new Map((await sel('siswa')).map(s => [s.id, s]));
  list = list.map(z => {
    const s = smap.get(z.siswa_id) || {};
    return { ...z, nama_siswa: s.nama || '-', nis: s.nis || '-', kelas: kmap.get(s.kelas_id) || '-' };
  });
  if (dari) list = list.filter(z => z.tanggal >= dari);
  if (sampai) list = list.filter(z => z.tanggal <= sampai);
  if (siswa_id) list = list.filter(z => z.siswa_id === +siswa_id);
  if (status) list = list.filter(z => z.status === status);
  list.sort((a, b) => String(b.tanggal + (b.created_at || '')).localeCompare(String(a.tanggal + (a.created_at || ''))));
  res.json(list);
}));
app.get('/api/izin/cek/:siswa_id', auth, wrap(async (req, res) => {
  const tgl = req.query.tanggal || todayStr();
  const aktif = await getIzinAktif(+req.params.siswa_id, tgl);
  const semua = await sel('izin', { siswa_id: +req.params.siswa_id, tanggal: tgl });
  res.json({ sedang_izin: !!aktif, detail: aktif, semua });
}));
app.post('/api/izin', auth, adminGuru, wrap(async (req, res) => {
  const { siswa_id, tanggal, jenis, jenis_custom, keterangan, status } = req.body || {};
  if (!siswa_id || !tanggal || !status) return res.status(400).json({ error: 'Data kurang' });
  if (!['pergi', 'kembali'].includes(status)) return res.status(400).json({ error: 'Status tidak valid' });
  let jenisFinal = String(jenis || '').trim();
  if (!jenisFinal || jenisFinal === 'Lainnya') jenisFinal = String(jenis_custom || '').trim() || 'Lainnya';
  const s = await selOne('siswa', { id: +siswa_id });
  if (!s) return res.status(400).json({ error: 'Siswa tidak ada' });
  if (s.aktif === 0) return res.status(400).json({ error: 'Siswa nonaktif' });
  const aktif = await getIzinAktif(+siswa_id, tanggal);
  if (status === 'pergi' && aktif) return res.status(400).json({ error: `Siswa masih izin (${aktif.jenis})` });
  if (status === 'kembali' && !aktif) return res.status(400).json({ error: 'Tidak ada izin pergi' });
  const row = await ins('izin', { siswa_id: +siswa_id, tanggal, jenis: jenisFinal, keterangan: keterangan || null, status, user_id: req.user.id });
  res.json({ ok: true, id: row.id });
}));
app.post('/api/izin/:id/kembali', auth, adminGuru, wrap(async (req, res) => {
  const asal = await selOne('izin', { id: +req.params.id });
  if (!asal) return res.status(404).json({ error: 'Izin tidak ditemukan' });
  if (asal.status !== 'pergi') return res.status(400).json({ error: 'Bukan status pergi' });
  const aktif = await getIzinAktif(asal.siswa_id, asal.tanggal);
  if (!aktif || aktif.id !== asal.id) return res.status(400).json({ error: 'Sudah dikembalikan' });
  const row = await ins('izin', { siswa_id: asal.siswa_id, tanggal: asal.tanggal, jenis: asal.jenis, keterangan: req.body?.keterangan || 'Kembali', status: 'kembali', user_id: req.user.id });
  res.json({ ok: true, id: row.id });
}));
app.delete('/api/izin/:id', auth, adminGuru, wrap(async (req, res) => { await del('izin', +req.params.id); res.json({ ok: true }); }));
app.get('/api/jenis-izin', auth, wrap(async (req, res) => { const list = await sel('jenis_izin'); res.json(list.map(j => j.nama)); }));
app.post('/api/jenis-izin', auth, adminGuru, wrap(async (req, res) => {
  const nama = String(req.body?.nama || '').trim();
  if (!nama) return res.status(400).json({ error: 'Nama wajib' });
  if (await selOne('jenis_izin', { nama })) return res.status(400).json({ error: 'Sudah ada' });
  await ins('jenis_izin', { nama }); res.json({ ok: true });
}));
app.delete('/api/jenis-izin/:nama', auth, adminGuru, wrap(async (req, res) => {
  const nama = decodeURIComponent(req.params.nama);
  const row = await selOne('jenis_izin', { nama });
  if (row) await del('jenis_izin', row.id);
  res.json({ ok: true });
}));

/* ============ ABSENSI SEKOLAH ============ */
app.post('/api/absen/scan', auth, wrap(async (req, res) => {
  const raw = String(req.body?.kode || '').trim();
  if (!raw) return res.status(400).json({ error: 'Kode kosong' });
  const ql = raw.toLowerCase();
  const { rows: siswaRows } = await pool.query(`SELECT * FROM siswa WHERE (LOWER(rfid) = $1 OR LOWER(nis) = $1 OR LOWER(nisn) = $1) AND aktif != 0 LIMIT 1`, [ql]);
  const s = siswaRows[0];
  if (!s) return res.status(404).json({ ok: false, found: false, error: 'Murid tidak ditemukan', kode: raw });
  const tgl = req.body?.tanggal || todayStr();
  const [izinAktif, st, kelasRows, exRows] = await Promise.all([
    getIzinAktif(s.id, tgl), getSetting(),
    pool.query('SELECT nama FROM kelas WHERE id = $1', [s.kelas_id]),
    pool.query('SELECT * FROM absensi WHERE siswa_id = $1 AND tanggal = $2', [s.id, tgl])
  ]);
  const kelas = kelasRows.rows[0]?.nama || '-';
  const ex = exRows.rows[0];
  if (izinAktif) return res.status(403).json({ ok: false, sedang_izin: true, error: 'Maaf, siswa sedang izin', siswa: { ...s, kelas }, detail_izin: izinAktif });
  const jam = timeNow();
  if (st.jam_masuk && jam < st.jam_masuk) return res.status(403).json({ ok: false, closed: true, error: 'Absen belum dibuka. Mulai jam ' + st.jam_masuk });
  if (st.batas_pulang && jam > st.batas_pulang) return res.status(403).json({ ok: false, closed: true, error: 'Absen sudah ditutup. Batas jam ' + st.batas_pulang });
  const status_masuk = jam > st.batas_telat ? 'telat' : 'tepat';
  if (ex && ex.status !== 'A') return res.json({ ok: true, found: true, status: 'sudah', siswa: { ...s, kelas }, jam: ex.jam, tanggal: tgl, status_masuk: ex.status_masuk });
  if (ex) await pool.query('DELETE FROM absensi WHERE id = $1', [ex.id]);
  await pool.query(`INSERT INTO absensi (siswa_id, tanggal, status, jam, status_masuk, user_id) VALUES ($1, $2, 'H', $3, $4, $5)`, [s.id, tgl, jam, status_masuk, req.user.id]);
  res.json({ ok: true, found: true, status: 'baru', siswa: { ...s, kelas }, jam, tanggal: tgl, status_masuk });
}));
app.post('/api/absen/manual', auth, adminGuru, wrap(async (req, res) => {
  const { siswa_id, status, keterangan, tanggal } = req.body || {};
  if (!siswa_id || !status) return res.status(400).json({ error: 'Data kurang' });
  const s = await selOne('siswa', { id: +siswa_id });
  if (!s || s.aktif === 0) return res.status(400).json({ error: 'Siswa tidak ada/nonaktif' });
  const tgl = tanggal || todayStr();
  const izinAktif = await getIzinAktif(s.id, tgl);
  if (izinAktif && status === 'H') return res.status(403).json({ error: `Siswa sedang izin (${izinAktif.jenis})` });
  const jam = timeNow();
  const ex = await selOne('absensi', { siswa_id: s.id, tanggal: tgl });
  if (ex) await del('absensi', ex.id);
  await ins('absensi', { siswa_id: s.id, tanggal: tgl, status, jam, keterangan: keterangan || null, user_id: req.user.id });
  res.json({ ok: true });
}));
app.get('/api/absen/hari-ini', auth, wrap(async (req, res) => {
  const tgl = req.query.tanggal || todayStr();
  let list = (await sel('absensi', { tanggal: tgl })).filter(a => ['H', 'S', 'I', 'A'].includes(a.status));
  const kmap = await getKelasMap();
  const smap = new Map((await sel('siswa')).map(s => [s.id, s]));
  res.json(list.map(a => {
    const s = smap.get(a.siswa_id) || {};
    return { ...a, nis: s.nis, nama: s.nama, foto: s.foto, kelas: kmap.get(s.kelas_id) || '-' };
  }).sort((a, b) => String(b.jam || '').localeCompare(String(a.jam || ''))));
}));
app.get('/api/rekap/harian', auth, wrap(async (req, res) => {
  const { kelas_id, tanggal } = req.query;
  const tgl = tanggal || todayStr();
  let listSiswa = (await sel('siswa')).filter(s => s.aktif !== 0);
  if (kelas_id) listSiswa = listSiswa.filter(s => s.kelas_id === +kelas_id);
  const kmap = await getKelasMap();
  const amap = new Map((await sel('absensi', { tanggal: tgl })).map(a => [a.siswa_id, a]));
  const izinMap = await getIzinAktifMap(tgl);
  const rows = listSiswa.map(s => {
    const absen = amap.get(s.id);
    const izinAktif = izinMap.get(s.id);
    return { siswa_id: s.id, nis: s.nis, nama: s.nama, foto: s.foto, kelas: kmap.get(s.kelas_id) || '-', status: absen?.status || null, jam: absen?.jam || null, status_masuk: absen?.status_masuk || null, jam_pulang: absen?.jam_pulang || null, sedang_izin: !!izinAktif, jenis_izin: izinAktif?.jenis || null };
  });
  const stat = { belum: 0, hadir: 0, telat: 0, ijin: 0, sakit: 0, alpa: 0, izin_keluar: 0 };
  rows.forEach(r => {
    if (r.sedang_izin) { stat.izin_keluar++; return; }
    if (!r.status) stat.belum++;
    else if (r.status === 'H' && r.status_masuk === 'telat') stat.telat++;
    else if (r.status === 'H') stat.hadir++;
    else if (r.status === 'I') stat.ijin++;
    else if (r.status === 'S') stat.sakit++;
    else if (r.status === 'A') stat.alpa++;
  });
  const total = stat.hadir + stat.telat + stat.ijin + stat.sakit + stat.alpa;
  const persen = total ? ((stat.hadir + stat.telat) / total * 100).toFixed(2) : '0.00';
  res.json({ rows, stat, persen, total });
}));
app.post('/api/absen/pulang/:siswa_id', auth, adminGuru, wrap(async (req, res) => {
  const tgl = req.query.tanggal || todayStr(); const jam = timeNow();
  const a = await selOne('absensi', { siswa_id: +req.params.siswa_id, tanggal: tgl });
  if (a) await upd('absensi', a.id, { jam_pulang: jam });
  res.json({ ok: true, jam });
}));
app.post('/api/absen/pulang-massal', auth, adminGuru, wrap(async (req, res) => {
  const tgl = req.query.tanggal || todayStr(); const jam = timeNow();
  const list = (await sel('absensi', { tanggal: tgl })).filter(a => a.status === 'H' && !a.jam_pulang);
  for (const a of list) await upd('absensi', a.id, { jam_pulang: jam });
  res.json({ ok: true, jumlah: list.length, jam });
}));
app.get('/api/rekap/per-kelas', auth, wrap(async (req, res) => {
  const tgl = req.query.tanggal || todayStr();
  const kmap = await getKelasMap();
  const kelasAll = await sel('kelas');
  const siswaAll = await sel('siswa');
  const amap = new Map((await sel('absensi', { tanggal: tgl })).map(a => [a.siswa_id, a]));
  const izinMap = await getIzinAktifMap(tgl);
  res.json({ tanggal: tgl, kelas: kelasAll.map(k => {
    const listSiswa = siswaAll.filter(s => s.kelas_id === k.id && s.aktif !== 0);
    const rows = listSiswa.map(s => {
      const a = amap.get(s.id); const izinAktif = izinMap.get(s.id);
      return { siswa_id: s.id, nis: s.nis, nama: s.nama, foto: s.foto, status: izinAktif ? 'IZIN' : (a?.status || null), jam: a?.jam || null, status_masuk: a?.status_masuk || null, jam_pulang: a?.jam_pulang || null, keterangan: a?.keterangan || (izinAktif?.jenis || null) };
    });
    const stat = { hadir: 0, telat: 0, izin: 0, sakit: 0, alpa: 0, belum: 0 };
    rows.forEach(r => {
      if (r.status === 'H' && r.status_masuk === 'telat') stat.telat++;
      else if (r.status === 'H') stat.hadir++;
      else if (r.status === 'I' || r.status === 'IZIN') stat.izin++;
      else if (r.status === 'S') stat.sakit++;
      else if (r.status === 'A') stat.alpa++;
      else if (!r.status) stat.belum++;
    });
    return { kelas: k.nama, kelas_id: k.id, jumlah: listSiswa.length, stat, rows };
  }) });
}));
app.get('/api/rekap/bulanan', auth, wrap(async (req, res) => {
  const { kelas_id, bulan, tahun } = req.query;
  const nowJkt = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const bl = String(bulan || (nowJkt.getMonth() + 1)).padStart(2, '0');
  const th = tahun || nowJkt.getFullYear();
  const dari = `${th}-${bl}-01`, sampai = `${th}-${bl}-31`;
  let listSiswa = (await sel('siswa')).filter(s => s.aktif !== 0);
  if (kelas_id) listSiswa = listSiswa.filter(s => s.kelas_id === +kelas_id);
  const kmap = await getKelasMap();
  const absensi = (await sel('absensi')).filter(a => a.tanggal >= dari && a.tanggal <= sampai);
  const bySid = {};
  absensi.forEach(a => { (bySid[a.siswa_id] = bySid[a.siswa_id] || []).push(a); });
  res.json(listSiswa.map(s => {
    const arr = bySid[s.id] || [];
    return { nis: s.nis, nama: s.nama, kelas: kmap.get(s.kelas_id) || '-', hadir: arr.filter(a => a.status === 'H' && a.status_masuk !== 'telat').length, telat: arr.filter(a => a.status === 'H' && a.status_masuk === 'telat').length, sakit: arr.filter(a => a.status === 'S').length, ijin: arr.filter(a => a.status === 'I').length, alpa: arr.filter(a => a.status === 'A').length };
  }));
}));

/* ============ INFORMASI ============ */
app.get('/api/informasi', auth, wrap(async (req, res) => {
  const list = (await sel('informasi')).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const umap = new Map((await sel('users')).map(u => [u.id, u.nama]));
  res.json(list.map(i => ({ ...i, user_nama: umap.get(i.user_id) || '-' })));
}));
app.post('/api/informasi', auth, adminGuru, wrap(async (req, res) => {
  const { judul, deskripsi, foto, tanggal } = req.body || {};
  if (!judul) return res.status(400).json({ error: 'Judul wajib' });
  if (foto && !/^data:image\/(jpeg|jpg|png);base64,/i.test(foto)) return res.status(400).json({ error: 'Foto harus JPG/JPEG/PNG' });
  if (foto && foto.length > 1500000) return res.status(400).json({ error: 'Foto terlalu besar' });
  const row = await ins('informasi', { judul: String(judul).trim(), deskripsi: String(deskripsi || '').trim(), foto: foto || null, tanggal: tanggal || todayStr(), user_id: req.user.id });
  res.json({ ok: true, id: row.id });
}));
app.put('/api/informasi/:id', auth, adminGuru, wrap(async (req, res) => {
  const info = await selOne('informasi', { id: +req.params.id });
  if (!info) return res.status(404).json({ error: 'Tidak ditemukan' });
  const patch = {};
  if (req.body.judul) patch.judul = String(req.body.judul).trim();
  if (req.body.deskripsi !== undefined) patch.deskripsi = String(req.body.deskripsi || '').trim();
  if (req.body.tanggal) patch.tanggal = req.body.tanggal;
  if (req.body.foto !== undefined) {
    if (req.body.foto && !/^data:image\/(jpeg|jpg|png);base64,/i.test(req.body.foto)) return res.status(400).json({ error: 'Foto harus JPG/JPEG/PNG' });
    patch.foto = req.body.foto || null;
  }
  await upd('informasi', info.id, patch);
  res.json({ ok: true });
}));
app.delete('/api/informasi/:id', auth, adminGuru, wrap(async (req, res) => { await del('informasi', +req.params.id); res.json({ ok: true }); }));

/* ============ SETTING ============ */
app.get('/api/setting', auth, wrap(async (req, res) => res.json(await getSetting())));
app.put('/api/setting', auth, adminGuru, wrap(async (req, res) => {
  const patch = {};
  const { jam_masuk, batas_telat, jam_pulang, batas_pulang, jam_extra_masuk, jam_extra_pulang, batas_extra_pulang, hari_libur_mingguan } = req.body;
  if (jam_masuk) patch.jam_masuk = jam_masuk;
  if (batas_telat) patch.batas_telat = batas_telat;
  if (jam_pulang) patch.jam_pulang = jam_pulang;
  if (batas_pulang) patch.batas_pulang = batas_pulang;
  if (jam_extra_masuk) patch.jam_extra_masuk = jam_extra_masuk;
  if (jam_extra_pulang) patch.jam_extra_pulang = jam_extra_pulang;
  if (batas_extra_pulang) patch.batas_extra_pulang = batas_extra_pulang;
  if (Array.isArray(hari_libur_mingguan)) patch.hari_libur_mingguan = hari_libur_mingguan.map(Number);
  if (Object.keys(patch).length) await upd('setting', 1, patch);
  res.json({ ok: true });
}));
app.get('/api/hari-libur', auth, wrap(async (req, res) => {
  let list = await sel('hari_libur');
  if (req.query.dari) list = list.filter(h => h.tanggal >= req.query.dari);
  if (req.query.sampai) list = list.filter(h => h.tanggal <= req.query.sampai);
  list.sort((a, b) => String(a.tanggal || '').localeCompare(String(b.tanggal || '')));
  res.json(list);
}));
app.post('/api/hari-libur', auth, adminGuru, wrap(async (req, res) => {
  const { tanggal, keterangan } = req.body;
  if (!tanggal) return res.status(400).json({ error: 'Tanggal wajib' });
  if (await selOne('hari_libur', { tanggal })) return res.status(400).json({ error: 'Tanggal sudah ada' });
  await ins('hari_libur', { tanggal, keterangan: keterangan || null });
  res.json({ ok: true });
}));
app.delete('/api/hari-libur/:id', auth, adminGuru, wrap(async (req, res) => { await del('hari_libur', +req.params.id); res.json({ ok: true }); }));

/* ============ JENIS PELANGGARAN ============ */
app.get('/api/jenis-pelanggaran', auth, wrap(async (req, res) => res.json(await sel('jenis_pelanggaran'))));
app.post('/api/jenis-pelanggaran', auth, adminGuru, wrap(async (req, res) => {
  const { kode, nama, kategori, poin } = req.body;
  if (!nama) return res.status(400).json({ error: 'Nama wajib' });
  const dup = (await sel('jenis_pelanggaran')).find(j => j.nama.toLowerCase() === nama.toLowerCase());
  if (dup) return res.status(400).json({ error: 'Nama sudah ada' });
  const row = await ins('jenis_pelanggaran', { kode: kode || null, nama, kategori: kategori || 'Ringan', poin: +poin || 5 });
  res.json({ ok: true, id: row.id });
}));
app.put('/api/jenis-pelanggaran/:id', auth, adminGuru, wrap(async (req, res) => {
  await upd('jenis_pelanggaran', +req.params.id, { kode: req.body.kode || null, nama: req.body.nama, kategori: req.body.kategori || 'Ringan', poin: +req.body.poin || 5 });
  res.json({ ok: true });
}));
app.delete('/api/jenis-pelanggaran/:id', auth, adminGuru, wrap(async (req, res) => { await del('jenis_pelanggaran', +req.params.id); res.json({ ok: true }); }));

/* ============ PELANGGARAN ============ */
app.get('/api/pelanggaran', auth, wrap(async (req, res) => {
  const { dari, sampai, jenis_id, kelas_id, siswa_id } = req.query;
  let list = await sel('pelanggaran');
  const kmap = await getKelasMap();
  const smap = new Map((await sel('siswa')).map(s => [s.id, s]));
  list = list.map(p => {
    const s = smap.get(p.siswa_id) || {};
    return { ...p, nama_siswa: s.nama || '-', nis: s.nis || '-', kelas: kmap.get(s.kelas_id) || '-' };
  });
  if (dari) list = list.filter(p => p.tanggal >= dari);
  if (sampai) list = list.filter(p => p.tanggal <= sampai);
  if (jenis_id) list = list.filter(p => p.jenis_id === +jenis_id);
  if (siswa_id) list = list.filter(p => p.siswa_id === +siswa_id);
  if (kelas_id) { const ids = [...smap.values()].filter(s => s.kelas_id === +kelas_id).map(s => s.id); list = list.filter(p => ids.includes(p.siswa_id)); }
  list.sort((a, b) => String(b.tanggal + (b.created_at || '')).localeCompare(String(a.tanggal + (a.created_at || ''))));
  res.json(list);
}));
app.post('/api/pelanggaran', auth, adminGuru, wrap(async (req, res) => {
  const { siswa_id, jenis_id, tanggal, keterangan, poin, jenis_custom } = req.body;
  if (!siswa_id || !tanggal) return res.status(400).json({ error: 'Data kurang' });
  let jenisNama = '', poinFinal = +poin || 0;
  if (jenis_id === 'lainnya' || jenis_id === null || jenis_id === undefined) jenisNama = String(jenis_custom || '').trim() || 'Lainnya';
  else {
    const j = await selOne('jenis_pelanggaran', { id: +jenis_id });
    if (!j) return res.status(400).json({ error: 'Jenis tidak ada' });
    jenisNama = j.nama; if (poin === undefined) poinFinal = j.poin;
  }
  const row = await ins('pelanggaran', { siswa_id: +siswa_id, jenis_id: jenis_id === 'lainnya' ? null : (+jenis_id || null), jenis: jenisNama, tanggal, poin: poinFinal, keterangan: keterangan || null, user_id: req.user.id });
  res.json({ ok: true, id: row.id });
}));
app.delete('/api/pelanggaran/:id', auth, adminGuru, wrap(async (req, res) => { await del('pelanggaran', +req.params.id); res.json({ ok: true }); }));
app.get('/api/pelanggaran/rekap', auth, wrap(async (req, res) => {
  const allSiswa = (await sel('siswa')).filter(s => s.aktif !== 0);
  const kmap = await getKelasMap();
  const allPel = await sel('pelanggaran');
  const bySid = {};
  allPel.forEach(p => { (bySid[p.siswa_id] = bySid[p.siswa_id] || []).push(p); });
  res.json(allSiswa.map(s => {
    const arr = bySid[s.id] || [];
    return { siswa_id: s.id, nis: s.nis, nama: s.nama, foto: s.foto, kelas: kmap.get(s.kelas_id) || '-', total_poin: arr.reduce((a, b) => a + (+b.poin || 0), 0), jumlah: arr.length };
  }).filter(x => x.total_poin > 0).sort((a, b) => b.total_poin - a.total_poin));
}));
app.get('/api/pelanggaran/statistik', auth, wrap(async (req, res) => {
  const all = await sel('pelanggaran');
  const perJenis = {};
  all.forEach(p => { perJenis[p.jenis] = (perJenis[p.jenis] || 0) + 1; });
  res.json({ perJenis: Object.entries(perJenis).map(([jenis, jumlah]) => ({ jenis, jumlah })).sort((a, b) => b.jumlah - a.jumlah).slice(0, 12) });
}));

/* ============ NILAI ============ */
app.get('/api/nilai', auth, wrap(async (req, res) => {
  const { mapel_id, siswa_id, kelas_id } = req.query;
  let list = await sel('nilai');
  const kmap = await getKelasMap();
  const smap = new Map((await sel('siswa')).map(s => [s.id, s]));
  const mmap = new Map((await sel('mapel')).map(m => [m.id, m.nama]));
  list = list.map(n => {
    const s = smap.get(n.siswa_id) || {};
    return { ...n, nama_siswa: s.nama || '-', nis: s.nis || '-', kelas: kmap.get(s.kelas_id) || '-', mapel: mmap.get(n.mapel_id) || '-' };
  });
  if (mapel_id) list = list.filter(n => n.mapel_id === +mapel_id);
  if (siswa_id) list = list.filter(n => n.siswa_id === +siswa_id);
  if (kelas_id) { const ids = [...smap.values()].filter(s => s.kelas_id === +kelas_id).map(s => s.id); list = list.filter(n => ids.includes(n.siswa_id)); }
  list.sort((a, b) => String(b.tanggal || '').localeCompare(String(a.tanggal || '')));
  res.json(list);
}));
app.post('/api/nilai', auth, adminGuru, wrap(async (req, res) => {
  const { siswa_id, mapel_id, nilai, jenis, tanggal, keterangan } = req.body;
  if (!siswa_id || !mapel_id || nilai === undefined) return res.status(400).json({ error: 'Data kurang' });
  await ins('nilai', { siswa_id: +siswa_id, mapel_id: +mapel_id, nilai: +nilai, jenis: jenis || 'harian', tanggal: tanggal || todayStr(), guru_id: req.user.id, keterangan: keterangan || null });
  res.json({ ok: true });
}));
app.put('/api/nilai/:id', auth, adminGuru, wrap(async (req, res) => {
  await upd('nilai', +req.params.id, { nilai: +req.body.nilai, jenis: req.body.jenis, tanggal: req.body.tanggal, keterangan: req.body.keterangan || null });
  res.json({ ok: true });
}));
app.delete('/api/nilai/:id', auth, adminGuru, wrap(async (req, res) => { await del('nilai', +req.params.id); res.json({ ok: true }); }));

/* ============ USERS ============ */
app.get('/api/users/guru', auth, wrap(async (req, res) => {
  const list = (await sel('users')).filter(u => u.role === 'guru');
  res.json(list.map(u => ({ id: Number(u.id), username: u.username, nama: u.nama })));
}));
app.get('/api/users', auth, adminGuru, wrap(async (req, res) => {
  let list = await sel('users');
  if (req.user.role === 'guru') list = list.filter(u => u.role !== 'admin');
  res.json(list.map(u => ({ id: u.id, username: u.username, nama: u.nama, role: u.role, permissions: u.permissions || [] })));
}));
app.post('/api/users', auth, adminOnly, wrap(async (req, res) => {
  const { username, password, nama, role } = req.body || {};
  const allowedPermissions = ALL_MENU_PERMISSIONS;
  const permissions = role === 'wali' ? [] : [...allowedPermissions];
  const pwd = String(password || '');
  if (!username || !nama || pwd.length < 8) return res.status(400).json({ error: 'Lengkapi username dan nama. Password harus minimal 8 karakter.' });
  if (!['admin', 'guru', 'operator', 'wali'].includes(role)) return res.status(400).json({ error: 'Role tidak valid' });
  if (req.user.role === 'guru' && role === 'admin') return res.status(403).json({ error: 'Guru tidak bisa buat akun admin' });
  if (await selOne('users', { username })) return res.status(400).json({ error: 'Username sudah dipakai' });
  await ins('users', { username, password: hashPassword(pwd), nama, role, permissions });
  res.json({ ok: true });
}));
app.put('/api/users/:id/password', auth, adminGuru, wrap(async (req, res) => {
  const u = await selOne('users', { id: +req.params.id });
  if (!u) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (req.user.role === 'guru' && u.role === 'admin') return res.status(403).json({ error: 'Tidak bisa ganti password admin' });
  const pwd = String(req.body?.password || '');
  if (pwd.length < 8) return res.status(400).json({ error: 'Gunakan password minimal 8 karakter agar akun lebih aman.' });
  await upd('users', u.id, { password: hashPassword(pwd) });
  await revokeUserSessions(u.id);
  res.json({ ok: true });
}));
app.delete('/api/users/:id', auth, adminOnly, wrap(async (req, res) => {
  const u = await selOne('users', { id: +req.params.id });
  if (!u) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'Tidak bisa hapus diri sendiri' });
  if (req.user.role === 'guru' && u.role === 'admin') return res.status(403).json({ error: 'Tidak bisa hapus admin' });
  await del('users', u.id);
  res.json({ ok: true });
}));

/* ============ WALI ============ */
app.get('/api/wali', auth, adminGuru, wrap(async (req, res) => {
  const list = await sel('wali_murid');
  const umap = new Map((await sel('users')).map(u => [u.id, u]));
  const smap = new Map((await sel('siswa')).map(s => [s.id, s]));
  const kmap = await getKelasMap();
  res.json(list.map(w => {
    const u = umap.get(w.user_id) || {};
    const s = smap.get(w.siswa_id) || {};
    return { ...w, username: u.username, nama_user: u.nama, nama_siswa: s.nama, nis: s.nis, kelas: kmap.get(s.kelas_id) || '-' };
  }));
}));
app.post('/api/wali', auth, adminGuru, wrap(async (req, res) => {
  const { user_id, siswa_id, hubungan } = req.body;
  if (!user_id || !siswa_id) return res.status(400).json({ error: 'Data kurang' });
  await ins('wali_murid', { user_id: +user_id, siswa_id: +siswa_id, hubungan: hubungan || 'wali' });
  res.json({ ok: true });
}));
app.delete('/api/wali/:id', auth, adminGuru, wrap(async (req, res) => { await del('wali_murid', +req.params.id); res.json({ ok: true }); }));

/* ============ ORTU (WALI) ============ */
app.get('/api/wali/saya', auth, wrap(async (req, res) => {
  if (req.user.role !== 'wali') return res.status(403).json({ error: 'Khusus wali' });
  const rel = (await sel('wali_murid')).filter(w => Number(w.user_id) === Number(req.user.id));
  const ids = rel.map(w => Number(w.siswa_id));
  const kmap = await getKelasMap();
  res.json((await sel('siswa')).filter(s => ids.includes(Number(s.id))).map(s => ({ ...s, kelas: kmap.get(s.kelas_id) || '-' })));
}));
const waliChildCheck = async (req, res, next) => {
  try {
    if (req.user.role !== 'wali') return res.status(403).json({ error: 'Khusus wali' });
    const targetSiswa = Number(req.params.siswa_id);
    const rel = (await sel('wali_murid')).filter(w => Number(w.user_id) === Number(req.user.id) && Number(w.siswa_id) === targetSiswa);
    if (!rel.length) return res.status(403).json({ error: 'Bukan anak Anda' });
    next();
  } catch (e) { next(e); }
};
app.get('/api/wali/anak/:siswa_id/absensi', auth, waliChildCheck, wrap(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page || '0', 10) || 0);
  const list = await sel('absensi', { siswa_id: +req.params.siswa_id });
  const sorted = list.sort((a, b) => String(b.tanggal || '').localeCompare(String(a.tanggal || '')));
  if (!req.query.page) return res.json(sorted);
  const start = dateStrOffset(-((page - 1) * 7 + 6));
  const end = dateStrOffset(-((page - 1) * 7));
  const rows = sorted.filter(a => String(a.tanggal) >= start && String(a.tanggal) <= end);
  const older = sorted.some(a => String(a.tanggal) < start);
  const oldest = sorted.length ? String(sorted[sorted.length - 1].tanggal).slice(0,10) : todayStr();
  const maxPage = Math.max(1, Math.floor((new Date(todayStr() + 'T12:00:00Z') - new Date(oldest + 'T12:00:00Z')) / 604800000) + 1);
  res.json({ rows, page, start, end, today: todayStr(), hasOlder: older, maxPage });
}));
app.get('/api/wali/anak/:siswa_id/nilai', auth, waliChildCheck, wrap(async (req, res) => {
  const list = await sel('nilai', { siswa_id: +req.params.siswa_id });
  const mmap = new Map((await sel('mapel')).map(m => [m.id, m.nama]));
  res.json(list.map(n => ({ ...n, mapel: mmap.get(n.mapel_id) || '-' })));
}));
app.get('/api/wali/anak/:siswa_id/pelanggaran', auth, waliChildCheck, wrap(async (req, res) => {
  const list = await sel('pelanggaran', { siswa_id: +req.params.siswa_id });
  res.json(list.sort((a, b) => String(b.tanggal || '').localeCompare(String(a.tanggal || ''))));
}));
app.get('/api/wali/anak/:siswa_id/izin', auth, waliChildCheck, wrap(async (req, res) => {
  const list = await sel('izin', { siswa_id: +req.params.siswa_id });
  res.json(list.sort((a, b) => String(b.tanggal + (b.created_at || '')).localeCompare(String(a.tanggal + (a.created_at || '')))));
}));
app.get('/api/wali/anak/:siswa_id/extra', auth, waliChildCheck, wrap(async (req, res) => {
  const list = await sel('absensi_extra', { siswa_id: +req.params.siswa_id });
  const emap = new Map((await sel('ekstra')).map(e => [e.id, e]));
  res.json(list.map(a => {
    const e = emap.get(a.ekstra_id) || {};
    return { ...a, ekstra_nama: e.nama || '-', ekstra_warna: e.warna || '#0284c7' };
  }).sort((a, b) => String(b.tanggal + (b.jam_masuk || '')).localeCompare(String(a.tanggal + (a.jam_masuk || '')))));
}));
app.get('/api/wali/anak/:siswa_id/pelajaran', auth, waliChildCheck, wrap(async (req, res) => {
  const { dari, sampai } = req.query;
  let list = await sel('absensi_pelajaran', { siswa_id: +req.params.siswa_id });
  if (dari) list = list.filter(a => a.tanggal >= dari);
  if (sampai) list = list.filter(a => a.tanggal <= sampai);
  const mmap = new Map((await sel('mapel')).map(m => [m.id, m.nama]));
  res.json(list.map(a => ({ ...a, mapel: mmap.get(a.mapel_id) || '-' }))
    .sort((a, b) => String(b.tanggal + (b.created_at || '')).localeCompare(String(a.tanggal + (a.created_at || '')))));
}));
app.get('/api/wali/informasi', auth, wrap(async (req, res) => {
  const list = (await sel('informasi')).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 20);
  res.json(list.map(i => ({ id: i.id, judul: i.judul, deskripsi: i.deskripsi, foto: i.foto, tanggal: i.tanggal, created_at: i.created_at })));
}));

/* ============ RIWAYAT AKTIVITAS ============ */
app.get('/api/aktivitas', auth, adminOnly, wrap(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit || '30', 10) || 30));
  const offset = (page - 1) * limit;
  const { rows } = await pool.query('SELECT username,nama,action,method,route,detail,status_code,created_at FROM activity_logs ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2', [limit, offset]);
  const count = await pool.query('SELECT COUNT(*)::int AS total FROM activity_logs');
  const menuForRoute = (route='') => {
    if (/\/auth\/(login|logout|ganti-password)/.test(route) || /\/users/.test(route)) return 'Akun & keamanan';
    if (/\/tabungan/.test(route)) return 'Tabungan siswa';
    if (/\/nilai/.test(route)) return 'Nilai siswa';
    if (/\/pelanggaran/.test(route)) return 'Pelanggaran';
    if (/\/wali/.test(route)) return 'Data wali';
    if (/\/siswa/.test(route)) return 'Data siswa';
    if (/\/kelas/.test(route)) return 'Data kelas';
    if (/\/mapel/.test(route)) return 'Mata pelajaran';
    if (/\/absen|\/rekap/.test(route)) return 'Absensi';
    if (/\/izin/.test(route)) return 'Perizinan';
    if (/\/ekstra/.test(route)) return 'Absensi ekstrakurikuler';
    if (/\/informasi/.test(route)) return 'Informasi sekolah';
    if (/\/setting|\/hari-libur/.test(route)) return 'Pengaturan sekolah';
    return 'Data sekolah';
  };
  const labels = { nama:'Nama', judul:'Judul', deskripsi:'Deskripsi', nominal:'Nominal', nilai:'Nilai', jenis:'Jenis', tanggal:'Tanggal', status:'Status', keterangan:'Keterangan', username:'Username', role:'Peran', jam_masuk:'Jam masuk', jam_pulang:'Jam pulang', batas_telat:'Batas keterlambatan', kode:'Kode', poin:'Poin', hubungan:'Hubungan', warna:'Warna' };
  const safeRows = rows.map(r => {
    let detail = String(r.detail || '').split(' · ').map(part => {
      const i = part.indexOf(':'); if (i < 0) return part === 'Data dihapus' || part === 'Data disimpan' ? part : '';
      const k = part.slice(0, i).trim(); return labels[k] ? labels[k] + ': ' + part.slice(i + 1) : '';
    }).filter(Boolean).join(' · ');
    if (!detail) detail = r.method === 'DELETE' ? 'Data dihapus' : 'Perubahan data tersimpan';
    return { username: r.username, nama: r.nama, action: r.action, menu: menuForRoute(r.route), detail, hasil: Number(r.status_code) < 400 ? 'Berhasil' : 'Tidak berhasil', created_at: r.created_at };
  });
  res.json({ rows: safeRows, page, limit, total: count.rows[0]?.total || 0 });
}));

/* ============ DASHBOARD ============ */
app.get('/api/dashboard', auth, wrap(async (req, res) => {
  const tgl = req.query.tanggal || todayStr();
  const [absHariIni, siswaAll, izinRows, pel, kelasAll, users, ekstraAll] = await Promise.all([
    sel('absensi', { tanggal: tgl }), sel('siswa'), sel('izin', { tanggal: tgl }),
    sel('pelanggaran'), sel('kelas'), sel('users'), sel('ekstra')
  ]);
  const izinMap = new Map();
  const bySid = {};
  izinRows.forEach(z => { (bySid[z.siswa_id] = bySid[z.siswa_id] || []).push(z); });
  Object.entries(bySid).forEach(([sid, list]) => {
    list.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    if (list[list.length - 1].status === 'pergi') izinMap.set(+sid, list[list.length - 1]);
  });
  const jumlahIzinAktif = siswaAll.filter(s => s.aktif !== 0 && izinMap.has(s.id)).length;
  res.json({
    tanggal: tgl, serverDate: todayStr(), serverTime: timeNow(), timezone: TZ,
    totalSiswa: siswaAll.filter(s => s.aktif !== 0).length,
    totalSiswaAll: siswaAll.length,
    totalSiswaNonaktif: siswaAll.filter(s => s.aktif === 0).length,
    totalKelas: kelasAll.length,
    totalGuru: users.filter(u => u.role === 'guru').length,
    totalEkstra: ekstraAll.length,
    hadirHariIni: absHariIni.filter(a => a.status === 'H' && a.status_masuk !== 'telat').length,
    telatHariIni: absHariIni.filter(a => a.status === 'H' && a.status_masuk === 'telat').length,
    ijinSakit: absHariIni.filter(a => ['S', 'I'].includes(a.status)).length,
    alpa: absHariIni.filter(a => a.status === 'A').length,
    izinAktif: jumlahIzinAktif,
    pelanggaran: pel.length,
    totalPoin: pel.reduce((a, b) => a + (+b.poin || 0), 0),
  });
}));
app.get('/api/dashboard/detail', auth, wrap(async (req, res) => {
  const tgl = req.query.tanggal || todayStr();
  const kategori = req.query.kategori || 'hadir';
  const list = [];
  const kmap = await getKelasMap();
  const smap = new Map((await sel('siswa')).map(s => [s.id, s]));
  const absHariIni = await sel('absensi', { tanggal: tgl });
  if (['hadir', 'telat', 'sakit', 'izin', 'alpa'].includes(kategori)) {
    let filter;
    if (kategori === 'hadir') filter = a => a.status === 'H' && a.status_masuk !== 'telat';
    else if (kategori === 'telat') filter = a => a.status === 'H' && a.status_masuk === 'telat';
    else if (kategori === 'sakit') filter = a => a.status === 'S';
    else if (kategori === 'izin') filter = a => a.status === 'I';
    else filter = a => a.status === 'A';
    absHariIni.filter(filter).forEach(a => {
      const s = smap.get(a.siswa_id); if (!s) return;
      list.push({ ...s, kelas: kmap.get(s.kelas_id) || '-', jam: a.jam, keterangan: a.keterangan });
    });
  } else if (kategori === 'izin-aktif') {
    const izinMap = await getIzinAktifMap(tgl);
    izinMap.forEach((iz, sid) => {
      const s = smap.get(sid); if (!s) return;
      list.push({ ...s, kelas: kmap.get(s.kelas_id) || '-', jam: iz.created_at ? iz.created_at.slice(11, 16) : null, keterangan: iz.jenis + (iz.keterangan ? ' - ' + iz.keterangan : '') });
    });
  } else if (kategori === 'belum') {
    const amap = new Map(absHariIni.map(a => [a.siswa_id, a]));
    const izinMap = await getIzinAktifMap(tgl);
    smap.forEach(s => {
      if (s.aktif === 0) return;
      if (amap.has(s.id)) return;
      if (izinMap.has(s.id)) return;
      list.push({ ...s, kelas: kmap.get(s.kelas_id) || '-', jam: null, keterangan: null });
    });
  }
  list.sort((a, b) => String(a.nama || '').localeCompare(String(b.nama || '')));
  res.json({ tanggal: tgl, kategori, jumlah: list.length, list });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Permintaan tidak tersedia' }));

/* ============ SPA ============ */
const SPA = async (req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  if (req.path.match(/\.(js|css|png|jpg|jpeg|ico|svg|woff|woff2|ttf|map)$/)) return next();
  const u = await getUser(req);
  if (req.path === '/login.html' || req.path === '/login') {
    if (u) return res.redirect('/');
    return res.sendFile(path.join(PUB, 'login.html'));
  }
  if (!u) return res.redirect('/login.html');
  res.sendFile(path.join(PUB, 'index.html'));
};
app.get('/login.html', wrap(SPA));
app.get('*', wrap(SPA));

app.use((err, req, res, next) => {
  const status = Number(err.status) >= 400 && Number(err.status) < 500 ? Number(err.status) : 500;
  if (status >= 500) console.error('Kesalahan internal pada permintaan');
  res.status(status).json({ error: status === 500 ? 'Terjadi kesalahan internal. Silakan coba lagi.' : (err.publicMessage || err.message || 'Permintaan tidak valid') });
});

async function ensureAdmin() {
  const { rows } = await pool.query(`SELECT id FROM users LIMIT 1`);
  if (!rows.length) {
    const configured = String(config.adminDefault?.password || '');
    const initialPassword = configured.length >= 16 && !/^(admin|password|changeme|123456)/i.test(configured)
      ? configured : crypto.randomBytes(24).toString('base64url');
    await ins('users', {
      username: String(config.adminDefault.username || 'admin').slice(0, 120),
      password: hashPassword(initialPassword),
      nama: String(config.adminDefault.nama || 'Administrator').slice(0, 120),
      role: 'admin',
    });
    console.log('Admin awal dibuat. Username:', config.adminDefault.username || 'admin');
    if (initialPassword !== configured) console.log('Password admin awal (simpan dan segera ganti):', initialPassword);
  } else {
    console.log('✅ Admin sudah ada.');
  }
}

export const ready = (async () => {
  await initSchema();
  await ensureAdmin();
})();

// Vercel menjalankan Express sebagai Function; jangan membuka listener atau timer persisten di sana.
if (!process.env.VERCEL) {
  ready.then(() => {
    setInterval(async () => { try { await pool.query('SELECT 1'); } catch (e) {} }, 60000).unref();
    setTimeout(() => { autoAlpha().catch(e => console.error(e.message)); }, 15000).unref();
    setInterval(() => { autoAlpha().catch(e => console.error(e.message)); }, 6 * 60 * 60 * 1000).unref();
    app.listen(config.port, config.host, () => {
      console.log(`\n  ${config.appName} - ${config.lembaga}`);
      console.log(`  Tapel ${config.tahunPelajaran} | TZ: ${TZ}`);
      console.log(`  http://localhost:${config.port}\n`);
    });
  }).catch(() => { process.exitCode = 1; });
}

export default app;

import app, { ready } from '../server.js';

export default async function handler(req, res) {
  try {
    await ready;
    return app(req, res);
  } catch (error) {
    console.error('Aplikasi belum siap menangani permintaan');
    if (!res.headersSent) res.status(503).json({ error: 'Layanan sementara tidak tersedia. Coba lagi.' });
  }
}

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { buildRouter } from './routes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = openDb();
const app = express();

app.use(express.json({ limit: '256kb' }));
app.use('/api', buildRouter(db));

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

const dist = path.join(root, 'dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Certificate Admin Console listening on http://localhost:${port}`);
});
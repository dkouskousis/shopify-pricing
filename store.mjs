import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(path, encryptionKey) {
  if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) throw new Error('ENCRYPTION_KEY must be 64 hexadecimal characters (32 random bytes).');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS variants (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rules (vendor TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, created TEXT NOT NULL, variant_id TEXT NOT NULL, title TEXT NOT NULL, old_price INTEGER NOT NULL, new_price INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL);
  `);
  // One-time v1 -> v2 migration. Preserve the former rules/charges locally,
  // but do not include flat charges in the newly requested simple formula.
  if (db.prepare('PRAGMA user_version').get().user_version < 2) {
    db.exec('BEGIN');
    try {
      const oldRules = db.prepare('SELECT vendor,data FROM rules').all();
      const hasExtras = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='extras'").get();
      const oldExtras = hasExtras ? db.prepare('SELECT * FROM extras').all() : [];
      if (oldRules.length || oldExtras.length) db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('legacyPricingV1', JSON.stringify({ rules: oldRules, extras: oldExtras }));
      for (const row of oldRules) {
        const old = JSON.parse(row.data);
        const rule = { vendor: old.vendor, multiplier: 10000 + old.markup, vat: old.vat, addVat: old.addVat };
        db.prepare('UPDATE rules SET data=? WHERE vendor=?').run(JSON.stringify(rule), row.vendor);
      }
      if (hasExtras) db.exec('DROP TABLE extras');
      db.exec('DELETE FROM previews; PRAGMA user_version=2; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 3) {
    db.exec(`BEGIN;
      ALTER TABLE audit ADD COLUMN kind TEXT NOT NULL DEFAULT 'price';
      ALTER TABLE audit ADD COLUMN old_missing INTEGER NOT NULL DEFAULT 0;
      PRAGMA user_version=3;
      COMMIT;`);
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 4) {
    db.exec('BEGIN');
    try {
      for (const row of db.prepare('SELECT vendor,data FROM rules').all()) {
        const previous = JSON.parse(row.data);
        db.prepare('UPDATE rules SET data=? WHERE vendor=?').run(JSON.stringify({ ...previous, mode: 'multiplier', targetMargin: null }), row.vendor);
      }
      db.exec('DELETE FROM previews; PRAGMA user_version=4; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 5) {
    db.exec('BEGIN');
    try {
      for (const row of db.prepare('SELECT vendor,data FROM rules').all()) {
        db.prepare('UPDATE rules SET data=? WHERE vendor=?').run(JSON.stringify({ ...JSON.parse(row.data), fixed: 0 }), row.vendor);
      }
      db.exec('DELETE FROM previews; PRAGMA user_version=5; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 6) {
    db.exec('BEGIN; DELETE FROM previews; PRAGMA user_version=6; COMMIT');
  }
  // Interrupted writes may have reached Shopify. Never automatically repeat them.
  db.prepare("UPDATE audit SET status='uncertain',detail='Η εφαρμογή επανεκκινήθηκε κατά την ενημέρωση. Συγχρόνισε και έλεγξε την τιμή ή το κόστος.' WHERE status='pending'").run();
  const key = Buffer.from(encryptionKey, 'hex');
  function encrypt(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  }
  function decrypt(value) {
    const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }
  function get(key) { const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  function put(key, value) { db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value)); }
  return { db, get, put, encrypt, decrypt,
    settings() { const value = get('settings'); return value ? decrypt(value) : null; },
    saveSettings(value) { put('settings', encrypt(value)); },
    rules() { return db.prepare('SELECT data FROM rules ORDER BY vendor').all().map(r => JSON.parse(r.data)); },
    variants() { return db.prepare('SELECT data FROM variants').all().map(r => JSON.parse(r.data)); },
    variant(id) { const row = db.prepare('SELECT data FROM variants WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; },
  };
}

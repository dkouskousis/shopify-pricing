import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.mjs';
test('v1 rules migrate once, keep credentials/data and back up removed flat amounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-migration-'));
  const path = join(dir, 'test.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE rules (vendor TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE extras (id TEXT PRIMARY KEY,amount INTEGER NOT NULL);
      CREATE TABLE previews (id TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);`);
    old.prepare('INSERT INTO rules VALUES (?,?)').run('Example', JSON.stringify({ vendor: 'Example', markup: 5457, fixed: 100, vat: 2400, addVat: true }));
    old.prepare('INSERT INTO extras VALUES (?,?)').run('variant-1', 2500);
    old.prepare('INSERT INTO previews(id,data,expires) VALUES (?,?,?)').run('old', '{}', Date.now() + 10000);
    old.prepare('INSERT INTO meta VALUES (?,?)').run('lastSync', JSON.stringify('previous-sync'));
    old.close();
    const key = 'ab'.repeat(32), current = openStore(path, key);
    assert.deepEqual(current.rules(), [{ vendor: 'Example', multiplier: 15457, vat: 2400, addVat: true }]);
    assert.equal(current.get('lastSync'), 'previous-sync');
    assert.equal(current.get('legacyPricingV1').extras[0].amount, 2500);
    assert.equal(current.db.prepare('SELECT count(*) AS n FROM previews').get().n, 0);
    current.saveSettings({ shop: 'example.myshopify.com', accessToken: 'private-token' });
    current.db.close();
    const reopened = openStore(path, key);
    assert.equal(reopened.rules()[0].multiplier, 15457);
    assert.equal(reopened.settings().accessToken, 'private-token');
    assert.equal(reopened.get('legacyPricingV1').extras[0].amount, 2500);
    reopened.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

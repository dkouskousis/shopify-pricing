import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.mjs';
const withoutFixed = ({ fixed, ...rule }) => rule;
test('rounding upgrade invalidates old previews once and preserves supplier rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-rounding-')), path = join(dir, 'test.sqlite');
  try {
    const key = 'ab'.repeat(32), initial = openStore(path, key);
    const rule = { vendor: 'Existing', mode: 'margin', multiplier: null, targetMargin: 4000, fixed: 1000, vat: 2400, addVat: true };
    initial.db.prepare('INSERT INTO rules VALUES (?,?)').run(rule.vendor, JSON.stringify(rule));
    initial.db.prepare('INSERT INTO previews(id,data,expires) VALUES (?,?,?)').run('old', '{}', Date.now() + 10000);
    initial.db.exec('PRAGMA user_version=5'); initial.db.close();
    const upgraded = openStore(path, key);
    assert.deepEqual(upgraded.rules(), [{ ...withoutFixed(rule), conditions: [] }]);
    assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM previews').get().n, 0);
    upgraded.db.prepare('INSERT INTO previews(id,data,expires) VALUES (?,?,?)').run('fresh', '{}', Date.now() + 10000);
    upgraded.db.close();
    const reopened = openStore(path, key);
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM previews').get().n, 1);
    reopened.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
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
    assert.deepEqual(current.rules(), [{ vendor: 'Example', multiplier: 15457, vat: 2400, addVat: true, mode: 'multiplier', targetMargin: null, conditions: [] }]);
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
test('v1.2 rules migrate to multiplier mode once without changing the chosen factor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-modes-')), path = join(dir, 'test.sqlite');
  try {
    const key = 'ab'.repeat(32), initial = openStore(path, key);
    initial.db.prepare('INSERT INTO rules VALUES (?,?)').run('Existing', JSON.stringify({ vendor: 'Existing', multiplier: 15457, vat: 2400, addVat: false }));
    initial.db.exec('PRAGMA user_version=3'); initial.db.close();
    const migrated = openStore(path, key);
    assert.deepEqual(migrated.rules()[0], { vendor: 'Existing', multiplier: 15457, vat: 2400, addVat: false, mode: 'multiplier', targetMargin: null, conditions: [] });
    migrated.db.prepare('UPDATE rules SET data=? WHERE vendor=?').run(JSON.stringify({ vendor: 'Existing', mode: 'margin', multiplier: null, targetMargin: 4000, vat: 2400, addVat: true }), 'Existing');
    migrated.db.close();
    const reopened = openStore(path, key);
    assert.equal(reopened.rules()[0].mode, 'margin');
    assert.equal(reopened.rules()[0].targetMargin, 4000);
    reopened.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('v1.6 upgrade removes global amounts, preserves separate condition amounts and invalidates previews', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-only-conditions-')), path = join(dir, 'test.sqlite');
  try {
    const key = 'ab'.repeat(32), initial = openStore(path, key);
    const conditions = [{ from: 0, to: 5000, amount: 200, collectionId: '' }, { from: 30000, to: 99900, amount: 2500, collectionId: 'gid://shopify/Collection/1' }];
    const rule = { vendor: 'Existing', mode: 'margin', multiplier: null, targetMargin: 4000, fixed: 1000, vat: 2400, addVat: true, conditions };
    initial.db.prepare('INSERT INTO rules VALUES (?,?)').run(rule.vendor, JSON.stringify(rule));
    initial.db.prepare('INSERT INTO previews(id,data,expires) VALUES (?,?,?)').run('old', '{}', Date.now() + 10000);
    initial.db.exec('PRAGMA user_version=7'); initial.db.close();
    const migrated = openStore(path, key);
    assert.deepEqual(migrated.rules()[0], withoutFixed(rule));
    assert.equal(migrated.db.prepare('SELECT count(*) AS n FROM previews').get().n, 0);
    migrated.db.close();
    const reopened = openStore(path, key);
    assert.deepEqual(reopened.rules()[0].conditions, conditions);
    assert.equal(Object.hasOwn(reopened.rules()[0], 'fixed'), false);
    reopened.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('condition upgrade preserves pricing mode and requires collections sync only once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-conditions-')), path = join(dir, 'test.sqlite');
  try {
    const key = 'ab'.repeat(32), initial = openStore(path, key);
    const rule = { vendor: 'Existing', mode: 'multiplier', multiplier: 14000, targetMargin: null, fixed: 1000, vat: 2400, addVat: true };
    initial.db.prepare('INSERT INTO rules VALUES (?,?)').run(rule.vendor, JSON.stringify(rule));
    initial.db.prepare('INSERT INTO variants VALUES (?,?)').run('variant', JSON.stringify({ id: 'variant', cost: 6000 }));
    initial.db.prepare('INSERT INTO previews(id,data,expires) VALUES (?,?,?)').run('old', '{}', Date.now() + 10000);
    initial.db.exec('PRAGMA user_version=6'); initial.db.close();
    const upgraded = openStore(path, key);
    assert.deepEqual(upgraded.rules(), [{ ...withoutFixed(rule), conditions: [] }]);
    assert.equal(upgraded.variant('variant').collectionIds, null);
    assert.deepEqual(upgraded.get('collections'), []);
    assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM previews').get().n, 0);
    const conditions = [{ from: 0, to: 5000, amount: 200, collectionId: '' }];
    upgraded.db.prepare('UPDATE rules SET data=?').run(JSON.stringify({ ...withoutFixed(rule), conditions }));
    upgraded.put('collections', [{ id: 'collection', title: 'Sleep' }]);
    upgraded.db.close();
    const reopened = openStore(path, key);
    assert.deepEqual(reopened.rules()[0].conditions, conditions);
    assert.equal(Object.hasOwn(reopened.rules()[0], 'fixed'), false);
    assert.equal(reopened.get('collections')[0].title, 'Sleep');
    reopened.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

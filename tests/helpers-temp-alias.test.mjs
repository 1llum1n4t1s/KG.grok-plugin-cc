import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeTempFixture } from './helpers.mjs';

// 公開cleanup経路を仮想FSで検証し、ホスト上の削除は一切実行しない。
function fixture(t, options = {}) {
  const aliasParent = path.resolve('virtual-temp-alias');
  const root = path.join(aliasParent, 'tmp');
  const canonical = path.resolve('virtual-temp-canonical', 'tmp');
  const target = path.join(root, 'fixture');
  const canonicalTarget = path.join(canonical, 'fixture');
  const removals = [];
  const directory = { isSymbolicLink: () => false, isDirectory: () => true };
  const link = { isSymbolicLink: () => true, isDirectory: () => false };
  t.mock.method(os, 'tmpdir', () => root);
  t.mock.method(fs, 'realpathSync', (value) => {
    assert.equal(value, root);
    if (options.rootError) throw Object.assign(new Error('Unknown root'), { code: options.rootError });
    return canonical;
  });
  t.mock.method(fs, 'lstatSync', (value) => {
    // rootのaliasが後で変更されても検査と削除が同じ実体を使うことを確認する。
    if (path.relative(canonical, value) && !path.relative(canonical, value).startsWith('..')) {
      value = path.join(root, path.relative(canonical, value));
    }
    if (value === options.unknown) throw Object.assign(new Error('Unknown path'), { code: 'EACCES' });
    if (value === options.missing) throw Object.assign(new Error('Missing path'), { code: 'ENOENT' });
    if (value === options.link || (options.rootAlias && value === root) || (options.ancestorAlias && value === aliasParent)) return link;
    return directory;
  });
  t.mock.method(fs, 'readdirSync', (value) => (value === target || value === canonicalTarget) && options.nestedLink ? ['link'] : []);
  t.mock.method(fs, 'rmSync', (...args) => removals.push(args));
  return { root, canonical, target, canonicalTarget, removals };
}

for (const rootAlias of [false, true]) {
  test(`cleanup accepts an OS temp ${rootAlias ? 'root' : 'ancestor'} alias and pins its real path`, (t) => {
    const { target, canonicalTarget, removals } = fixture(t, { rootAlias, ancestorAlias: !rootAlias });
    removeTempFixture(target, { recursive: true, force: true });
    assert.deepEqual(removals, [[canonicalTarget, { recursive: true, force: true }]]);
  });
}

test('cleanup rejects the temp root and paths outside its lexical boundary', (t) => {
  const { root, removals } = fixture(t);
  for (const value of [root, path.dirname(root), `${root}-outside`, path.join(root, '..', 'outside')]) {
    assert.throws(() => removeTempFixture(value), /outside the allowed root/);
  }
  assert.equal(removals.length, 0);
});

test('cleanup rejects a link or junction beneath the allowed root', (t) => {
  const { root, removals } = fixture(t, { link: path.resolve('virtual-temp-alias', 'tmp', 'linked') });
  assert.throws(() => removeTempFixture(path.join(root, 'linked', 'fixture')), /contains a link/);
  assert.equal(removals.length, 0);
});

test('cleanup rejects a target link', (t) => {
  const { target, removals } = fixture(t, { link: path.resolve('virtual-temp-alias', 'tmp', 'fixture') });
  assert.throws(() => removeTempFixture(target), /contains a link/);
  assert.equal(removals.length, 0);
});

test('cleanup rejects nested links', (t) => {
  const { target, removals } = fixture(t, {
    nestedLink: true,
    link: path.resolve('virtual-temp-alias', 'tmp', 'fixture', 'link')
  });
  assert.throws(() => removeTempFixture(target), /contains a link/);
  assert.equal(removals.length, 0);
});

for (const rootError of ['EACCES', 'ENOENT']) {
  test(`cleanup rejects an unresolved temp root (${rootError})`, (t) => {
    const { target, removals } = fixture(t, { rootError });
    assert.throws(() => removeTempFixture(target), { code: rootError });
    assert.equal(removals.length, 0);
  });
}

test('cleanup rejects unknown state beneath the temp root', (t) => {
  const { target, removals } = fixture(t, { unknown: path.resolve('virtual-temp-alias', 'tmp', 'fixture') });
  assert.throws(() => removeTempFixture(target), { code: 'EACCES' });
  assert.equal(removals.length, 0);
});

test('cleanup tolerates an already missing fixture', (t) => {
  const { target, removals } = fixture(t, { missing: path.resolve('virtual-temp-alias', 'tmp', 'fixture') });
  removeTempFixture(target, { recursive: true, force: true });
  assert.equal(removals.length, 1);
});

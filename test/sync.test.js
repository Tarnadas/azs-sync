import test from 'node:test';
import assert from 'node:assert/strict';

import { decideSync, publicState, validateSave } from '../src/sync.js';

const remote = (version, save) => ({ version, save });

test('no local and no remote is a no-op', () => {
  assert.equal(decideSync({ localSave: null, baseSave: null, remote: null }), 'noop');
  assert.equal(decideSync({ localSave: null, baseSave: null, remote: remote(0, null) }), 'noop');
});

test('first local save is pushed', () => {
  assert.equal(decideSync({ localSave: 'A', baseSave: null, remote: null }), 'push');
  assert.equal(decideSync({ localSave: 'A', baseSave: null, remote: remote(0, null) }), 'push');
});

test('first remote save is pulled', () => {
  assert.equal(decideSync({ localSave: null, baseSave: null, remote: remote(1, 'A') }), 'pull');
});

test('identical saves are a no-op', () => {
  assert.equal(decideSync({ localSave: 'A', baseSave: 'A', remote: remote(1, 'A') }), 'noop');
});

test('local unchanged and remote changed pulls', () => {
  assert.equal(decideSync({ localSave: 'A', baseSave: 'A', remote: remote(2, 'B') }), 'pull');
});

test('remote unchanged and local changed pushes', () => {
  assert.equal(decideSync({ localSave: 'B', baseSave: 'A', remote: remote(1, 'A') }), 'push');
});

test('both changed is a conflict', () => {
  assert.equal(decideSync({ localSave: 'B', baseSave: 'A', remote: remote(2, 'C') }), 'conflict');
});

test('first contact with different saves is a conflict', () => {
  assert.equal(decideSync({ localSave: 'B', baseSave: null, remote: remote(1, 'A') }), 'conflict');
});

test('a deleted local save with a known base can be recovered', () => {
  assert.equal(decideSync({ localSave: null, baseSave: 'A', remote: remote(1, 'A') }), 'pull');
});

test('sealed save validation', () => {
  assert.equal(validateSave('RSE1:abc'), null);
  assert.match(validateSave(''), /empty/);
  assert.match(validateSave('hello'), /sealed/);
  assert.match(validateSave(null), /string/);
  assert.match(validateSave('RSE1:' + 'x'.repeat(70000)), /large/);
});

test('public state has stable empty shape', () => {
  assert.deepEqual(publicState(null), {
    version: 0,
    save: null,
    hash: null,
    updatedAt: null,
    deviceName: null,
  });
});

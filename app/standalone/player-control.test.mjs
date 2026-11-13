import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerControlHub } from './player-control.mjs';

test('player control accepts transport and numeric actions', () => {
  const hub = createPlayerControlHub();
  const toggle = hub.push('toggle');
  assert.equal(toggle.action, 'toggle');
  assert.equal(toggle.seq, 1);

  const seek = hub.push('seek', 42.5);
  assert.equal(seek.seq, 2);
  assert.equal(seek.action, 'seek');
  assert.equal(seek.value, 42.5);
  assert.equal(hub.push('volume', 0.35).value, 0.35);
  assert.equal(hub.push('jump', 3).value, 3);
  assert.equal(hub.push('shuffle', true).value, true);
  assert.equal(hub.push('repeat', 'one').value, 'one');
});

test('player control rejects unknown actions and bad values', () => {
  const hub = createPlayerControlHub();
  assert.equal(hub.push('rm -rf', 1), null);
  assert.equal(hub.push('seek', -1), null);
  assert.equal(hub.push('seek', 'nope'), null);
  assert.equal(hub.push('volume', Infinity), null);
  assert.equal(hub.push('repeat', 'twice'), null);
  assert.equal(hub.push('play', 1).action, 'play');
  assert.equal(hub.seq, 1);
});

test('player control only returns commands newer than the cursor', () => {
  const hub = createPlayerControlHub();
  const first = hub.push('pause');
  const second = hub.push('next');
  assert.deepEqual(hub.pending(first.seq).map(command => command.seq), [second.seq]);
  assert.deepEqual(hub.pending(second.seq), []);
});

test('player control expires old commands but keeps the sequence monotonic', () => {
  let clock = 1000;
  const hub = createPlayerControlHub({ ttl: 5000, now: () => clock });
  const old = hub.push('pause');
  clock += 6000;
  const fresh = hub.push('play');
  assert.deepEqual(hub.pending(0).map(command => command.seq), [fresh.seq]);
  assert.ok(fresh.seq > old.seq);
  clock += 6000;
  assert.deepEqual(hub.pending(0), []);
  assert.ok(hub.push('toggle').seq > fresh.seq);
});

test('player control keeps only the newest commands', () => {
  const hub = createPlayerControlHub({ limit: 2 });
  hub.push('toggle');
  hub.push('next');
  const last = hub.push('prev');
  assert.deepEqual(hub.pending(0).map(command => command.action), ['next', 'prev']);
  assert.equal(hub.seq, 3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { ManagedSession, streamArguments, CAPABILITY } from '../src/managed-session.mjs';

function fixture(options = {}) {
  const child = new EventEmitter(), writes = [];
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, cb) { writes.push(JSON.parse(String(chunk))); cb(); } });
  const session = new ManagedSession(child, { ownedProcess: true, ...options });
  const frame = value => child.stdout.write(JSON.stringify(value) + '\n');
  const init = (overrides = {}) => frame({ event: 'init', conversation_id: 'session-a', init: { permission_mode: 'request-review', ...overrides } });
  const result = (num = 1, overrides = {}) => frame({ event: 'result', result: { conversation_id: 'session-a', status: 'SUCCESS', num_turns: num, ...overrides } });
  const agent = (text = 'AGENT untrusted test') => session.withExclusiveInputLease(lease => lease.safe ? session.submit({ model_input: text, lease }) : { blocked: true });
  return { child, writes, session, frame, init, result, agent };
}

test('arguments preserve permission policy; no real CLI certification is claimed', () => {
  assert.deepEqual(streamArguments(), ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert(!streamArguments({ model: 'example-model' }).some(arg => arg.includes('skip-permissions')));
  assert.throws(() => streamArguments({ model: '--model=x\n--dangerously-skip-permissions' }));
  assert.equal(CAPABILITY.certified_mode, 'unsupported'); assert.equal(CAPABILITY.tested_cli_version, null);
  assert.throws(() => new ManagedSession({}), /exclusive_process_required/);
});

test('one native process identity, serial result boundary and model unknown/observed', async () => {
  const f = fixture(); assert.equal(f.session.canAcceptAgentInput, false); assert.equal(f.session.model.source, 'unknown');
  f.init({ model: 'chosen-model' }); assert.equal(f.session.nativeSessionId, 'session-a'); assert.equal(f.session.model.source, 'observed');
  const first = f.agent(); assert.equal(f.writes.length, 1); assert.equal(f.session.state, 'busy');
  assert.deepEqual(await f.agent('second'), { blocked: true });
  f.frame({ event: 'step_update', step_update: { conversation_id: 'session-a', state: 'ACTIVE', step_type: 'tool' } });
  assert.equal(f.writes.length, 1); assert.equal(f.session.canAcceptAgentInput, false);
  f.result(2); const receipt = await first; assert.equal(receipt.receipt_id, 'session-a:2'); assert.equal(receipt.action_success, 'unknown');
  const second = f.agent('second'); f.result(3); await second; assert.equal(f.writes.length, 2);
});

test('human draft, approval hold and abort pause block agent input without consuming yes', async () => {
  const f = fixture(); f.init();
  f.session.setHumanDraft(true); assert.deepEqual(await f.agent('yes'), { blocked: true });
  f.session.setHumanDraft(false); f.session.holdForHuman(); assert.deepEqual(await f.agent('yes'), { blocked: true });
  f.session.releaseHumanHold(); f.session.pauseAfterHumanAbort(); assert.deepEqual(await f.agent('yes'), { blocked: true });
  assert.equal(f.writes.length, 0);
  f.session.resumeByOperator(); const p = f.agent('AGENT: yes'); f.result(); await p;
  assert.equal(f.writes[0].message.content, 'AGENT: yes'); assert.equal(f.writes[0].event, 'user');
});

test('single-owner arbiter closes idle-check race and still checks a new human hold', async () => {
  const f = fixture(); f.init();
  const p = f.session.withExclusiveInputLease(async lease => {
    assert.equal(lease.safe, true);
    assert.throws(() => f.session.submitHuman('human'), /unsafe_human_boundary/);
    f.session.setHumanDraft(true);
    const rejected = f.session.submit({ model_input: 'AGENT: one', lease });
    assert.deepEqual(rejected, { accepted: false, definitely_not_accepted: true });
  }); await p; assert.equal(f.writes.length, 0);
  f.session.setHumanDraft(false); const human = f.session.submitHuman('human first');
  assert.deepEqual(await f.agent(), { blocked: true }); f.result(); await human;
});

test('pipe write is not acceptance; exit zero cannot fake accepted action', async () => {
  const f = fixture(); f.init(); const p = f.agent();
  let settled = false; p.finally(() => { settled = true; }).catch(() => {});
  await Promise.resolve(); assert.equal(settled, false);
  f.child.emit('exit', 0);
  await assert.rejects(p, error => error.code === 'process_exited' && error.uncertain);
  assert.equal(f.session.canAcceptAgentInput, false);
});

for (const [name, invalid] of [
  ['wrong session', f => f.result(1, { conversation_id: 'session-b' })],
  ['native error', f => f.result(1, { status: 'ERROR' })],
  ['bad JSON', f => f.child.stdout.write('{bad}\n')],
  ['unknown event', f => f.frame({ event: 'control_request' })],
  ['oversized frame', f => f.child.stdout.write('x'.repeat(1025))],
  ['partial frame', f => { f.child.stdout.write('{'); f.child.stdout.end(); }],
]) test(`${name} fails closed and leaves acceptance uncertain`, async () => {
  const f = fixture({ maxFrameBytes: 1024 }); f.init(); const p = f.agent(); invalid(f);
  await assert.rejects(p, error => error.uncertain === true);
  assert.equal(f.session.state, 'closed'); assert.deepEqual(await f.agent(), { blocked: true });
});

test('permissive or duplicate init fails closed; no permission replies or terminal commands', () => {
  const f = fixture(); f.init({ permission_mode: 'always-proceed' }); assert.equal(f.session.state, 'closed');
  assert.equal(f.writes.length, 0);
  const g = fixture(); g.init(); g.init(); assert.equal(g.session.state, 'closed');
});

test('UTF-8 split frames are decoded without changing model identity', () => {
  const f = fixture(); const text = Buffer.from(JSON.stringify({ event: 'init', conversation_id: 'session-a', init: { permission_mode: 'request-review', model: 'mødel' } }) + '\n');
  const pos = text.indexOf(Buffer.from('ø')) + 1;
  f.child.stdout.write(text.subarray(0, pos)); f.child.stdout.write(text.subarray(pos));
  assert.equal(f.session.model.id, 'mødel');
});

test('invalid UTF-8 closes the native protocol instead of changing its content', () => {
  const f = fixture(); f.child.stdout.write(Buffer.from([0xc0, 0xaf]));
  assert.equal(f.session.state, 'closed'); assert.equal(f.writes.length, 0);
});

test('graceful close rejects a pending turn as uncertain without abort or replay', async () => {
  const f = fixture(); f.init(); const pending = f.agent(); f.session.close();
  await assert.rejects(pending, error => error.uncertain && error.code === 'session_closed');
  assert.equal(f.session.state, 'closed'); assert.equal(f.writes.length, 1);
});

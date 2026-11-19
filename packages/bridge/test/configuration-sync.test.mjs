import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, lstat, readlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBridgeClient } from '../src/client.mjs';

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
function configuration(revision = 1, ids = ['research']) {
  return { revision, role: { name: 'Reviewer', prompt: 'Review sources.', summary: 'Reviewer' }, role_prompt: 'Review sources.\n\nStay in scope.', role_summary: 'Reviewer', instructions: 'Stay in scope.', permissions: { file_read: true, external_send: false }, allowed_actions: ['file_read'], skills: ids.map(id => ({ source: 'bundled', id, version: '1.0.0', name: id, content: `# ${id}\nRevision ${revision}\n`, sha256: sha(`# ${id}\nRevision ${revision}\n`) })) };
}
async function fixture(options = {}) {
  const skillsDirectory = await mkdtemp(path.join(tmpdir(), 'muse-node-sync-'));
  await mkdir(path.join(skillsDirectory, 'manual'));
  await writeFile(path.join(skillsDirectory, 'manual', 'SKILL.md'), '# Hand-written\n');
  const state = { configuration: configuration(), hint: 1, calls: [], failStaged: false, failApplied: false, ...options };
  const client = createBridgeClient({ baseUrl: 'https://muse.example', agentKey: 'fixture-key', skillsDirectory, fetchImpl: async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ pathname, body });
    if (pathname === '/api/agents/heartbeat') return new Response(JSON.stringify({ ok: true, ...(state.hint ? { configuration: { revision: state.hint } } : {}) }));
    if (pathname === '/api/agents/me/configuration') return state.configuration ? new Response(JSON.stringify({ configuration: state.configuration })) : new Response(null, { status: 204 });
    if (pathname === '/api/agents/me/configuration/ack') {
      if ((body.status === 'staged' && state.failStaged) || (body.status === 'applied' && state.failApplied)) return new Response(JSON.stringify({ error: { message: 'Retry later' } }), { status: 409 });
      return new Response(JSON.stringify({ ok: true, revision: body.revision, status: body.status }));
    }
    throw new Error(`Unexpected request: ${pathname}`);
  } });
  return { client, state, skillsDirectory };
}
async function current(skillsDirectory) {
  const base = path.join(skillsDirectory, 'muse-managed');
  const namespaces = (await readdir(base)).filter(name => /^[a-f0-9]{64}$/.test(name));
  assert.equal(namespaces.length, 1);
  const namespace = path.join(base, namespaces[0]);
  assert.equal((await lstat(path.join(namespace, 'current'))).isSymbolicLink(), true);
  const target = await readlink(path.join(namespace, 'current'));
  assert.match(target, /^revision-\d+-[a-f0-9-]+$/);
  const snapshot = path.join(namespace, target);
  return { namespace, snapshot, configuration: JSON.parse(await readFile(path.join(snapshot, 'configuration.json'), 'utf8')) };
}
const acks = state => state.calls.filter(c => c.pathname.endsWith('/ack')).map(c => c.body.status);

test('legacy heartbeat and unconfigured pull leave all skill files untouched', async () => {
  const f = await fixture({ hint: 0, configuration: null });
  assert.deepEqual(await f.client.heartbeat(), { ok: true });
  assert.equal(f.state.calls.length, 1);
  assert.equal((await f.client.syncConfiguration()).status, 'unconfigured');
  assert.deepEqual(await readdir(f.skillsDirectory), ['manual']);
});

test('startup pulls a resolved bundle, stages then atomically publishes skills and role/actions', async () => {
  const f = await fixture();
  const result = await f.client.syncConfiguration();
  assert.equal(result.status, 'applied');
  assert.deepEqual(acks(f.state), ['staged', 'applied']);
  const installed = await current(f.skillsDirectory);
  assert.equal(await readFile(path.join(installed.snapshot, 'bundled-research', 'SKILL.md'), 'utf8'), f.state.configuration.skills[0].content);
  assert.equal(installed.configuration.role_prompt, f.state.configuration.role_prompt);
  assert.deepEqual(installed.configuration.allowed_actions, ['file_read']);
  assert.equal(await readFile(path.join(f.skillsDirectory, 'manual', 'SKILL.md'), 'utf8'), '# Hand-written\n');
});

test('heartbeat syncs changed revisions only and removed skills disappear from current snapshot', async () => {
  const f = await fixture();
  await f.client.heartbeat();
  const first = await current(f.skillsDirectory);
  const count = f.state.calls.length;
  await f.client.heartbeat();
  assert.equal(f.state.calls.length, count + 1);
  f.state.hint = 2; f.state.configuration = configuration(2, ['debug']);
  await f.client.heartbeat();
  const second = await current(f.skillsDirectory);
  assert.notEqual(second.snapshot, first.snapshot);
  assert.deepEqual((await readdir(second.snapshot)).sort(), ['bundled-debug', 'configuration.json']);
  assert.equal(await readFile(path.join(first.snapshot, 'bundled-research', 'SKILL.md'), 'utf8'), configuration().skills[0].content);
  assert.equal(await readFile(path.join(f.skillsDirectory, 'manual', 'SKILL.md'), 'utf8'), '# Hand-written\n');
});

test('bad hash, traversal IDs, duplicate IDs and unknown action grants fail without writing', async () => {
  for (const mutate of [c => { c.skills[0].sha256 = '0'.repeat(64); }, c => { c.skills[0].id = '../../outside'; }, c => { c.skills.push(c.skills[0]); }, c => { c.allowed_actions.push('unknown_grant'); }]) {
    const f = await fixture(); mutate(f.state.configuration);
    await f.client.heartbeat();
    assert.deepEqual(acks(f.state), ['failed']);
    assert.deepEqual(await readdir(f.skillsDirectory), ['manual']);
  }
});

test('staged ACK failure retains the old current snapshot', async () => {
  const f = await fixture(); await f.client.heartbeat();
  const first = await current(f.skillsDirectory);
  f.state.configuration = configuration(2); f.state.hint = 2; f.state.failStaged = true;
  await f.client.heartbeat();
  assert.equal((await current(f.skillsDirectory)).snapshot, first.snapshot);
  assert.equal(acks(f.state).at(-1), 'failed');
});

test('applied ACK failure retries ACK only, never regresses to failed or rewrites skills', async () => {
  const f = await fixture({ failApplied: true }); await f.client.heartbeat();
  const first = await current(f.skillsDirectory);
  f.state.failApplied = false; await f.client.heartbeat();
  assert.equal((await current(f.skillsDirectory)).snapshot, first.snapshot);
  assert.deepEqual(acks(f.state), ['staged', 'applied', 'applied']);
  assert.equal(f.state.calls.filter(c => c.pathname === '/api/agents/me/configuration').length, 1);
});

test('a manually-created managed directory and a symlinked skills root are never adopted', async () => {
  const f = await fixture(); await mkdir(path.join(f.skillsDirectory, 'muse-managed'));
  await writeFile(path.join(f.skillsDirectory, 'muse-managed', 'manual.txt'), 'keep');
  await f.client.heartbeat();
  assert.deepEqual(acks(f.state), ['failed']);
  assert.equal(await readFile(path.join(f.skillsDirectory, 'muse-managed', 'manual.txt'), 'utf8'), 'keep');
  const target = await mkdtemp(path.join(tmpdir(), 'muse-node-target-'));
  const link = path.join(f.skillsDirectory, 'linked'); await symlink(target, link, 'dir');
  const linkedClient = createBridgeClient({ baseUrl: 'https://muse.example', agentKey: 'fixture-key', skillsDirectory: link, fetchImpl: async url => new Response(JSON.stringify(new URL(url).pathname.endsWith('/ack') ? { ok: true } : { configuration: configuration() })) });
  assert.equal((await linkedClient.syncConfiguration()).status, 'failed');
  assert.deepEqual(await readdir(target), []);
});

test('concurrent heartbeats use a single sync and a restart reuses a verified snapshot', async () => {
  const f = await fixture(); await Promise.all([f.client.heartbeat(), f.client.heartbeat()]);
  assert.deepEqual(acks(f.state), ['staged', 'applied']);
  const first = await current(f.skillsDirectory);
  const restarted = createBridgeClient({ baseUrl: 'https://muse.example', agentKey: 'fixture-key', skillsDirectory: f.skillsDirectory, fetchImpl: async (url, init) => new Response(JSON.stringify(new URL(url).pathname.endsWith('/ack') ? { ok: true } : { configuration: f.state.configuration })) });
  assert.equal((await restarted.syncConfiguration()).status, 'applied');
  assert.equal((await current(f.skillsDirectory)).snapshot, first.snapshot);
});

test('404 configuration endpoint is compatible with older hubs', async () => {
  const skillsDirectory = await mkdtemp(path.join(tmpdir(), 'muse-node-legacy-'));
  const client = createBridgeClient({ baseUrl: 'https://muse.example', agentKey: 'fixture-key', skillsDirectory, fetchImpl: async () => new Response('missing', { status: 404 }) });
  assert.equal((await client.syncConfiguration()).status, 'unconfigured');
  assert.deepEqual(await readdir(skillsDirectory), []);
});

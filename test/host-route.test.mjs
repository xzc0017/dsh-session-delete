/**
 * Route-level test for the Host half: `node test/host-route.test.mjs`.
 * Drives the registered handler with fake request/response objects and a fake
 * Context: wrong DSH_HOME, live parking, cold deletion, already-gone cleanup,
 * and the rule that a failed delete must not detach the Session.
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-session-delete-route-'))
const home = path.join(root, 'real-home')
const wrongHome = path.join(root, 'wrong-home')
await fs.mkdir(wrongHome, { recursive: true })
// Every home candidate stays inside the fixture: the real ~/.dsh is never probed.
process.env.DSH_HOME = wrongHome
process.env.DSH_PROFILE_DIR = path.join(home, 'profiles', 'desktop')
process.env.USERPROFILE = path.join(root, 'user')
process.env.HOME = path.join(root, 'user')
process.env.APPDATA = path.join(root, 'appdata')
process.env.LOCALAPPDATA = path.join(root, 'localdata')

const coldId = 'ab56a86f-3508-4496-bacb-915d5ccaeef2'
const liveId = 'live-probe-0001'
const ghostId = 'orphan-probe-0002'
const events = []
const detached = []
const archived = new Set()
const workspace = {
  id: 'ws-1',
  sessionIds: [coldId, liveId, ghostId],
  detachSession: async (id) => { events.push('detach:' + id); detached.push(id) },
}
const registry = {
  list: () => [workspace],
  archiveSession: async (id) => { events.push('archive:' + id); archived.add(id) },
  unarchiveSession: async (id) => { events.push('unarchive:' + id); archived.delete(id) },
  unpinSession: async () => { events.push('unpin') },
}
let liveAgent
const ctx = {
  webServer: {
    register(route) {
      ctx.route = route
      return () => {}
    },
  },
  effect(fn) { fn() },
  get(name) {
    if (name === 'workspaceRegistry') return registry
    if (name === 'agents') return { get: (id) => (id === liveId ? liveAgent : undefined) }
    return undefined
  },
  logger: { info() {}, warn() {} },
}
apply(ctx)
assert.equal(ctx.route.path, '/dsh-session-delete/delete')

async function call(method, body) {
  const req = {
    method,
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield Buffer.from(body, 'utf8')
    },
  }
  const captured = { status: 0, body: '' }
  const res = {
    writeHead(status) { captured.status = status },
    end(text) { captured.body = text },
  }
  await ctx.route.handler(req, res)
  return { status: captured.status, body: captured.body.length > 0 ? JSON.parse(captured.body) : null }
}

assert.equal((await call('GET', '')).status, 405)
assert.equal((await call('POST', 'not json')).status, 400)
assert.equal((await call('POST', JSON.stringify({ sessionId: '../escape' }))).status, 400)

// A session whose log is already gone still finishes: archived (to hide the
// stale row) and detached, answering ok instead of a dead-end error.
const ghost = await call('POST', JSON.stringify({ sessionId: ghostId }))
assert.equal(ghost.status, 200)
assert.equal(ghost.body.alreadyGone, true)
assert.ok(archived.has(ghostId))
assert.ok(detached.includes(ghostId))

const cwdDir = path.join(home, 'sessions', '--C-Users-test-project--')
const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')
await fs.mkdir(cacheDir, { recursive: true })
for (const id of [coldId, liveId]) {
  await fs.mkdir(path.join(cwdDir, id), { recursive: true })
  await fs.writeFile(path.join(cwdDir, id, 'session.v4.jsonl.zstd'), 'log')
  await fs.writeFile(path.join(cacheDir, id + '.json'), '{}')
}

liveAgent = { id: liveId }
const live = await call('POST', JSON.stringify({ sessionId: liveId }))
assert.equal(live.status, 200)
assert.equal(live.body.live, true)
assert.ok(live.body.trashed.length >= 1, 'a live session is parked, not unlinked')
assert.ok(archived.has(liveId), 'archive happens before deletion so the row hides')
await assert.rejects(fs.stat(path.join(cwdDir, liveId)))

const ok = await call('POST', JSON.stringify({ sessionId: coldId }))
assert.equal(ok.status, 200)
assert.equal(ok.body.ok, true)
assert.equal(ok.body.live, false)
assert.equal(ok.body.removed.length, 1)
assert.deepEqual(ok.body.detached, ['ws-1'])
assert.ok(archived.has(coldId))
await assert.rejects(fs.stat(path.join(cwdDir, coldId)))
await assert.rejects(fs.stat(path.join(cacheDir, coldId + '.json')))

// Archive is written before the delete attempt, so a refusal can roll it back.
const archiveIndex = events.indexOf('archive:' + coldId)
assert.ok(archiveIndex >= 0)
assert.ok(events.indexOf('detach:' + coldId) > archiveIndex)

await fs.rm(root, { recursive: true, force: true })
console.log('host route test passed')

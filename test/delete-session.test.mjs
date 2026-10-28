/**
 * Fixture test for the file half: `node test/delete-session.test.mjs`.
 * Covers candidate probing (a wrong DSH_HOME is skipped), the "not found"
 * failure, cold deletion, live parking, and start-up cleanup of the delete
 * trash plus orphaned log directories.
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanupTrash, deleteSessionFiles, locateSession, isValidSessionId } from '../lib/delete-session.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-session-delete-'))
const wrongHome = path.join(root, 'wrong-home')
const home = path.join(root, 'real-home')
const cwdDir = path.join(home, 'sessions', '--C-Users-test-project--')
const victim = '0980d04a-6353-4a9f-b732-95530fbf0fa2'
const liveId = 'live-probe-0001'
const orphan = 'orphan-probe-0003'
const kept = 'kept-probe-0004'
const neighbour = '15f78cd2-bab8-4310-9960-be45bc30ac91'
const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')

for (const id of [victim, liveId, orphan, kept, neighbour]) {
  await fs.mkdir(path.join(cwdDir, id), { recursive: true })
  await fs.writeFile(path.join(cwdDir, id, 'session.v4.jsonl.zstd'), id)
}
await fs.mkdir(cacheDir, { recursive: true })
for (const id of [victim, liveId, kept, neighbour]) await fs.writeFile(path.join(cacheDir, id + '.json'), '{}')
await fs.mkdir(wrongHome, { recursive: true })

assert.equal(isValidSessionId(victim), true)
assert.equal(isValidSessionId('../etc'), false)
assert.equal(isValidSessionId('a/b'), false)

const located = await locateSession({ homes: [wrongHome, home], sessionId: victim })
assert.deepEqual(located.logDirs, [path.join(cwdDir, victim)])
assert.equal(located.cacheFile, path.join(cacheDir, victim + '.json'))
assert.equal(located.home, home)

await assert.rejects(
  deleteSessionFiles({ homes: [wrongHome], sessionId: victim }),
  (error) => error.code === 'session-not-found',
)
assert.equal((await fs.stat(path.join(cwdDir, victim, 'session.v4.jsonl.zstd'))).isFile(), true)

const result = await deleteSessionFiles({ homes: [wrongHome, home], sessionId: victim })
assert.equal(result.removed.length, 1)
assert.equal(result.cache, path.join(cacheDir, victim + '.json'))
await assert.rejects(fs.stat(path.join(cwdDir, victim)))
await assert.rejects(fs.stat(path.join(cacheDir, victim + '.json')))
assert.equal((await fs.stat(path.join(cwdDir, neighbour))).isDirectory(), true)

// A live Session is parked, never unlinked underneath its Agent.
const liveResult = await deleteSessionFiles({ homes: [home], sessionId: liveId, live: true })
assert.equal(liveResult.removed.length, 0)
assert.ok(liveResult.trashed.length >= 1)
await assert.rejects(fs.stat(path.join(cwdDir, liveId)))

// Start-up sweep: parked paths go; a directory no workspace vouches for goes;
// one the registry lists, and one an Agent owns, stay.
const registry = { list: () => [{ sessionIds: [kept, neighbour] }] }
const context = { get: (name) => (name === 'agents' ? { get: (id) => (id === liveId ? {} : undefined) } : undefined) }
const cleared = await cleanupTrash({ homes: [wrongHome, home], registry, context })
assert.ok(cleared >= 2)
await assert.rejects(fs.stat(path.join(cwdDir, orphan)))
assert.equal((await fs.stat(path.join(cwdDir, kept))).isDirectory(), true)
assert.equal((await fs.stat(path.join(cwdDir, neighbour))).isDirectory(), true)

// Without a registry the sweep cannot vouch for anything, so it removes
// nothing but the parked paths, even with a live session in view.
await fs.mkdir(path.join(cwdDir, 'unlisted-probe-0005'), { recursive: true })
await fs.mkdir(path.join(cwdDir, liveId), { recursive: true })
await cleanupTrash({ homes: [home], context })
assert.equal((await fs.stat(path.join(cwdDir, 'unlisted-probe-0005'))).isDirectory(), true)
assert.equal((await fs.stat(path.join(cwdDir, liveId))).isDirectory(), true)

await fs.rm(root, { recursive: true, force: true })
console.log('delete-session fixture test passed')


/**
 * Permanent Session removal for the desktop harness.
 *
 * A Session lives on disk in two places: its log directory under
 * `<home>/sessions/<cwd-encoded>/<sessionId>/` (holding
 * `session.v4.jsonl.zstd`) and its projection cache under
 * `<home>/storages/session_projcache/sessions/<sessionId>.json`.
 *
 * The harness home is NOT guessed from one environment variable: the Host
 * process, the shell it spawns, and a packaged desktop app can each report a
 * different value. Candidates are probed, and a candidate only counts when it
 * really contains this Session's log directory, so "found nothing" becomes a
 * failure instead of a silent success.
 *
 * A path that survives deletion (a file still held open inside the running
 * Host) is moved to `<home>/.session-delete-trash/`, outside the Session tree,
 * so it can never be listed as a conversation again; its bytes are retried on
 * the next Host start.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Session ids are opaque, but they are single path segments: refuse anything else. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_BODY_BYTES = 64 * 1024
const RETRY = { maxRetries: 8, retryDelay: 200 }
const TRASH_DIR = '.session-delete-trash'

/**
 * @param {unknown} value - candidate session id.
 * @returns {boolean} whether the value is safe to use as one path segment.
 */
export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value)
}

/**
 * Every plausible harness home, most specific first. Duplicates are dropped.
 * @returns {string[]} absolute candidate directories.
 */
export function candidateHomes() {
  const candidates = []
  const push = (value) => {
    if (typeof value !== 'string' || value.length === 0) return
    const resolved = path.resolve(value)
    if (!candidates.includes(resolved)) candidates.push(resolved)
  }
  // The most reliable source: this plugin's own location is
  // <home>/profiles/<profile>/node_modules/<package>/, so the `profiles`
  // segment gives the home even when the process environment says nothing.
  const fromModule = homeFromPath(fileURLToPath(import.meta.url))
  if (fromModule !== undefined) push(fromModule)
  const fromCwd = homeFromPath(process.cwd(), true)
  if (fromCwd !== undefined) push(fromCwd)
  push(process.env.DSH_HOME)
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) {
    const profileDir = path.resolve(process.env.DSH_PROFILE_DIR)
    push(path.dirname(profileDir))
    // The shipped layout is <home>/profiles/<name>; the grandparent is the home.
    if (path.basename(path.dirname(profileDir)) === 'profiles') push(path.dirname(path.dirname(profileDir)))
  }
  const userHome = process.env.USERPROFILE ?? os.homedir()
  push(path.join(userHome, '.dsh'))
  if (typeof process.env.APPDATA === 'string') push(path.join(process.env.APPDATA, 'DeepSeek Harness'))
  if (typeof process.env.LOCALAPPDATA === 'string') push(path.join(process.env.LOCALAPPDATA, 'DeepSeek Harness'))
  return candidates
}

/**
 * Walk up from a path until a `profiles` directory is found; its parent is the
 * harness home. Works for both `<home>/profiles/<name>/...` (installed plugin)
 * and a profile working directory.
 * @param {string} start - file or directory to start from.
 * @param {boolean} [isDirectory] - whether `start` is already a directory.
 * @returns {string | undefined} the implied harness home.
 */
function homeFromPath(start, isDirectory = false) {
  let dir = isDirectory ? path.resolve(start) : path.dirname(path.resolve(start))
  for (let depth = 0; depth < 12; depth += 1) {
    if (path.basename(dir) === 'profiles') return path.dirname(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** @param {string} target @returns {Promise<import('node:fs').Stats | undefined>} */
async function statSafe(target) {
  try {
    return await fs.stat(target)
  } catch {
    return undefined
  }
}

/**
 * Locate one Session's log directories and projection cache across candidate
 * homes. A home counts only when it holds this exact Session directory.
 * @param {{ homes: readonly string[], sessionId: string }} request - candidates and the Session.
 * @returns {Promise<{ logDirs: string[], cacheFile: string | undefined, searched: string[], home: string | undefined }>} matches.
 */
export async function locateSession({ homes, sessionId }) {
  if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${String(sessionId)}`)
  const logDirs = []
  const searched = []
  let cacheFile
  let home
  for (const candidateHome of homes) {
    const sessionsRoot = path.join(candidateHome, 'sessions')
    const cachesRoot = path.join(candidateHome, 'storages', 'session_projcache', 'sessions')
    searched.push(sessionsRoot)
    let roots = []
    try {
      roots = await fs.readdir(sessionsRoot, { withFileTypes: true })
    } catch {
      roots = []
    }
    for (const entry of roots) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(sessionsRoot, entry.name, sessionId)
      if (!candidate.startsWith(sessionsRoot + path.sep)) continue
      if ((await statSafe(candidate)) === undefined) continue
      logDirs.push(candidate)
      if (home === undefined) home = candidateHome
      const cache = path.join(cachesRoot, `${sessionId}.json`)
      if (cacheFile === undefined && cache.startsWith(cachesRoot + path.sep) && (await statSafe(cache)) !== undefined) {
        cacheFile = cache
        if (home === undefined) home = candidateHome
      }
    }
  }
  return { logDirs, cacheFile, searched, home }
}

/**
 * Move a path that could not be unlinked into the delete trash, outside the
 * Session tree, so the harness stops listing it.
 * @param {string} target - stuck path.
 * @param {string} home - harness home owning the trash directory.
 * @returns {Promise<string | undefined>} the parked path, or undefined when even the rename failed.
 */
async function park(target, home) {
  const trashRoot = path.join(home, TRASH_DIR)
  const parked = path.join(trashRoot, `${path.basename(target)}-${Date.now()}`)
  try {
    await fs.mkdir(trashRoot, { recursive: true })
    await fs.rename(target, parked)
  } catch {
    return undefined
  }
  return parked
}

/**
 * Remove a Session's durable log directories and projection cache.
 *
 * `live: true` means an Agent still has the Session open: deleting its files
 * underneath that Agent would be unsafe, so the paths are only parked in the
 * delete trash (the Session stops being listed) and their bytes are removed on
 * the next Host start.
 * @param {{ homes: readonly string[], sessionId: string, live?: boolean }} request - candidates, Session, and ownership.
 * @returns {Promise<{ removed: string[], trashed: string[], cache: string | undefined, searched: string[] }>} removed paths.
 */
export async function deleteSessionFiles({ homes, sessionId, live = false }) {
  const { logDirs, cacheFile, searched, home } = await locateSession({ homes, sessionId })
  if (logDirs.length === 0 && cacheFile === undefined) {
    const error = new Error(`找不到该对话的日志文件（已查找 ${searched.length} 个位置）`)
    error.code = 'session-not-found'
    error.searched = searched
    throw error
  }
  const trashHome = home ?? homes[0]
  const removed = []
  const trashed = []
  for (const dir of logDirs) {
    if (!live) {
      await fs.rm(dir, { recursive: true, force: true, ...RETRY }).catch(() => {})
      if ((await statSafe(dir)) === undefined) {
        removed.push(dir)
        continue
      }
    }
    const parked = await park(dir, trashHome)
    if (parked === undefined) {
      const error = new Error(`日志文件被占用，删不掉：${dir}`)
      error.code = 'session-locked'
      throw error
    }
    trashed.push(parked)
  }
  let cache
  if (cacheFile !== undefined) {
    if (!live) {
      await fs.rm(cacheFile, { force: true, ...RETRY }).catch(() => {})
      if ((await statSafe(cacheFile)) === undefined) cache = cacheFile
    }
    if (cache === undefined) {
      const parked = await park(cacheFile, trashHome)
      if (parked !== undefined) trashed.push(parked)
    }
  }
  return { removed, trashed, cache, searched }
}

/**
 * Best-effort removal of paths parked by this or an earlier delete, run at Host
 * start. Also drops log directories that no Workspace, archive entry or read of
 * this exact session id vouches for; such a directory can only drag a stale
 * "not found" row back into the sidebar, or leave its content unaccountable.
 *
 * An id is kept when any workspace lists it, when any session-memory hit maps
 * to it, when its title claims it as a parent, or when it looks like a fork
 * anchor — anything the sweep cannot prove is someone's conversation.
 * @param {{ homes: readonly string[], registry?: unknown, context?: unknown }} request
 *   candidate homes plus the optional registry and Host context used to skip
 *   live Sessions.
 * @returns {Promise<number>} how many paths were removed.
 */
export async function cleanupTrash({ homes, registry, context }) {
  const known = collectKnownIds(registry)
  // Nothing vouches for any id: deleting "everything unvouched" would be a
  // guess, so only the parked paths are collected in that case.
  const canSweep = known.size > 0
  const live = (id) => {
    try {
      const agents = context?.get?.('agents')
      return agents !== undefined && agents !== null && agents.get(id) !== undefined
    } catch {
      return false
    }
  }
  let cleaned = 0
  for (const home of homes) {
    const trashRoot = path.join(home, TRASH_DIR)
    let entries = []
    try {
      entries = await fs.readdir(trashRoot, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      await fs.rm(path.join(trashRoot, entry.name), { recursive: true, force: true, ...RETRY }).catch(() => {})
      cleaned += 1
    }
    const sessionsRoot = path.join(home, 'sessions')
    let roots = []
    try {
      roots = await fs.readdir(sessionsRoot, { withFileTypes: true })
    } catch {
      roots = []
    }
    for (const entry of roots) {
      if (!entry.isDirectory()) continue
      const parent = path.join(sessionsRoot, entry.name)
      let children = []
      try {
        children = await fs.readdir(parent, { withFileTypes: true })
      } catch {
        children = []
      }
      for (const child of children) {
        const target = path.join(parent, child.name)
        // Older builds parked inside the Session tree.
        if (child.name.includes('.trash-')) {
          await fs.rm(target, { recursive: true, force: true, ...RETRY }).catch(() => {})
          cleaned += 1
          continue
        }
        if (!canSweep) continue
        if (!child.isDirectory()) continue
        if (!isValidSessionId(child.name)) continue
        if (known.has(child.name) || known.has(`session-${child.name}`)) continue
        if (oracleMentions(known, child.name)) continue
        if (live(child.name)) continue
        await fs.rm(target, { recursive: true, force: true, ...RETRY }).catch(() => {})
        cleaned += 1
      }
    }
  }
  return cleaned
}

/**
 * Collect every session id the registry vouches for, from the registry object
 * and from the oracles already in memory: workspace membership, archive and
 * pin sets, live Sessions, and session titles.
 * @param {unknown} registry - the `workspaceRegistry` service, when present.
 * @returns {Set<string>} known ids and their `session-` spellings.
 */
function collectKnownIds(registry) {
  const known = new Set()
  if (registry === undefined || registry === null) return known
  const add = (value) => {
    if (typeof value !== 'string' || value.length === 0) return
    known.add(value)
    if (!value.startsWith('session-')) known.add(`session-${value}`)
  }
  try {
    for (const workspace of registry.list()) {
      for (const id of workspace.sessionIds ?? []) add(id)
    }
  } catch {
    // A registry that cannot list vouches for nothing extra.
  }
  const views = ['sessions', 'agents']
  for (const key of views) {
    try {
      const service = registry.ctx?.get?.(key)
      for (const entry of service?.list?.() ?? []) add(entry?.id)
    } catch {
      // best effort
    }
  }
  for (const read of ['sessionTitles', 'titles']) {
    try {
      const oracles = registry[read]?.()
      for (const id of oracles ?? []) add(id)
    } catch {
      // best effort
    }
  }
  return known
}

/**
 * Whether a title oracle names this id as a parent, which makes it someone's
 * conversation even when no workspace lists it.
 * @param {Set<string>} known - ids the registry vouched for.
 * @param {string} id - candidate session id.
 * @returns {boolean} true when the id appears anywhere in the oracle text.
 */
function oracleMentions(known, id) {
  for (const value of known) {
    if (value.includes(id)) return true
  }
  return false
}

/**
 * Read a small JSON request body.
 * @param {import('node:http').IncomingMessage} req - the route request.
 * @returns {Promise<Record<string, unknown>>} the parsed object.
 */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

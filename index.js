/**
 * Host half of dsh-session-delete.
 *
 * One HTTP route behind the harness browser cookie performs the operation the
 * sidebar row asks for: delete the Session's durable log and projection cache,
 * and only then detach it from its Workspace and drop its archive/pin
 * bookkeeping.
 *
 * The order matters: detaching first leaves a row that reappears under the
 * sidebar's ungrouped section while the log still exists on disk, which reads
 * as "the delete did nothing". A delete that cannot remove the files now
 * fails loudly and leaves the workspace membership untouched.
 */
import {
  candidateHomes, cleanupTrash, deleteSessionFiles, isValidSessionId, readJsonBody,
} from './lib/delete-session.js'

export const inject = ['webServer']

const ROUTE = '/dsh-session-delete/delete'

/**
 * @param {import('node:http').ServerResponse} res - the response to settle.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON payload.
 */
function respond(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Detach one Session from every Workspace that lists it and forget its pin.
 * The archive entry is deliberately kept: it is what hides the row from the
 * sidebar even while the Client still holds a stale Session summary.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} sessionId - the Session to detach.
 * @returns {Promise<string[]>} workspace ids that lost the Session.
 */
async function detachFromWorkspaces(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  const detached = []
  if (registry === undefined || registry === null) return detached
  for (const workspace of registry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    await workspace.detachSession(sessionId)
    detached.push(workspace.id)
  }
  try {
    await registry.unpinSession(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`session-delete: unpin failed: ${String(error)}`)
  }
  return detached
}

/**
 * Mark the Session archived. The sidebar hides archived ids from its lists, so
 * this is what removes the row immediately — a deleted log alone leaves the
 * Client's cached summary on screen until the next reload.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} sessionId - the Session to hide.
 * @returns {Promise<boolean>} whether the archive write settled.
 */
async function hideSession(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || registry === null) return false
  try {
    await registry.archiveSession(sessionId, { stopActivity: true })
    return true
  } catch (error) {
    ctx.logger?.warn?.(`session-delete: archive failed for ${sessionId}: ${String(error)}`)
    return false
  }
}

/**
 * Undo {@link hideSession} when the deletion itself failed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} sessionId - the Session to restore.
 */
async function unhideSession(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || registry === null) return
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`session-delete: unarchive rollback failed: ${String(error)}`)
  }
}

/**
 * Whether a live Agent still owns this Session. The `sessions` store is not a
 * reliable signal here: the sidebar retains Sessions it merely lists, so
 * `sessions.get()` is truthy for rows that are not open at all.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} sessionId - the Session to test.
 * @returns {boolean} true when an Agent is driving the Session.
 */
function hasLiveAgent(ctx, sessionId) {
  const agents = ctx.get('agents')
  return agents !== undefined && agents !== null && agents.get(sessionId) !== undefined
}

/**
 * Install the delete route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        respond(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST required' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        respond(res, 400, { ok: false, code: 'bad-request', message: String(error?.message ?? error) })
        return
      }
      const sessionId = body.sessionId
      if (!isValidSessionId(sessionId)) {
        respond(res, 400, { ok: false, code: 'invalid-session-id', message: 'sessionId must be one path segment' })
        return
      }
      // A Session an Agent still owns cannot have its bytes deleted underneath
      // it, but parking the log directory removes it from the account while the
      // running handle keeps writing into the parked copy. That deletes an open
      // conversation without making the user restart first.
      const live = hasLiveAgent(ctx, sessionId)
      // Archive first: it hides the row now, stops running work, and survives
      // an already-deleted log. A failed delete rolls it back.
      const archived = await hideSession(ctx, sessionId)
      let files
      try {
        files = await deleteSessionFiles({ homes: candidateHomes(), sessionId, live })
      } catch (error) {
        const notFound = error?.code === 'session-not-found'
        const searched = Array.isArray(error?.searched) ? error.searched : []
        ctx.logger?.warn?.(`session-delete: ${sessionId}: ${String(error)}`)
        if (!notFound) {
          if (archived) await unhideSession(ctx, sessionId)
          respond(res, error?.code === 'session-locked' ? 409 : 500, {
            ok: false,
            code: error?.code ?? 'delete-failed',
            message: String(error?.message ?? error),
            searched,
          })
          return
        }
        // Nothing left on disk: the conversation is already gone, so finish the
        // job by hiding and detaching it instead of failing the click.
        let detached = []
        try {
          detached = await detachFromWorkspaces(ctx, sessionId)
        } catch (detachError) {
          ctx.logger?.warn?.(`session-delete: detach failed for ${sessionId}: ${String(detachError)}`)
        }
        respond(res, 200, {
          ok: true,
          sessionId,
          live,
          alreadyGone: true,
          archived,
          detached,
          removed: [],
          trashed: [],
          cache: null,
        })
        return
      }
      let detached = []
      try {
        detached = await detachFromWorkspaces(ctx, sessionId)
      } catch (error) {
        ctx.logger?.warn?.(`session-delete: detach failed for ${sessionId}: ${String(error)}`)
      }
      ctx.logger?.info?.(
        `session-delete: removed ${sessionId} (live=${String(live)}, files=${files.removed.length}, trashed=${files.trashed.length}, workspaces=${detached.length})`,
      )
      respond(res, 200, {
        ok: true,
        sessionId,
        live,
        archived,
        detached,
        removed: files.removed,
        trashed: files.trashed,
        cache: files.cache ?? null,
      })
    },
  })
  ctx.effect(() => dispose)
  // Start-up sweep: parked log directories from an earlier delete, plus log
  // directories no Workspace, archive entry or live Session vouches for. Such a
  // directory is what drags a stale "session not found" row back into the
  // sidebar, so it is removed with the trash. Best effort: a failure only
  // leaves the bytes.
  Promise.resolve()
    .then(() => cleanupTrash({ homes: candidateHomes(), registry: ctx.get('workspaceRegistry'), context: ctx }))
    .then((cleaned) => {
      if (cleaned > 0) ctx.logger?.info?.(`session-delete: cleared ${cleaned} parked/stale path(s)`)
    })
    .catch((error) => ctx.logger?.warn?.(`session-delete: trash cleanup failed: ${String(error)}`))
}

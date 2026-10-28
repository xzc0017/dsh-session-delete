/**
 * Client half of dsh-session-delete.
 *
 * One row in `sidebar.workspaces.session.menu.item`, beside the shipped
 * pin/rename/fork/archive/copy-id rows (order 500). Selecting it dismisses the
 * menu, asks for confirmation, then calls the Host route that removes the
 * Session's log and projection cache.
 *
 * The row is a plain `role="menuitem"` button styled from theme tokens: the
 * slot's keyboard walk reads the DOM, and the shipped `MenuItemButton` is a
 * package-private module this bundle does not import.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'session-delete'
    const ENDPOINT = '/dsh-session-delete/delete'

    const en = {
      'menu.delete': 'Delete conversation',
      'confirm.title': 'Delete conversation permanently?',
      'confirm.desc': '“{title}” and its entire history will be removed from this computer. This cannot be undone.\n\nIf it is the conversation you have open, the view goes blank — switch to another one first.\n\nNote: the row may still show under “Ungrouped” until it disappears from the list; restarting DSH finishes the removal.',
      'confirm.action': 'Delete',
      'notice.after': 'Deleted “{title}”. It may still appear under “Ungrouped” for a moment — restarting DSH finishes the removal.',
      'error.live': 'This conversation is open or running. Switch to another conversation first.',
      'error.failed': 'Delete failed: {reason}',
    }
    const zh = {
      'menu.delete': '删除对话',
      'confirm.title': '永久删除该对话？',
      'confirm.desc': '「{title}」及其全部历史将从本机删除，无法恢复。\n\n如果它正开在窗口里，删完那个视图会变空——想继续干活就先切到别的对话。\n\n提示：删除后该行可能还会出现在「未分组」里；如果没消失，重新打开 DSH 即可完成删除。',
      'confirm.action': '删除',
      'notice.after': '已删除「{title}」。该行可能还会短暂出现在「未分组」里；如果没消失，重新打开 DSH 即可完成删除。',
      'error.live': '该对话正在打开或运行中，请先切换到其它对话再删除。',
      'error.failed': '删除失败：{reason}',
    }

    /** Trash glyph sized for a menu row. */
    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', 'aria-hidden': true,
      },
        h('path', { d: 'M2.5 4h11' }),
        h('path', { d: 'M6 4V2.8h4V4' }),
        h('path', { d: 'M4 4l.7 9.1h6.6L12 4' }),
        h('path', { d: 'M6.6 6.6v4.2M9.4 6.6v4.2' }),
      )
    }

    /**
     * Ask the Host to delete one Session.
     * @param {string} sessionId - the Session to delete.
     * @returns {Promise<{ ok: boolean, detached?: string[] }>} the Host answer.
     */
    async function requestDelete(sessionId) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const error = new Error(payload?.message ?? `HTTP ${String(response.status)}`)
        error.code = payload?.code
        throw error
      }
      return payload
    }

    /**
     * @param {{ sessionId: string, displayTitle?: string, useMenuOpenState?: () => [boolean, (open: boolean) => void], t?: (key: string, params?: Record<string, unknown>) => string }} props
     *   row owner share, the slot's menu-open hook, and the locale seat.
     * @returns {import('react').ReactElement} the menu row.
     */
    function SessionDeleteMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, t } = props
      const [hover, setHover] = React.useState(false)
      const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined
      const closeMenu = Array.isArray(menuState) && typeof menuState[1] === 'function' ? menuState[1] : () => {}
      const label = typeof t === 'function' ? t('menu.delete') : '删除对话'
      const title = displayTitle && displayTitle.length > 0 ? displayTitle : sessionId
      const ask = (key, params) => (typeof t === 'function' ? t(key, params) : key)

      const onSelect = () => {
        closeMenu(false)
        const question = `${ask('confirm.title')}\n\n${ask('confirm.desc', { title })}`
        if (typeof window.confirm === 'function' && !window.confirm(question)) return
        requestDelete(sessionId).then(() => {
          window.setTimeout(() => { window.alert(ask('notice.after', { title })) }, 400)
        }).catch((reason) => {
          const message = reason instanceof Error ? reason.message : String(reason)
          console.warn('session delete rejected:', reason)
          if (reason?.code === 'session-live') {
            window.alert(ask('error.live'))
            return
          }
          window.alert(ask('error.failed', { reason: message }))
        })
      }

      return h('button', {
        type: 'button',
        role: 'menuitem',
        'data-session-delete': sessionId,
        onMouseEnter: () => { setHover(true) },
        onMouseLeave: () => { setHover(false) },
        onClick: onSelect,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          boxSizing: 'border-box',
          padding: '6px 10px',
          border: 0,
          borderRadius: 6,
          background: hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: 'var(--dsw-alias-state-error-primary)',
          font: 'inherit',
          fontSize: 13,
          lineHeight: '20px',
          textAlign: 'left',
          cursor: 'pointer',
        },
      }, h('span', { style: { display: 'inline-flex', flex: '0 0 auto' } }, h(TrashIcon)), h('span', null, label))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-delete: dictionaries')
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-delete',
          order: 500,
          locale: NS,
        }, SessionDeleteMenuItem))
      },
    }
  },
})

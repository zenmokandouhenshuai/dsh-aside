/**
 * Client half of 旁问 (aside). Three seats, all reading one module store:
 *
 *   conversation.input.right  id dsh-aside-button   the clickable 问 control
 *   shell.overlay             id dsh-aside-layer    the floating card
 *   sidebar.panellist         id dsh-aside          the archive entry
 *   main                      key dsh-aside         the archive page
 *
 * Answers come from the Host routes under /dsh-aside; nothing here talks to a
 * model and nothing here touches the session log.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-aside',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const ENDPOINT = '/dsh-aside'
    const SHORTCUT = 'Alt+Q'

    /* --------------------------------------------------------------- store */

    const store = {
      open: false,
      question: '',
      context: '',
      site: '',
      answer: '',
      loading: false,
      error: '',
      items: [],
      loaded: false,
      route: null,
      query: '',
      switching: false,
    }
    const listeners = new Set()

    function patch(next) {
      Object.assign(store, next)
      for (const listener of Array.from(listeners)) listener()
    }

    function useAside() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((n) => n + 1)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return store
    }

    /* ---------------------------------------------------------------- data */

    async function loadList() {
      try {
        const res = await fetch(ENDPOINT + '/list', { cache: 'no-store', headers: { accept: 'application/json' } })
        const data = await res.json()
        if (!data || data.ok !== true) throw new Error((data && data.error) || 'load failed')
        patch({
          items: Array.isArray(data.items) ? data.items : [],
          route: data.route || null,
          loaded: true,
        })
      } catch (err) {
        patch({ error: '读取存档失败：' + String((err && err.message) || err), loaded: true })
      }
    }

    async function setMode(mode) {
      if (store.switching) return
      patch({ switching: true, error: '' })
      try {
        const res = await fetch(ENDPOINT + '/route', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ mode }),
        })
        const data = await res.json()
        if (!data || data.ok !== true) throw new Error((data && data.error) || ('HTTP ' + res.status))
        patch({ switching: false, route: data.route })
      } catch (err) {
        patch({ switching: false, error: '切换路由失败：' + String((err && err.message) || err) })
      }
    }

    async function ask() {
      const question = String(store.question || '').trim()
      if (!question || store.loading) return
      patch({ loading: true, error: '', answer: '' })
      try {
        const res = await fetch(ENDPOINT + '/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ question, context: store.context, site: store.site }),
        })
        const data = await res.json()
        if (!data || data.ok !== true) throw new Error((data && data.error) || ('HTTP ' + res.status))
        patch({
          loading: false,
          answer: data.item.answer,
          route: data.route || store.route,
          items: [data.item].concat(store.items).slice(0, 500),
        })
      } catch (err) {
        patch({ loading: false, error: '没问成：' + String((err && err.message) || err) })
      }
    }

    async function removeItem(id) {
      patch({ items: store.items.filter((item) => item.id !== id) })
      try {
        await fetch(ENDPOINT + '/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        })
      } catch (err) {
        /* the next load reconciles with disk */
      }
    }

    function copyItem(item) {
      const text = item.question + '\n' + item.answer
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          void navigator.clipboard.writeText(text)
        }
      } catch (err) { /* clipboard is best-effort */ }
    }

    function relTime(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value)) return ''
      const delta = Date.now() - value
      const minute = 60_000
      const hour = 60 * minute
      const day = 24 * hour
      if (delta < minute) return '刚刚'
      if (delta < hour) return Math.floor(delta / minute) + ' 分钟前'
      if (delta < day) return Math.floor(delta / hour) + ' 小时前'
      if (delta < 7 * day) return Math.floor(delta / day) + ' 天前'
      const date = new Date(value)
      return (date.getMonth() + 1) + '-' + date.getDate()
    }

    function dayGroup(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value)) return '更早'
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      if (value >= start) return '今天'
      if (value >= start - 86_400_000) return '昨天'
      return '更早'
    }

    function matches(item, query) {
      const q = String(query || '').trim().toLowerCase()
      if (!q) return true
      return (String(item.question || '') + ' ' + String(item.answer || '') + ' ' + String(item.context || ''))
        .toLowerCase()
        .includes(q)
    }

    /* --------------------------------------------------------------- style */

    const T = {
      ink: 'var(--dsw-alias-label-primary, #e8eaed)',
      dim: 'var(--dsw-alias-label-secondary, #9aa0a8)',
      faint: 'var(--dsw-alias-state-idle-primary, #6c727a)',
      line: 'var(--dsw-alias-border-l1, #2a2e35)',
      card: 'var(--dsw-alias-bg-overlay, #1c1f24)',
      field: 'var(--dsw-alias-bg-layer-2, #22262c)',
      accent: 'var(--dsw-alias-brand-primary, #2ea88a)',
      danger: 'var(--dsw-alias-state-error-primary, #d9534f)',
    }

    const pill = (active) => ({
      height: 24, padding: '0 10px', borderRadius: 12, fontSize: 12, font: 'inherit',
      cursor: 'pointer',
      border: '1px solid ' + (active ? T.accent : T.line),
      background: active ? 'color-mix(in srgb, ' + T.accent + ' 18%, transparent)' : 'transparent',
      color: active ? T.accent : T.dim,
    })

    const S = {
      button: {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 28, padding: '0 10px', marginRight: 6,
        borderRadius: 8, border: '1px solid ' + T.line,
        background: 'transparent', color: T.dim,
        font: 'inherit', fontSize: 13, cursor: 'pointer',
      },
      buttonOn: {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 28, padding: '0 10px', marginRight: 6,
        borderRadius: 8, border: '1px solid ' + T.accent,
        background: 'color-mix(in srgb, ' + T.accent + ' 16%, transparent)',
        color: T.accent, font: 'inherit', fontSize: 13, cursor: 'pointer',
      },
      layer: {
        position: 'fixed', right: 26, bottom: 128, width: 468,
        maxHeight: '62vh', display: 'flex', flexDirection: 'column',
        background: T.card, color: T.ink,
        border: '1px solid ' + T.line, borderRadius: 14,
        boxShadow: '0 18px 48px rgba(0,0,0,.42)',
        font: 'inherit', fontSize: 14, zIndex: 40,
      },
      head: {
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '12px 14px 10px', borderBottom: '1px solid ' + T.line,
      },
      body: { padding: '12px 14px', overflowY: 'auto' },
      field: {
        width: '100%', boxSizing: 'border-box', resize: 'vertical',
        minHeight: 54, maxHeight: 160, padding: '9px 10px',
        borderRadius: 9, border: '1px solid ' + T.line,
        background: T.field, color: T.ink,
        font: 'inherit', fontSize: 14, lineHeight: 1.55, outline: 'none',
      },
      key: {
        display: 'inline-block', padding: '1px 5px', borderRadius: 5,
        border: '1px solid ' + T.line, color: T.faint, fontSize: 11,
      },
      answer: {
        marginTop: 10, padding: '10px 12px', borderRadius: 10,
        background: T.field, lineHeight: 1.62, whiteSpace: 'pre-wrap',
      },
      row: {
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 0', borderTop: '1px solid ' + T.line, cursor: 'pointer',
      },
      rowTitle: { fontSize: 14, lineHeight: 1.5, color: T.ink },
      rowText: {
        marginTop: 3, fontSize: 13, lineHeight: 1.6, color: T.dim,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      link: {
        border: 0, background: 'none', color: T.faint, cursor: 'pointer',
        font: 'inherit', fontSize: 12, padding: 0,
      },
      page: { height: '100%', overflowY: 'auto' },
      pageInner: { maxWidth: 1000, margin: '0 auto', padding: '26px 30px 60px' },
      pageTitle: { fontSize: 26, fontWeight: 700, letterSpacing: 0.2 },
      search: {
        width: '100%', boxSizing: 'border-box', height: 40, padding: '0 12px',
        borderRadius: 10, border: '1px solid ' + T.line, background: T.field,
        color: T.ink, font: 'inherit', fontSize: 15, outline: 'none',
      },
      groupHead: {
        display: 'flex', alignItems: 'baseline', gap: 10,
        margin: '26px 0 6px', color: T.dim, fontSize: 13,
      },
      pageRow: {
        padding: '14px 16px', borderRadius: 12, border: '1px solid ' + T.line,
        background: T.card, marginBottom: 10,
      },
      pageQ: { fontSize: 16, fontWeight: 600, lineHeight: 1.5 },
      pageA: { marginTop: 6, fontSize: 14, lineHeight: 1.72, color: T.dim, whiteSpace: 'pre-wrap' },
      pageMeta: { marginTop: 10, color: T.faint, fontSize: 12, display: 'flex', gap: 12, alignItems: 'center' },
      empty: {
        marginTop: 60, textAlign: 'center', color: T.faint, fontSize: 14, lineHeight: 2,
      },
    }

    /* ------------------------------------------------------------ components */

    function openCard(sessionId) {
      if (sessionId) store.site = String(sessionId).slice(0, 120)
      if (store.open) {
        patch({ open: false })
        return
      }
      let selected = ''
      try {
        const sel = window.getSelection && window.getSelection()
        selected = sel ? String(sel.toString() || '').trim() : ''
      } catch (err) { selected = '' }
      if (selected.length > 120) selected = selected.slice(0, 120)
      patch({
        open: true,
        error: '',
        answer: '',
        context: selected,
        question: selected ? (selected.length <= 40 ? '什么是' + selected + '？' : '') : '',
      })
      if (!store.loaded) void loadList()
    }

    function RouteSwitch() {
      const route = store.route
      const mode = route && route.mode ? route.mode : 'dp'
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { color: T.faint, fontSize: 12 } }, '回答用'),
        h('button', {
          type: 'button', style: pill(mode === 'dp'), title: '走你不用完不心疼的 dp 中转',
          onClick: () => { void setMode('dp') },
        }, 'dp 中转'),
        h('button', {
          type: 'button', style: pill(mode === 'auto'), title: '走应用默认模型，也就是官方账号',
          onClick: () => { void setMode('auto') },
        }, '官方账号'),
      )
    }

    function AsideButton(props) {
      useAside()
      return h('button', {
        type: 'button',
        title: '旁问：问一个名词，不动主对话（' + SHORTCUT + '）',
        'aria-label': '旁问',
        style: store.open ? S.buttonOn : S.button,
        onClick: (event) => {
          event.preventDefault()
          openCard(props && props.sessionId)
        },
      }, h('span', { 'aria-hidden': true, style: { fontWeight: 700 } }, '?'), '问')
    }

    function AsideLayer() {
      useAside()
      const inputRef = useRef(null)

      useEffect(() => {
        if (store.open && inputRef.current) inputRef.current.focus()
      }, [store.open])

      if (!store.open) return null

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          patch({ open: false })
          return
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          void ask()
        }
      }

      return h('div', { style: S.layer, role: 'dialog', 'aria-label': '旁问' },
        h('div', { style: S.head },
          h('span', {
            style: {
              padding: '2px 8px', borderRadius: 7, fontSize: 12, color: T.accent,
              background: 'color-mix(in srgb, ' + T.accent + ' 18%, transparent)',
            },
          }, '旁问'),
          h('span', { style: { color: T.faint, fontSize: 12 } }, '答案不进主对话'),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.key }, SHORTCUT),
          h('button', {
            type: 'button', style: S.link, title: '关闭',
            onClick: () => patch({ open: false }),
          }, 'Esc 关闭'),
        ),

        h('div', { style: S.body },
          store.route
            ? h('div', { style: { marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 } },
                h(RouteSwitch),
                h('span', { style: { flex: 1 } }),
                h('span', { style: { color: T.faint, fontSize: 11 } },
                  store.route.provider + ' / ' + store.route.model),
              )
            : null,

          store.context
            ? h('div', {
                style: {
                  marginBottom: 8, padding: '6px 9px', borderRadius: 8,
                  background: T.field, color: T.dim, fontSize: 12,
                  whiteSpace: 'pre-wrap', maxHeight: 52, overflow: 'hidden',
                },
              }, '选中：' + store.context)
            : null,

          h('textarea', {
            ref: inputRef,
            value: store.question,
            placeholder: '问一个名词，比如 NZSP、固-固界面阻抗…',
            style: S.field,
            onChange: (event) => patch({ question: event.target.value }),
            onKeyDown,
          }),

          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
            h('button', {
              type: 'button',
              disabled: store.loading || !String(store.question || '').trim(),
              onClick: () => { void ask() },
              style: {
                height: 28, padding: '0 12px', borderRadius: 8,
                border: '1px solid ' + T.accent,
                background: 'color-mix(in srgb, ' + T.accent + ' 20%, transparent)',
                color: T.accent, font: 'inherit', fontSize: 13,
                cursor: store.loading ? 'default' : 'pointer',
                opacity: store.loading || !String(store.question || '').trim() ? 0.55 : 1,
              },
            }, store.loading ? '在查…' : '问'),
            h('span', { style: { color: T.dim, fontSize: 12 } }, 'Enter 问 / Shift+Enter 换行'),
          ),

          store.error ? h('div', { style: { marginTop: 10, color: T.danger, fontSize: 13, lineHeight: 1.6 } }, store.error) : null,
          store.answer ? h('div', { style: S.answer }, store.answer) : null,

          store.items.length
            ? h('div', { style: { marginTop: 16 } },
                h('div', { style: { color: T.dim, fontSize: 13, marginBottom: 4 } },
                  '存档 · ' + store.items.length + ' 条　点一条看完整答案'),
                ...store.items.slice(0, 20).map((item) => h('div', {
                  key: item.id,
                  style: S.row,
                  title: '点一下，把这条的完整答案放回上面',
                  onClick: () => patch({
                    question: item.question,
                    answer: item.answer,
                    context: item.context || '',
                    error: '',
                  }),
                },
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: S.rowTitle }, item.question),
                    h('div', { style: S.rowText }, String(item.answer || '')),
                    h('div', { style: { color: T.faint, fontSize: 11, marginTop: 4 } },
                      relTime(item.createdAt) + (item.context ? '　·　' + String(item.context).slice(0, 24) : '')),
                  ),
                  h('button', {
                    type: 'button', style: S.link, title: '删除这条',
                    onClick: (event) => { event.stopPropagation(); void removeItem(item.id) },
                  }, '删'),
                )),
              )
            : null,
        ),
      )
    }

    function AsidePanel() {
      useAside()

      useEffect(() => {
        if (!store.loaded) void loadList()
      }, [])

      const items = store.items.filter((item) => matches(item, store.query))
      const groups = []
      for (const item of items) {
        const label = dayGroup(item.createdAt)
        const last = groups[groups.length - 1]
        if (last && last.label === label) last.items.push(item)
        else groups.push({ label, items: [item] })
      }

      return h('div', { style: S.page },
        h('div', { style: S.pageInner },

          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
            h('span', { style: S.pageTitle }, '旁问存档'),
            h('span', {
              style: {
                padding: '2px 9px', borderRadius: 8, fontSize: 13, color: T.accent,
                background: 'color-mix(in srgb, ' + T.accent + ' 16%, transparent)',
              },
            }, store.items.length + ' 条'),
            h('span', { style: { flex: 1 } }),
            h(RouteSwitch),
          ),

          h('div', { style: { marginTop: 6, color: T.faint, fontSize: 12 } },
            (store.route ? store.route.provider + ' / ' + store.route.model : '路由未知')
            + '　·　都存在 ' + '~/.dsh/dsh-aside/　·　检索在本地做，不花 token'),

          h('div', { style: { marginTop: 18 } },
            h('input', {
              value: store.query,
              placeholder: '搜：填料、NZSP、界面…',
              style: S.search,
              onChange: (event) => patch({ query: event.target.value }),
            }),
          ),

          store.error
            ? h('div', { style: { marginTop: 12, color: T.danger, fontSize: 13 } }, store.error)
            : null,

          items.length === 0
            ? h('div', { style: S.empty },
                store.items.length === 0
                  ? h('div', null,
                      h('div', null, '还没有旁问。'),
                      h('div', null, '在对话里选中一个词，点输入框旁的「? 问」或按 ' + SHORTCUT + '。'))
                  : h('div', null, '没有匹配「' + store.query + '」的条目。'))
            : groups.map((group) => h('div', { key: group.label },
                h('div', { style: S.groupHead },
                  h('span', { style: { fontSize: 14, color: T.ink, fontWeight: 600 } }, group.label),
                  h('span', null, group.items.length + ' 条')),
                ...group.items.map((item) => h('div', { key: item.id, style: S.pageRow },
                  h('div', { style: S.pageQ }, item.question),
                  h('div', { style: S.pageA }, item.answer),
                  h('div', { style: S.pageMeta },
                    h('span', null, relTime(item.createdAt)),
                    item.context ? h('span', null, '选中：' + String(item.context).slice(0, 40)) : null,
                    h('span', { style: { flex: 1 } }),
                    h('button', {
                      type: 'button', style: S.link,
                      onClick: () => copyItem(item),
                    }, '复制'),
                    h('button', {
                      type: 'button', style: S.link,
                      onClick: () => { void removeItem(item.id) },
                    }, '删除'),
                  ),
                )),
              )),
        ),
      )
    }

    function AsideIcon(props) {
      const size = (props && props.size) || 16
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'block' },
      },
      h('path', { d: 'M4.2 5.6h15.6a1.2 1.2 0 0 1 1.2 1.2v8.4a1.2 1.2 0 0 1-1.2 1.2H9.6L5.4 20v-3.6H4.2A1.2 1.2 0 0 1 3 15.2V6.8a1.2 1.2 0 0 1 1.2-1.2z' }),
      h('path', { d: 'M9.1 9.1a2.3 2.3 0 1 1 3.3 2.1c-.6.3-.9.8-.9 1.4v.3' }),
      h('path', { d: 'M11.5 15.6h.01' }))
    }

    /* ------------------------------------------------------------------ half */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-aside-button',
          order: 40,
          label: '旁问',
        }, AsideButton)), 'dsh-aside: composer button')

        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-aside-layer',
          order: 80,
          label: '旁问',
        }, AsideLayer)), 'dsh-aside: floating card')

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'dsh-aside',
          order: 30,
          label: '旁问存档',
        }, AsideIcon)), 'dsh-aside: sidebar entry')

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'dsh-aside',
        }, AsidePanel)), 'dsh-aside: archive page')

        ctx.effect(() => {
          const onKey = (event) => {
            if (!event.altKey || event.ctrlKey || event.metaKey) return
            if (String(event.key || '').toLowerCase() !== 'q') return
            const target = event.target
            const tag = target && target.tagName ? String(target.tagName).toLowerCase() : ''
            if (tag === 'input' || tag === 'textarea') return
            event.preventDefault()
            if (store.open) patch({ open: false })
            else openCard(store.site)
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, 'dsh-aside: shortcut')
      },
    }
  },
})
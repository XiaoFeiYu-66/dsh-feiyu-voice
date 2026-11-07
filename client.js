window.__ModuleLoader__.load({
  id: 'dsh-feiyu-voice',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '660px' },
      card: {
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      label: { color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '13px', minWidth: '72px' },
      value: { color: 'var(--dsw-alias-label-primary, #111827)', fontSize: '14px' },
      title: { margin: 0, fontSize: '16px', color: 'var(--dsw-alias-label-primary, #111827)' },
      hint: { color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: '12px', lineHeight: 1.5 },
      input: {
        padding: '6px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #111827)',
        fontSize: '13px',
        minWidth: '260px',
      },
      textarea: {
        width: '100%',
        minHeight: '62px',
        resize: 'vertical',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #111827)',
        fontSize: '14px',
        boxSizing: 'border-box',
      },
      button: {
        padding: '7px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
        color: 'var(--dsw-alias-label-primary, #111827)',
        fontSize: '13px',
        cursor: 'pointer',
      },
      primary: {
        padding: '7px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-brand-primary, #2563eb)',
        background: 'var(--dsw-alias-brand-primary, #2563eb)',
        color: '#fff',
        fontSize: '13px',
        cursor: 'pointer',
      },
      error: { color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: '13px', whiteSpace: 'pre-wrap' },
      ok: { color: 'var(--dsw-alias-state-success-primary, #16a34a)', fontSize: '13px', whiteSpace: 'pre-wrap' },
    }

    async function api(path, init) {
      const res = await fetch('/feiyu-voice/' + path, {
        credentials: 'same-origin',
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init && init.headers) },
      })
      if (!res.ok) {
        let detail = ''
        try {
          detail = (await res.text()).slice(0, 400)
        } catch {
          /* ignore */
        }
        throw new Error(`HTTP ${res.status}${detail ? '：' + detail : ''}`)
      }
      return res
    }

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [defaultRef, setDefaultRef] = React.useState('')
      const [customRef, setCustomRef] = React.useState('')
      const [ttsHome, setTtsHome] = React.useState('')
      const [autoStart, setAutoStart] = React.useState(true)
      const [text, setText] = React.useState('你好，这是我的声音。')
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [error, setError] = React.useState('')
      const audioRef = React.useRef(null)

      const load = React.useCallback(async () => {
        try {
          const res = await api('status')
          const data = await res.json()
          setStatus(data)
          setDefaultRef(data.defaultRef || '')
          setTtsHome(data.ttsHome || '')
          setAutoStart(Boolean(data.autoStartDaemon))
          setError('')
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [])

      React.useEffect(() => {
        load()
        return () => {
          const a = audioRef.current
          if (a) {
            a.pause()
            if (a.src && a.src.startsWith('blob:')) URL.revokeObjectURL(a.src)
          }
        }
      }, [load])

      const run = async (name, fn) => {
        setBusy(name)
        setError('')
        setMessage('')
        try {
          await fn()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy('')
          load()
        }
      }

      const preview = () =>
        run('preview', async () => {
          const ref = customRef.trim() || defaultRef
          const started = Date.now()
          const res = await api('speak', { method: 'POST', body: JSON.stringify({ text, ref: ref || undefined }) })
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const a = audioRef.current || new Audio()
          audioRef.current = a
          if (a.src && a.src.startsWith('blob:')) URL.revokeObjectURL(a.src)
          a.src = url
          await a.play()
          setMessage(`试听已生成：${res.headers.get('X-Duration') || '?'} 秒，耗时 ${Math.round((Date.now() - started) / 1000)} 秒`)
        })

      const save = () =>
        run('save', async () => {
          await api('config', {
            method: 'POST',
            body: JSON.stringify({
              defaultRef: customRef.trim() || defaultRef,
              autoStartDaemon: autoStart,
              ttsHome: ttsHome.trim() || undefined,
            }),
          })
          setCustomRef('')
          setMessage('设置已保存')
        })

      const daemon = (action) =>
        run(action, async () => {
          await api('daemon', { method: 'POST', body: JSON.stringify({ action }) })
          setMessage(action === 'start' ? '常驻服务已启动' : '常驻服务已停止')
        })

      const daemonState = status?.daemon || {}
      const files = status?.files || {}
      const refs = status?.refs || []

      return h(
        'div',
        { style: styles.wrap },
        h('h2', { style: styles.title }, '小肥鱼语音'),
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '常驻服务'),
            h(
              'span',
              { style: { ...styles.value, color: daemonState.running ? 'var(--dsw-alias-state-success-primary, #16a34a)' : 'var(--dsw-alias-label-secondary, #6b7280)' } },
              daemonState.running ? `运行中${daemonState.busy ? '（正在合成）' : ''}` : '未运行',
            ),
            h('button', { style: styles.button, disabled: Boolean(busy), onClick: () => daemon('start') }, busy === 'start' ? '启动中…' : '启动'),
            h('button', { style: styles.button, disabled: Boolean(busy) || !daemonState.running, onClick: () => daemon('stop') }, '停止'),
          ),
          h('div', { style: styles.hint }, `服务地址 ${status?.speakdUrl || ''}　·　常驻时约占 2–3 GB 内存`),
        ),
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, 'TTS 目录'),
            h('input', {
              style: { ...styles.input, minWidth: '360px' },
              value: ttsHome,
              placeholder: '例如 C:\\Users\\你\\.dsh\\tts',
              onChange: (e) => setTtsHome(e.target.value),
            }),
          ),
          h('div', { style: styles.hint }, '目录里要有 venv/、_src/MOSS-TTS-Nano-main/（含 models/）、refs/。保存后生效。'),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '默认音色'),
            h(
              'select',
              {
                style: { ...styles.input, minWidth: '220px' },
                value: refs.some((r) => r.name === defaultRef) ? defaultRef : '',
                onChange: (e) => setDefaultRef(e.target.value),
              },
              h('option', { value: '' }, refs.length ? '（未选择）' : '（refs 目录里没有 wav）'),
              refs.map((r) => h('option', { key: r.name, value: r.name }, r.name)),
            ),
            h('input', {
              style: styles.input,
              value: customRef,
              placeholder: '或填 wav 绝对路径',
              onChange: (e) => setCustomRef(e.target.value),
            }),
          ),
          h(
            'label',
            { style: { ...styles.hint, display: 'flex', alignItems: 'center', gap: '6px' } },
            h('input', { type: 'checkbox', checked: autoStart, onChange: (e) => setAutoStart(e.target.checked) }),
            '服务没起时自动拉起',
          ),
          h(
            'div',
            { style: styles.hint },
            `文件检查：python ${files.python ? '✓' : '✗'}　infer ${files.infer ? '✓' : '✗'}　speakd ${files.speakd ? '✓' : '✗'}　qq-voice ${files.qqVoice ? '✓' : '✗'}　out ${files.out ? '✓' : '✗'}`,
          ),
          h('div', { style: styles.row }, h('button', { style: styles.primary, disabled: Boolean(busy), onClick: save }, busy === 'save' ? '保存中…' : '保存设置')),
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.label }, '试听'),
          h('textarea', {
            style: styles.textarea,
            value: text,
            maxLength: 200,
            onChange: (e) => setText(e.target.value),
            placeholder: '输入要试听的文字（建议 ≤30 字）',
          }),
          h(
            'div',
            { style: styles.row },
            h('button', { style: styles.primary, disabled: Boolean(busy) || !text.trim() }, busy === 'preview' ? '合成中…（约 20–90 秒）' : '生成并试听'),
            h('span', { style: styles.hint }, '走常驻服务约 20–40 秒；服务没起会先加载模型'),
          ),
        ),
        message ? h('div', { style: styles.ok }, message) : null,
        error ? h('div', { style: styles.error }, error) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () =>
          slots.register({ name: 'settings.section', id: 'feiyu-voice', order: 60, label: '小肥鱼语音' }, () => h(Panel)),
        )
      },
    }
  },
})

// dsh-aitestcase — browser half.
//
// Packaged as the client module system's lazy-CJS factory: the page's module
// loader registers this package id and hands the factory a `require` bound to
// the runtime modules (react here). Registers one `settings.section` page so the
// plugin has a readable home under Settings → 测试设计.
window.__ModuleLoader__.load({
  id: 'dsh-aitestcase',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState

    // ---- design tokens (theme variables, light/dark handled by the theme) ----
    var T = {
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      text3: 'var(--dsw-alias-label-caption)',
      bg: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      bg3: 'var(--dsw-alias-bg-base)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    }

    var VERSION = '1.0.0'

    var STEPS = [
      { n: '1', title: '测试 PRD', tool: 'aitestcase_testprd', desc: '补全未定义规则，列出待确认问题，给出可测的验收标准' },
      { n: '2', title: '测试点', tool: 'aitestcase_testpoints', desc: '从 PRD 提取验证要点，不含步骤与数据' },
      { n: '3', title: '测试用例', tool: 'aitestcase_testcases', desc: 'xmind 层级 / Markdown 表格 / YAML 三种格式' },
      { n: '4', title: '质检评估', tool: 'aitestcase_evaluate', desc: '覆盖度打分、漏测点、逻辑问题、补充用例' },
    ]

    var TOOLS = [
      {
        name: 'aitestcase_testprd',
        use: '需求原文 → 测试 PRD',
        out: 'Markdown',
      },
      {
        name: 'aitestcase_testpoints',
        use: 'PRD / 需求 → 测试点清单',
        out: 'Markdown',
      },
      {
        name: 'aitestcase_testcases',
        use: '测试点 + PRD → 测试用例（可指定格式）',
        out: 'xmind / table / yaml',
      },
      {
        name: 'aitestcase_evaluate',
        use: '用例质检：覆盖率、边界、异常路径、安全',
        out: 'JSON 报告',
      },
      {
        name: 'aitestcase_history',
        use: '读取本会话此前的生成结果，做增量修改',
        out: 'Markdown',
      },
      {
        name: 'aitestcase_status',
        use: '自检：模型连通、模板完整、产物目录',
        out: 'Markdown',
      },
    ]

    var CONFIG_ROWS = [
      { key: 'provider', def: 'deepseek-official', desc: '模型提供方路由' },
      { key: 'model', def: 'deepseek-flash', desc: '生成与评估使用的模型' },
      { key: 'temperature', def: '0', desc: '采样温度，测试设计建议 0' },
      { key: 'maxTokens', def: '20000', desc: '单次生成输出上限（token）' },
      { key: 'outputDir', def: '.aitestcase', desc: '产物目录，相对路径按会话工作目录解析' },
      { key: 'saveArtifacts', def: 'true', desc: '是否把每次生成落盘为 Markdown 文件' },
      { key: 'historyRounds', def: '4', desc: '回灌本会话前几轮结果做延续上下文，0 关闭' },
      { key: 'maxInputChars', def: '60000', desc: '单次输入字符上限，超出截断并注明' },
    ]

    var EXAMPLES = [
      {
        id: 'analyze',
        title: '需求分析',
        prompt:
          '用 aitestcase_testprd 把下面这段需求整理成测试 PRD，先列出明确规则和待确认问题，不要替未定义规则编造预期结果：\n\n（粘贴需求）',
      },
      {
        id: 'cases',
        title: '生成用例',
        prompt:
          '基于上面的测试 PRD，先调用 aitestcase_testpoints 提取测试点，再调用 aitestcase_testcases 生成 xmind 层级用例，优先级只保留 P0/P1。',
      },
      {
        id: 'review',
        title: '质检评审',
        prompt:
          '用 aitestcase_evaluate 对下面这份测试用例做对抗式评审，重点看边界值、异常路径和安全性，给出评分、漏测点和补充用例：\n\n（粘贴用例）',
      },
    ]

    // ---- small building blocks -------------------------------------------------

    function Badge(props) {
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '3px 10px',
            borderRadius: '999px',
            fontSize: '12px',
            lineHeight: '18px',
            fontWeight: 500,
            color: props.tone ? props.tone : T.text2,
            background: props.bg ? props.bg : T.bg2,
            border: '1px solid ' + T.border,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    function Card(props) {
      return h(
        'div',
        {
          style: Object.assign(
            {
              background: T.bg,
              border: '1px solid ' + T.border,
              borderRadius: '12px',
              padding: '18px 20px',
              boxSizing: 'border-box',
            },
            props.style || {},
          ),
        },
        props.children,
      )
    }

    function SectionTitle(props) {
      return h(
        'div',
        { style: { marginBottom: '12px' } },
        h(
          'div',
          { style: { fontSize: '15px', fontWeight: 600, color: T.text, letterSpacing: '0.01em' } },
          props.title,
        ),
        props.hint
          ? h('div', { style: { marginTop: '4px', fontSize: '12.5px', color: T.text3, lineHeight: '20px' } }, props.hint)
          : null,
      )
    }

    function StepCard(step, index, total) {
      return h(
        'div',
        {
          key: step.n,
          style: {
            flex: '1 1 200px',
            minWidth: '180px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '14px 16px',
            borderRadius: '10px',
            background: T.bg2,
            border: '1px solid ' + T.border,
            position: 'relative',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h(
            'span',
            {
              style: {
                width: '22px',
                height: '22px',
                borderRadius: '999px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                fontWeight: 700,
                color: T.brand,
                background: T.bg,
                border: '1px solid ' + T.border2,
                flex: '0 0 auto',
              },
            },
            step.n,
          ),
          h('span', { style: { fontSize: '14px', fontWeight: 600, color: T.text } }, step.title),
        ),
        h('code', { style: { fontFamily: T.mono, fontSize: '11.5px', color: T.brand } }, step.tool),
        h('div', { style: { fontSize: '12.5px', color: T.text2, lineHeight: '20px' } }, step.desc),
      )
    }

    function Row(props) {
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: props.columns,
            gap: '12px',
            padding: '9px 0',
            borderTop: props.first ? 'none' : '1px solid ' + T.border,
            alignItems: 'start',
          },
        },
        props.children,
      )
    }

    function useCopy() {
      var state = useState('')
      var copiedId = state[0]
      var setCopiedId = state[1]
      var copy = function (id, text) {
        var done = function () {
          setCopiedId(id)
          setTimeout(function () {
            setCopiedId('')
          }, 1600)
        }
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, done)
            return
          }
        } catch (error) {
          /* fall through to the legacy path */
        }
        try {
          var area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          document.body.removeChild(area)
          done()
        } catch (error) {
          setCopiedId('')
        }
      }
      return [copiedId, copy]
    }

    // ---- the settings page -----------------------------------------------------

    function Section() {
      var copyState = useCopy()
      var copiedId = copyState[0]
      var copy = copyState[1]

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '20px', color: T.text } },

        // header
        h(
          'div',
          {
            style: {
              padding: '22px 24px',
              borderRadius: '14px',
              border: '1px solid ' + T.border,
              background: T.bg,
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: '20px', fontWeight: 650, letterSpacing: '0.01em' } }, '测试设计'),
            h('div', { style: { fontSize: '12.5px', color: T.text3 } }, 'AI Test Design · 需求到用例的完整闭环'),
          ),
          h(
            'div',
            { style: { fontSize: '13.5px', color: T.text2, lineHeight: '22px', maxWidth: '760px' } },
            '一个自包含的测试设计插件：在对话里直接把需求变成测试 PRD、测试点、测试用例，并对用例做对抗式质检。' +
              '全部能力在 DSH 进程内完成，不需要额外后端、端口或第二份 API Key。',
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h(Badge, { tone: T.ok }, '● 已加载 v' + VERSION),
            h(Badge, null, '6 个工具'),
            h(Badge, null, '自包含 · 无外部依赖'),
            h(Badge, null, '支持 xmind / table / yaml'),
          ),
        ),

        // pipeline
        h(
          Card,
          null,
          h(SectionTitle, {
            title: '推荐流程',
            hint: '每一步的产出都可以直接作为下一步的输入；也可以单独调用任意一步。',
          }),
          h(
            'div',
            { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
            STEPS.map(function (step) {
              return StepCard(step, 0, STEPS.length)
            }),
          ),
        ),

        // capabilities
        h(
          Card,
          null,
          h(SectionTitle, {
            title: '工具能力',
            hint: '模型会自动选择合适的工具；你也可以在对话里直接点名使用，例如「用 aitestcase_testcases 生成用例」。',
          }),
          h(
            'div',
            null,
            h(
              Row,
              { first: true, columns: '220px 1fr 150px' },
              h('div', { style: { fontSize: '12px', color: T.text3, fontWeight: 600 } }, '工具'),
              h('div', { style: { fontSize: '12px', color: T.text3, fontWeight: 600 } }, '作用'),
              h('div', { style: { fontSize: '12px', color: T.text3, fontWeight: 600 } }, '输出'),
            ),
            TOOLS.map(function (tool) {
              return h(
                Row,
                { key: tool.name, columns: '220px 1fr 150px' },
                h(
                  'code',
                  { style: { fontFamily: T.mono, fontSize: '12px', color: T.brand, wordBreak: 'break-all' } },
                  tool.name,
                ),
                h('div', { style: { fontSize: '12.8px', color: T.text2, lineHeight: '20px' } }, tool.use),
                h('div', { style: { fontSize: '12.5px', color: T.text2 } }, tool.out),
              )
            }),
          ),
        ),

        // prompt library
        h(
          Card,
          null,
          h(SectionTitle, {
            title: '常用提示词',
            hint: '复制后粘贴到对话里即可。插件不依赖特殊语法，自然语言描述需求就行。',
          }),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            EXAMPLES.map(function (example) {
              return h(
                'div',
                {
                  key: example.id,
                  style: {
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                    padding: '12px 14px',
                    borderRadius: '10px',
                    background: T.bg2,
                    border: '1px solid ' + T.border,
                  },
                },
                h(
                  'div',
                  { style: { flex: '1 1 auto', minWidth: 0 } },
                  h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } }, example.title),
                  h(
                    'div',
                    {
                      style: {
                        fontSize: '12.5px',
                        color: T.text2,
                        lineHeight: '20px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      },
                    },
                    example.prompt,
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: function () {
                      copy(example.id, example.prompt)
                    },
                    style: {
                      flex: '0 0 auto',
                      padding: '6px 12px',
                      borderRadius: '8px',
                      fontSize: '12.5px',
                      cursor: 'pointer',
                      color: copiedId === example.id ? T.ok : T.text2,
                      background: T.bg,
                      border: '1px solid ' + T.border2,
                    },
                  },
                  copiedId === example.id ? '已复制' : '复制',
                ),
              )
            }),
          ),
        ),

        // configuration
        h(
          Card,
          null,
          h(SectionTitle, {
            title: '配置项',
            hint: '这些字段已经注册为插件的即时配置项，可在「插件」页本插件的配置表单中直接修改，保存后下一次调用即生效。',
          }),
          h(
            'div',
            null,
            h(
              Row,
              { first: true, columns: '160px 170px 1fr' },
              h('div', { style: { fontSize: '12px', color: T.text3, fontWeight: 600 } }, '键'),
              h('div', { style: { fontSize: '12px', color: T.text3, fontWeight: 600 } }, '默认值'),
              h('div', { style: { fontSize: '12px', color: T.text3, fontWeight: 600 } }, '说明'),
            ),
            CONFIG_ROWS.map(function (row) {
              return h(
                Row,
                { key: row.key, columns: '160px 170px 1fr' },
                h('code', { style: { fontFamily: T.mono, fontSize: '12px', color: T.brand } }, row.key),
                h('code', { style: { fontFamily: T.mono, fontSize: '12px', color: T.text2 } }, row.def),
                h('div', { style: { fontSize: '12.8px', color: T.text2, lineHeight: '20px' } }, row.desc),
              )
            }),
          ),
        ),

        // artifacts + tips
        h(
          Card,
          null,
          h(SectionTitle, { title: '产物与排错', hint: '生成的完整结果会自动落盘，方便归档、评审和二次编辑。' }),
          h(
            'ul',
            { style: { margin: 0, paddingLeft: '20px', fontSize: '12.8px', color: T.text2, lineHeight: '24px' } },
            h(
              'li',
              null,
              '产物目录：',
              h('code', { style: { fontFamily: T.mono, color: T.brand } }, '<会话工作目录>/.aitestcase/'),
              '，文件名形如 ',
              h('code', { style: { fontFamily: T.mono, color: T.brand } }, 'testcase-table-20261023-181617.md'),
            ),
            h('li', null, '落盘失败不会影响返回结果，只会省略「已保存」一行。'),
            h('li', null, '连接或模板异常时，让模型调用 aitestcase_status（可带 probe=true）做一次自检。'),
            h('li', null, '生成历史只属于当前会话；代码热重载会清空历史，磁盘上的产物文件不受影响。'),
          ),
        ),
      )
    }

    // ---- plugin registration ---------------------------------------------------

    var name = 'aitestcase'
    var inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'aitestcase',
            order: 25,
            label: function () {
              return '测试设计'
            },
          },
          Section,
        )
      })
    }

    module.exports = { apply: apply, inject: inject, name: name }
    return module.exports
  },
})

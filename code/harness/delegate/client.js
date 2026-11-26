import { install, t } from './client-locale.js'
import { absolutePath, argsOf, duration, metaOf, registerToolView, resultText, toolViews } from '../shared/page-tool-view.js'

// delegate_agent's row in the conversation: which agent, how long, and how many problems it listed. Opened, the
// problems come first (severity, a file link that opens at the line, the summary), then the agent's whole answer.
window.__ModuleLoader__.load({
  id: '@local/dsh-delegate',
  factory(require) {
    const react = require('react')
    const { createElement: h } = react
    const { Row, Text } = toolViews(react)
    const names = { codex: 'Codex', claude: 'Claude Code' }
    const tones = { high: 'danger', medium: 'warn', low: undefined }
    const order = { high: 0, medium: 1, low: 2 }

    function DelegateView(owner) {
      const meta = metaOf(owner, 'fig-delegate')
      const agent = names[meta?.agent ?? argsOf(owner).agent] ?? t('main.externalAgent')
      const findings = meta?.findings ? [...meta.findings].sort((a, b) => order[a.severity] - order[b.severity]) : undefined
      const summary = [agent,
        findings ? (findings.length ? t(findings.length === 1 ? 'main.findings.one' : 'main.findings.other', { count: findings.length }) : t('main.noProblemsFound')) : undefined,
        meta ? duration(meta.elapsedMs) : undefined].filter(Boolean).join(' · ')
      const output = owner.phase === 'result' ? resultText(owner.block) : ''
      return h(Row, { owner, tool: 'delegate_agent', title: t('main.delegate'), summary },
        output ? [
          findings?.length ? h('ul', { key: 'findings', className: 'fig-tool-list' }, findings.map((finding, index) => {
            return h('li', { key: index, 'data-fig-finding': finding.severity },
              h('span', { className: 'fig-tool-tag', 'data-tone': tones[finding.severity] }, t(`main.severity.${/** @type {'high' | 'medium' | 'low'} */ (finding.severity)}`)),
              h('span', { style: { minWidth: 0 } },
                h('button', { type: 'button', className: 'fig-tool-link',
                  onClick: () => owner.openFile(absolutePath(finding.path, owner.cwd), finding.line ? { line: finding.line } : undefined) },
                finding.path + (finding.line ? ':' + finding.line : '')),
                ' ' + finding.summary))
          })) : null,
          h(Text, { key: 'answer' }, output)
        ] : undefined)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) { install(ctx); registerToolView(ctx, 'delegate_agent', DelegateView) }
    }
  }
})

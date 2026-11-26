import { install, t } from './client-locale.js'
import { argsOf, metaOf, registerToolView, resultText, shortTarget, toolViews } from '../shared/page-tool-view.js'

// preview's row in the conversation: what was opened, how many problems, and a thumbnail per width that opens the
// full screenshot in the right sidebar. The findings text the model received shows when the row is opened.
window.__ModuleLoader__.load({
  id: '@local/dsh-preview',
  factory(require) {
    const react = require('react')
    const { createElement: h, useEffect, useState } = react
    const { Row, Text } = toolViews(react)

    /** One screenshot, read through preview's own route (the Host checks the browser's DSH session). */
    function Shot({ view, openFile }) {
      const [url, setUrl] = useState(/** @type {string | undefined} */ (undefined))
      useEffect(() => {
        if (!view.shot) return undefined
        let made, gone = false
        fetch('/fig-preview/shot', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shot: view.shot }) })
          .then(response => response.ok ? response.blob() : undefined)
          .then(blob => { if (blob && !gone) { made = URL.createObjectURL(blob); setUrl(made) } })
          .catch(() => undefined)
        return () => { gone = true; if (made) URL.revokeObjectURL(made) }
      }, [view.shot])
      const label = view.error ? t('main.pxNotCaptured', { width: view.width })
        : view.overflowX > 0 ? t('main.pxOverflowsPx', { width: view.width, overflowX: view.overflowX }) : `${view.width}px`
      return h('button', { type: 'button', className: 'fig-tool-shot', 'data-fig-preview-shot': view.width, disabled: !view.screenshot,
        title: t('main.openTheScreenshotInThe'), onClick: () => view.screenshot && openFile(view.screenshot) },
      url ? h('img', { src: url, alt: t('main.pageScreenshotAtPx', { width: view.width }) }) : h('span', { className: 'fig-tool-blank' }),
      h('span', null, label))
    }

    /** `无问题`, or the counts that are not zero. */
    function problems(meta) {
      const parts = []
      if (meta.loadError) parts.push(t('main.loadFailed'))
      /** @param {number} n @param {'consoleErrors' | 'failedRequests' | 'overflows' | 'brokenImages' | 'failedSteps' | 'notCaptured'} problem */
      const count = (n, problem) => { if (n) parts.push(t(`main.problem.${problem}.${n === 1 ? 'one' : 'other'}`, { n })) }
      count(meta.consoleErrors, 'consoleErrors')
      count(meta.failedRequests, 'failedRequests')
      count(meta.views.filter(view => view.overflowX > 0).length, 'overflows')
      count(meta.views.reduce((sum, view) => sum + view.brokenImages, 0), 'brokenImages')
      count(meta.failedSteps, 'failedSteps')
      count(meta.views.filter(view => view.error).length, 'notCaptured')
      return parts.length ? parts.join(t('main.problemSeparator')) : t('main.noProblemsFound')
    }

    function PreviewView(owner) {
      const meta = metaOf(owner, 'fig-preview')
      const target = shortTarget(meta?.target ?? String(argsOf(owner).target ?? ''), owner.cwd)
      const output = owner.phase === 'result' ? resultText(owner.block) : ''
      return h(Row, { owner, tool: 'preview', title: t('main.preview'),
        summary: [target, meta ? problems(meta) : undefined].filter(Boolean).join(' · '),
        strip: meta?.views.length ? meta.views.map(view => h(Shot, { key: view.width, view, openFile: owner.openFile })) : undefined },
      output ? h(Text, null, output) : undefined)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) { install(ctx); registerToolView(ctx, 'preview', PreviewView) }
    }
  }
})

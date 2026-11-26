import { useEffect, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { appearancePreference, type FigBridge, type ServiceState } from '../shared/protocol'
import wordmark from '../../../assets/brand/wordmark.svg'
import reverseWordmark from '../../../assets/brand/wordmark-reverse.svg'
import './style.css'

declare global { interface Window { fig: FigBridge } }

// The first state arrives from main at once; an empty message avoids flashing text in the wrong language.
const initial: ServiceState = { phase: 'checking', message: '', logs: [] }
const initialAppearance = appearancePreference(new URLSearchParams(location.search).get('appearance'))

function Startup() {
  const [state, setState] = useState<ServiceState>(initial)
  const [actionError, setActionError] = useState('')
  const [seconds, setSeconds] = useState(0)
  const choosing = state.startupChoice !== undefined
  const cowork = state.cowork?.screen
  const busy = !choosing && !cowork && ['idle', 'checking', 'starting', 'stopping'].includes(state.phase)
  const ready = state.workbenchAvailable === true
  const appearance = state.appearance ?? initialAppearance
  const english = state.language === 'en'
  const t = (zh: string, en: string) => english ? en : zh
  useLayoutEffect(() => { document.documentElement.dataset.appearance = appearance }, [appearance])
  useLayoutEffect(() => { document.documentElement.lang = english ? 'en' : 'zh-CN' }, [english])
  useEffect(() => {
    let alive = true
    const unsubscribe = window.fig.onState(next => { if (alive) setState(next) })
    void window.fig.getState().then(next => { if (alive) setState(next) })
    return () => { alive = false; unsubscribe() }
  }, [])
  useEffect(() => {
    if (!busy) return
    setSeconds(0)
    const timer = setInterval(() => setSeconds(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [busy])
  async function action(run: () => Promise<void>, failure = t('操作未完成，请稍后重试。', 'That did not finish. Try again shortly.')) {
    setActionError('')
    try { await run() } catch { setActionError(failure) }
  }
  const unusable = t('无法使用这个目录，请确认它可以读写，或换一个目录。', 'This folder cannot be used. Make sure it can be read and written, or choose another.')
  const failed = state.phase === 'failed'
  const recovering = state.workbenchRecovery !== undefined
  const plugins = failed ? state.pluginFailure : undefined
  return <main className="startup" hidden={ready}>
    <section className="panel" aria-labelledby="startup-title">
      <div className="identity">
        <div className="wordmark-row">
          <picture className="wordmark">
            {appearance === 'system' && <source media="(prefers-color-scheme: dark)" srcSet={reverseWordmark} />}
            <img src={appearance === 'dark' ? reverseWordmark : wordmark} alt="Fig Desktop" width="260" height="56" />
          </picture>
          {state.appVersion && <span className="app-version">v{state.appVersion}</span>}
        </div>
        <p className="tagline">{t('内有万千，自在桌面。', 'Intelligence, from within.')}</p>
      </div>
      {cowork ? <div className="startup-content">
        <h1 id="startup-title">{cowork === 'waiting' ? t('等待邀请', 'Waiting for an invitation')
          : cowork === 'signing-in' ? t('正在连接 Cowork', 'Connecting to Cowork')
          : cowork === 'expired' ? t('重新登录 Cowork', 'Sign in to Cowork again') : t('Cowork 暂不可用', 'Cowork is unavailable')}</h1>
        <p className="description">{cowork === 'waiting' ? t('请让组织管理员向你的账号发送邀请。接受邀请后，回到这里重新检查。', 'Ask your organization administrator to invite you. After accepting the invitation, check again here.')
          : cowork === 'signing-in' ? t('如果浏览器打开了登录页，请完成登录，然后回到 Fig。', 'If a sign-in page opens in your browser, finish signing in and return to Fig.')
          : cowork === 'expired' ? t('请重新认证后继续使用协作版。', 'Sign in again to continue using the team edition.')
          : t('检查网络连接后重新尝试。', 'Check your connection and try again.')}</p>
        <div className="actions">
          {cowork === 'expired' && <button className="primary" onClick={() => void action(() => window.fig.editionAction('team'))}>{t('重新登录', 'Sign In Again')}</button>}
          {(cowork === 'waiting' || cowork === 'unavailable') && <button className="primary" onClick={() => void action(() => window.fig.editionAction('check'))}>{t('重新检查', 'Check Again')}</button>}
          <button onClick={() => void action(() => window.fig.editionAction('personal'))}>{t('回到个人版', 'Return to Personal')}</button>
        </div>
        {actionError && <p className="action-error" role="alert">{actionError}</p>}
      </div> : choosing ? <div className="startup-content">
        <h1 id="startup-title">{t('选择启动目录', 'Choose a startup folder')}</h1>
        <p className="description">{t('Fig 在这个目录启动 DSH，新会话默认在这里工作，DSH 的写入权限也以它为界。以后可以在「设置 › 运行环境」中更改。', 'Fig starts DSH in this folder. New sessions work here by default, and DSH can write only inside it. You can change it later in Settings › Runtime.')}</p>
        <p className="choice-path" title={state.startupChoice!.suggested}>{state.startupChoice!.suggested}</p>
        <div className="actions">
          <button className="primary" onClick={() => void action(() => window.fig.chooseStartup('suggested'), unusable)}>{t('使用此目录', 'Use This Folder')}</button>
          <button onClick={() => void action(() => window.fig.chooseStartup('browse'), unusable)}>{t('选择其他目录…', 'Choose Another Folder…')}</button>
        </div>
        {actionError && <p className="action-error" role="alert">{actionError}</p>}
      </div> : <div className="startup-content">
        <h1 id="startup-title">{failed ? state.message : recovering ? t('正在恢复工作台', 'Recovering the workbench') : t('打开工作台', 'Opening the workbench')}</h1>
        {plugins ? <div className="description">
          <p className="plugin-lead">{plugins.required.length
            ? t('下面的插件在工作台启动时出错。其中有本 Profile 的必装插件，不能停用；可以只在本次启动暂停它们，依赖它们的功能随之停用并显示原因，下次启动会重新加载。', 'These plugins failed while the workbench started. Some are required by this Profile and cannot be turned off; you can pause them for this launch only. Features that depend on them stop and show why, and the next start loads them again.')
            : plugins.disablable.length
            ? t('下面的插件在工作台启动时出错，工作台因此没有打开。停用后插件仍留在本机，以后可在「插件」页重新开启。', 'These plugins failed while the workbench started, so it did not open. Turned off, they stay installed and can be turned on again on the Plugins page.')
            : t('下面的插件在工作台启动时出错。它们属于 DSH 或 Fig 本身，无法在这里停用，请展开诊断或重新尝试。', 'These plugins failed while the workbench started. They belong to DSH or Fig and cannot be turned off here; open the diagnostics or try again.')}</p>
          <ul className="plugin-list">{(plugins.plugins.length ? plugins.plugins : [t('未知插件', 'Unknown plugin')]).map(name => <li key={name}>{name}</li>)}</ul>
        </div> : <p className="description">{failed ? state.error : recovering ? t('工作台页面已停止，Fig 会重新打开它。', 'The workbench page stopped. Fig will reopen it.') : state.directoryChange ? t('正在修改目录设置。', 'Changing folder settings.') : t('正在为你准备工作环境。', 'Getting your workspace ready.')}</p>}
        <div className={`status ${failed ? 'status-error' : ''}`} role={failed ? 'alert' : 'status'} aria-live="polite">
          {failed ? <span className="error-icon" aria-hidden="true">!</span> : <span className="spinner" aria-hidden="true" />}
          <span>{failed ? t('启动未完成', 'Startup did not finish') : state.workbenchRecovery === 'rate-limited'
            ? t('页面反复崩溃，稍后自动重试', 'The page stopped repeatedly. Fig will retry shortly.')
            : recovering ? t('正在重新打开页面', 'Reopening the page') : state.message}</span>
          {busy && <span className="elapsed" aria-hidden="true">{seconds}s</span>}
        </div>
        {busy && <p className="hint">{state.directoryChange ? t('修改目录期间请保持应用打开。', 'Keep the app open while folders change.') : t('首次启动需要下载，可能会多等一会儿。', 'The first start downloads DSH and may take a while.')}</p>}
        {failed && <div className="actions">{plugins?.required.length ? <button className="primary" onClick={() => void action(() => window.fig.disablePlugins())}>{t('本次暂停并重启', 'Pause for This Launch and Restart')}</button> : plugins?.disablable.length ? <button className="primary" onClick={() => void action(() => window.fig.disablePlugins())}>{plugins.disablable.length > 1 ? t('停用这些插件并重启', 'Turn Off These Plugins and Restart') : t('停用这个插件并重启', 'Turn Off This Plugin and Restart')}</button> : null}<button className={plugins?.disablable.length || plugins?.required.length ? '' : 'primary'} onClick={() => void action(() => window.fig.retry())}>{t('重新尝试', 'Try Again')}</button><button onClick={() => void action(() => window.fig.quit())}>{t('退出 Fig Desktop', 'Quit Fig Desktop')}</button></div>}
        {recovering && <div className="actions">
          <button onClick={() => void action(() => window.fig.retry())}>{t('重启 DSH', 'Restart DSH')}</button>
          <button onClick={() => void action(() => window.fig.quit())}>{t('退出 Fig Desktop', 'Quit Fig Desktop')}</button>
        </div>}
        {actionError && <p className="action-error" role="alert">{actionError}</p>}
        {failed && <details className="diagnostics">
          <summary>{t('查看启动诊断', 'Startup diagnostics')}{state.nodeVersion && <span>Node.js {state.nodeVersion}</span>}</summary>
          <pre tabIndex={0}>{plugins && state.error ? state.error + (state.logs.length ? '\n\n' : '') : ''}{state.logs.length ? state.logs.join('\n') : plugins ? '' : t('没有诊断日志', 'No diagnostic log')}</pre>
        </details>}
      </div>}
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<Startup />)

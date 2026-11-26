import { subscriptionModels } from '../shared/page-subscription-models.js'
import { announceSubscriptionChange, subscriptionUsage, usagePercent } from '../shared/page-subscription-usage.js'
import { install, t } from './client-locale.js'
import { nameModelGroup } from '../shared/page-model-groups.js'
import { accountPieces, button, colors as baseColors, formatTime, label, note, pageCaller } from '../shared/page-ui.js'

window.__ModuleLoader__.load({
  id: '@local/dsh-provider-chatgpt',
  factory(require) {
    const { createElement: h, useCallback, useEffect, useState, useRef } = require('react')
    const react = require('react')
    const { createPortal } = require('react-dom')
    const pollInterval = 2000
    // The Host half answers on /fig-chatgpt.
    const call = pageCaller('/fig-chatgpt', () => t('main.serviceUnavailable'), () => t('main.actionFailed'))
    const Models = subscriptionModels(react, call, t)
    const colors = { ...baseColors, accent: '#10a37f' }
    const { heading: title, Field, UsageCard } = accountPieces(h)

    function windowTitle(minutes) {
      if (minutes === 10080) return t('main.weeklyLimit')
      if (minutes && minutes % 60 === 0 && minutes < 1440) return t('main.hourLimit', { hours: minutes / 60 })
      return t('main.limit')
    }

    const SidebarUsage = subscriptionUsage(react, createPortal, {
      id: 'chatgpt', name: () => t('main.chatgptSubscription'), call, glyph: 'C', section: 'fig-chatgpt-account',
      read: async (account, live) => {
        const limits = live ? await call('limits').catch(() => account.limits) : account.limits
        const windows = (limits?.windows ?? []).filter(window => usagePercent(window.usedPercent) != null)
        return { percent: windows.length ? Math.max(...windows.map(window => window.usedPercent)) : undefined,
          description: windows.length ? windows.map(window => windowTitle(window.minutes) + t('main.used') + window.usedPercent + '%').join('\n') + '\n' + t('main.sourceCodexMayDifferFrom') + '\n' + formatTime(limits.fetchedAt) : undefined }
      }
    })

    // Same card as the Grok weekly limit; the numbers are the ones Codex reports for this account.
    function Usage({ window, limits, updating }) {
      return h(UsageCard, { usedPercent: window.usedPercent, resetsAt: window.resetsAt, accent: colors.accent, margin: '8px 0 16px',
        source: (limits.source === 'live'
          ? t('main.limitSourceCodex') + (limits.email ? t('main.sourceAccount', { email: limits.email }) : '') + t('main.mayDifferFromTheModel') + t('main.comma') + formatTime(limits.fetchedAt)
          : t('main.fromCodexSessionRecordsSource') + formatTime(limits.fetchedAt)) +
          (updating ? t('main.updating') : '') })
    }

    function Limits({ limits, loading, refresh }) {
      if (loading && !limits) return h('div', { style: { ...note, padding: '16px 0' } }, t('main.readingLimitsFromCodex'))
      if (!limits?.windows) {
        const reason = limits?.unavailable === 'missing'
            ? t('main.codexWasNotFoundLimits')
            : t('main.couldNotReadLimitsFrom')
        return h(Field, { title: t('main.limits'), description: reason },
          h('button', { type: 'button', style: button, disabled: loading, onClick: refresh }, t('main.retry')))
      }
      return h('div', null, limits.windows.map(window => h('div', { key: String(window.minutes) },
        h('div', { style: { ...label, marginTop: 16 } }, windowTitle(window.minutes)),
        h(Usage, { window, limits, updating: loading }))))
    }

    function ChatgptAccountSection() {
      const [state, setState] = useState(/** @type {{loading?: boolean, error?: string, value?: any}} */ ({ loading: true }))
      const [signInUrl, setSignInUrl] = useState()
      const epoch = useRef(0), reads = useRef(0)
      const [busy, setBusy] = useState(false)
      const load = useCallback(async () => {
        const e = epoch.current, r = ++reads.current
        try { const value = await call('account'); if (e === epoch.current && r === reads.current) setState({value}) } catch (error) { if (e === epoch.current && r === reads.current) setState({error: error instanceof Error ? error.message : String(error)}) }
      }, [])
      useEffect(() => { void load(); return () => {epoch.current++} }, [load])
      const value = state.value
      // The account answers at once with the limits at hand; the live read from Codex (a few seconds) follows.
      const [limits, setLimits] = useState(/** @type {{loading: boolean, value?: any}} */ ({ loading: false }))
      const loadLimits = useCallback(async (refresh = false) => {
        const e = epoch.current
        setLimits(current => ({ ...current, loading: true }))
        const result = await call('limits', { refresh }).catch(() => ({ unavailable: 'failed' }))
        if (e !== epoch.current) return
        setLimits(current => ({ loading: false, value: result.windows || !current.value?.windows ? result : current.value }))
      }, [])
      useEffect(() => {
        if (!value?.signedIn) return
        setLimits(current => current.value?.source === 'live' ? current : { loading: false, value: value.limits?.windows ? value.limits : current.value })
        void loadLimits()
      }, [value?.signedIn, loadLimits])
      // While the browser sign-in is open, poll until the grant is stored.
      useEffect(() => {
        if (!value?.signingIn) return
        const timer = setInterval(() => { void load() }, pollInterval)
        return () => clearInterval(timer)
      }, [value?.signingIn, load])

      async function signIn() {
        // Opened from the click, as DSH does, then pointed at the sign-in page; Fig hands it to the browser.
        const e = ++epoch.current
        setBusy(true)
        const popup = window.open('about:blank')
        try {
          setState(current => ({ value: { ...current.value, signingIn: true, error: undefined } }))
          const { url } = await call('login')
          if (e !== epoch.current) {popup?.close(); return}
          setSignInUrl(url)
          if (popup) popup.location.href = url
          else window.open(url)
        } catch (error) {
          popup?.close()
          if (e === epoch.current) setState({error: error instanceof Error ? error.message : String(error)})
        } finally {if (e === epoch.current) setBusy(false)}
      }

      async function act(endpoint) {
        const e = ++epoch.current
        setBusy(true); setLimits({loading: false})
        try { await call(endpoint); if (e === epoch.current) {setSignInUrl(undefined); await load()} } catch (error) { if (e === epoch.current) setState({error: error instanceof Error ? error.message : String(error)}) }
        finally { if (e === epoch.current) { setBusy(false); announceSubscriptionChange() } }
      }

      const heading = title(t('main.chatgptAccount'))
      if (state.loading) return h('div', null, heading, h('div', { style: note }, t('main.loading')))
      if (state.error) return h('div', null, heading,
        h(Field, { title: t('main.chatgptAccountActionFailed'), description: state.error },
          h('button', { type: 'button', style: button, onClick: () => load() }, t('main.retry'))))

      const signInPending = value.signingIn && h('div', { style: { ...note, padding: '12px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        t('main.finishSigningInToChatgpt'),
        signInUrl && h('a', { href: signInUrl, target: '_blank', rel: 'noreferrer', style: { color: colors.accent } }, t('main.browserDidNotOpenContinue')),
        h('button', { type: 'button', style: button, onClick: () => act('cancel') }, t('main.cancel')))

      const usage = h(Field, {
        title: t('main.usage'),
        description: t('main.usesYourChatgptPlanUsage')
      }, h('a', { href: 'https://chatgpt.com/settings/usage', target: '_blank', rel: 'noreferrer', style: button }, t('main.viewUsage')))

      if (!value.signedIn) return h('div', null, heading,
        h(Field, {
          title: t('main.notSignedInToChatgpt'),
          description: value.error ?? t('main.signInWithYourChatgpt')
        }, h('button', { type: 'button', style: button, disabled: busy || value.signingIn, onClick: signIn }, t('main.signInWithChatgpt'))),
        signInPending, usage)

      return h('div', null, heading,
        h(Field, { title: t('main.signedInToChatgpt') }, h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { type: 'button', style: button, disabled: busy || value.signingIn, onClick: signIn }, t('main.signInAgain')),
          h('button', { type: 'button', style: button, disabled: busy, onClick: () => act('logout') }, t('main.signOut')))),
        signInPending, h(Models, { key: value.profile?.email ?? value.email }),
        value.checkedAt && h('p', {style: note}, t('main.authorizationReadAt') + formatTime(value.checkedAt)),
        limits.value?.plan && h('div', { style: { ...note, paddingTop: 12 } }, t('main.plan') + limits.value.plan.replace(/^./, c => c.toUpperCase())),
        h(Limits, { limits: limits.value, loading: limits.loading, refresh: () => loadLimits(true) }),
        usage)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        install(ctx)
        // The model picker shows this subscription's group under its page-language name.
        ctx.effect(() => nameModelGroup(require, 'fig-chatgpt', () => t('main.modelGroup')))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'fig-chatgpt-usage', order: -19
        }, () => h(SidebarUsage, { ctx })))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'fig-chatgpt-account', order: -8,
          label: () => t('main.chatgptAccount')
        }, ChatgptAccountSection))
      }
    }
  }
})

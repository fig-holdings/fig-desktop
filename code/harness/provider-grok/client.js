import { subscriptionModels } from '../shared/page-subscription-models.js'
import { announceSubscriptionChange, subscriptionUsage } from '../shared/page-subscription-usage.js'
import { install, t } from './client-locale.js'
import { nameModelGroup } from '../shared/page-model-groups.js'
import { accountPieces, button, colors as baseColors, formatTime, label, note, pageCaller, row } from '../shared/page-ui.js'

window.__ModuleLoader__.load({
  id: '@local/dsh-provider-grok',
  factory(require) {
    const { createElement: h, useCallback, useEffect, useState, useRef } = require('react')
    const react = require('react')
    const { createPortal } = require('react-dom')
    const pollInterval = 3000
    // The Host half answers on /fig-grok.
    const call = pageCaller('/fig-grok', () => t('main.serviceUnavailable'), () => t('main.readFailed'))
    const Models = subscriptionModels(react, call, t)
    const colors = { ...baseColors, accent: '#ff6a1a' }
    const { heading: title, Field, UsageCard } = accountPieces(h)

    const SidebarUsage = subscriptionUsage(react, createPortal, {
      id: 'grok', name: () => t('main.grokSubscription'), call, glyph: 'G', section: 'fig-grok-account',
      read: async (account, live) => {
        const billing = (live ? (await call('billing').catch(() => ({}))).billing : undefined) ?? account.billing
        return { percent: billing?.usedPercent, description: billing
          ? t('main.used') + billing.usedPercent + '% · ' + (billing.period === 'weekly' ? t('main.weeklyLimit') : t('main.limit')) + '\n' + t('main.sourceGrokCliSourceAccount') + '\n' + formatTime(billing.fetchedAt)
          : undefined }
      }
    })

    // billingFrom always sets periodEnd, so the reset time always shows.
    function Usage({ billing, updating }) {
      return h(UsageCard, { usedPercent: billing.usedPercent, resetsAt: billing.periodEnd, accent: colors.accent, margin: '16px 0',
        source: (billing.source === 'live'
          ? t('main.readFromTheGrokCli') + formatTime(billing.fetchedAt)
          : t('main.fromGrokCliLogsSource') + formatTime(billing.fetchedAt)) +
          (updating ? t('main.updating') : '') })
    }

    function GrokAccountSection() {
      const [state, setState] = useState(/** @type {{loading?: boolean, error?: string, value?: any}} */ ({ loading: true }))
      const [signInUrl, setSignInUrl] = useState()
      const [busy, setBusy] = useState(false)
      const epoch = useRef(0), reads = useRef(0)
      // The account shows at once with the billing at hand; live billing from the CLI follows.
      const load = useCallback(async refresh => {
        const e = epoch.current, r = ++reads.current
        let value
        try { value = await call('account') } catch (error) { if (e === epoch.current && r === reads.current) setState({error: error instanceof Error ? error.message : String(error)}); return }
        if (e !== epoch.current || r !== reads.current) return
        setState({ value: { ...value, updating: value.signedIn } })
        if (!value.signedIn) return
        const live = await call('billing', { refresh }).catch(() => ({}))
        if (e !== epoch.current || r !== reads.current) return
        setState(current => current.value?.signedIn ? { value: { ...current.value, ...live, updating: false } } : current)
      }, [])
      useEffect(() => { void load(false); return () => { epoch.current++ } }, [load])
      const value = state.value
      // While the CLI waits for the browser, poll until auth.json changes.
      useEffect(() => {
        if (!value?.signingIn) return
        const timer = setInterval(() => { void load(false) }, pollInterval)
        return () => clearInterval(timer)
      }, [value?.signingIn, load])

      async function signIn() {
        const e = ++epoch.current
        setBusy(true)
        try {
          setState(current => ({value: {...current.value, signingIn: true}}))
          const {url} = await call('login')
          if (e === epoch.current) { setSignInUrl(url); await load(false) }
        } catch (error) { if (e === epoch.current) setState({error: error instanceof Error ? error.message : String(error)}) }
        finally { if (e === epoch.current) { setBusy(false); announceSubscriptionChange() } }
      }
      async function act(endpoint) {
        const e = ++epoch.current
        setBusy(true)
        try { await call(endpoint); if (e === epoch.current) { setSignInUrl(undefined); await load(false) } }
        catch (error) { if (e === epoch.current) setState({error: error instanceof Error ? error.message : String(error)}) }
        finally { if (e === epoch.current) { setBusy(false); announceSubscriptionChange() } }
      }
      const heading = title(h('span', {style: {display: 'inline-flex', alignItems: 'center', gap: 8}},
        h('svg', {width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, 'data-fig-grok-symbol': ''},
          h('path', {d: 'M20 6A9 9 0 1 0 21 13H13M8 16L20 4', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round'})),
        t('main.grokAccount')))
      if (state.loading) return h('div', null, heading, h('div', { style: note }, t('main.loading')))
      if (state.error) return h('div', null, heading,
        h(Field, { title: t('main.couldNotReadTheGrok'), description: state.error },
          h('button', { type: 'button', style: button, onClick: () => load(true) }, t('main.retry'))))

      if (value.state === 'unknown') return h('div', null, heading, h(Field, {title: t('main.authorizationStatusUnknown'), description: t('main.couldNotReadLocalAuthorization')}, h('button', {type: 'button', style: button, onClick: () => load(true)}, t('main.refresh'))))

      const signInPending = value.signingIn && h('div', { style: { ...note, padding: '12px 0' } },
        t('main.finishSigningInToGrok'),
        h('button', {type: 'button', style: button, onClick: () => act('cancel')}, t('main.cancelSignIn')),
        signInUrl && h('a', { href: signInUrl, target: '_blank', rel: 'noreferrer', style: { marginLeft: 8, color: colors.accent } }, t('main.browserDidNotOpenContinue')))

      if (!value.signedIn) return h('div', null, heading,
        h(Field, {
          title: t('main.notSignedInToGrok'),
          description: t('main.signInThroughTheOfficial')
        }, h('button', { type: 'button', style: button, disabled: busy || value.signingIn, onClick: signIn }, t('main.signInToGrok'))),
        signInPending)

      const { profile, billing } = value
      return h('div', null, heading,
        h('div', { style: row },
          h('div', { style: { width: 40, height: 40, borderRadius: 20, background: colors.accent, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, flex: 'none' } }, profile.initials),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { ...label, display: 'flex', gap: 8, alignItems: 'center' } }, profile.name ?? profile.email ?? t('main.accountUnknown'),
              billing?.tier && h('span', { style: { fontSize: 11, padding: '1px 8px', borderRadius: 10, border: '.5px solid ' + colors.accent, color: colors.accent } }, billing.tier)),
            h('div', { style: note }, [profile.name && profile.email, profile.team ? t('main.teamAccount') : t('main.personalAccount')].filter(Boolean).join(' · '))),
          h('div', {style: {display: 'flex', gap: 8}},
            h('button', {type: 'button', style: button, disabled: busy || value.signingIn, onClick: signIn}, t('main.signInAgain')),
            h('button', {type: 'button', style: button, disabled: busy, onClick: () => act('logout')}, t('main.signOut')))),
        signInPending, h(Models, { key: value.profile?.email ?? value.email }),
        value.checkedAt && h('p', {style: note}, t('main.authorizationReadAt') + formatTime(value.checkedAt)),
        billing
          ? h('div', null,
            h('div', { style: { ...label, marginTop: 16 } }, billing.period === 'weekly' ? t('main.weeklyLimit') : t('main.limit')),
            h(Usage, { billing, updating: value.updating }))
          : h(Field, { title: t('main.limit'), description: value.updating ? t('main.readingTheAllowance')
            : t('main.theAllowanceIsNotAvailable') }),
        billing?.prepaidBalance !== undefined && h(Field, { title: t('main.extraUsageCredits') },
          h('span', { style: label }, '$' + billing.prepaidBalance.toFixed(2))),
        h(Field, { title: t('main.zeroDataRetention') }, h('span', { style: note }, profile.zeroDataRetention ? t('main.on') : t('main.off'))),
        h(Field, { title: t('main.codingDataForTraining') }, h('span', { style: note }, profile.codingDataOptOut ? t('main.optedOut') : t('main.shared'))),
        h(Field, { title: t('main.usageAndBilling'), description: t('main.manageYourPlanBillingAnd') },
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'button', style: button, onClick: () => load(true) }, t('main.refresh')),
            h('a', { href: 'https://grok.com', target: '_blank', rel: 'noreferrer', style: button }, t('main.manageOnGrokCom')))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        install(ctx)
        // The model picker shows this subscription's group under its page-language name.
        ctx.effect(() => nameModelGroup(require, 'fig-grok-oauth', () => t('main.modelGroup')))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'fig-grok-usage', order: -20
        }, () => h(SidebarUsage, { ctx })))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'fig-grok-account', order: -9,
          label: () => t('main.grokAccount')
        }, GrokAccountSection))
      }
    }
  }
})

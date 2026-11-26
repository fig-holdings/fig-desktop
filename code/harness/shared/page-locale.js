// Fig's page text goes through DSH's locale service (`ctx.locale`, DSH 0.2.2): each page plugin registers its own
// namespace with a zh and an en dictionary and reads its text with `t(key, { params })` when it renders, so a
// language switch redraws without a reload (DSH redraws every slot outlet on a switch). Fig offers Chinese and
// English only (desktop-skin/client-languages.js). English plurals take two keys, `…one` and `…other`, and the
// caller picks one by the count. The Electron main process and the startup page keep their own `uiText`; text
// written for the Agent (instructions, quoted comments) is not interface text and still follows a `language` flag
// taken from `isZh()`.
//
// A plugin keeps its dictionaries in its `client-locale.js`:
//   const zh = { 'main.title': '标题' }
//   /** @type {{ [K in keyof typeof zh]: string }} */
//   const en = { 'main.title': 'Title' }
//   export const { t, install } = pageLocale('fig.<plugin>', zh, en)
// so a key missing from either dictionary, or a `t` key in neither, fails `npm run typecheck`. Its client's
// `apply(ctx)` calls `install(ctx)` with 'locale' injected.

/** Text the shared page modules draw; part of every plugin's dictionaries, since each bundle carries them. */
const sharedZh = {
  'shared.listSeparator': '、',
  'shared.used': '已用',
  'shared.resetsAt': '重置于 {time}',
  'shared.usageUnavailable': '用量暂不可用',
  'shared.running': '运行中…'
}
/** @type {{ [K in keyof typeof sharedZh]: string }} */
const sharedEn = {
  'shared.listSeparator': ', ',
  'shared.used': 'used',
  'shared.resetsAt': 'Resets {time}',
  'shared.usageUnavailable': 'Usage unavailable',
  'shared.running': 'Running…'
}

/** @typedef {keyof typeof sharedZh} SharedKey */
/** @typedef {Record<string, string | number>} TextParams */

// One page plugin per bundle: these belong to the plugin this copy of the module is bundled into.
/** @type {any} DSH's locale service once the plugin applies */
let runtime
/** @type {((key: string, params?: TextParams) => string) | undefined} the plugin's namespace, for shared modules */
let bundleText

const format = (template, params) =>
  params ? template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match) : template

/** Whether the page shows Chinese: DSH's active locale, or `<html lang>` before the plugin applies. */
export function isZh() {
  if (runtime) return runtime.getSnapshot().active === 'zh'
  return typeof document !== 'undefined' && /^zh/i.test(document.documentElement.lang)
}

/**
 * The page plugin's dictionaries in namespace `ns`; `en` must carry exactly `zh`'s keys.
 * @template {Record<string, string>} D
 * @param {string} ns @param {D} zh @param {{ [K in keyof D]: string }} en
 */
export function pageLocale(ns, zh, en) {
  const dictionaries = { zh: { ...sharedZh, ...zh }, en: { ...sharedEn, ...en } }
  /** @type {((key: string, params?: TextParams) => string) | undefined} */
  let bound
  return {
    /**
     * The text for `key` in the page's language, `{name}` placeholders filled from `params`.
     * @param {Extract<keyof D, string> | SharedKey} key @param {TextParams} [params]
     */
    t: (key, params) => bound ? bound(key, params) : fallback(dictionaries, key, params),
    /** Registers the dictionaries with DSH for as long as the plugin is loaded. */
    install(ctx) {
      ctx.effect(() => ctx.locale.register(ns, dictionaries), 'fig: ' + ns + ' dictionaries')
      runtime = ctx.locale
      bound = bundleText = ctx.locale.bind(ns)
    }
  }
}

/** Shared modules' text, from the dictionaries of the plugin they are bundled into. */
export const sharedText = /** @type {(key: SharedKey, params?: TextParams) => string} */ ((key, params) =>
  bundleText ? bundleText(key, params) : fallback({ zh: sharedZh, en: sharedEn }, key, params))

/** Before the plugin applies (and in unit tests): the same dictionaries, by `<html lang>`. */
function fallback(dictionaries, key, params) {
  return format((isZh() ? dictionaries.zh : dictionaries.en)[key] ?? key, params)
}

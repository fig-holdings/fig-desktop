import { pageRoute, registerPageRoute, RouteError } from '../shared/http.js'
import { braveSearch, unsupportedSearch } from '../shared/native-search.js'
import { uiText } from '../shared/ui-text.ts'
import { searchModelRoute } from './model-route.js'

export const inject = ['web']
const follow = 'fig-follow-model'
const independent = 'fig-brave-search'
const keyRef = 'BRAVE_SEARCH_API_KEY'
const prefix = '/fig-web-search'

export function apply(ctx, config = {}) {
  const team = config.team === true
  const organization = Array.isArray(config.organizationProviders) ? config.organizationProviders : []
  const currentModel = (request, signal) => {
    const route = ctx.get('agents')?.currentInitiator()?.session.requestContext()
    if (!route?.model || !request.llmProvider || request.llmProvider !== route.provider || (team &&
      (route.provider === 'deepseek-account' || organization.includes(route.provider)))) throw unsupportedSearch()
    return searchModelRoute(ctx, route, request, signal)
  }
  if (team) ctx.provide('figNativeModelSearch', { search: currentModel })
  ctx.web.registerSearchProvider({
    id: follow, title: uiText('跟随当前模型', 'Follow current model'),
    description: { zh: '通过本次会话所选的模型接入执行搜索，使用该账号的额度。',
      en: 'Search through the current conversation’s model connection and account.' },
    available: () => true,
    async search(request, signal) {
      const controller = team && ctx.get('figCoworkSearch')
      return controller ? controller.search(request, signal) : currentModel(request, signal)
    }
  })
  if (!team) ctx.web.registerSearchProvider({
    id: independent, title: uiText('使用独立搜索服务（Brave）', 'Independent search (Brave)'),
    description: { zh: '使用个人 Brave Search API Key。在 Fig 的联网搜索设置中配置。',
      en: 'Uses your Brave Search API key. Configure it in Fig’s Web search settings.' },
    available: () => true,
    search: async (request, signal) => braveSearch((await ctx.get('credentials')?.resolve(keyRef))?.value, request, signal)
  })
  ctx.inject(['settings', 'credentials'], scope => {
    registerPageRoute(scope, prefix, 'Fig web search settings', (connection, req, res) => settingsRoute(connection, req, res, {scope, team}))
  })
}

const settingsRoute = pageRoute({
  prefix,
  endpoints: {
    async status(_, {scope: ctx, team}) {
      if (team) return { managed: true }
      const web = ctx.settings.describe().find(item => item.ns === 'web')
      return { selected: web?.value.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null,
        configured: (await ctx.credentials.describe(keyRef)).configured }
    },
    async select({ mode }, {scope: ctx, team}) {
      if (team) throw new RouteError(403, 'COWORK_SEARCH_MANAGED')
      if (![follow, independent].includes(mode)) throw new RouteError(400, 'UNKNOWN_MODE')
      await ctx.settings.update('web', { searchProvider: mode })
    },
    async key({ key }, {scope: ctx, team}) {
      if (team) throw new RouteError(403, 'COWORK_SEARCH_MANAGED')
      if (typeof key !== 'string' || !key.trim() || /[\s\x00-\x1f]/.test(key.trim())) throw new RouteError(400, 'INVALID_KEY')
      await ctx.credentials.set(keyRef, key.trim())
    },
    async clear(_, {scope: ctx, team}) {
      if (team) throw new RouteError(403, 'COWORK_SEARCH_MANAGED')
      await ctx.credentials.unset(keyRef)
    }
  },
  failure: () => ({ code: 'WEB_SEARCH_SETTINGS' })
})

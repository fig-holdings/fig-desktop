import { pageLocale } from '../shared/page-locale.js'

// This plugin's page text in DSH's locale service (see shared/page-locale.js); en carries exactly zh's keys.

const zh = {
  'rules.ruleSources': '规则来源',
  'rules.included': '已包含',
  'rules.truncated': '已截断',
  'rules.tooLargeNotRead': '超大，未读取',
  'rules.omittedByBudget': '预算省略',
  'rules.unknown': '未知',
  'rules.versionUnknown': '版本未知',
  'rules.noConfirmedSharedSources': '没有可确认的共享来源。',
  'rules.close': '关闭',
  'rules.refreshList': '刷新清单',
  'rules.loading': '正在读取…',
  'rules.couldNotReadRulesRefresh': '无法读取。请刷新重试。',
  'rules.figSharedRulesMatchThe': 'Fig共享规则与最近注入版本一致。',
  'rules.filesChangedTheLastInjected': '当前文件已变化；最近注入仍是旧版本，下一步执行时刷新。',
  'rules.injectedSourcesAreUnknownOpen': '注入来源未知。打开并继续会话后可核实。',
  'rules.currentFolder': '当前目录：',
  'rules.folderAtInjection': '注入时目录：',
  'rules.lastInjectedFigSharedLayer': '最近注入 · Fig共享层',
  'rules.theInstructionsPackageIsOff': '指令包已关闭，不会注入规则文件',
  'rules.currentFilesNextStep': '当前文件 · 下一次执行',
  'rules.dshProjectLayer': 'DSH项目层',
  'rules.sourcesCannotBeConfirmedStructurally': '来源无法结构化确认；此清单不推测项目层是否已注入。',
  'rules.figBehaviorGuidanceVersion': 'Fig行为指引版本：',
  'rules.readAt': '读取于 '
}

/** @type {{ [K in keyof typeof zh]: string }} */
const en = {
  'rules.ruleSources': 'Rule sources',
  'rules.included': 'Included',
  'rules.truncated': 'Truncated',
  'rules.tooLargeNotRead': 'Too large; not read',
  'rules.omittedByBudget': 'Omitted by budget',
  'rules.unknown': 'Unknown',
  'rules.versionUnknown': 'Version unknown',
  'rules.noConfirmedSharedSources': 'No confirmed shared sources.',
  'rules.close': 'Close',
  'rules.refreshList': 'Refresh list',
  'rules.loading': 'Loading…',
  'rules.couldNotReadRulesRefresh': 'Could not read rules. Refresh to retry.',
  'rules.figSharedRulesMatchThe': 'Fig shared rules match the last injected version.',
  'rules.filesChangedTheLastInjected': 'Files changed; the last injected version is older and refreshes on the next step.',
  'rules.injectedSourcesAreUnknownOpen': 'Injected sources are unknown. Open and continue this session to verify.',
  'rules.currentFolder': 'Current folder: ',
  'rules.folderAtInjection': 'Folder at injection: ',
  'rules.lastInjectedFigSharedLayer': 'Last injected · Fig shared layer',
  'rules.theInstructionsPackageIsOff': 'The instructions package is off; rule files are not injected',
  'rules.currentFilesNextStep': 'Current files · Next step',
  'rules.dshProjectLayer': 'DSH project layer',
  'rules.sourcesCannotBeConfirmedStructurally': 'Sources cannot be confirmed structurally; this list does not infer whether project rules were injected.',
  'rules.figBehaviorGuidanceVersion': 'Fig behavior guidance version: ',
  'rules.readAt': 'Read at '
}

export const { t, install } = pageLocale('fig.rule-sources', zh, en)

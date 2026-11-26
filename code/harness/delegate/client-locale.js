import { pageLocale } from '../shared/page-locale.js'

// This plugin's page text in DSH's locale service (see shared/page-locale.js); en carries exactly zh's keys.

const zh = {
  'main.externalAgent': '外部智能体',
  'main.findings.one': '{count} 条发现',
  'main.findings.other': '{count} 条发现',
  'main.noProblemsFound': '未发现问题',
  'main.delegate': '委派',
  'main.severity.high': '高',
  'main.severity.medium': '中',
  'main.severity.low': '低'
}

/** @type {{ [K in keyof typeof zh]: string }} */
const en = {
  'main.externalAgent': 'External agent',
  'main.findings.one': '{count} finding',
  'main.findings.other': '{count} findings',
  'main.noProblemsFound': 'no problems found',
  'main.delegate': 'Delegate',
  'main.severity.high': 'High',
  'main.severity.medium': 'Medium',
  'main.severity.low': 'Low'
}

export const { t, install } = pageLocale('fig.delegate', zh, en)

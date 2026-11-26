import { pageLocale } from '../shared/page-locale.js'

// This plugin's page text in DSH's locale service (see shared/page-locale.js); en carries exactly zh's keys.

const zh = {
  'main.untitled': '未命名',
  'main.archivedOrUnavailable': '已归档或不可用',
  'main.running': '运行中',
  'main.stopped': '已停止',
  'main.newSession': '新会话',
  'main.open': '打开'
}

/** @type {{ [K in keyof typeof zh]: string }} */
const en = {
  'main.untitled': 'Untitled',
  'main.archivedOrUnavailable': 'Archived or unavailable',
  'main.running': 'Running',
  'main.stopped': 'Stopped',
  'main.newSession': 'New session',
  'main.open': 'Open'
}

export const { t, install } = pageLocale('fig.handoff', zh, en)

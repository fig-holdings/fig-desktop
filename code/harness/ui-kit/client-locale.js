import { pageLocale } from '../shared/page-locale.js'

// This plugin's page text in DSH's locale service (see shared/page-locale.js); en carries exactly zh's keys.

const zh = {
  'components.less': '少',
  'components.more': '多'
}

/** @type {{ [K in keyof typeof zh]: string }} */
const en = {
  'components.less': 'Less',
  'components.more': 'More'
}

export const { t, install } = pageLocale('fig.ui-kit', zh, en)

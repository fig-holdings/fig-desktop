import { pageLocale } from '../shared/page-locale.js'

// This plugin's page text in DSH's locale service (see shared/page-locale.js); en carries exactly zh's keys.

const zh = {
  'queue.stopEndsThisTurnQueued': '停止本轮，已排队消息保留，后续可能继续。',
  'settings.couldNotReadThisSetting': '无法读取此设置。',
  'settings.couldNotSaveThisSetting': '无法保存此设置。',
  'settings.nextStepHint': '下一步提示',
  'settings.composer': '输入框',
  'settings.afterEachTurnTheSessions': '每轮结束后用当前会话的模型生成一句你可能要发的下一句话，灰字显示在空输入框里，按 Tab 填入。每轮多一次小调用。'
}

/** @type {{ [K in keyof typeof zh]: string }} */
const en = {
  'queue.stopEndsThisTurnQueued': 'Stop ends this turn. Queued messages are kept and may run later.',
  'settings.couldNotReadThisSetting': 'Could not read this setting.',
  'settings.couldNotSaveThisSetting': 'Could not save this setting.',
  'settings.nextStepHint': 'Next-step hint',
  'settings.composer': 'Composer',
  'settings.afterEachTurnTheSessions': 'After each turn the session\'s model suggests a likely next message, greyed in the empty composer; Tab fills it in. One small extra call per turn.'
}

export const { t, install } = pageLocale('fig.composer', zh, en)

import { pageLocale } from '../shared/page-locale.js'

// This plugin's page text in DSH's locale service (see shared/page-locale.js); en carries exactly zh's keys.

const zh = {
  'side-chat.theMainSessionIsRunning': '主会话正在运行，空闲后再发。',
  'side-chat.theMainSessionHasQueued': '主会话还有排队消息，队列清空后再发。',
  'side-chat.theMainSessionIsWaiting': '主会话正在等待输入，请先处理。',
  'side-chat.couldNotConfirmTheMain': '无法确认主会话状态，请稍后再试。',
  'side-chat.aMessageIsAlreadyBeing': '已有内容正在发送，请稍候。',
  'side-chat.shortenTheTextBeforeSending': '内容太长，请缩短后再发。',
  'side-chat.sendingFailedYourDraftIs': '发送失败，草稿已保留。',
  'side-chat.sendToMainSession': '发到主会话',
  'side-chat.youCanEditTheText': '可先修改内容。主会话空闲时才能发送。',
  'side-chat.textForTheMainSession': '发到主会话的内容',
  'side-chat.cancel': '取消',
  'side-chat.sending': '发送中…',
  'side-chat.send': '发送 ⌘↩',
  'side-chat.sentToMainSession': '已发到主会话',
  'side-chat.couldNotLoadRetry': '读取失败，重试',
  'side-chat.loading': '读取中…',
  'side-chat.running': '运行中',
  'side-chat.idle': '空闲',
  'side-chat.mainSession': '主会话：',
  'side-chat.untitled': '未命名会话',
  'side-chat.openASessionFirstThen': '请先打开一个会话，再开侧边聊天。',
  'side-chat.couldNotOpenTheSide': '无法打开侧边聊天，请重试。',
  'side-chat.openingTheSideChat': '正在打开侧边聊天…',
  'side-chat.sideChat': '侧边聊天',
  'side-chat.openASessionFirst': '请先打开一个会话',
  'side-chat.askWithoutInterruptingTheMain': '不打断主会话，另开一个只读对话'
}

/** @type {{ [K in keyof typeof zh]: string }} */
const en = {
  'side-chat.theMainSessionIsRunning': 'The main session is running. Try when it is idle.',
  'side-chat.theMainSessionHasQueued': 'The main session has queued messages. Try when the queue is empty.',
  'side-chat.theMainSessionIsWaiting': 'The main session is waiting for input. Handle it first.',
  'side-chat.couldNotConfirmTheMain': 'Could not confirm the main session state. Try again shortly.',
  'side-chat.aMessageIsAlreadyBeing': 'A message is already being sent.',
  'side-chat.shortenTheTextBeforeSending': 'Shorten the text before sending.',
  'side-chat.sendingFailedYourDraftIs': 'Sending failed. Your draft is still here.',
  'side-chat.sendToMainSession': 'Send to main session',
  'side-chat.youCanEditTheText': 'You can edit the text before sending. The main session must be idle.',
  'side-chat.textForTheMainSession': 'Text for the main session',
  'side-chat.cancel': 'Cancel',
  'side-chat.sending': 'Sending…',
  'side-chat.send': 'Send ⌘↩',
  'side-chat.sentToMainSession': 'Sent to main session',
  'side-chat.couldNotLoadRetry': 'Could not load. Retry',
  'side-chat.loading': 'Loading…',
  'side-chat.running': 'running',
  'side-chat.idle': 'idle',
  'side-chat.mainSession': 'Main session: ',
  'side-chat.untitled': 'Untitled',
  'side-chat.openASessionFirstThen': 'Open a session first, then start a side chat.',
  'side-chat.couldNotOpenTheSide': 'Could not open the side chat. Try again.',
  'side-chat.openingTheSideChat': 'Opening the side chat…',
  'side-chat.sideChat': 'Side chat',
  'side-chat.openASessionFirst': 'Open a session first',
  'side-chat.askWithoutInterruptingTheMain': 'Ask without interrupting the main session'
}

export const { t, install } = pageLocale('fig.side-chat', zh, en)

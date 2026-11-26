import { pageLocale } from '../shared/page-locale.js'

// This plugin's page text in DSH's locale service (see shared/page-locale.js); en carries exactly zh's keys.

const zh = {
  'main.pxNotCaptured': '{width}px 未截到',
  'main.pxOverflowsPx': '{width}px · 横向溢出 {overflowX}px',
  'main.openTheScreenshotInThe': '在右侧栏打开截图',
  'main.pageScreenshotAtPx': '{width}px 宽的页面截图',
  'main.loadFailed': '加载失败',
  'main.problem.consoleErrors.one': '{n} 个控制台错误',
  'main.problem.consoleErrors.other': '{n} 个控制台错误',
  'main.problem.failedRequests.one': '{n} 个请求失败',
  'main.problem.failedRequests.other': '{n} 个请求失败',
  'main.problem.overflows.one': '{n} 个宽度横向溢出',
  'main.problem.overflows.other': '{n} 个宽度横向溢出',
  'main.problem.brokenImages.one': '{n} 张图片损坏',
  'main.problem.brokenImages.other': '{n} 张图片损坏',
  'main.problem.failedSteps.one': '{n} 步操作未通过',
  'main.problem.failedSteps.other': '{n} 步操作未通过',
  'main.problem.notCaptured.one': '{n} 个宽度未截到',
  'main.problem.notCaptured.other': '{n} 个宽度未截到',
  'main.problemSeparator': '，',
  'main.noProblemsFound': '未发现问题',
  'main.preview': '预览'
}

/** @type {{ [K in keyof typeof zh]: string }} */
const en = {
  'main.pxNotCaptured': '{width}px not captured',
  'main.pxOverflowsPx': '{width}px · overflows {overflowX}px',
  'main.openTheScreenshotInThe': 'Open the screenshot in the sidebar',
  'main.pageScreenshotAtPx': 'Page screenshot at {width}px',
  'main.loadFailed': 'load failed',
  'main.problem.consoleErrors.one': '{n} console error',
  'main.problem.consoleErrors.other': '{n} console errors',
  'main.problem.failedRequests.one': '{n} failed request',
  'main.problem.failedRequests.other': '{n} failed requests',
  'main.problem.overflows.one': '{n} width overflows',
  'main.problem.overflows.other': '{n} widths overflow',
  'main.problem.brokenImages.one': '{n} broken image',
  'main.problem.brokenImages.other': '{n} broken images',
  'main.problem.failedSteps.one': '{n} step failed',
  'main.problem.failedSteps.other': '{n} steps failed',
  'main.problem.notCaptured.one': '{n} width not captured',
  'main.problem.notCaptured.other': '{n} widths not captured',
  'main.problemSeparator': ', ',
  'main.noProblemsFound': 'no problems found',
  'main.preview': 'Preview'
}

export const { t, install } = pageLocale('fig.preview', zh, en)

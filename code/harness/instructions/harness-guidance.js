import { createHash } from 'node:crypto'
import { harnessGuidanceSource } from '../shared/message-sources.js'

export const guidanceVersion = 5
export const guidanceText = '执行型任务收尾时，简要区分已完成、已验证、未验证及需用户决定的事项；无内容的项不必列出，已明确授权的事项不重复询问。交付文件给出真实保存路径。只有确需用户选择且现有信息不足时，使用原生问答卡。\n'
  + '修改页面或界面后，交付前调用 preview 检查实际渲染及窄屏；项目支持或要求深浅主题时覆盖对应主题。依据本轮实际诊断修正问题；收尾必须简述已检查的视口宽度和关键诊断（如是否横向溢出），说明验证仅限渲染或实际已测交互；最终交付回复至少用一句话保留“文件路径；实测宽度与诊断；已测或未测交互”，不能因简短收尾省略这些证据，也不能将截图当成交互验证。工具不可用则说明未验证。'
export const guidanceDigest = createHash('sha256').update(`${guidanceVersion}\n${guidanceText}`).digest('hex')

/** Advisory Fig-only source. No extra middleware, model calls or writes to shared rules. */
export function guidanceSnapshot(messages, enabled = true) {
  if (!enabled || messages.findLast(message => message.source?.kind === harnessGuidanceSource)?.source.digest === guidanceDigest) return undefined
  return {
    source: { kind: harnessGuidanceSource, version: guidanceVersion, digest: guidanceDigest },
    content: [{ type: 'text', text: '<system-reminder>\nFig task guidance. This replaces earlier Fig guidance; '
      + 'system, developer and direct user instructions take precedence.\n' + guidanceText + '\n</system-reminder>' }]
  }
}

import type { MessageBoxOptions, OpenDialogOptions } from 'electron'
import { tr } from './language'
import { DirectoryError, existingDirectory, readWorkspaceRegistry, type Directories, type DirectoryKind, type DirectorySettings } from './directory-settings'

interface Dependencies {
  settings: DirectorySettings;
  current: Directories;
  release: string;
  defaultWorkspace(): Promise<string | undefined>;
  idle(): Promise<boolean>;
  valid(): boolean;
  choose(options: OpenDialogOptions): Promise<{canceled: boolean; filePaths: string[]}>;
  confirm(options: MessageBoxOptions): Promise<{response: number}>;
  stop(): Promise<void>;
  settle?(): Promise<void>;
  resume(): Promise<void>;
  restart(): void;
}
export const directoryErrorText = (error: unknown): string => {
  const code = error instanceof DirectoryError ? error.code : ''
  const text = ({
    DIRECTORY_UNAVAILABLE: ['目录不可用，请确认目录存在并且可以读写。', 'The folder is unavailable. Make sure it exists and can be read and written.'],
    TARGET_NOT_EMPTY: ['请选择一个空目录，已有文件的目录不会被覆盖。', 'Choose an empty folder. A folder with files is never overwritten.'],
    OVERLAPPING_DIRECTORIES: ['新数据目录不能与当前数据目录相同，也不能互相包含。', 'The new data folder cannot be the current one or contain it, or be inside it.'],
    UNSUPPORTED_DATA_FILE: ['数据目录含有管道或套接字等特殊文件，暂不支持自动迁移。原目录保持可用。', 'The data folder holds special files such as pipes or sockets, which cannot be migrated automatically. The original folder stays in use.'],
    SOURCE_CHANGED: ['迁移期间原数据发生变化，已停止切换，继续使用原目录。', 'The original data changed during migration. The switch stopped and the original folder stays in use.'],
    COPY_VERIFICATION_FAILED: ['数据复制校验未通过，继续使用原目录。请另选空目录重试。', 'The copied data did not pass the check; the original folder stays in use. Choose another empty folder and retry.'],
    WORKSPACE_FORMAT_UNSUPPORTED: ['当前DSH版本或工作区记录格式不支持此修改，原设置已保留。', 'This DSH version or its workspace record format does not support this change. The original setting is kept.'],
    PREFERENCES_UNREADABLE: ['无法读取目录设置文件，请检查文件权限。', 'Could not read the folder settings file. Check its permissions.'],
    TASKS_RUNNING: ['仍有会话或后台任务在运行，请等待结束或停止后再修改目录。', 'Sessions or background tasks are still running. Wait for them to finish or stop them, then change the folder.']
  } as Record<string, [string, string]>)[code] ?? ['目录修改未完成，原数据已保留。请检查目录权限和可用空间后重试。', 'The folder change did not finish; the original data is kept. Check folder permissions and free space, then retry.']
  return tr(...text)
}

/**
 * Stops DSH, waits for writes in flight, applies `write` and restarts Fig. A failure after the stop starts DSH again;
 * `recover` first keeps a migration candidate's recovery record, before another in-app retry can start.
 */
async function applyAndRestart(deps: Dependencies, write: () => Promise<unknown>, recover = false): Promise<void> {
  if (!await deps.idle()) throw new DirectoryError('TASKS_RUNNING')
  let stopped = false
  try {
    await deps.stop(); stopped = true
    await deps.settle?.()
    await write()
  } catch (error) {
    if (stopped) {
      if (recover) await deps.settings.recoverNotice().catch(() => {})
      await deps.resume()
    }
    throw error
  }
  deps.restart()
}

/** A pathless page gesture only opens native UI. All selected paths and confirmations remain native-owned. */
export async function configureDirectory(kind: DirectoryKind, deps: Dependencies): Promise<void> {
  if (!deps.valid()) return
  if (!await deps.idle()) throw new DirectoryError('TASKS_RUNNING')
  const value = await deps.settings.read()
  const skills = kind === 'skillDirectory' || kind === 'clearSkillDirectory'
  const label = kind === 'startup' ? tr('启动目录', 'startup folder') : kind === 'defaultWorkspace' ? tr('DSH默认工作区', 'DSH default workspace') : skills ? tr('额外技能目录', 'extra skill folder') : tr('DSH数据目录', 'DSH data folder')
  const currentPath = kind === 'startup' ? deps.current.startup : kind === 'defaultWorkspace' ? await deps.defaultWorkspace()
    : skills ? await deps.settings.readSkillDirectory() : deps.current.dshHome
  if (kind === 'clearSkillDirectory') {
    if (currentPath === undefined) return
    const result = await deps.confirm({type: 'question', title: tr('清除额外技能目录', 'Clear Extra Skill Folder'), message: tr('不再加载额外技能目录并重启？', 'Stop loading the extra skill folder and restart?'),
      detail: tr(`当前目录：${currentPath}\n\n目录及其中的技能文件不会删除，DSH 自带的技能目录照常可用。Fig现在将重启。`, `Current folder: ${currentPath}\n\nThe folder and its skill files are not deleted, and DSH's own skill folders stay available. Fig will restart now.`),
      buttons: [tr('清除并重启', 'Clear and Restart'), tr('取消', 'Cancel')], defaultId: 1, cancelId: 1, noLink: true})
    if (result.response !== 0 || !deps.valid()) return
    await applyAndRestart(deps, () => deps.settings.writeSkillDirectory(undefined))
    return
  }
  let targetPath: string
  if (kind === 'restoreDshHome') {
    if (!value.previousDshHome) throw new DirectoryError('DIRECTORY_UNAVAILABLE')
    targetPath = value.previousDshHome
  } else {
    const result = await deps.choose({title: kind === 'dshHome' ? tr('选择新的空数据目录', 'Choose a New Empty Data Folder') : tr('设置' + label, 'Set the ' + label), defaultPath: currentPath,
      properties: ['openDirectory', 'createDirectory'], buttonLabel: tr('选择目录', 'Choose Folder')})
    if (result.canceled || result.filePaths.length !== 1) return
    targetPath = result.filePaths[0]
  }
  if (!deps.valid()) return
  const target = await existingDirectory(targetPath)
  if (currentPath && target === await existingDirectory(currentPath).catch(() => undefined)) return
  if (kind === 'dshHome') await deps.settings.validateMigration(deps.current.dshHome, target)
  // Read-only, before the confirmation and before DSH stops: an unsupported release or format restarts nothing.
  if (kind === 'defaultWorkspace') await readWorkspaceRegistry(deps.current.dshHome, deps.release)
  const restoring = kind === 'restoreDshHome', migrating = kind === 'dshHome'
  const warning = migrating || restoring
  const result = await deps.confirm({
    type: warning ? 'warning' : 'question',
    title: restoring ? tr('恢复旧数据目录', 'Restore Old Data Folder') : tr('更改' + label, 'Change the ' + label),
    message: restoring ? tr('恢复旧数据目录并重启？', 'Restore the old data folder and restart?') : migrating ? tr('迁移DSH数据并重启？', 'Migrate DSH data and restart?') : tr('更改' + label + '并重启？', `Change the ${label} and restart?`),
    detail: tr(`当前目录：${currentPath ?? '未设置'}\n新目录：${target}\n\n`, `Current folder: ${currentPath ?? 'not set'}\nNew folder: ${target}\n\n`) + (restoring
      ? tr('旧目录保留的是迁移时的数据，迁移后新增的会话和设置不会自动同步回去。当前目录也会保留。恢复后将重启Fig。', 'The old folder holds the data as it was at migration; sessions and settings added since are not copied back. The current folder is kept too. Fig restarts after restoring.')
      : migrating
        ? tr('会先停止DSH，再复制并校验会话、登录和设置；完成后切换到新目录并重启Fig。旧目录保留供回退。复制失败或取消不会切换目录。请勿在迁移期间退出应用或断开磁盘。', 'DSH stops first, then sessions, sign-ins and settings are copied and checked; Fig then switches to the new folder and restarts. The old folder is kept for rollback. A failed or cancelled copy does not switch. Do not quit the app or disconnect the disk during migration.')
        : kind === 'startup' ? tr('下次启动从新目录运行DSH。现有工作区和会话文件不会移动。Fig现在将重启。', 'DSH runs from the new folder from now on. Existing workspaces and session files are not moved. Fig will restart now.')
          : skills ? tr('该目录中的技能将对所有会话和模型可用，与DSH自带的技能目录并列。不移动或修改任何文件。Fig现在将重启。', 'Skills in this folder become available to every session and model, alongside DSH\'s own skill folders. No files are moved or changed. Fig will restart now.')
          : tr('新目录将成为DSH默认工作区。原工作区及会话仍保留，不移动项目文件。Fig现在将重启。', 'The new folder becomes the DSH default workspace. The original workspace and its sessions are kept; project files are not moved. Fig will restart now.')),
    buttons: [restoring ? tr('恢复并重启', 'Restore and Restart') : migrating ? tr('迁移并重启', 'Migrate and Restart') : tr('保存并重启', 'Save and Restart'), tr('取消', 'Cancel')],
    defaultId: 1, cancelId: 1, noLink: true
  })
  if (result.response !== 0 || !deps.valid()) return
  await applyAndRestart(deps, () => deps.settings.commit(kind, target, deps.current, deps.release), true)
}

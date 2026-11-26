import { readFile } from 'node:fs/promises'
import { writeRecord } from './atomic-json.ts'
import { PublicError } from './http.js'
import { uiText } from './ui-text'

function validIds(ids) {
  return Array.isArray(ids) && ids.every(id => typeof id === 'string' && /^[\w.-]+$/.test(id))
}

// An absent preference suggests the first compatible account model. An explicit [] hides them all. A damaged file
// reads as absent, so the menu still offers a model and the next save from the account page replaces it.
export function subscriptionModelPreferences(path) {
  async function read() {
    let text
    try { text = await readFile(path, 'utf8') } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined
      throw new PublicError(uiText('无法读取已保存的模型菜单设置。', 'Could not read the saved model menu settings.'))
    }
    try {
      const saved = JSON.parse(text)
      return validIds(saved?.ids) ? new Set(saved.ids) : undefined
    } catch { return undefined }
  }
  let pending = Promise.resolve()
  return {
    async visible(models) {
      const saved = await read()
      return saved ? models.filter(({ id }) => saved.has(id)) : models.slice(0, 1)
    },
    save(ids, getModels) {
      const write = pending.then(async () => {
        const models = await getModels()
        const allowed = new Set(models.filter(row => row.input).map(row => row.id))
        if (!validIds(ids) || ids.some(id => !allowed.has(id))) {
          throw new PublicError(uiText('模型目录已变化。请刷新模型后重试。', 'The model list changed. Refresh it and try again.'))
        }
        await read() // A file the system refuses to read is not overwritten; a damaged one is.
        const selected = [...new Set(ids)]
        await writeRecord(path, { ids: selected })
        return { models, selected }
      })
      pending = write.then(() => {}, () => {})
      return write
    }
  }
}

// Give both account pages the same view of the catalog and refresh the native picker after writes.
export function subscriptionMenuActions(preferences, models, updated) {
  return {
    async settingsModels(refresh) {
      try {
        const { models: rows } = await models(refresh)
        const selected = (await preferences.visible(rows.filter(row => row.input))).map(row => row.id)
        return { models: rows, selected }
      } finally { if (refresh) updated() }
    },
    async saveModels(ids) {
      const result = await preferences.save(ids, async () => (await models(false)).models)
      updated()
      return result
    }
  }
}


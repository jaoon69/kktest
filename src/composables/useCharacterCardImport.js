import { getCurrentScope, onScopeDispose, ref } from 'vue'
import { readSTCharacterCardFile } from '../utils/stCharacterCard'
import { compressImage } from './useImage'

export function useCharacterCardImport({ readCard = readSTCharacterCardFile, readAvatar = compressImage } = {}) {
  const importedCard = ref(null)
  const importing = ref(false)
  const importError = ref('')
  let requestId = 0

  function resetImport() {
    requestId += 1
    importedCard.value = null
    importing.value = false
    importError.value = ''
  }

  if (getCurrentScope()) onScopeDispose(resetImport)

  async function importCard(file) {
    const currentRequest = ++requestId
    importing.value = true
    importError.value = ''
    try {
      const card = await readCard(file)
      if (currentRequest !== requestId) return null
      const avatar = card.hasAvatar ? await readAvatar(file, 200) : null
      if (currentRequest !== requestId) return null
      const result = { ...card, avatar }
      importedCard.value = result
      return result
    } catch (error) {
      if (currentRequest === requestId) {
        importError.value = error?.message || '角色卡导入失败，请检查文件后重试'
      }
      return null
    } finally {
      if (currentRequest === requestId) importing.value = false
    }
  }

  return { importedCard, importing, importError, resetImport, importCard }
}

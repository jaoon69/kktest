import { isReservedPromptPresetBook } from '../../../utils/presetPromptBooks'
import { applyTemplateVars } from './templateVars'
import { matchesLorebookKeyword, prepareKeywordMatchContext } from './lorebookKeywordMatch'

function matchesEntryKeyword(context, keyword, entry) {
  if (!entry.useRegex) return matchesLorebookKeyword(context, keyword, { caseSensitive: entry.caseSensitive === true })
  if (typeof keyword !== 'string' || !keyword.trim()) return false
  try {
    const literal = keyword.match(/^\/(.*)\/([dgimsuvy]*)$/s)
    const pattern = literal ? literal[1] : keyword
    const flags = literal ? literal[2] : entry.caseSensitive ? '' : 'i'
    return new RegExp(pattern, flags).test(context.raw)
  } catch {
    return false
  }
}

function matchesSecondaryKeywords(context, entry) {
  const keywords = Array.isArray(entry.secondaryKeywords) ? entry.secondaryKeywords : []
  if (!entry.selective || keywords.length === 0) return true
  const matches = keywords.map(keyword => matchesEntryKeyword(context, keyword, entry))
  switch (entry.selectiveLogic) {
    case 1: return !matches.every(Boolean) // NOT_ALL
    case 2: return !matches.some(Boolean) // NOT_ANY
    case 3: return matches.every(Boolean) // AND_ALL
    default: return matches.some(Boolean) // AND_ANY
  }
}

function getActiveLorebookEntries(store) {
  if (!store.activeChat) return []

  const contexts = new Map()
  const getMatchContext = (depth = 10) => {
    if (!contexts.has(depth)) {
      const messages = Array.isArray(store.activeChat.msgs) ? store.activeChat.msgs : []
      contexts.set(depth, prepareKeywordMatchContext((depth > 0 ? messages.slice(-depth) : [])
        .map(m => typeof m?.content === 'string' ? m.content : '').join(' ')))
    }
    return contexts.get(depth)
  }
  const activeEntries = []
  const activeBookIds = new Set()
  const presetBookIds = new Set(
    (Array.isArray(store.lorebook?.books) ? store.lorebook.books : [])
      .filter(isReservedPromptPresetBook)
      .map(b => b.id)
  )

  if (Array.isArray(store.activeChat.boundLorebooks)) {
    store.activeChat.boundLorebooks.forEach(bookId => {
      if (!presetBookIds.has(bookId)) {
        activeBookIds.add(bookId)
      }
    })
  }

  activeBookIds.forEach(bookId => {
    const book = store.lorebook.books.find(b => b.id === bookId)
    if (!book || !book.entries) return
    if (isReservedPromptPresetBook(book)) return

    book.entries.forEach(entry => {
      if (!entry.enabled) return

      const keywords = Array.isArray(entry.keywords) ? entry.keywords : []

      if (entry.alwaysActive) {
        activeEntries.push(entry)
        return
      }

      if (keywords.length > 0) {
        const matchContext = getMatchContext(entry.scanDepth ?? book.scanDepth ?? 10)
        const hasMatch = keywords.some(keyword => matchesEntryKeyword(matchContext, keyword, entry))
        if (hasMatch && matchesSecondaryKeywords(matchContext, entry)) {
          activeEntries.push(entry)
        }
      }
    })
  })

  return activeEntries.sort((a, b) => {
    const depthA = Number.isFinite(a?.insertDepth) ? a.insertDepth : 0
    const depthB = Number.isFinite(b?.insertDepth) ? b.insertDepth : 0
    if (depthA !== depthB) return depthA - depthB
    const orderA = Number.isFinite(a?.order) ? a.order : 0
    const orderB = Number.isFinite(b?.order) ? b.order : 0
    return orderA - orderB
  })
}

export function insertLorebookEntries(store, messages, templateVars = {}) {
  const activeEntries = getActiveLorebookEntries(store)
  if (activeEntries.length === 0) return messages

  const result = [...messages]
  const systemIndex = result.findIndex(m => m.role === 'system')

  activeEntries.forEach(entry => {
    let insertIndex
    if (entry.insertDepth === 0) {
      insertIndex = systemIndex + 1
    } else if (entry.insertDepth < 0) {
      insertIndex = result.length + entry.insertDepth + 1
    } else {
      insertIndex = systemIndex + 1 + entry.insertDepth
    }

    insertIndex = Math.max(systemIndex + 1, Math.min(insertIndex, result.length))
    result.splice(insertIndex, 0, {
      role: 'system',
      content: '<world_book name="' + entry.name + '">\n' + applyTemplateVars(entry.content, templateVars) + '\n</world_book>'
    })
  })

  return result
}

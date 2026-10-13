import { pickFullSmartUIMessages, rewriteSmartUIContentForModel } from '../../features/chat'

function isImagePlaceholder(content) {
  return content === '[\u56FE\u7247]'
}

function buildImageParts(imageUrl, text) {
  const parts = []
  if (text) {
    parts.push({ type: 'text', text })
  }
  parts.push({ type: 'image_url', image_url: { url: imageUrl } })
  return parts
}

function resolveReplyText(message, allMessages = []) {
  if (message?.replyToText != null) {
    return message.replyToText
  }
  if (message?.replyTo) {
    const originalMessage = allMessages.find(item => item?.id === message.replyTo)
    return originalMessage?.content || ''
  }
  return ''
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasSenderPrefix(content, senderName) {
  const text = String(content || '')
  const name = String(senderName || '').trim()
  if (!text || !name) return false
  return new RegExp(`^\\[\\s*${escapeRegex(name)}\\s*\\][:：]\\s*`, 'i').test(text)
}

function prefixGroupAssistantContent(message, content, fallback = '') {
  const text = String(content || '').trim()
  const senderName = String(message?.senderName || '').trim()
  const nextContent = text || String(fallback || '').trim()

  if (!senderName || !nextContent) return nextContent
  if (hasSenderPrefix(nextContent, senderName)) return nextContent
  return `[${senderName}]: ${nextContent}`
}

export async function resolveContextMessageImageUrls(contextMsgs = [], resolveImageUrl) {
  if (!Array.isArray(contextMsgs) || contextMsgs.length === 0 || typeof resolveImageUrl !== 'function') {
    return contextMsgs
  }

  return await Promise.all(contextMsgs.map(async (message) => {
    if (!message?.isImage) return message

    const currentUrl = String(message?.imageUrl || '').trim()
    const nextUrl = await resolveImageUrl(message, currentUrl)
    if (!nextUrl || nextUrl === currentUrl) return message

    return {
      ...message,
      imageUrl: nextUrl
    }
  }))
}

export function buildDirectChatApiMessages(contextMsgs = [], allMessages = []) {
  const fullSmartUIMessages = pickFullSmartUIMessages(contextMsgs)
  return contextMsgs.map(message => {
    if (message?.role === 'system') {
      return { role: message.role, content: message.content }
    }

    if (message?.isImage && message?.imageUrl) {
      const text = (message.content && !isImagePlaceholder(message.content)) ? message.content : ''
      return {
        role: message.role,
        content: buildImageParts(message.imageUrl, text)
      }
    }

    let content = rewriteSmartUIContentForModel(message, message.content, fullSmartUIMessages.has(message))
    const replyText = resolveReplyText(message, allMessages)
    if (replyText) {
      content = `[quote:${replyText}]\n${content}`
    }

    return { role: message.role, content }
  })
}

export function buildGroupSingleApiMessages(contextMsgs = []) {
  return contextMsgs.map(message => {
    if (message?.role === 'system') {
      return { role: message.role, content: message.content }
    }

    if (message?.isImage && message?.imageUrl) {
      const baseContent = (message.content && !isImagePlaceholder(message.content)) ? message.content : ''
      let text = ''
      if (message.role === 'user') {
        text = '[\u7528\u6237]:' + (baseContent ? ` ${baseContent}` : ' [\u56FE\u7247]')
      } else if (message.role === 'assistant') {
        text = prefixGroupAssistantContent(message, baseContent, '[\u56FE\u7247]')
      } else if (baseContent) {
        text = baseContent
      }
      return {
        role: message.role,
        content: buildImageParts(message.imageUrl, text)
      }
    }

    let content = message.content
    if (message.role === 'user') {
      content = `[\u7528\u6237]: ${message.content}`
    } else if (message.role === 'assistant') {
      content = prefixGroupAssistantContent(message, message.content)
    }
    return { role: message.role, content }
  })
}

export function buildGroupMultiApiMessages(contextMsgs = [], memberId) {
  return contextMsgs.map(message => {
    if (message?.role === 'system') {
      return { role: message.role, content: message.content }
    }

    const isUserMessage = message.role === 'user'
    const role = isUserMessage ? 'user' : (message.senderId === memberId ? 'assistant' : 'user')
    const prefix = isUserMessage ? '[\u7528\u6237]:' : (message.senderName ? `[${message.senderName}]:` : '')

    if (message?.isImage && message?.imageUrl) {
      const baseContent = (message.content && !isImagePlaceholder(message.content)) ? message.content : ''
      const text = prefix
        ? (baseContent ? `${prefix} ${baseContent}` : `${prefix} [\u56FE\u7247]`)
        : baseContent
      return {
        role,
        content: buildImageParts(message.imageUrl, text)
      }
    }

    const content = prefix ? `${prefix} ${message.content}` : message.content
    return { role, content }
  })
}

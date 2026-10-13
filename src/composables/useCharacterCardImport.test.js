import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useCharacterCardImport } from './useCharacterCardImport'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

describe('useCharacterCardImport', () => {
  it('reads PNG metadata before compressing the image and stages the result for review', async () => {
    const order = []
    const readCard = vi.fn(async () => { order.push('card'); return { name: '星河', hasAvatar: true } })
    const readAvatar = vi.fn(async () => { order.push('avatar'); return 'data:image/jpeg;base64,avatar' })
    const state = useCharacterCardImport({ readCard, readAvatar })
    const result = await state.importCard('file')
    expect(order).toEqual(['card', 'avatar'])
    expect(state.importedCard.value).toEqual(result)
    expect(result.avatar).toBe('data:image/jpeg;base64,avatar')
    expect(readAvatar).toHaveBeenCalledWith('file', 200)
    expect(state.importing.value).toBe(false)
  })

  it('discards a pending read when the modal closes', async () => {
    const pending = deferred()
    const readAvatar = vi.fn()
    const state = useCharacterCardImport({ readCard: () => pending.promise, readAvatar })
    const request = state.importCard('file')
    state.resetImport()
    pending.resolve({ name: '星河', hasAvatar: true })
    expect(await request).toBeNull()
    expect(readAvatar).not.toHaveBeenCalled()
    expect(state.importedCard.value).toBeNull()
    expect(state.importError.value).toBe('')
    expect(state.importing.value).toBe(false)
  })

  it('discards an older import while a newer file is selected', async () => {
    const first = deferred()
    const state = useCharacterCardImport({
      readCard: file => file === 'first' ? first.promise : Promise.resolve({ name: '新版', hasAvatar: false })
    })
    const oldRequest = state.importCard('first')
    await state.importCard('second')
    first.resolve({ name: '旧版', hasAvatar: false })
    expect(await oldRequest).toBeNull()
    expect(state.importedCard.value.name).toBe('新版')
  })

  it('discards a pending avatar conversion when the component unmounts', async () => {
    const pending = deferred()
    const scope = effectScope()
    const state = scope.run(() => useCharacterCardImport({
      readCard: async () => ({ name: '星河', hasAvatar: true }), readAvatar: () => pending.promise
    }))
    const request = state.importCard('file')
    await Promise.resolve()
    scope.stop()
    pending.resolve('data:image/jpeg;base64,avatar')
    expect(await request).toBeNull()
    expect(state.importedCard.value).toBeNull()
  })

  it('keeps the previous draft intact on error and allows retrying', async () => {
    const readCard = vi.fn().mockResolvedValueOnce({ name: '有效', hasAvatar: false })
      .mockRejectedValueOnce(new Error('角色卡 JSON 格式无效')).mockResolvedValueOnce({ name: '重试', hasAvatar: false })
    const state = useCharacterCardImport({ readCard })
    await state.importCard('valid')
    expect(await state.importCard('invalid')).toBeNull()
    expect(state.importedCard.value.name).toBe('有效')
    expect(state.importError.value).toBe('角色卡 JSON 格式无效')
    expect(state.importing.value).toBe(false)
    await state.importCard('retry')
    expect(state.importError.value).toBe('')
    expect(state.importedCard.value.name).toBe('重试')
  })
})

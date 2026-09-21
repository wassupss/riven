import { describe, it, expect } from 'vitest'
import { answer, topicOf, type TalkFacts } from './petTalk'
import { initialState } from './pet'

const T0 = 1_700_000_000_000

// The real t() reads the settings store; here we only care WHICH line was
// picked and that its parameters were filled, so the key and the params come
// back verbatim.
const t = ((key: string, arg1?: unknown): string => {
  const params = typeof arg1 === 'object' && arg1 !== null ? arg1 : undefined
  return params ? `${key}(${JSON.stringify(params)})` : key
}) as TalkFacts['t']

const facts = (over: Partial<TalkFacts> = {}): TalkFacts => ({
  pet: initialState(T0),
  now: T0,
  busy: [],
  recent: [],
  todayTokens: 0,
  limit: null,
  editedFiles: 0,
  dur: (ms) => `${Math.round(ms / 60000)}분`,
  fmt: (n) => `${n}`,
  t,
  ...over
})

describe('topicOf', () => {
  it.each([
    ['안녕!', 'greeting'],
    ['오늘 뭐 먹었어?', 'food'],
    ['지금 바빠?', 'busy'],
    ['아까 뭐 끝났어?', 'finished'],
    ['한도 얼마 남았어', 'limit'],
    ['오늘 바뀐 파일 있어?', 'files'],
    ['너 몇살이야', 'self'],
    ['뭐 물어볼 수 있어?', 'help'],
    ['what are you running', 'busy'],
    ['how much quota is left', 'limit']
  ])('reads %s as %s', (q, expected) => {
    expect(topicOf(q)).toBe(expected)
  })

  it('says so when it has no idea', () => {
    expect(topicOf('ㅁㄴㅇㄹ')).toBe('unknown')
    expect(topicOf('')).toBe('unknown')
  })
})

describe('answer', () => {
  it('reports what is running and where', () => {
    const a = answer('지금 바빠?', facts({
      busy: [
        { workspace: 'web', title: 'chat' },
        { workspace: 'api', title: 'chat' }
      ]
    }))
    expect(a.text).toContain('pet.talk.busy')
    expect(a.text).toContain('"n":2')
    expect(a.text).toContain('web, api')
  })

  it('says nothing is running when nothing is', () => {
    expect(answer('바빠?', facts()).text).toBe('pet.talk.busyNone')
  })

  it('leads with a failure over a success', () => {
    const a = answer('뭐 끝났어?', facts({
      now: T0 + 5 * 60_000,
      recent: [
        { workspace: 'web', title: 'chat', at: T0 + 4 * 60_000, failed: false },
        { workspace: 'api', title: 'chat', at: T0 + 60_000, failed: true }
      ]
    }))
    expect(a.text).toContain('pet.talk.failed')
    expect(a.text).toContain('api')
  })

  it('reports the newest finished turn when nothing failed', () => {
    const a = answer('뭐 끝났어?', facts({
      now: T0 + 3 * 60_000,
      recent: [{ workspace: 'web', title: 'chat', at: T0, failed: false }]
    }))
    expect(a.text).toContain('pet.talk.finished')
    expect(a.text).toContain('web')
    expect(a.text).toContain('3분')
  })

  it('answers the plan limit with what is left and when it resets', () => {
    const a = answer('한도 남았어?', facts({
      limit: { usedPct: 62, resetsAt: new Date(T0 + 2 * 3_600_000).toISOString() }
    }))
    expect(a.text).toContain('"left":38')
    expect(a.text).toContain('120분')
  })

  it('handles an account that reports no limit at all', () => {
    expect(answer('한도?', facts()).text).toBe('pet.talk.limitNone')
  })

  it('counts the files agents touched', () => {
    expect(answer('바뀐 파일?', facts({ editedFiles: 12 })).text).toContain('"n":12')
    expect(answer('바뀐 파일?', facts()).text).toBe('pet.talk.filesNone')
  })

  it('names its own diet when asked what it ate', () => {
    const pet = initialState(T0)
    pet.diet = { opus: 80, sonnet: 20, haiku: 0, codex: 0, other: 0 }
    const a = answer('오늘 뭐 먹었어?', facts({ pet, todayTokens: 6_400_000 }))
    expect(a.text).toContain('pet.flavor.opus')
    expect(a.text).toContain('"pct":80')
  })

  it('admits an empty stomach', () => {
    expect(answer('뭐 먹었어?', facts()).text).toBe('pet.talk.foodNone')
  })

  it('greets differently when it is hungry', () => {
    const hungry = { ...initialState(T0), fullness: 5 }
    expect(answer('안녕', facts({ pet: hungry })).text).toBe('pet.talk.hiHungry')
    expect(answer('안녕', facts()).text).toBe('pet.talk.hi')
  })

  it('offers help rather than guessing when it does not understand', () => {
    expect(answer('ㅁㄴㅇㄹ', facts()).text).toBe('pet.talk.dunno')
    expect(answer('뭐 물어볼 수 있어?', facts()).text).toBe('pet.talk.help')
  })

  it('shortens a long list of workspaces', () => {
    const a = answer('바빠?', facts({
      busy: ['web', 'api', 'riven', 'docs'].map((w) => ({ workspace: w, title: 'chat' }))
    }))
    // The inner call is nested inside the outer one's params, so its quotes come
    // back escaped — the first two names, and a count of the rest.
    expect(a.text).toContain('pet.talk.andMore')
    expect(a.text).toContain('web, api')
    expect(a.text).toContain('n\\":2') // two more beyond the first pair
  })
})

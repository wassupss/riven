import { describe, expect, it } from 'vitest'
import { dropMentionQuery, insertMention, mentionHandle, mentionMatches, mentionQuery, parseMentions } from './mention'

const peers = [
  { id: 'a', title: '리드 · 팀' },
  { id: 'b', title: 'Claude Code' },
  { id: 'c', title: 'Claude' }
]

describe('mention', () => {
  it('handles drop the group', () => {
    expect(mentionHandle('리드 · 팀 · 대화')).toBe('리드')
    expect(mentionHandle('Solo')).toBe('Solo')
  })
  it('finds the query being typed and fills it in', () => {
    expect(mentionQuery('hi @Cla')).toBe('cla')
    expect(mentionQuery('mail a@b')).toBeNull()
    expect(mentionQuery('@')).toBe('')
    expect(insertMention('hi @Cla', 'Claude Code')).toBe('hi @Claude Code ')
    expect(insertMention('@', '리드')).toBe('@리드 ')
    expect(dropMentionQuery('hi @Cla')).toBe('hi')
    expect(mentionMatches(peers, 'cla').map((p) => p.id)).toEqual(['b', 'c'])
    expect(mentionMatches(peers, null)).toEqual([])
  })
  it('parses leading mentions, longest handle first', () => {
    expect(parseMentions('@Claude Code run tests', peers)).toEqual({ targets: [peers[1]], body: 'run tests' })
    expect(parseMentions('@리드 @Claude hi', peers)?.targets.map((p) => p.id)).toEqual(['a', 'c'])
    expect(parseMentions('@리드', peers)).toBeNull()
    expect(parseMentions('no mention', peers)).toBeNull()
    expect(parseMentions('@nobody hi', peers)).toBeNull()
  })
})

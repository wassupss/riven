import type { TFn } from '../i18n'
import { dietOf, progressOf, speciesName, type PetSave } from './pet'
import { statsOf, topStat } from './petLevel'
import { customOf, isCustomId } from './petSpecies'

// ---------------------------------------------------------------------------
// What the pet says when you talk to it.
//
// Deliberately NOT a language model. Every answer here is read straight off what
// riven already knows: today's usage, what is running, what just finished, the
// plan limit, the files that changed, so a question costs nothing, answers
// instantly, works offline, and cannot make something up. The pet is a way to
// ASK YOUR OWN WORKSPACE a question in words.
//
// Everything is pure: the caller gathers the facts, this decides what to say.
// ---------------------------------------------------------------------------

export interface TalkFacts {
  pet: PetSave
  now: number
  /** Agent panes running right now, by workspace name. */
  busy: Array<{ workspace: string; title: string }>
  /** Turns that finished recently, newest first. */
  recent: Array<{ workspace: string; title: string; at: number; failed: boolean }>
  /** Food tokens (see foodOf) worked today. */
  todayTokens: number
  /** The tightest plan window, if the account reports one. */
  limit: { usedPct: number; resetsAt: string | null } | null
  /** Files agents changed today, across every workspace. */
  editedFiles: number
  /** Human-readable "3분", for durations. */
  dur: (ms: number) => string
  /** Token count formatter (12.4M). */
  fmt: (n: number) => string
  t: TFn
}

export type TalkTopic =
  | 'greeting'
  | 'tokens'
  | 'level'
  | 'stats'
  | 'busy'
  | 'finished'
  | 'limit'
  | 'files'
  | 'self'
  | 'help'
  | 'unknown'

// Keyword tables, Korean first because that is what the device speaks. Matching
// is deliberately dumb (substring, no stemming): a pet that understands ten
// questions reliably beats one that half-understands a hundred.
const TOPICS: Array<{ topic: TalkTopic; words: string[] }> = [
  { topic: 'greeting', words: ['안녕', '하이', 'ㅎㅇ', 'hello', 'hi ', 'hey'] },
  { topic: 'tokens', words: ['먹', '토큰', 'token', 'eat'] },
  { topic: 'level', words: ['레벨', '렙', '경험치', 'level', 'lvl'] },
  {
    topic: 'stats',
    words: ['능력', '스탯', '힘', '지능', '속도', '체력', 'stat', 'power', 'smart', 'speed', 'stamina', 'strong']
  },
  {
    topic: 'busy',
    words: ['바쁘', '바빠', '돌아', '실행', '작업', '일하', 'busy', 'running', 'working', 'doing']
  },
  {
    topic: 'finished',
    words: ['끝', '완료', '실패', '에러', '오류', 'done', 'finish', 'fail', 'error', 'result']
  },
  { topic: 'limit', words: ['한도', '남았', '리셋', '쿼터', '제한', 'limit', 'quota', 'left', 'reset'] },
  { topic: 'files', words: ['파일', '바뀐', '변경', '고친', 'file', 'change', 'edit', 'diff'] },
  {
    topic: 'self',
    words: ['너', '나이', '기분', '상태', '몇살', '어때', 'you', 'age', 'mood', 'how are']
  },
  { topic: 'help', words: ['뭐', '도움', '할 수', '물어', 'help', 'what can', 'commands'] }
]

/** Which of the handful of things it knows about is being asked. */
export function topicOf(question: string): TalkTopic {
  const q = question.trim().toLowerCase()
  if (!q) return 'unknown'
  // 'help' is the broadest bucket ("뭐 해줄 수 있어"), so it loses ties to the
  // specific topics and is checked last.
  for (const { topic, words } of TOPICS)
    if (topic !== 'help' && words.some((w) => q.includes(w))) return topic
  if (TOPICS[TOPICS.length - 1].words.some((w) => q.includes(w))) return 'help'
  return 'unknown'
}

const listNames = (items: Array<{ workspace: string }>, t: TFn): string => {
  const names = [...new Set(items.map((i) => i.workspace))]
  if (names.length <= 2) return names.join(', ')
  return t('pet.talk.andMore', { first: names.slice(0, 2).join(', '), n: names.length - 2 })
}

/** The pet's answer: one short line, in its own voice. */
export function answer(question: string, f: TalkFacts): { topic: TalkTopic; text: string } {
  const { t } = f
  const topic = topicOf(question)
  switch (topic) {
    case 'greeting':
      return { topic, text: t('pet.talk.hi') }

    case 'tokens': {
      const diet = dietOf(f.pet)
      if (f.todayTokens <= 0) return { topic, text: t('pet.talk.tokensNone') }
      return {
        topic,
        text: t('pet.talk.tokens', {
          tokens: f.fmt(f.todayTokens),
          flavor: t(`pet.flavor.${diet.top}`),
          pct: Math.round(diet.share * 100)
        })
      }
    }

    case 'level': {
      const g = progressOf(f.pet.xp)
      return {
        topic,
        text:
          g.toNext > 0
            ? t('pet.talk.level', { n: g.level, xp: g.toNext })
            : t('pet.talk.levelMax', { n: g.level })
      }
    }

    case 'stats': {
      const s = statsOf(progressOf(f.pet.xp).level, f.pet.species, f.pet.diet, customOf(f.pet.species) ?? f.pet.custom)
      return {
        topic,
        text: t('pet.talk.stats', { ...s, top: t(`pet.stat.${topStat(s)}`) })
      }
    }

    case 'busy':
      if (f.busy.length === 0) return { topic, text: t('pet.talk.busyNone') }
      return {
        topic,
        text: t('pet.talk.busy', { n: f.busy.length, where: listNames(f.busy, t) })
      }

    case 'finished': {
      const failed = f.recent.filter((r) => r.failed)
      if (failed.length > 0)
        return {
          topic,
          text: t('pet.talk.failed', {
            where: listNames(failed, t),
            ago: f.dur(f.now - failed[0].at)
          })
        }
      const last = f.recent[0]
      if (!last) return { topic, text: t('pet.talk.finishedNone') }
      return {
        topic,
        text: t('pet.talk.finished', { where: last.workspace, ago: f.dur(f.now - last.at) })
      }
    }

    case 'limit': {
      if (!f.limit) return { topic, text: t('pet.talk.limitNone') }
      const left = Math.max(0, 100 - Math.round(f.limit.usedPct))
      const resets = f.limit.resetsAt ? new Date(f.limit.resetsAt).getTime() - f.now : 0
      return {
        topic,
        text:
          resets > 0
            ? t('pet.talk.limit', { left, in: f.dur(resets) })
            : t('pet.talk.limitNoReset', { left })
      }
    }

    case 'files':
      return {
        topic,
        text:
          f.editedFiles > 0
            ? t('pet.talk.files', { n: f.editedFiles })
            : t('pet.talk.filesNone')
      }

    case 'self': {
      const text = t('pet.talk.self', {
        species: speciesName(f.pet.species, t, customOf(f.pet.species) ?? f.pet.custom),
        n: progressOf(f.pet.xp).level,
        age: f.dur(f.now - f.pet.bornAt)
      })
      // One made from a photo knows where it came from.
      return { topic, text: isCustomId(f.pet.species) ? `${text} ${t('pet.talk.custom')}` : text }
    }

    case 'help':
      return { topic, text: t('pet.talk.help') }

    default:
      return { topic, text: t('pet.talk.dunno') }
  }
}

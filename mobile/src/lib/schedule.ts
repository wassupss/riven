import type { RemoteTrigger } from '@riven/remote'

// A schedule in words, the way riven's scheduler on the computer says it.

export const DAYS = ['일', '월', '화', '수', '목', '금', '토']

const two = (n: number): string => String(n).padStart(2, '0')

/** "오전 9:00" */
export function clock(hour: number, minute: number): string {
  const am = hour < 12
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${am ? '오전' : '오후'} ${h}:${two(minute)}`
}

export function triggerLabel(t: RemoteTrigger): string {
  switch (t.kind) {
    case 'once': {
      const d = new Date(t.at)
      return `${d.getMonth() + 1}월 ${d.getDate()}일 ${clock(d.getHours(), d.getMinutes())} 한 번`
    }
    case 'every':
      return t.minutes % 60 === 0 ? `${t.minutes / 60}시간마다` : `${t.minutes}분마다`
    case 'hourly':
      return `매시 ${two(t.minute)}분`
    case 'daily':
      return `매일 ${clock(t.hour, t.minute)}`
    case 'weekdays':
      return `평일 ${clock(t.hour, t.minute)}`
    case 'weekly':
      return `매주 ${DAYS[t.day]}요일 ${clock(t.hour, t.minute)}`
  }
}

/** "3시간 후", "내일 오전 9:00" */
export function whenLabel(at: number | null, now = Date.now()): string {
  if (at === null) return '다음 실행 없음'
  const min = Math.round((at - now) / 60_000)
  if (min < 1) return '곧'
  if (min < 60) return `${min}분 후`
  if (min < 6 * 60) return `${Math.round(min / 60)}시간 후`
  const d = new Date(at)
  const today = new Date(now)
  const tomorrow = new Date(now + 86_400_000)
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
  const day = same(d, today) ? '오늘' : same(d, tomorrow) ? '내일' : `${d.getMonth() + 1}/${d.getDate()}`
  return `${day} ${clock(d.getHours(), d.getMinutes())}`
}

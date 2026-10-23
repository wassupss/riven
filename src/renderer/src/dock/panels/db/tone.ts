// Maps a SQL type name to a colour family so the grid header, its cells and the
// column list all speak the same visual language. Colours themselves live in CSS
// (`.tone-*`) and come from theme tokens.
export type Tone = 'num' | 'bool' | 'time' | 'json' | 'id' | 'text'

export function typeTone(type: string): Tone {
  const s = type.toLowerCase().trim()
  if (!s) return 'text'
  if (s.endsWith('[]') || s.startsWith('_') || /^(jsonb?|xml|hstore)\b/.test(s)) return 'json'
  if (/^bool/.test(s)) return 'bool'
  if (/^(date|time|timestamp|interval)/.test(s)) return 'time'
  if (/^(uuid|bytea|inet|cidr|macaddr|oid)\b/.test(s)) return 'id'
  if (/^(int|smallint|bigint|serial|bigserial|smallserial|numeric|decimal|real|double|float|money)/.test(s)) return 'num'
  return 'text'
}

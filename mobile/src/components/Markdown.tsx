import { memo, useMemo, type ReactNode } from 'react'
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native'
import { marked, type Token, type Tokens } from 'marked'
import { C } from '@/lib/theme'

// An agent's reply, rendered the way riven's chat shows it: headings, lists,
// quotes, tables and code blocks, not the raw markdown. marked only tokenizes
// here (pure JS); every block is drawn with React Native views in riven's
// palette, so nothing native is needed and it runs in Expo Go.

type Inline = Token[] | undefined

function inline(tokens: Inline, key = 'i'): ReactNode[] {
  if (!tokens) return []
  return tokens.map((t, i) => {
    const k = `${key}-${i}`
    switch (t.type) {
      case 'strong':
        return (
          <Text key={k} style={s.strong}>
            {inline((t as Tokens.Strong).tokens, k)}
          </Text>
        )
      case 'em':
        return (
          <Text key={k} style={s.em}>
            {inline((t as Tokens.Em).tokens, k)}
          </Text>
        )
      case 'del':
        return (
          <Text key={k} style={s.del}>
            {inline((t as Tokens.Del).tokens, k)}
          </Text>
        )
      case 'codespan':
        return (
          <Text key={k} style={s.codespan}>
            {decode((t as Tokens.Codespan).text)}
          </Text>
        )
      case 'link': {
        const l = t as Tokens.Link
        return (
          <Text key={k} style={s.link} onPress={() => void Linking.openURL(l.href).catch(() => {})}>
            {inline(l.tokens, k)}
          </Text>
        )
      }
      case 'br':
        return <Text key={k}>{'\n'}</Text>
      case 'text': {
        const tt = t as Tokens.Text
        return <Text key={k}>{tt.tokens ? inline(tt.tokens, k) : decode(tt.text)}</Text>
      }
      case 'escape':
        return <Text key={k}>{decode((t as Tokens.Escape).text)}</Text>
      default:
        return <Text key={k}>{decode((t as { raw?: string }).raw ?? '')}</Text>
    }
  })
}

function block(t: Token, key: string): ReactNode {
  switch (t.type) {
    case 'heading': {
      const h = t as Tokens.Heading
      return (
        <Text key={key} style={[s.p, h.depth <= 1 ? s.h1 : h.depth === 2 ? s.h2 : s.h3]}>
          {inline(h.tokens, key)}
        </Text>
      )
    }
    case 'paragraph':
      return (
        <Text key={key} style={s.p}>
          {inline((t as Tokens.Paragraph).tokens, key)}
        </Text>
      )
    case 'text':
      return (
        <Text key={key} style={s.p}>
          {inline((t as Tokens.Text).tokens, key)}
        </Text>
      )
    case 'code': {
      const c = t as Tokens.Code
      return (
        <View key={key} style={s.code}>
          {!!c.lang && <Text style={s.codeLang}>{c.lang}</Text>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Text style={s.codeText} selectable>
              {c.text}
            </Text>
          </ScrollView>
        </View>
      )
    }
    case 'list': {
      const l = t as Tokens.List
      const start = typeof l.start === 'number' ? l.start : 1
      return (
        <View key={key} style={s.list}>
          {l.items.map((item, i) => (
            <View key={`${key}-${i}`} style={s.li}>
              <Text style={s.bullet}>{item.task ? (item.checked ? '☑' : '☐') : l.ordered ? `${start + i}.` : '•'}</Text>
              <View style={s.liBody}>{item.tokens.map((c, j) => block(c, `${key}-${i}-${j}`))}</View>
            </View>
          ))}
        </View>
      )
    }
    case 'blockquote':
      return (
        <View key={key} style={s.quote}>
          {(t as Tokens.Blockquote).tokens.map((c, i) => block(c, `${key}-${i}`))}
        </View>
      )
    case 'hr':
      return <View key={key} style={s.hr} />
    case 'table': {
      const tb = t as Tokens.Table
      return (
        <ScrollView key={key} horizontal style={s.tableWrap} showsHorizontalScrollIndicator={false}>
          <View>
            <View style={[s.tr, s.th]}>
              {tb.header.map((c, i) => (
                <Text key={i} style={[s.td, s.strong]}>
                  {inline(c.tokens, `${key}-h${i}`)}
                </Text>
              ))}
            </View>
            {tb.rows.map((row, r) => (
              <View key={r} style={s.tr}>
                {row.map((c, i) => (
                  <Text key={i} style={s.td}>
                    {inline(c.tokens, `${key}-${r}-${i}`)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )
    }
    case 'space':
      return null
    default:
      return (
        <Text key={key} style={s.p}>
          {decode((t as { raw?: string }).raw ?? '')}
        </Text>
      )
  }
}

// marked leaves HTML entities in text it escaped.
function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

export default memo(function Markdown({ text }: { text: string }): JSX.Element {
  const tokens = useMemo(() => {
    try {
      return marked.lexer(text)
    } catch {
      return null
    }
  }, [text])
  if (!tokens) return <Text style={s.p}>{text}</Text>
  return <View style={s.root}>{tokens.map((t, i) => block(t, `b${i}`))}</View>
})

const s = StyleSheet.create({
  root: { gap: 8 },
  p: { color: C.fg, fontSize: 15, lineHeight: 22 },
  h1: { fontSize: 19, lineHeight: 26, fontWeight: '700', marginTop: 4 },
  h2: { fontSize: 17, lineHeight: 24, fontWeight: '700', marginTop: 2 },
  h3: { fontSize: 15, lineHeight: 22, fontWeight: '700' },
  strong: { fontWeight: '700', color: C.fg },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through', color: C.dim },
  codespan: { fontFamily: 'monospace', fontSize: 13.5, color: '#d6cffd', backgroundColor: 'rgba(139,124,246,0.14)' },
  link: { color: C.accent, textDecorationLine: 'underline' },
  code: { backgroundColor: C.bg, borderColor: C.edge, borderWidth: 1, borderRadius: 10, padding: 10, gap: 4 },
  codeLang: { color: C.dim, fontSize: 11, fontWeight: '600' },
  codeText: { color: C.fg, fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
  list: { gap: 4 },
  li: { flexDirection: 'row', gap: 8 },
  bullet: { color: C.dim, fontSize: 15, lineHeight: 22, minWidth: 14 },
  liBody: { flex: 1, gap: 4 },
  quote: { borderLeftColor: C.edge, borderLeftWidth: 3, paddingLeft: 10, gap: 6 },
  hr: { height: 1, backgroundColor: C.edge, marginVertical: 4 },
  tableWrap: { borderColor: C.edge, borderWidth: 1, borderRadius: 8 },
  tr: { flexDirection: 'row', borderBottomColor: C.edge, borderBottomWidth: 1 },
  th: { backgroundColor: C.bg2 },
  td: { color: C.fg, fontSize: 14, lineHeight: 20, paddingVertical: 6, paddingHorizontal: 10, minWidth: 90, maxWidth: 240 }
})

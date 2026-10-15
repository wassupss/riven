import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { C } from '@/lib/theme'

// "도구 N개 사용", and under it, once tapped, what those calls were: the tool
// and what it was pointed at (a file, a command, a search).

export default function ToolList({
  count,
  list
}: {
  count: number
  list?: Array<{ name: string; detail: string }>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const more = list ? count - list.length : 0
  if (!list?.length) return <Text style={s.head}>도구 {count}개 사용</Text>
  return (
    <View>
      <Pressable style={s.toggle} onPress={() => setOpen((o) => !o)} hitSlop={6}>
        <Text style={s.head}>도구 {count}개 사용</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={C.dim} />
      </Pressable>
      {open && (
        <View style={s.list}>
          {list.map((t, i) => (
            <View key={i} style={s.row}>
              <Text style={s.name} numberOfLines={1}>
                {t.name}
              </Text>
              <Text style={s.detail} numberOfLines={2}>
                {t.detail}
              </Text>
            </View>
          ))}
          {more > 0 && <Text style={s.head}>외 {more}개</Text>}
        </View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  head: { color: C.dim, fontSize: 12 },
  list: { marginTop: 6, gap: 5, borderLeftColor: C.edge, borderLeftWidth: 2, paddingLeft: 10 },
  row: { flexDirection: 'row', gap: 8 },
  name: { color: C.accent, fontSize: 12, fontWeight: '600', minWidth: 44, flexShrink: 0 },
  detail: { flex: 1, color: C.dim, fontSize: 12, fontFamily: 'monospace' }
})

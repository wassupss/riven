import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import type { Choice } from '@riven/remote'
import { C, R } from '@/lib/theme'

// A list of choices that slides over the bottom of the screen it is drawn in.
// Not a Modal: an Android Modal is its own window, and the edge-to-edge insets
// do not line up with it (the gap under the chat composer came from exactly
// that). Render it last in the screen so it sits on top.

export default function Sheet({
  title,
  options,
  value,
  onPick,
  onClose
}: {
  title: string
  options: Choice[]
  value?: string
  onPick: (value: string) => void
  onClose: () => void
}): JSX.Element {
  const insets = useSafeAreaInsets()
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Text style={s.title}>{title}</Text>
        <ScrollView style={s.list} contentContainerStyle={s.listIn}>
          {options.map((o) => (
            <Pressable
              key={o.value}
              style={({ pressed }) => [s.row, pressed && s.pressed]}
              onPress={() => {
                onPick(o.value)
                onClose()
              }}
            >
              <Text style={[s.label, o.value === value && s.on]} numberOfLines={1}>
                {o.label}
              </Text>
              {o.value === value && <Ionicons name="checkmark" size={20} color={C.accent} />}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '70%',
    backgroundColor: C.bg2,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderColor: C.edge,
    borderWidth: 1,
    paddingTop: 14
  },
  title: { color: C.dim, fontSize: 13, fontWeight: '600', paddingHorizontal: 20, paddingBottom: 8 },
  list: { flexGrow: 0 },
  listIn: { paddingHorizontal: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: R
  },
  pressed: { backgroundColor: C.bg3 },
  label: { flex: 1, color: C.fg, fontSize: 16 },
  on: { color: C.accent, fontWeight: '600' }
})

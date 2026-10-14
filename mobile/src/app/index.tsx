import { useCallback, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { listComputers, type Computer } from '@/lib/computers'
import { C, R } from '@/lib/theme'

// The computers this phone is paired with.
export default function Home(): JSX.Element {
  const [list, setList] = useState<Computer[] | null>(null)

  useFocusEffect(
    useCallback(() => {
      void listComputers().then(setList)
    }, [])
  )

  if (list === null) return <View style={s.screen} />

  return (
    <View style={s.screen}>
      {list.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyTitle}>연결된 컴퓨터가 없어요</Text>
          <Text style={s.emptyText}>
            컴퓨터의 riven에서 설정 › 원격 제어 › 휴대폰 추가를 누르고, 나오는 QR 코드를 찍어주세요.
          </Text>
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(c) => c.id}
          contentContainerStyle={s.list}
          renderItem={({ item }) => (
            <Pressable style={s.card} onPress={() => router.push({ pathname: '/c/[id]', params: { id: item.id } })}>
              <Text style={s.cardTitle}>{item.name}</Text>
              <Text style={s.cardSub}>{new Date(item.pairedAt).toLocaleDateString()} 연결</Text>
            </Pressable>
          )}
        />
      )}
      <Pressable style={s.primary} onPress={() => router.push('/pair')}>
        <Text style={s.primaryText}>컴퓨터 추가</Text>
      </Pressable>
    </View>
  )
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, padding: 16 },
  list: { gap: 10 },
  card: { backgroundColor: C.bg2, borderColor: C.edge, borderWidth: 1, borderRadius: R, padding: 16 },
  cardTitle: { color: C.fg, fontSize: 17, fontWeight: '600' },
  cardSub: { color: C.dim, fontSize: 13, marginTop: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 10 },
  emptyTitle: { color: C.fg, fontSize: 18, fontWeight: '600' },
  emptyText: { color: C.dim, fontSize: 15, textAlign: 'center', lineHeight: 22 },
  primary: { backgroundColor: C.accent, borderRadius: R, paddingVertical: 15, alignItems: 'center', marginTop: 12 },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '600' }
})

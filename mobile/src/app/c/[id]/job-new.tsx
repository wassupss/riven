import { useMemo, useState, type ReactNode } from 'react'
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import type { Choice, RemoteJobTarget, RemoteTrigger } from '@riven/remote'
import Sheet from '@/components/Sheet'
import { useComputerCtx } from '@/lib/ComputerContext'
import { reason } from '@/lib/reason'
import { DAYS, clock } from '@/lib/schedule'
import { C, R } from '@/lib/theme'

// A new scheduled job, made here and kept on the computer: the same fields as
// riven's own scheduler, with every time chosen from a list (no typing a clock).

type Kind = RemoteTrigger['kind']
const KINDS: Array<[Kind, string]> = [
  ['daily', '매일'],
  ['weekdays', '평일'],
  ['weekly', '매주'],
  ['once', '한 번'],
  ['hourly', '매시간'],
  ['every', '간격']
]
const HOURS: Choice[] = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: clock(h, 0).replace(':00', '시')
}))
const MINUTES: Choice[] = Array.from({ length: 12 }, (_, i) => ({
  value: String(i * 5),
  label: `${i * 5}분`
}))
const INTERVALS: Choice[] = [15, 30, 60, 120, 180, 360, 720].map((m) => ({
  value: String(m),
  label: m < 60 ? `${m}분마다` : `${m / 60}시간마다`
}))
const DATES: Choice[] = [
  { value: '0', label: '오늘' },
  { value: '1', label: '내일' },
  { value: '2', label: '모레' }
]

type Picking = 'workspace' | 'hour' | 'minute' | 'interval' | 'model' | 'chat' | null

export default function NewJob(): JSX.Element {
  const { link, notify } = useComputerCtx()
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  const view = link.jobs
  const [workspace, setWorkspace] = useState(view?.workspaces[0]?.value ?? '')
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<Kind>('daily')
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)
  const [day, setDay] = useState(1)
  const [dateOffset, setDateOffset] = useState(0)
  const [interval, setEvery] = useState(60)
  const [targetKind, setTargetKind] = useState<'new' | 'pane'>('new')
  const [model, setModel] = useState('default')
  const [chatKey, setChatKey] = useState('')
  const [picking, setPicking] = useState<Picking>(null)
  const [saving, setSaving] = useState(false)

  const chats = useMemo(
    () =>
      link.agents
        .filter((a) => a.kind === 'chat' && a.wsId === workspace)
        .map((a) => ({ value: a.id, label: a.title })),
    [link.agents, workspace]
  )
  const label = (list: Choice[], v: string): string => list.find((x) => x.value === v)?.label ?? v

  const trigger = (): RemoteTrigger | null => {
    switch (kind) {
      case 'daily':
      case 'weekdays':
        return { kind, hour, minute }
      case 'weekly':
        return { kind, day, hour, minute }
      case 'hourly':
        return { kind, minute }
      case 'every':
        return { kind, minutes: interval }
      case 'once': {
        const d = new Date()
        d.setDate(d.getDate() + dateOffset)
        d.setHours(hour, minute, 0, 0)
        return d.getTime() > Date.now() ? { kind, at: d.getTime() } : null
      }
    }
  }

  const target: RemoteJobTarget | null =
    targetKind === 'new'
      ? {
          kind: 'new',
          cli: 'claude',
          ...(model !== 'default' ? { model } : {})
        }
      : chatKey
        ? { kind: 'pane', chatKey, title: label(chats, chatKey) }
        : null

  const ready = !!workspace && !!prompt.trim() && !!target && !saving

  const save = (): void => {
    const t = trigger()
    if (!t) return notify('이미 지난 시각이에요', '날짜나 시간을 다시 골라주세요.')
    if (!target) return
    setSaving(true)
    void link
      .addJob({
        workspace,
        name: name.trim() || prompt.trim().split('\n')[0].slice(0, 30),
        prompt,
        trigger: t,
        target
      })
      .then((a) => {
        setSaving(false)
        if (a.ok) router.back()
        else notify('만들지 못했어요', reason(a.error))
      })
  }

  const sheet = ((): {
    title: string
    options: Choice[]
    value: string
    pick: (v: string) => void
  } | null => {
    switch (picking) {
      case 'workspace':
        return {
          title: '워크스페이스',
          options: view?.workspaces ?? [],
          value: workspace,
          pick: (v) => {
            setWorkspace(v)
            setChatKey('')
          }
        }
      case 'hour':
        return {
          title: '시',
          options: HOURS,
          value: String(hour),
          pick: (v) => setHour(Number(v))
        }
      case 'minute':
        return {
          title: '분',
          options: MINUTES,
          value: String(minute),
          pick: (v) => setMinute(Number(v))
        }
      case 'interval':
        return {
          title: '간격',
          options: INTERVALS,
          value: String(interval),
          pick: (v) => setEvery(Number(v))
        }
      case 'model':
        return {
          title: '모델',
          options: view?.models ?? [],
          value: model,
          pick: setModel
        }
      case 'chat':
        return {
          title: '보낼 챗',
          options: chats,
          value: chatKey,
          pick: setChatKey
        }
      default:
        return null
    }
  })()

  const timeRow = (
    <View style={s.row}>
      <Select label={clock(hour, 0).replace(':00', '시')} onPress={() => setPicking('hour')} />
      <Select label={`${minute}분`} onPress={() => setPicking('minute')} />
    </View>
  )

  return (
    <KeyboardAvoidingView style={s.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView contentContainerStyle={[s.form, { paddingBottom: 24 }]} keyboardShouldPersistTaps="handled">
        <Field label="워크스페이스">
          <Select
            label={label(view?.workspaces ?? [], workspace) || '고르기'}
            onPress={() => setPicking('workspace')}
          />
        </Field>

        <Field label="할 일">
          <TextInput
            style={[s.input, s.multi]}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="에이전트에게 보낼 메시지"
            placeholderTextColor={C.dim}
            multiline
          />
        </Field>

        <Field label="이름 (선택)">
          <TextInput
            style={s.input}
            value={name}
            onChangeText={setName}
            placeholder="비워두면 할 일의 첫 줄"
            placeholderTextColor={C.dim}
            maxLength={100}
          />
        </Field>

        <Field label="언제">
          <View style={s.chips}>
            {KINDS.map(([k, l]) => (
              <Chip key={k} label={l} on={kind === k} onPress={() => setKind(k)} />
            ))}
          </View>
          {kind === 'once' && (
            <View style={s.chips}>
              {DATES.map((d) => (
                <Chip
                  key={d.value}
                  label={d.label}
                  on={dateOffset === Number(d.value)}
                  onPress={() => setDateOffset(Number(d.value))}
                />
              ))}
            </View>
          )}
          {kind === 'weekly' && (
            <View style={s.chips}>
              {DAYS.map((d, i) => (
                <Chip key={d} label={d} on={day === i} onPress={() => setDay(i)} />
              ))}
            </View>
          )}
          {(kind === 'daily' || kind === 'weekdays' || kind === 'weekly' || kind === 'once') && timeRow}
          {kind === 'hourly' && (
            <View style={s.row}>
              <Select label={`매시 ${minute}분`} onPress={() => setPicking('minute')} />
            </View>
          )}
          {kind === 'every' && (
            <View style={s.row}>
              <Select label={label(INTERVALS, String(interval))} onPress={() => setPicking('interval')} />
            </View>
          )}
        </Field>

        <Field label="어디로">
          <View style={s.chips}>
            <Chip label="새 챗 열기" on={targetKind === 'new'} onPress={() => setTargetKind('new')} />
            <Chip label="기존 챗에 보내기" on={targetKind === 'pane'} onPress={() => setTargetKind('pane')} />
          </View>
          {targetKind === 'new' ? (
            <View style={s.row}>
              <Select label={label(view?.models ?? [], model)} onPress={() => setPicking('model')} />
            </View>
          ) : chats.length ? (
            <View style={s.row}>
              <Select label={chatKey ? label(chats, chatKey) : '챗 고르기'} onPress={() => setPicking('chat')} />
            </View>
          ) : (
            <Text style={s.note}>이 워크스페이스에 열린 챗이 없어요.</Text>
          )}
        </Field>
      </ScrollView>

      <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Pressable style={[s.save, !ready && s.dim]} disabled={!ready} onPress={save}>
          <Text style={s.saveText}>{saving ? '저장 중…' : '저장'}</Text>
        </Pressable>
      </View>

      {sheet && (
        <Sheet
          title={sheet.title}
          options={sheet.options}
          value={sheet.value}
          onPick={sheet.pick}
          onClose={() => setPicking(null)}
        />
      )}
    </KeyboardAvoidingView>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      {children}
    </View>
  )
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }): JSX.Element {
  return (
    <Pressable style={[s.chip, on && s.chipOn]} onPress={onPress}>
      <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
    </Pressable>
  )
}

function Select({ label, onPress }: { label: string; onPress: () => void }): JSX.Element {
  return (
    <Pressable style={s.select} onPress={onPress}>
      <Text style={s.selectText} numberOfLines={1}>
        {label}
      </Text>
      <Ionicons name="chevron-down" size={16} color={C.dim} />
    </Pressable>
  )
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  form: { padding: 16, gap: 18 },
  field: { gap: 8 },
  label: { color: C.dim, fontSize: 12, fontWeight: '600', letterSpacing: 0.6 },
  input: {
    color: C.fg,
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: R,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15
  },
  multi: { minHeight: 96, maxHeight: 200, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14
  },
  chipOn: { backgroundColor: 'rgba(139,124,246,0.18)', borderColor: C.accent },
  chipText: { color: C.fg, fontSize: 14 },
  chipTextOn: { color: C.accent, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8 },
  select: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: C.bg2,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: R,
    paddingHorizontal: 12,
    paddingVertical: 12
  },
  selectText: { flex: 1, color: C.fg, fontSize: 15 },
  note: { color: C.dim, fontSize: 14 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopColor: C.edge,
    borderTopWidth: 1,
    backgroundColor: C.bg
  },
  save: {
    backgroundColor: C.accent,
    borderRadius: R,
    paddingVertical: 15,
    alignItems: 'center'
  },
  saveText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  dim: { opacity: 0.45 }
})

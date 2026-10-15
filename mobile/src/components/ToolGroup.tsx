import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { C } from '@/lib/theme'

// Tool calls the way riven's chat shows a finished turn (ChatPanel ToolGroup /
// ToolItem / SubagentCard): consecutive calls fold into one outlined group,
// "명령 N개 · N 변경", opening to a line per call with its icon, name and what it
// was pointed at. A subagent delegation is its own card, not a line in a group.

export interface Tool {
  name: string
  detail: string
}

type IconName = keyof typeof Ionicons.glyphMap

// Same mapping as the desktop's TOOL_ICON, in Ionicons.
const ICON: Record<string, IconName> = {
  Read: 'document-text-outline',
  Edit: 'pencil-outline',
  Write: 'pencil-outline',
  MultiEdit: 'pencil-outline',
  NotebookEdit: 'pencil-outline',
  Bash: 'terminal-outline',
  BashOutput: 'terminal-outline',
  Grep: 'search-outline',
  Glob: 'folder-open-outline',
  LS: 'list-outline',
  WebFetch: 'globe-outline',
  WebSearch: 'globe-outline',
  TodoWrite: 'checkbox-outline'
}

const CHANGES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export const isSubagent = (name: string): boolean => name === 'Agent' || name === 'Task'

function ToolItem({ t }: { t: Tool }): JSX.Element {
  return (
    <View style={s.item}>
      <Ionicons name={ICON[t.name] ?? 'construct-outline'} size={13} color={C.dim} />
      <Text style={s.name} numberOfLines={1}>
        {t.name}
      </Text>
      {!!t.detail && (
        <Text style={s.detail} numberOfLines={1} ellipsizeMode="middle">
          {t.detail}
        </Text>
      )}
    </View>
  )
}

export function ToolGroup({ tools }: { tools: Tool[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const changed = tools.filter((t) => CHANGES.has(t.name)).length
  return (
    <View style={s.group}>
      <Pressable style={s.head} onPress={() => setOpen((o) => !o)} hitSlop={4}>
        <Ionicons name="construct-outline" size={13} color={C.dim} />
        <Text style={s.title} numberOfLines={1}>
          명령 {tools.length}개{changed > 0 ? ` · ${changed} 변경` : ''}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={C.dim} />
      </Pressable>
      {open && (
        <View style={s.body}>
          {tools.map((t, i) => (
            <ToolItem key={i} t={t} />
          ))}
        </View>
      )}
    </View>
  )
}

export function SubagentCard({ task, kids }: { task: Tool; kids: Tool[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <View style={s.agent}>
      <Pressable style={s.head} onPress={() => setOpen((o) => !o)} disabled={!kids.length} hitSlop={4}>
        <Ionicons name="git-branch-outline" size={14} color={C.accent} />
        <Text style={s.agentTitle}>서브에이전트</Text>
        <Text style={s.agentDesc} numberOfLines={1}>
          {task.detail}
        </Text>
        <Ionicons name="checkmark" size={13} color={C.ok} />
        <Text style={s.agentDone}>완료</Text>
        {kids.length > 0 && <Text style={s.count}>{kids.length}</Text>}
        {kids.length > 0 && <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={C.dim} />}
      </Pressable>
      {open && (
        <View style={s.body}>
          {kids.map((t, i) => (
            <ToolItem key={i} t={t} />
          ))}
        </View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  // Finished: the desktop's done border, success at half strength.
  group: {
    borderColor: C.ok + '80',
    borderWidth: 1,
    borderRadius: 8,
    backgroundColor: 'rgba(232,232,234,0.04)',
    overflow: 'hidden'
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 10 },
  title: { flex: 1, color: C.dim, fontSize: 13 },
  body: {
    gap: 6,
    paddingTop: 6,
    paddingBottom: 9,
    paddingHorizontal: 10,
    borderTopColor: C.edge,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  item: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  name: { color: C.fg, fontSize: 13, fontWeight: '500', flexShrink: 0 },
  detail: { flex: 1, color: C.dim, fontSize: 12, fontFamily: 'monospace' },
  agent: {
    borderColor: C.accent + '66',
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 8,
    backgroundColor: C.accent + '10',
    overflow: 'hidden'
  },
  agentTitle: { color: C.accent, fontSize: 13, fontWeight: '600' },
  agentDesc: { flex: 1, color: C.dim, fontSize: 13 },
  agentDone: { color: C.ok, fontSize: 12, fontWeight: '500' },
  count: {
    color: C.accent,
    fontSize: 11,
    paddingHorizontal: 6,
    borderRadius: 999,
    backgroundColor: C.accent + '26',
    overflow: 'hidden'
  }
})

import { useEffect, useRef, useState } from 'react'
import {
  Plus,
  X,
  Users,
  GitBranch,
  Eye,
  Trash2,
  UserPlus,
  ArrowLeft,
  Pencil,
  Check,
  Loader2,
  Circle,
  AlertCircle,
  Square,
  User,
  Target
} from 'lucide-react'
import { askChatTurn, useAgents, agentsForWorkspace, resolveAgent } from '../../state/agents'
import {
  useAgentGroups,
  type GroupMember,
  type AgentGroup
} from '../../state/agentGroups'
import { addChat, getActiveApi, setChatTitle, setChatAvatar, type SplitDir } from '../registry'
import { pathOf } from '../../state/session'
import { usePipelineRuns, type RunStage } from '../../state/pipelineRuns'
import { useGroupLog } from '../../state/groupLog'
import { useGoals, goalsFor, type Goal } from '../../state/goals'
import { modelsFor, modelForCli, type Cli } from '../../lib/models'
import { usePipelines, type PipelineDef } from '../../state/pipelines'
import { useT, type TFn } from '../../i18n'
import { promptInput } from '../../components/promptInput'
import {
  tintStyle,
  hueColor,
  encodeAvatar,
  avatarSpec,
  AVATAR_COLOR_COUNT,
  AVATAR_NONE
} from '../../lib/avatar'
import '../../styles/agent-group.css'

// A member pane's tab title: "name · group" so the tab shows who it is and which
// team it belongs to.
const memberTitle = (name: string, group: string): string =>
  group.trim() ? `${name} · ${group.trim()}` : name

// Avatar chooser used in the group editor: click the current face to open a small
// popover of glyphs + colors. Picking either commits a "glyph.color" override.
function AvatarPicker({
  name,
  override,
  onPick
}: {
  name: string
  override?: string | null
  onPick: (spec: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const isNone = override === AVATAR_NONE
  const spec = avatarSpec(name, override)
  return (
    <div className="agp-avatarpick">
      <button
        type="button"
        className={`agp-avatarpick-btn${isNone ? ' none' : ''}`}
        style={isNone ? undefined : { background: hueColor(spec.color) }}
        onClick={() => setOpen((o) => !o)}
        title="색상 선택"
      />
      {open && (
        <div className="agp-avatarpop">
          <div className="agp-avatarpop-row">
            <button
              type="button"
              className={`agp-avatarpop-color none${isNone ? ' on' : ''}`}
              onClick={() => onPick(AVATAR_NONE)}
              aria-label="no color"
              title="색상 없음"
            />
            {Array.from({ length: AVATAR_COLOR_COUNT }, (_, c) => (
              <button
                key={c}
                type="button"
                className={`agp-avatarpop-color${!isNone && c === spec.color ? ' on' : ''}`}
                style={{ background: hueColor(c) }}
                onClick={() => onPick(encodeAvatar(spec.glyph, c))}
                aria-label={`color ${c}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}


const MIN = 2
const MAX = 8
// Members stack vertically to the right of the lead, at most this many per column;
// overflow starts a new column further right.
const MAX_PER_COL = 3
const PIPE_TIMEOUT_MS = 300_000

// ---- draft (compose) shapes -------------------------------------------------

interface Draft {
  name: string
  persona: string
  // Which agent runs this member. A team is allowed to mix them — that is the
  // point of having more than one — so it is picked per member, not per group.
  cli: Cli
  model: string
  parent: number | null // index of another draft this one reports to
  agent: string // custom agent (.claude/agents) or '' for a plain chat
}

interface Stage {
  name: string
  cli: Cli
  model: string
  role: string
  agent: string // custom agent (.claude/agents) or ''
}

interface AgentDef {
  name: string
  description: string
  source: 'project' | 'user'
}

// ---- reporting tree ---------------------------------------------------------

interface TreeItem {
  name: string
  sub: string
  parent: number | null
  open: boolean
  busy: boolean
  chatKey?: string
  avatar?: string | null
  /** What it runs on, shown as its own chip rather than buried in `sub`. */
  model?: string
  cli?: Cli
}

interface TreeNode extends TreeItem {
  idx: number
  isMain: boolean
  children: TreeNode[]
}

// Build a forest of reporting trees from a flat member list (parent = index).
// Roots are members with no parent (the main agent); cycles are broken defensively.
function buildForest(items: TreeItem[]): TreeNode[] {
  const children: Record<number, number[]> = {}
  const roots: number[] = []
  items.forEach((it, i) => {
    if (it.parent != null && it.parent !== i && items[it.parent]) {
      ;(children[it.parent] ??= []).push(i)
    } else {
      roots.push(i)
    }
  })
  const seen = new Set<number>()
  const make = (i: number): TreeNode => {
    seen.add(i)
    const it = items[i]
    return {
      ...it,
      idx: i,
      isMain: it.parent == null,
      children: (children[i] ?? []).filter((c) => !seen.has(c)).map(make)
    }
  }
  return roots.map(make)
}

// One org-chart node + its subtree. Closed members render faded with the reopen
// hint; open members focus their pane on click.
// One agent in the chart.
//
// The old card was a name, the word MAIN and a dot — which told you neither what
// the member runs on nor what it is doing, so a team of three read as three
// identical grey boxes. It now says, in order of what you actually look for:
// who it is (colour + name + whether it leads), what its job is, what model is
// behind it, and whether it is working right now.
// One agent in the chart.
//
// The old card was a name, the word MAIN and a dot — which told you neither what
// the member runs on nor what it is doing, so a team of three read as three
// identical grey boxes. It now says, in order of what you actually look for:
// who it is (colour + name + whether it leads), what its job is, what model is
// behind it, and whether it is working right now.
function OrgCard({ node, closedLabel, onPick }: {
  node: TreeNode
  closedLabel: string
  onPick: (n: TreeNode) => void
}): JSX.Element {
  const t = useT()
  const cls = `agp-node${node.isMain ? ' agp-main' : ''}${node.open ? '' : ' closed'}${
    node.busy ? ' busy' : ''
  }`
  // The agent's colour identifies it here and on its tab — the same face in
  // both. tintStyle only answers when the user has PICKED a colour, so the dot
  // falls back to the accent rather than staying a grey pebble on every card.
  const tint = tintStyle(node.name, node.avatar, 'var(--bg-2)')
  const state = node.busy ? t('team.busy') : node.open ? t('team.idle') : closedLabel
  return (
    <button className={cls} onClick={() => onPick(node)} title={node.sub}>
      <span className="agp-node-top">
        <span
          className="agp-node-face"
          style={{ background: tint ? tint.color : 'var(--accent)' }}
          aria-hidden
        />
        <span className="agp-node-name">{node.name || '?'}</span>
        {node.isMain && <span className="agp-node-badge">{t('team.lead')}</span>}
      </span>
      <span className="agp-node-sub">{node.sub}</span>
      <span className="agp-node-foot">
        {node.model && node.model !== 'default' && <span className="agp-node-chip">{node.model}</span>}
        {node.cli === 'codex' && <span className="agp-node-chip">codex</span>}
        <span className={`agp-node-state${node.busy ? ' busy' : node.open ? '' : ' closed'}`}>{state}</span>
      </span>
    </button>
  )
}

// The tree, drawn left to right: an agent, and everyone who reports to it
// stacked to its right off a single rail.
//
// It used to be a centred ul/li tree that grew sideways, so three members sat in
// a row of thin connectors in the middle of a half-screen of dots — and it
// looked nothing like the pipeline view, which is the other thing this panel
// draws. Flowing rightwards puts the hierarchy in reading order, keeps members
// in a vertical stack like the pipeline's stages, and the rail is drawn exactly
// (every card is the same height, so the joints land on the card centres).
function OrgBranch({ node, closedLabel, onPick }: {
  node: TreeNode
  closedLabel: string
  onPick: (n: TreeNode) => void
}): JSX.Element {
  return (
    <div className="agp-tree-row">
      <div className="agp-tree-self">
        <OrgCard node={node} closedLabel={closedLabel} onPick={onPick} />
      </div>
      {node.children.length > 0 && (
        <div className="agp-tree-kids">
          {node.children.map((c) => (
            <div className="agp-tree-kid" key={c.idx}>
              <OrgBranch node={c} closedLabel={closedLabel} onPick={onPick} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OrgChart({
  roots,
  emptyLabel,
  closedLabel,
  onPick
}: {
  roots: TreeNode[]
  emptyLabel: string
  closedLabel: string
  onPick: (n: TreeNode) => void
}): JSX.Element {
  if (roots.length === 0) return <div className="agp-chart-empty">{emptyLabel}</div>
  return (
    <div className="agp-tree">
      {roots.map((r) => (
        <OrgBranch key={r.idx} node={r} closedLabel={closedLabel} onPick={onPick} />
      ))}
    </div>
  )
}

// A spawned teammate's role block. Sent as its SYSTEM prompt at spawn (not as a
// chat turn), so it stays in character and knows who it reports to without
// spending a request or polluting the visible conversation.
function priming(
  name: string,
  persona: string,
  group: string,
  parentName: string | null,
  t: TFn
): string {
  const lines: string[] = []
  lines.push(`[${t('agentGroup.name')}] ${name.trim()}`)
  lines.push(`[${t('agentGroup.role')}] ${persona.trim() || t('team.noPersona')}`)
  if (group.trim()) lines.push(`[${t('agentGroup.groupName')}] ${group.trim()}`)
  // Make the pane's position explicit so it actually knows it's the lead vs a
  // member (before it just got a name and often didn't realise its role).
  if (parentName) {
    lines.push(`[${t('agentGroup.reportsTo')}] ${parentName}`)
    lines.push(t('agentGroup.memberIdentity', { name: name.trim(), parent: parentName }))
  } else {
    lines.push(t('agentGroup.leadIdentity', { name: name.trim() }))
  }
  return `${lines.join('\n')}\n${t('agentGroup.primeSuffix')}`
}

// Dockable Agent Group panel - riven's orchestration surface. A tab strip holds a
// "새 그룹" (compose) tab plus one tab per open group. The compose tab toggles
// between a normal group (a grid of member cards + org preview) and a serial
// pipeline; a group tab draws that group's reporting tree.
export default function AgentGroupPanel({ workspace }: { workspace: string }): JSX.Element {
  const t = useT()
  useAgents((s) => s.version) // re-render when the live roster changes
  const groups = useAgentGroups((s) => s.byWorkspace[workspace]) ?? []
  const {
    createGroup,
    addMember,
    removeMember,
    setMemberChatKey,
    updateMember,
    renameGroup,
    deleteGroup
  } = useAgentGroups((s) => s)
  const runs = usePipelineRuns((s) => s.runs).filter((r) => r.workspace === workspace)
  const {
    start: startRun,
    setStage: setRunStage,
    setCurrent: setRunCurrent,
    finish: finishRun,
    cancel: cancelRunStore,
    isCanceled: isRunCanceled,
    remove: removeRun
  } = usePipelineRuns((s) => s)
  const pipelines = usePipelines((s) => s.byWorkspace[workspace]) ?? []
  const goals = useGoals((s) => s.byWorkspace[workspace]) ?? []
  const {
    create: createPipeline,
    remove: removePipeline
  } = usePipelines((s) => s)

  // null = the "새 그룹" draft tab; otherwise the shown group's name.
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [mode, setMode] = useState<'group' | 'pipeline'>('group')
  const shownGoal = activeTab?.startsWith('goal:')
    ? goals.find((g) => g.id === activeTab.slice('goal:'.length))
    : undefined
  const [previewing, setPreviewing] = useState(false)
  // Group-tab edit mode: edit member fields / rename the group after creation.
  const [editing, setEditing] = useState(false)

  // Closing this panel no longer stops the pipelines. It used to — the reasoning
  // was "there's no UI left to control it" — but a pipeline an AGENT started is
  // not this panel's to end: closing the tab (or having it evicted when the
  // workspace is unmounted) killed work nobody asked to stop, mid-stage. The run
  // keeps going, its stage panes are right there, and reopening this panel shows
  // it again with a Cancel button.

  // Custom agents (.claude/agents) available for members/stages to run as.
  const [agentDefs, setAgentDefs] = useState<AgentDef[]>([])
  useEffect(() => {
    let live = true
    // Guard: window.api.chat.agents may be absent if the preload is stale (dev
    // reload before the app fully restarts). Never let that crash the panel.
    const fn = window.api.chat.agents
    if (typeof fn === 'function') {
      fn(pathOf(workspace))
        .then((a) => live && setAgentDefs(a))
        .catch(() => live && setAgentDefs([]))
    }
    return () => {
      live = false
    }
  }, [workspace])

  // Heal a layout↔store desync after restart: the dock restores chat panes by id,
  // but a group's stored member.chatKey can point at an id that no longer exists
  // (so the org chart wrongly shows "closed" and loses control). If a member's
  // pane is gone but an OPEN chat pane carries its exact title, re-point to it.
  useEffect(() => {
    const api = getActiveApi()
    if (!api) return
    for (const g of groups) {
      const claimed = new Set(g.members.map((x) => x.chatKey))
      for (const m of g.members) {
        if (api.getPanel(m.chatKey)) continue
        const want = memberTitle(m.name, g.group)
        const match = api.panels.find(
          (p) => p.id.startsWith('chat-') && p.title === want && !claimed.has(p.id)
        )
        if (match) {
          claimed.add(match.id)
          setMemberChatKey(workspace, g.group, m.chatKey, match.id)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length, workspace])

  // ---- normal-group draft ----
  const [groupName, setGroupName] = useState(() => t('team.nameDefault'))
  const [drafts, setDrafts] = useState<Draft[]>(() => [
    { name: t('team.mainDefault'), persona: '', cli: 'claude', model: 'default', parent: null, agent: '' },
    { name: t('team.memberDefault', { n: 1 }), persona: '', cli: 'claude', model: 'default', parent: 0, agent: '' },
    { name: t('team.memberDefault', { n: 2 }), persona: '', cli: 'claude', model: 'default', parent: 0, agent: '' }
  ])

  // ---- pipeline draft ----
  const [pipeName, setPipeName] = useState(() => t('pipe.nameDefault'))
  const [stages, setStages] = useState<Stage[]>(() => [
    { name: t('pipe.def.plan'), cli: 'claude', model: 'default', role: t('pipe.def.planRole'), agent: '' },
    { name: t('pipe.def.design'), cli: 'claude', model: 'default', role: t('pipe.def.designRole'), agent: '' },
    { name: t('pipe.def.build'), cli: 'claude', model: 'default', role: t('pipe.def.buildRole'), agent: '' },
    { name: t('pipe.def.qa'), cli: 'claude', model: 'default', role: t('pipe.def.qaRole'), agent: '' },
    { name: t('pipe.def.ship'), cli: 'claude', model: 'default', role: t('pipe.def.shipRole'), agent: '' }
  ])
  const [task, setTask] = useState('')
  const [running, setRunning] = useState(false)

  const isRunTab = !!activeTab && activeTab.startsWith('run:')
  const isPipeTab = !!activeTab && activeTab.startsWith('pipe:')
  const shown =
    activeTab && !isRunTab && !isPipeTab ? (groups.find((g) => g.group === activeTab) ?? null) : null
  const shownRun = isRunTab ? (runs.find((r) => `run:${r.id}` === activeTab) ?? null) : null
  const shownPipeline = isPipeTab
    ? (pipelines.find((p) => `pipe:${p.id}` === activeTab) ?? null)
    : null
  const onDraft = shown == null && shownRun == null && shownPipeline == null
  // The live run for the currently-shown saved pipeline (if it's running now).
  const pipelineRun = shownPipeline
    ? (runs.find((r) => r.pipelineId === shownPipeline.id && !r.done) ??
      runs.filter((r) => r.pipelineId === shownPipeline.id).slice(-1)[0] ??
      null)
    : null
  // Task text entered for the next run of the shown pipeline. Cleared when the
  // active tab changes so one pipeline's task doesn't bleed into another.
  const [runTask, setRunTask] = useState('')
  useEffect(() => setRunTask(''), [activeTab])
  // Uniform stage list for the pipeline view: live run stages when running, else
  // the saved plan (as pending). Avoids mapping over a union of array types.
  const shownPipelineStages: RunStage[] = shownPipeline
    ? pipelineRun
      ? pipelineRun.stages
      : shownPipeline.stages.map((s) => ({ ...s, status: 'pending' as const }))
    : []

  // live pane state for the org chart
  const roster = agentsForWorkspace(workspace)
  const isOpen = (chatKey: string): boolean => !!getActiveApi()?.getPanel(chatKey)
  const isBusy = (chatKey: string): boolean => roster.find((a) => a.id === chatKey)?.busy ?? false

  const subText = (persona: string, model: string, isMain: boolean): string => {
    const parts = [persona.trim(), model && model !== 'default' ? model : ''].filter(Boolean)
    return parts.length ? parts.join(' · ') : isMain ? t('team.main') : t('team.noPersona')
  }

  // A "run as custom agent" dropdown (.claude/agents). Always shown; when none are
  // defined it still appears with a hint so the option is discoverable.
  const agentSelectEl = (value: string, onChange: (v: string) => void): JSX.Element => (
    <div className="agp-card-row">
      <label className="agp-card-label">{t('team.agent')}</label>
      <select className="ui-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('team.agentNone')}</option>
        {agentDefs.map((a) => (
          <option key={a.name} value={a.name}>
            {a.name}
          </option>
        ))}
        {agentDefs.length === 0 && (
          <option value="" disabled>
            {t('team.agentEmpty')}
          </option>
        )}
      </select>
    </div>
  )

  // ---- draft card helpers ----
  const draftNames = drafts.map(
    (d, i) => d.name.trim() || (i === 0 ? t('team.mainDefault') : t('team.memberDefault', { n: i }))
  )
  const setDraft = (i: number, patch: Partial<Draft>): void =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  const addDraft = (): void =>
    setDrafts((ds) =>
      ds.length < MAX
        ? [
            ...ds,
            { name: t('team.memberDefault', { n: ds.length }), persona: '', cli: 'claude' as Cli, model: 'default', parent: 0, agent: '' }
          ]
        : ds
    )
  const removeDraft = (i: number): void =>
    setDrafts((ds) => {
      if (ds.length <= MIN) return ds
      return ds
        .filter((_, j) => j !== i)
        .map((d) => ({
          ...d,
          parent:
            d.parent == null ? null : d.parent === i ? 0 : d.parent > i ? d.parent - 1 : d.parent
        }))
    })

  const resetDraft = (): void => {
    setGroupName(t('team.nameDefault'))
    setDrafts([
      { name: t('team.mainDefault'), persona: '', cli: 'claude', model: 'default', parent: null, agent: '' },
      { name: t('team.memberDefault', { n: 1 }), persona: '', cli: 'claude', model: 'default', parent: 0, agent: '' },
      { name: t('team.memberDefault', { n: 2 }), persona: '', cli: 'claude', model: 'default', parent: 0, agent: '' }
    ])
    setPreviewing(false)
  }

  // ---- create a normal group ----
  const doCreate = (): void => {
    const g = groupName.trim() || t('team.nameDefault')
    const created: string[] = []
    const columnTops: string[] = [] // the top (first) pane of each member column
    const members: GroupMember[] = drafts.map((d, i) => {
      const parentIdx = i === 0 ? null : (d.parent ?? 0)
      const parentName = parentIdx != null ? draftNames[parentIdx] : null
      // Layout: the lead is the leftmost single pane. Members stack vertically to
      // its right, MAX_PER_COL per column; the (MAX_PER_COL+1)th member starts a
      // new column further right. e.g. lead | m1 m4 | m2 m5 | m3 m6 (cols of 3).
      let dir: SplitDir = 'right'
      let ref: string | undefined
      if (i === 0) {
        ref = undefined // beside the agent-group panel (the active pane)
      } else {
        const p = i - 1 // 0-based position among members
        const row = p % MAX_PER_COL
        const col = Math.floor(p / MAX_PER_COL)
        if (row === 0) {
          // First pane of a column: split right off the lead (col 0) or off the
          // previous column's top pane (col > 0).
          dir = 'right'
          ref = col === 0 ? created[0] : columnTops[col - 1]
        } else {
          // Below the previous pane in the same column.
          dir = 'below'
          ref = created[created.length - 1]
        }
      }
      const chatKey = addChat(
        undefined, // no priming TURN — the role goes in the system prompt instead
        dir,
        d.model === 'default' ? undefined : d.model,
        ref,
        memberTitle(draftNames[i], g),
        true, // don't steal focus while the team is being spawned
        d.agent || undefined,
        priming(draftNames[i], d.persona, g, parentName, t) || undefined,
        undefined, // this workspace
        d.cli
      )
      created.push(chatKey)
      if (i > 0 && (i - 1) % MAX_PER_COL === 0) columnTops.push(chatKey)
      return {
        name: draftNames[i],
        persona: d.persona.trim() || null,
        cli: d.cli,
        model: d.model,
        parent: parentIdx,
        chatKey,
        agent: d.agent || null
      }
    })
    createGroup(workspace, g, members)
    resetDraft()
    setActiveTab(g)
  }

  // ---- save a pipeline definition (from the draft) ----
  const doCreatePipeline = (): void => {
    const valid = stages.filter((s) => s.name.trim())
    if (valid.length < MIN) return
    const id = createPipeline(
      workspace,
      pipeName.trim() || t('pipe.nameDefault'),
      valid.map((s) => ({ name: s.name.trim(), model: s.model, role: s.role, agent: s.agent }))
    )
    // reset the pipeline draft to defaults
    setPipeName(t('pipe.nameDefault'))
    setStages([
      { name: t('pipe.def.plan'), cli: 'claude', model: 'default', role: t('pipe.def.planRole'), agent: '' },
      { name: t('pipe.def.design'), cli: 'claude', model: 'default', role: t('pipe.def.designRole'), agent: '' },
      { name: t('pipe.def.build'), cli: 'claude', model: 'default', role: t('pipe.def.buildRole'), agent: '' },
      { name: t('pipe.def.qa'), cli: 'claude', model: 'default', role: t('pipe.def.qaRole'), agent: '' },
      { name: t('pipe.def.ship'), cli: 'claude', model: 'default', role: t('pipe.def.shipRole'), agent: '' }
    ])
    setTask('')
    setRunTask('')
    setActiveTab(`pipe:${id}`)
  }

  // ---- run a saved pipeline ----
  // Creates a live run (shown inline in the pipeline's tab) and threads each
  // stage's output into the next, flipping each stage pending → running → done.
  const runPipeline = async (def: PipelineDef, taskText: string): Promise<void> => {
    const valid = def.stages.filter((s) => s.name.trim())
    if (valid.length < MIN || !taskText.trim()) return
    const runId = startRun(
      workspace,
      def.id,
      def.name,
      taskText.trim(),
      valid.map((s) => ({ name: s.name.trim(), model: s.model, role: s.role, agent: s.agent }))
    )
    setRunning(true)
    try {
      let carry = taskText.trim()
      let ref: string | undefined
      for (let i = 0; i < valid.length; i++) {
        if (isRunCanceled(runId)) break // stopped by the user / panel closed
        const st = valid[i]
        setRunCurrent(runId, i)
        setRunStage(runId, i, { status: 'running' })
        const id = addChat(
          undefined,
          'right',
          st.model === 'default' ? undefined : st.model,
          ref,
          st.name.trim() || undefined,
          true,
          st.agent || undefined,
          undefined,
          undefined,
          st.cli
        )
        ref = id // next stage opens beside this one
        setRunStage(runId, i, { chatKey: id })
        await new Promise((r) => setTimeout(r, 400)) // let the pane register as an agent
        const target = resolveAgent(id)
        if (!target) {
          setRunStage(runId, i, { status: 'error' })
          continue
        }
        // The next stage is a FRESH agent — it needs the prior stage's result as
        // input. That handoff is the header shown in the stage's chat.
        const prompt = `${st.role.trim() ? st.role.trim() + '\n\n' : ''}${t('pipe.handoffHeader')}\n${carry}`
        carry = await askChatTurn(target, prompt, PIPE_TIMEOUT_MS, '(timeout)')
        if (isRunCanceled(runId)) break // canceled while this stage was running
        setRunStage(runId, i, { status: carry === '(timeout)' ? 'error' : 'done' })
      }
    } finally {
      if (!isRunCanceled(runId)) finishRun(runId)
      setRunning(false)
    }
  }

  // Stop a running pipeline: mark canceled (the loop breaks) and interrupt the
  // stage that's mid-turn so its CLI stops too.
  const cancelRun = (id: string): void => {
    const run = usePipelineRuns.getState().runs.find((r) => r.id === id)
    const cur = run && run.current >= 0 ? run.stages[run.current] : undefined
    if (cur?.chatKey) window.api.chat.interrupt(cur.chatKey)
    cancelRunStore(id)
  }

  const setStage = (i: number, patch: Partial<Stage>): void =>
    setStages((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const addStage = (): void =>
    setStages((ss) => [...ss, { name: '', cli: 'claude', model: 'default', role: '', agent: '' }])
  const removeStage = (i: number): void =>
    setStages((ss) => (ss.length > MIN ? ss.filter((_, j) => j !== i) : ss))

  // ---- group-tab actions ----
  // The chatKey of an open member of this group — used to place a reopened/added
  // member right beside the existing team.
  const openMemberKey = (g: AgentGroup): string | undefined =>
    g.members.find((mm) => getActiveApi()?.getPanel(mm.chatKey))?.chatKey
  const onPickNode = (g: AgentGroup, node: TreeNode): void => {
    const m = g.members[node.idx]
    if (!m) return
    if (node.open) {
      getActiveApi()?.getPanel(m.chatKey)?.api.setActive()
      return
    }
    // Closed → reopen: spawn a fresh pane primed the same way, re-point the member.
    const parentName = m.parent != null ? (g.members[m.parent]?.name ?? null) : null
    // Reopen the member into its slot in the column layout (below its column
    // neighbour, or starting its column) so the team stays tidy.
    const i = node.idx
    let dir: SplitDir = 'right'
    let ref: string | undefined
    if (i === 0) {
      ref = undefined
    } else {
      const p = i - 1
      if (p % MAX_PER_COL === 0) {
        const col = Math.floor(p / MAX_PER_COL)
        const topIdx = col === 0 ? 0 : 1 + (col - 1) * MAX_PER_COL
        ref = g.members[topIdx]?.chatKey
      } else {
        dir = 'below'
        ref = g.members[i - 1]?.chatKey
      }
      if (!ref || !getActiveApi()?.getPanel(ref)) ref = openMemberKey(g)
    }
    const newKey = addChat(
      undefined, // role goes in the system prompt, not a chat turn
      dir,
      m.model === 'default' ? undefined : m.model,
      ref,
      memberTitle(m.name, g.group),
      true,
      m.agent || undefined,
      priming(m.name, m.persona ?? '', g.group, parentName, t) || undefined,
      undefined,
      m.cli
    )
    // Carry the member's avatar override to the new pane so its tab keeps the face.
    if (m.avatar) setChatAvatar(newKey, m.avatar)
    setMemberChatKey(workspace, g.group, m.chatKey, newKey)
  }

  const doAddToGroup = async (g: AgentGroup): Promise<void> => {
    const n = g.members.length
    const typed = await promptInput({
      title: t('team.mainName'),
      initial: t('team.memberDefault', { n })
    })
    const name = (typed || '').trim() || t('team.memberDefault', { n })
    const mainName = g.members[0]?.name ?? null
    // Place the new member in the next slot of the same column layout: below the
    // last member if its column has room, else start a new column to the right.
    const i = g.members.length // the new member's index
    const p = i - 1
    let dir: SplitDir = 'right'
    let ref: string | undefined
    if (p % MAX_PER_COL === 0) {
      const col = Math.floor(p / MAX_PER_COL)
      const topIdx = col === 0 ? 0 : 1 + (col - 1) * MAX_PER_COL
      ref = g.members[topIdx]?.chatKey
    } else {
      dir = 'below'
      ref = g.members[i - 1]?.chatKey
    }
    // If that neighbour pane was closed, fall back to any open member.
    if (!ref || !getActiveApi()?.getPanel(ref)) ref = openMemberKey(g)
    const chatKey = addChat(
      undefined, // role goes in the system prompt, not a chat turn
      dir,
      undefined,
      ref,
      memberTitle(name, g.group),
      true,
      undefined,
      priming(name, '', g.group, mainName, t) || undefined
    )
    addMember(workspace, g.group, { name, persona: null, model: 'default', parent: 0, chatKey })
  }

  const doDeleteGroup = (g: AgentGroup): void => {
    const ok = window.confirm(
      `${t('team.confirmDelete', { group: g.group })}\n\n${t('team.deleteDetail', {
        n: g.members.length
      })}`
    )
    if (!ok) return
    const api = getActiveApi()
    for (const m of g.members) {
      const p = api?.getPanel(m.chatKey)
      if (p && api) api.removePanel(p)
    }
    deleteGroup(workspace, g.group)
    setActiveTab(null)
  }

  // ---- edit an existing group ----
  const doRenameGroup = (g: AgentGroup, raw: string): void => {
    const nn = raw.trim()
    if (!nn || nn === g.group) return
    renameGroup(workspace, g.group, nn)
    // Re-title the member panes so their tabs track the new group name.
    for (const m of g.members) setChatTitle(m.chatKey, memberTitle(m.name, nn))
    setActiveTab(nn)
  }
  const doRenameMember = (g: AgentGroup, m: GroupMember, raw: string): void => {
    const nn = raw.trim()
    if (!nn || nn === m.name) return
    updateMember(workspace, g.group, m.chatKey, { name: nn })
    setChatTitle(m.chatKey, memberTitle(nn, g.group))
  }
  const doRemoveMember = (g: AgentGroup, m: GroupMember): void => {
    if (g.members.length <= MIN) return
    const api = getActiveApi()
    const p = api?.getPanel(m.chatKey)
    if (p && api) api.removePanel(p)
    removeMember(workspace, g.group, m.chatKey)
  }

  // ---- trees ----
  const draftTree = buildForest(
    drafts.map((d, i) => ({
      name: draftNames[i],
      sub: subText(d.persona, d.model, i === 0),
      parent: i === 0 ? null : (d.parent ?? 0),
      open: true,
      busy: false
    }))
  )
  const groupTree = (g: AgentGroup): TreeNode[] =>
    buildForest(
      g.members.map((m) => ({
        name: m.name,
        sub: (m.persona ?? '').trim(),
        parent: m.parent,
        open: isOpen(m.chatKey),
        busy: isBusy(m.chatKey),
        chatKey: m.chatKey,
        avatar: m.avatar,
        model: m.model,
        cli: m.cli
      }))
    )

  const showChart = !onDraft || (mode === 'group' && previewing)

  return (
    <div className="agent-group-panel">
      <div className="agp-head">
        <div className="agp-title">
          <Users size={14} /> {t('title.agentgroup')}
        </div>
        <div className="agp-hint">{t('team.hint')}</div>
      </div>

      {/* Tab strip: draft + one per open group */}
      <div className="agp-tabs" role="tablist">
        <button
          className={`agp-tab${onDraft ? ' on' : ''}`}
          onClick={() => {
            setActiveTab(null)
            setEditing(false)
          }}
        >
          {t('team.draft')}
        </button>
        {groups.map((g) => (
          <button
            key={g.group}
            className={`agp-tab${activeTab === g.group ? ' on' : ''}`}
            onClick={() => {
              setActiveTab(g.group)
              setEditing(false)
            }}
          >
            {g.group}
            <span className="agp-tab-count">{g.members.length}</span>
          </button>
        ))}
        {goals.map((g) => (
          <button
            key={g.id}
            className={`agp-tab agp-tab-goal${activeTab === `goal:${g.id}` ? ' on' : ''}${
              g.status === 'open' ? ' running' : ''
            }`}
            onClick={() => {
              setActiveTab(`goal:${g.id}`)
              setEditing(false)
            }}
            title={g.goal}
          >
            <Target size={12} />
            {g.goal.length > 18 ? g.goal.slice(0, 18) + '…' : g.goal}
            <span className="agp-tab-count">
              R{g.round} · {g.turns}턴
            </span>
          </button>
        ))}
        {pipelines.map((p) => {
          const active = runs.some((r) => r.pipelineId === p.id && !r.done)
          return (
            <button
              key={p.id}
              className={`agp-tab agp-tab-pipe${activeTab === `pipe:${p.id}` ? ' on' : ''}${
                active ? ' running' : ''
              }`}
              onClick={() => {
                setActiveTab(`pipe:${p.id}`)
                setEditing(false)
              }}
            >
              <GitBranch size={12} />
              {p.name}
              <span className="agp-tab-count">{p.stages.length}</span>
            </button>
          )
        })}
        {/* Only ad-hoc runs (no saved pipeline) get their own tab; a saved
            pipeline's run is shown inside that pipeline's tab. */}
        {runs
          .filter((r) => !r.pipelineId)
          .map((r) => {
            const doneCount = r.stages.filter((s) => s.status === 'done').length
            return (
              <button
                key={r.id}
                className={`agp-tab agp-tab-run${activeTab === `run:${r.id}` ? ' on' : ''}${
                  r.done ? '' : ' running'
                }`}
              onClick={() => {
                setActiveTab(`run:${r.id}`)
                setEditing(false)
              }}
            >
              <GitBranch size={12} />
              {r.name}
              <span className="agp-tab-count">
                {doneCount}/{r.stages.length}
              </span>
            </button>
          )
        })}
      </div>

      {/* ---- Draft tab ---- */}
      {onDraft && (
        <div className="agp-body">
          <div className="ui-seg agp-modeseg">
            <button
              className={`ui-seg-btn${mode === 'group' ? ' on' : ''}`}
              onClick={() => {
                setMode('group')
                setPreviewing(false)
              }}
            >
              {t('pipe.modeGroup')}
            </button>
            <button
              className={`ui-seg-btn${mode === 'pipeline' ? ' on' : ''}`}
              onClick={() => {
                setMode('pipeline')
                setPreviewing(false)
              }}
            >
              {t('pipe.modePipeline')}
            </button>
          </div>

          {/* Normal group */}
          {mode === 'group' && !previewing && (
            <>
              <div className="agp-namerow">
                <label className="agp-namelabel">{t('team.name')}</label>
                <input
                  className="ui-input"
                  value={groupName}
                  placeholder={t('team.nameDefault')}
                  onChange={(e) => setGroupName(e.target.value)}
                />
              </div>

              <div className="agp-grid">
                {drafts.map((d, i) => (
                  <div className={`agp-card${i === 0 ? ' agp-main' : ''}`} key={i}>
                    <div className="agp-card-head">
                      <span className="agp-card-badge">
                        {i === 0 ? t('team.main') : `#${i + 1}`}
                      </span>
                      {i > 0 && drafts.length > MIN && (
                        <button
                          className="agp-card-remove"
                          title={t('team.removeTip')}
                          onClick={() => removeDraft(i)}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    <input
                      className="ui-input"
                      value={d.name}
                      placeholder={i === 0 ? t('team.mainName') : t('team.memberName', { n: i })}
                      onChange={(e) => setDraft(i, { name: e.target.value })}
                    />
                    <input
                      className="ui-input"
                      value={d.persona}
                      placeholder={t('team.personaPlaceholder')}
                      onChange={(e) => setDraft(i, { persona: e.target.value })}
                    />
                    <div className="agp-card-row">
                      <label className="agp-card-label">{t('team.agentCli')}</label>
                      <select
                        className="ui-select"
                        value={d.cli}
                        onChange={(e) => {
                          const cli = e.target.value as Cli
                          // A model belongs to one CLI, so switching drops a
                          // choice the other one has never heard of.
                          setDraft(i, { cli, model: modelForCli(d.model, cli) })
                        }}
                      >
                        <option value="claude">Claude</option>
                        <option value="codex">Codex</option>
                      </select>
                    </div>
                    <div className="agp-card-row">
                      <label className="agp-card-label">{t('team.model')}</label>
                      <select
                        className="ui-select"
                        value={d.model}
                        onChange={(e) => setDraft(i, { model: e.target.value })}
                      >
                        {modelsFor(d.cli).map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="agp-card-row">
                      <label className="agp-card-label">{t('team.reportsTo')}</label>
                      {i === 0 ? (
                        <select className="ui-select" disabled value="">
                          <option value="">{t('team.noParent')}</option>
                        </select>
                      ) : (
                        <select
                          className="ui-select"
                          value={d.parent ?? 0}
                          onChange={(e) => setDraft(i, { parent: Number(e.target.value) })}
                        >
                          {drafts.map((_, j) =>
                            j === i ? null : (
                              <option key={j} value={j}>
                                {draftNames[j]}
                              </option>
                            )
                          )}
                        </select>
                      )}
                    </div>
                    {agentSelectEl(d.agent, (v) => setDraft(i, { agent: v }))}
                  </div>
                ))}

                {drafts.length < MAX && (
                  <button className="agp-addcard" onClick={addDraft}>
                    <Plus size={14} /> {t('team.add')}
                  </button>
                )}
              </div>
            </>
          )}

          {/* Org preview of the draft */}
          {mode === 'group' && previewing && (
            <div className="agp-chartwrap">
              <OrgChart
                roots={draftTree}
                emptyLabel={t('team.none')}
                closedLabel={t('team.closed')}
                onPick={() => {}}
              />
            </div>
          )}

          {/* Pipeline */}
          {mode === 'pipeline' && (
            <>
              <div className="agp-namerow">
                <label className="agp-namelabel">{t('pipe.nameLabel')}</label>
                <input
                  className="ui-input"
                  value={pipeName}
                  placeholder={t('pipe.nameDefault')}
                  onChange={(e) => setPipeName(e.target.value)}
                />
              </div>
              <div className="agp-stages">
                {stages.map((st, i) => (
                  <div className="agp-stage" key={i}>
                    <div className="agp-stage-head">
                      <span className="agp-stage-num">{i + 1}</span>
                      <input
                        className="ui-input"
                        value={st.name}
                        placeholder={t('pipe.stageName')}
                        onChange={(e) => setStage(i, { name: e.target.value })}
                      />
                      {stages.length > MIN && (
                        <button
                          className="agp-card-remove"
                          title={t('team.removeTip')}
                          onClick={() => removeStage(i)}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    <select
                      className="ui-select"
                      value={st.cli}
                      onChange={(e) => {
                        const cli = e.target.value as Cli
                        setStage(i, { cli, model: modelForCli(st.model, cli) })
                      }}
                    >
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                    </select>
                    <select
                      className="ui-select"
                      value={st.model}
                      onChange={(e) => setStage(i, { model: e.target.value })}
                    >
                      {modelsFor(st.cli).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <textarea
                      className="ui-textarea agp-stage-role"
                      value={st.role}
                      placeholder={t('pipe.role')}
                      onChange={(e) => setStage(i, { role: e.target.value })}
                    />
                    {agentSelectEl(st.agent, (v) => setStage(i, { agent: v }))}
                  </div>
                ))}
                <button className="agp-addcard agp-addstage" onClick={addStage}>
                  {t('pipe.addStage')}
                </button>
              </div>
              <div className="agp-editnote">{t('pipe.createHint')}</div>
            </>
          )}

          {/* Draft actions */}
          <div className="agp-actions">
            {mode === 'group' ? (
              <>
                <button className="ui-btn ui-btn-default" onClick={() => setPreviewing((p) => !p)}>
                  {previewing ? <ArrowLeft size={13} /> : <Eye size={13} />}
                  {previewing ? t('team.backToSetup') : t('team.preview')}
                </button>
                <button className="ui-btn ui-btn-primary" onClick={doCreate}>
                  <Users size={13} /> {t('team.create')}
                </button>
              </>
            ) : (
              <button
                className="ui-btn ui-btn-primary agp-runbtn"
                disabled={stages.filter((s) => s.name.trim()).length < MIN}
                onClick={doCreatePipeline}
              >
                <GitBranch size={13} /> {t('pipe.create')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ---- Group tab ---- */}
      {shown && (
        <div className="agp-body">
          {editing ? (
            <>
              <div className="agp-namerow">
                <label className="agp-namelabel">{t('team.name')}</label>
                <input
                  className="ui-input"
                  defaultValue={shown.group}
                  key={shown.group}
                  placeholder={t('team.nameDefault')}
                  onBlur={(e) => doRenameGroup(shown, e.target.value)}
                />
              </div>
              <div className="agp-grid">
                {shown.members.map((m, i) => (
                  <div className={`agp-card${i === 0 ? ' agp-main' : ''}`} key={m.chatKey}>
                    <div className="agp-card-head">
                      <span className="agp-card-badge">
                        {i === 0 ? t('team.main') : `#${i + 1}`}
                      </span>
                      {i > 0 && shown.members.length > MIN && (
                        <button
                          className="agp-card-remove"
                          title={t('team.removeTip')}
                          onClick={() => doRemoveMember(shown, m)}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    <div className="agp-card-namerow">
                      <AvatarPicker
                        name={m.name}
                        override={m.avatar}
                        onPick={(spec) => {
                          updateMember(workspace, shown.group, m.chatKey, { avatar: spec })
                          setChatAvatar(m.chatKey, spec)
                        }}
                      />
                      <input
                        className="ui-input"
                        defaultValue={m.name}
                        key={`n${m.chatKey}`}
                        placeholder={i === 0 ? t('team.mainName') : t('team.memberName', { n: i })}
                        onBlur={(e) => doRenameMember(shown, m, e.target.value)}
                      />
                    </div>
                    <input
                      className="ui-input"
                      defaultValue={m.persona ?? ''}
                      key={`p${m.chatKey}`}
                      placeholder={t('team.personaPlaceholder')}
                      onBlur={(e) =>
                        updateMember(workspace, shown.group, m.chatKey, {
                          persona: e.target.value.trim() || null
                        })
                      }
                    />
                    <div className="agp-card-row">
                      <label className="agp-card-label">{t('team.agentCli')}</label>
                      <select
                        className="ui-select"
                        value={m.cli ?? 'claude'}
                        onChange={(e) => {
                          const cli = e.target.value as Cli
                          updateMember(workspace, shown.group, m.chatKey, {
                            cli,
                            model: modelForCli(m.model, cli)
                          })
                        }}
                      >
                        <option value="claude">Claude</option>
                        <option value="codex">Codex</option>
                      </select>
                    </div>
                    <div className="agp-card-row">
                      <label className="agp-card-label">{t('team.model')}</label>
                      <select
                        className="ui-select"
                        value={m.model}
                        onChange={(e) =>
                          updateMember(workspace, shown.group, m.chatKey, { model: e.target.value })
                        }
                      >
                        {modelsFor(m.cli).map((mm) => (
                          <option key={mm} value={mm}>
                            {mm}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="agp-card-row">
                      <label className="agp-card-label">{t('team.reportsTo')}</label>
                      {i === 0 ? (
                        <select className="ui-select" disabled value="">
                          <option value="">{t('team.noParent')}</option>
                        </select>
                      ) : (
                        <select
                          className="ui-select"
                          value={m.parent ?? 0}
                          onChange={(e) =>
                            updateMember(workspace, shown.group, m.chatKey, {
                              parent: Number(e.target.value)
                            })
                          }
                        >
                          {shown.members.map((mm, j) =>
                            j === i ? null : (
                              <option key={j} value={j}>
                                {mm.name}
                              </option>
                            )
                          )}
                        </select>
                      )}
                    </div>
                    {agentSelectEl(m.agent ?? '', (v) =>
                      updateMember(workspace, shown.group, m.chatKey, { agent: v || null })
                    )}
                  </div>
                ))}
                {shown.members.length < MAX && (
                  <button className="agp-addcard" onClick={() => doAddToGroup(shown)}>
                    <Plus size={14} /> {t('team.add')}
                  </button>
                )}
              </div>
              <div className="agp-editnote">{t('team.editNote')}</div>
            </>
          ) : (
            <div className="agp-chartwrap">
              {showChart && (
                <OrgChart
                  roots={groupTree(shown)}
                  emptyLabel={t('team.none')}
                  closedLabel={t('team.closed')}
                  onPick={(n) => onPickNode(shown, n)}
                />
              )}
            </div>
          )}
          {!editing && <GroupTalk workspace={workspace} group={shown.group} />}
          <div className="agp-actions">
            {editing ? (
              <button className="ui-btn ui-btn-primary" onClick={() => setEditing(false)}>
                <Check size={13} /> {t('team.editDone')}
              </button>
            ) : (
              <>
                <button className="ui-btn ui-btn-default" onClick={() => setEditing(true)}>
                  <Pencil size={13} /> {t('team.edit')}
                </button>
                <button className="ui-btn ui-btn-default" onClick={() => doAddToGroup(shown)}>
                  <UserPlus size={13} /> {t('team.addToGroup')}
                </button>
                <button
                  className="ui-btn ui-btn-default agp-danger"
                  onClick={() => doDeleteGroup(shown)}
                >
                  <Trash2 size={13} /> {t('team.deleteGroup')}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- Goal board tab ---- */}
      {shownGoal && <GoalBoard goal={shownGoal} workspace={workspace} />}

      {/* ---- Pipeline run tab ---- */}
      {shownRun && (
        <div className="agp-body">
          <div className="agp-run">
            <div className="agp-run-head">
              <GitBranch size={14} />
              <span className="agp-run-name">{shownRun.name}</span>
              <span className={`agp-run-badge${shownRun.done ? ' done' : ' running'}`}>
                {shownRun.done ? t('pipe.doneLabel') : t('pipe.running')}
              </span>
            </div>
            {shownRun.task && <div className="agp-run-task">{shownRun.task}</div>}
            <ol className="agp-run-stages">
              {shownRun.stages.map((s, i) => (
                <li
                  key={i}
                  className={`agp-run-stage ${s.status}${shownRun.current === i ? ' current' : ''}`}
                  onClick={() => s.chatKey && getActiveApi()?.getPanel(s.chatKey)?.api.setActive()}
                >
                  <span className="agp-run-stage-ico">
                    {s.status === 'running' ? (
                      <Loader2 size={13} className="spin" />
                    ) : s.status === 'done' ? (
                      <Check size={13} />
                    ) : s.status === 'error' ? (
                      <AlertCircle size={13} />
                    ) : (
                      <Circle size={13} />
                    )}
                  </span>
                  <span className="agp-run-stage-num">{i + 1}</span>
                  <span className="agp-run-stage-name">{s.name}</span>
                  {s.agent && <span className="agp-run-stage-agent">{s.agent}</span>}
                  {s.model !== 'default' && <span className="agp-run-stage-model">{s.model}</span>}
                </li>
              ))}
            </ol>
          </div>
          <div className="agp-actions">
            {!shownRun.done ? (
              <button
                className="ui-btn ui-btn-default agp-danger"
                onClick={() => cancelRun(shownRun.id)}
              >
                <Square size={12} fill="currentColor" /> {t('pipe.stop')}
              </button>
            ) : (
              <button
                className="ui-btn ui-btn-default agp-danger"
                onClick={() => {
                  removeRun(shownRun.id)
                  setActiveTab(null)
                }}
              >
                <Trash2 size={13} /> {t('pipe.removeRun')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ---- Saved pipeline tab: run it (with a task) and watch/control it ---- */}
      {shownPipeline && (
        <div className="agp-body">
          <div className="agp-run">
            <div className="agp-run-head">
              <GitBranch size={14} />
              <span className="agp-run-name">{shownPipeline.name}</span>
              {pipelineRun && (
                <span className={`agp-run-badge${pipelineRun.done ? ' done' : ' running'}`}>
                  {pipelineRun.done ? t('pipe.doneLabel') : t('pipe.running')}
                </span>
              )}
            </div>
            {/* task to run this pipeline on */}
            <textarea
              className="ui-textarea agp-task"
              value={runTask}
              placeholder={t('pipe.taskHint')}
              onChange={(e) => setRunTask(e.target.value)}
            />
            {/* stage list: shows the live run status when running, else the plan */}
            <ol className="agp-run-stages">
              {shownPipelineStages.map((s, i) => {
                const status = s.status
                const chatKey = s.chatKey
                const cur = pipelineRun?.current === i
                return (
                  <li
                    key={i}
                    className={`agp-run-stage ${status}${cur ? ' current' : ''}`}
                    onClick={() => chatKey && getActiveApi()?.getPanel(chatKey)?.api.setActive()}
                  >
                    <span className="agp-run-stage-ico">
                      {status === 'running' ? (
                        <Loader2 size={13} className="spin" />
                      ) : status === 'done' ? (
                        <Check size={13} />
                      ) : status === 'error' ? (
                        <AlertCircle size={13} />
                      ) : (
                        <Circle size={13} />
                      )}
                    </span>
                    <span className="agp-run-stage-num">{i + 1}</span>
                    <span className="agp-run-stage-name">{s.name}</span>
                    {s.agent && <span className="agp-run-stage-agent">{s.agent}</span>}
                    {s.model !== 'default' && (
                      <span className="agp-run-stage-model">{s.model}</span>
                    )}
                  </li>
                )
              })}
            </ol>
          </div>
          <div className="agp-actions">
            {pipelineRun && !pipelineRun.done ? (
              <button
                className="ui-btn ui-btn-default agp-danger"
                onClick={() => cancelRun(pipelineRun.id)}
              >
                <Square size={12} fill="currentColor" /> {t('pipe.stop')}
              </button>
            ) : (
              <button
                className="ui-btn ui-btn-primary agp-runbtn"
                disabled={runTask.trim() === ''}
                onClick={() => void runPipeline(shownPipeline, runTask)}
              >
                <GitBranch size={13} /> {t('pipe.run')}
              </button>
            )}
            <button
              className="ui-btn ui-btn-default agp-danger"
              onClick={() => {
                if (!window.confirm(t('pipe.confirmDelete', { name: shownPipeline.name }))) return
                removePipeline(workspace, shownPipeline.id)
                setActiveTab(null)
              }}
            >
              <Trash2 size={13} /> {t('pipe.delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// "3분 전" — a timeline is read newest-last, so how long ago matters more than
// the clock time.
function ago(at: number, t: TFn): string {
  const mins = Math.floor((Date.now() - at) / 60000)
  if (mins < 1) return t('team.justNow')
  if (mins < 60) return t('team.minsAgo', { n: mins })
  return t('team.hoursAgo', { n: Math.floor(mins / 60) })
}

// Telling the group something, and watching what it does about it.
//
// Both halves were missing: there was no way to put a task to a team except by
// finding its lead's pane and typing there, and the exchanges that followed
// happened inside the members' own panes where nobody could follow them. The
// box below sends to the whole group (or just the lead), and the list under it
// is every ask, answer and refusal in this group, newest last.
function GroupTalk({ workspace, group }: { workspace: string; group: string }): JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  // Who the message goes to. Empty = the lead, which is the default on purpose:
  // telling a TEAM something should go through whoever runs it, and the lead can
  // then hand work out and put the answers together. Sending to everyone at once
  // (the old default, and the old ONLY other choice) produced three unrelated
  // answers to the user with nobody collecting them — the org chart existed and
  // was ignored.
  const [picked, setPicked] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  // Korean input commits a syllable on the same Enter that sends. Send read
  // React's state, which still lagged the DOM, and the IME then put the
  // in-progress syllable back into the cleared box — every message left its last
  // word behind. So: ignore Enter mid-composition, and take the text from the
  // DOM, which is where the committed characters actually are.
  const composing = useRef(false)
  // The selector must return what is IN the store, never a fresh value: zustand
  // compares with Object.is, so a `?? []` inside it hands back a new array on
  // every render and the component re-renders forever ("Maximum update depth
  // exceeded"). Default outside the selector.
  const events = useGroupLog((s) => s.byWorkspace[workspace])
  const mine = (events ?? []).filter((e) => e.group === group)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [mine.length])

  const roster = (useAgentGroups((s) => s.byWorkspace[workspace]) ?? []).find((g) => g.group === group)
  const titleOf = (key?: string): string => {
    if (!key) return ''
    if (key === 'user') return t('team.you')
    const m = roster?.members.find((x) => x.chatKey === key)
    return m?.name ?? key.slice(0, 9)
  }

  const send = async (): Promise<void> => {
    const msg = (inputRef.current?.value ?? text).trim()
    if (!msg || sending || !roster?.members.length) return
    setSending(true)
    setText('')
    if (inputRef.current) inputRef.current.value = ''
    const targets = picked.length
      ? roster.members.filter((m) => picked.includes(m.chatKey))
      : roster.members.slice(0, 1) // the lead
    useGroupLog.getState().add({
      ws: workspace,
      group,
      kind: 'ask',
      from: 'user',
      text: targets.length === 1 ? msg : `[${targets.map((m) => m.name).join(', ')}] ${msg}`
    })
    try {
      // The user is not an agent, so this goes through the same delegation path
      // the agents use — one pane at a time, each answer tied to its question.
      await Promise.all(
        targets.map(async (m) => {
          const target = resolveAgent(m.chatKey, undefined, workspace)
          if (!target) return
          const reply = await askChatTurn(target, msg, 5 * 60_000, t('team.noReply'))
          useGroupLog.getState().add({ ws: workspace, group, kind: 'reply', from: m.chatKey, text: reply })
        })
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="agp-talk">
      <div className="agp-talk-log">
        {mine.length === 0 && <div className="agp-talk-empty">{t('team.logEmpty')}</div>}
        {mine.map((e, i) => {
          // A run of entries from the same speaker reads as one block: the name
          // is printed once and the rest are indented under it. One line per
          // event with the name repeated was a wall nobody could follow.
          const prev = mine[i - 1]
          const runOn = prev && prev.from === e.from && prev.kind === e.kind && e.at - prev.at < 60_000
          return (
            <div key={e.id} className={`agp-ev agp-ev-${e.kind}${runOn ? ' run-on' : ''}`}>
              {!runOn && (
                <div className="agp-ev-head">
                  <span className="agp-ev-who">{titleOf(e.from)}</span>
                  {e.to && <span className="agp-ev-to">→ {titleOf(e.to)}</span>}
                  <span className="agp-ev-kind">{t(`team.ev.${e.kind}`)}</span>
                  <time className="agp-ev-at">{ago(e.at, t)}</time>
                </div>
              )}
              <div className="agp-ev-text">{e.text}</div>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>
      <div className="agp-talk-to">
        <span className="agp-talk-tolabel">{t('team.sendTo')}</span>
        <button
          className={`agp-chip${picked.length === 0 ? ' on' : ''}`}
          onClick={() => setPicked([])}
          title={t('team.toLeadHint')}
        >
          <User size={11} /> {roster?.members[0]?.name ?? t('team.lead')}
        </button>
        {(roster?.members ?? []).slice(1).map((m) => (
          <button
            key={m.chatKey}
            className={`agp-chip${picked.includes(m.chatKey) ? ' on' : ''}`}
            onClick={() =>
              setPicked((p) => (p.includes(m.chatKey) ? p.filter((k) => k !== m.chatKey) : [...p, m.chatKey]))
            }
          >
            {m.name}
          </button>
        ))}
        <button
          className={`agp-chip${picked.length > 0 && picked.length === (roster?.members.length ?? 0) ? ' on' : ''}`}
          onClick={() => setPicked((roster?.members ?? []).map((m) => m.chatKey))}
          title={t('team.toEveryoneHint')}
        >
          <Users size={11} /> {t('team.everyone')}
        </button>
      </div>
      <div className="agp-talk-box">
        <input
          ref={inputRef}
          className="agp-talk-input"
          value={text}
          placeholder={t('team.talkPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return
            // Let the IME finish the syllable this Enter is committing.
            if (composing.current || e.nativeEvent.isComposing) return
            e.preventDefault()
            void send()
          }}
        />

        <button className="ui-btn ui-btn-primary" disabled={sending || !text.trim()} onClick={() => void send()}>
          {sending ? t('team.sending') : t('team.send')}
        </button>
      </div>
    </div>
  )
}

// The goal board: what the team is converging on, what it has cost so far, and
// the button that ends it.
//
// Nothing stops a goal on its own — that was the decision — so this view is the
// safeguard: the spend is on screen at all times (rounds, turns, how long it has
// been going), and Stop is always one click away. A person can also put a line
// on the board between rounds, which is the cheapest way to correct a team that
// has drifted.
function GoalBoard({ goal, workspace }: { goal: Goal; workspace: string }): JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const postRef = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const roster = (useAgentGroups((s) => s.byWorkspace[workspace]) ?? []).find((g) => g.group === goal.group)
  const nameOf = (key: string): string =>
    key === 'user' ? t('team.you') : roster?.members.find((m) => m.chatKey === key)?.name ?? key.slice(0, 9)
  const mins = Math.max(1, Math.round(((goal.endedAt ?? Date.now()) - goal.startedAt) / 60000))

  const stop = (): void => {
    // End the turns this goal has in flight as well as the goal itself: a member
    // mid-answer would otherwise keep going (and keep spending) after "stop".
    for (const m of roster?.members ?? []) window.api.chat.interrupt(m.chatKey)
    useGoals.getState().stop(goal.id)
  }

  return (
    <div className="agp-body agp-goal">
      <div className="agp-goal-head">
        <div className="agp-goal-title">{goal.goal}</div>
        <div className="agp-goal-done">{t('goal.doneWhen')}: {goal.doneWhen}</div>
        <div className="agp-goal-meta">
          <span className={`agp-goal-status s-${goal.status}`}>{t(`goal.status.${goal.status}`)}</span>
          <span>{t('goal.spend', { rounds: goal.round, turns: goal.turns, mins })}</span>
          {goal.artifact && <span className="agp-goal-artifact">{goal.artifact}</span>}
          {goal.status === 'open' && (
            <button className="ui-btn ui-btn-default agp-danger" onClick={stop}>
              <Square size={12} /> {t('goal.stop')}
            </button>
          )}
        </div>
      </div>

      <div className="agp-goal-posts">
        {goal.posts.length === 0 && <div className="agp-talk-empty">{t('goal.empty')}</div>}
        {goal.posts.map((p) => (
          <div key={p.id} className={`agp-post k-${p.kind}`}>
            <div className="agp-post-head">
              <span className="agp-post-by">{nameOf(p.by)}</span>
              <span className="agp-post-kind">
                R{p.round} · {t(`goal.kind.${p.kind}`)}
              </span>
            </div>
            <div className="agp-post-text">{p.text}</div>
          </div>
        ))}
      </div>

      {goal.summary && (
        <div className="agp-goal-summary">
          <b>{t('goal.conclusion')}</b>
          <div>{goal.summary}</div>
        </div>
      )}

      {goal.status === 'open' && (
        <div className="agp-talk-box">
          <input
            ref={postRef}
            className="agp-talk-input"
            value={text}
            placeholder={t('goal.postPlaceholder')}
            onChange={(e) => setText(e.target.value)}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return
              if (composing.current || e.nativeEvent.isComposing) return
              const value = (postRef.current?.value ?? text).trim()
              if (!value) return
              e.preventDefault()
              useGoals.getState().post(goal.id, { round: goal.round, by: 'user', kind: 'note', text: value })
              setText('')
              if (postRef.current) postRef.current.value = ''
            }}
          />
        </div>
      )}
    </div>
  )
}

import { useT } from '../i18n'
import { isPinnedClaude, modelLabel, modelsFor, pinnedModels, type Cli } from '../lib/models'
import { useClaudeCatalog } from '../state/modelCatalog'

// The <option>s of every model picker in the app — the chat chip, the agent
// group forms, the schedule form and the settings default. There were five
// hand-written copies; the settings one had even lost fable.
//
// Aliases first, labelled with the version they run today ("Opus 5.5"), then the
// versions that can be pinned on purpose. Without the CLI's list (offline, or
// the CLI missing) it degrades to the bare aliases, exactly as before.
export default function ModelOptions({
  cli,
  configDir,
  current
}: {
  cli: Cli | string | null | undefined
  configDir?: string
  /** The selected value, so a pinned version still shows before the list loads. */
  current?: string
}): JSX.Element {
  const t = useT()
  const catalog = useClaudeCatalog(cli === 'codex' ? undefined : configDir)
  if (cli === 'codex') {
    return (
      <>
        {modelsFor('codex').map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </>
    )
  }
  const pinned = pinnedModels(catalog)
  const orphan = current && isPinnedClaude(current) && !pinned.some((p) => p.value === current)
  return (
    <>
      {modelsFor('claude').map((m) => (
        <option key={m} value={m}>
          {modelLabel(m, catalog)}
        </option>
      ))}
      {(pinned.length > 0 || orphan) && (
        <optgroup label={t('model.pinned')}>
          {pinned.map((p) => (
            <option key={p.value} value={p.value}>
              {p.displayName}
            </option>
          ))}
          {orphan && <option value={current}>{modelLabel(current, catalog)}</option>}
        </optgroup>
      )}
    </>
  )
}

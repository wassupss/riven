import { useMemo, useState } from "react";
import { CornerDownLeft, Play, Save, Trash2, X } from "lucide-react";
import { useT } from "../../../i18n";
import { useDb } from "../../../state/db";
import {
  useDbHistory,
  type HistoryEntry,
  type Snippet,
} from "../../../state/dbHistory";
import { Button, Segmented, TextInput } from "../../../components/ui/Controls";

// Side drawer of the SQL console: every query run (newest first) and saved
// snippets. Click inserts at the cursor, the play button runs it right away.

const SHOWN = 200;

const ago = (at: number): string => {
  const d = new Date(at);
  const today = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === today.toDateString()
    ? hm
    : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

export default function HistoryDrawer({
  connId,
  selection,
  onInsert,
  onRun,
  onClose,
}: {
  connId: string | undefined;
  /** The editor's selection (or the whole text) to save as a snippet. */
  selection: () => string;
  onInsert: (sql: string) => void;
  onRun: (sql: string) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const history = useDbHistory((s) => s.history);
  const snippets = useDbHistory((s) => s.snippets);
  const removeHistory = useDbHistory((s) => s.removeHistory);
  const clearHistory = useDbHistory((s) => s.clearHistory);
  const saveSnippet = useDbHistory((s) => s.saveSnippet);
  const removeSnippet = useDbHistory((s) => s.removeSnippet);
  const connections = useDb((s) => s.connections);
  const [mode, setMode] = useState<"history" | "snippets">("history");
  const [q, setQ] = useState("");
  const [thisConn, setThisConn] = useState(false);
  const [name, setName] = useState("");

  const needle = q.trim().toLowerCase();
  const hist = useMemo(() => {
    const out: HistoryEntry[] = [];
    for (const h of history) {
      if (thisConn && h.connId !== connId) continue;
      if (needle && !h.sql.toLowerCase().includes(needle)) continue;
      out.push(h);
      if (out.length >= SHOWN) break;
    }
    return out;
  }, [history, needle, thisConn, connId]);
  const snips = useMemo(
    () =>
      snippets.filter(
        (s) =>
          !needle ||
          s.name.toLowerCase().includes(needle) ||
          s.sql.toLowerCase().includes(needle),
      ),
    [snippets, needle],
  );
  const connName = (id: string): string =>
    connections.find((c) => c.id === id)?.name ?? "?";

  const save = (): void => {
    const sql = selection().trim();
    if (!sql) return;
    saveSnippet(name.trim() || sql.split("\n")[0].slice(0, 40), sql);
    setName("");
  };

  const actions = (sql: string, remove: () => void): JSX.Element => (
    <span className="dbx-hist-actions">
      <button
        className="dbx-icon-btn"
        title={t("db.hist.insert")}
        onClick={(e) => (e.stopPropagation(), onInsert(sql))}
      >
        <CornerDownLeft size={12} />
      </button>
      <button
        className="dbx-icon-btn"
        title={t("db.run")}
        onClick={(e) => (e.stopPropagation(), onRun(sql))}
      >
        <Play size={12} />
      </button>
      <button
        className="dbx-icon-btn"
        title={t("db.hist.remove")}
        onClick={(e) => (e.stopPropagation(), remove())}
      >
        <Trash2 size={12} />
      </button>
    </span>
  );

  return (
    <aside className="dbx-hist">
      <div className="dbx-hist-top">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "history", label: t("db.hist.history") },
            { value: "snippets", label: t("db.hist.snippets") },
          ]}
        />
        <span className="dbx-spacer" />
        <button
          className="dbx-icon-btn"
          title={t("db.hist.close")}
          onClick={onClose}
        >
          <X size={13} />
        </button>
      </div>
      <div className="dbx-hist-top">
        <TextInput
          className="dbx-hist-q"
          placeholder={t("db.hist.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {mode === "history" && (
          <button
            className={`dbx-chip${thisConn ? " on" : ""}`}
            title={t("db.hist.thisConnHint")}
            onClick={() => setThisConn((v) => !v)}
          >
            {t("db.hist.thisConn")}
          </button>
        )}
      </div>
      {mode === "snippets" && (
        <div className="dbx-hist-top">
          <TextInput
            className="dbx-hist-q"
            placeholder={t("db.hist.snippetName")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
          <Button onClick={save} title={t("db.hist.saveHint")}>
            <Save size={11} /> {t("db.hist.save")}
          </Button>
        </div>
      )}
      <div className="dbx-hist-list">
        {mode === "history" ? (
          hist.length ? (
            hist.map((h) => (
              <div
                key={h.id}
                className={`dbx-hist-item${h.error ? " err" : ""}`}
                onClick={() => onInsert(h.sql)}
                title={h.error ?? h.sql}
              >
                <pre>{h.sql}</pre>
                <div className="dbx-hist-meta">
                  <span>{ago(h.at)}</span>
                  <span>
                    {connName(h.connId)}
                    {h.db ? ` / ${h.db}` : ""}
                  </span>
                  {h.ms !== undefined && <span>{h.ms} ms</span>}
                  {h.rows != null && (
                    <span>{t("db.hist.rows", { n: String(h.rows) })}</span>
                  )}
                  {h.error && (
                    <span className="dbx-hist-errtag">{t("db.error")}</span>
                  )}
                  {actions(h.sql, () => removeHistory(h.id))}
                </div>
              </div>
            ))
          ) : (
            <div className="dbx-empty">{t("db.hist.empty")}</div>
          )
        ) : snips.length ? (
          snips.map((s: Snippet) => (
            <div
              key={s.id}
              className="dbx-hist-item"
              onClick={() => onInsert(s.sql)}
              title={s.sql}
            >
              <div className="dbx-hist-name">{s.name}</div>
              <pre>{s.sql}</pre>
              <div className="dbx-hist-meta">
                <span>{ago(s.at)}</span>
                {actions(s.sql, () => removeSnippet(s.id))}
              </div>
            </div>
          ))
        ) : (
          <div className="dbx-empty">{t("db.hist.noSnippets")}</div>
        )}
      </div>
      {mode === "history" && history.length > 0 && (
        <div className="dbx-hist-foot">
          <span className="dbx-meta">
            {t("db.hist.count", { n: String(history.length) })}
          </span>
          <span className="dbx-spacer" />
          <Button
            variant="ghost"
            onClick={() =>
              window.confirm(t("db.hist.clearConfirm")) && clearHistory()
            }
          >
            {t("db.hist.clear")}
          </Button>
        </div>
      )}
    </aside>
  );
}

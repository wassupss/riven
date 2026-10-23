import * as monaco from "monaco-editor";
import { format } from "sql-formatter";
import {
  statementAround,
  suggest,
  type CompletionMeta,
  type SuggestionKind,
} from "../../../../../main/db/complete";
import type { DbKind } from "../../../../../main/db/types";

// Schema-aware SQL autocomplete for the console. One provider serves every SQL
// model; each console model registers which connection and database it talks
// to. Catalog snapshots are cached per connection+database: a stale one is
// served at once and refreshed behind the scenes, and DDL drops it.

interface Target {
  connId: string;
  db: string | undefined;
  kind: DbKind;
}

const targets = new Map<string, Target>();
const cache = new Map<
  string,
  {
    at: number;
    meta?: CompletionMeta;
    pending?: Promise<CompletionMeta | undefined>;
  }
>();
const FRESH_MS = 60_000;
const key = (connId: string, db: string | undefined): string =>
  `${connId}\0${db ?? ""}`;

/** Points a console model at a connection and database (null to forget it). */
export function setCompletionTarget(
  model: monaco.editor.ITextModel,
  t: Target | null,
): void {
  if (t) targets.set(model.uri.toString(), t);
  else targets.delete(model.uri.toString());
}

/** Drops cached catalogs for a connection (after DDL), so the next completion reloads. */
export function invalidateCompletion(connId: string): void {
  for (const k of cache.keys())
    if (k.startsWith(`${connId}\0`)) cache.delete(k);
}

function load(t: Target): Promise<CompletionMeta | undefined> {
  const k = key(t.connId, t.db);
  const entry = cache.get(k);
  if (entry?.pending)
    return entry.meta ? Promise.resolve(entry.meta) : entry.pending;
  if (entry?.meta && Date.now() - entry.at < FRESH_MS)
    return Promise.resolve(entry.meta);
  const pending = window.api.db
    .completionMeta(t.connId, t.db)
    .then((meta) => {
      cache.set(k, { at: Date.now(), meta });
      return meta;
    })
    .catch(() => {
      const old = cache.get(k);
      cache.set(k, { at: Date.now(), meta: old?.meta });
      return old?.meta;
    });
  cache.set(k, { at: entry?.at ?? 0, meta: entry?.meta, pending });
  // Stale: answer with the old snapshot now; the refresh lands for next time.
  return entry?.meta ? Promise.resolve(entry.meta) : pending;
}

const KIND: Record<SuggestionKind, monaco.languages.CompletionItemKind> = {
  keyword: monaco.languages.CompletionItemKind.Keyword,
  schema: monaco.languages.CompletionItemKind.Module,
  table: monaco.languages.CompletionItemKind.Struct,
  view: monaco.languages.CompletionItemKind.Interface,
  column: monaco.languages.CompletionItemKind.Field,
  function: monaco.languages.CompletionItemKind.Function,
};

let registered = false;

/** Pretty-prints SQL in the server's dialect; null when it can't be parsed. */
export function formatSql(
  text: string,
  kind: DbKind | undefined,
): string | null {
  try {
    return format(text, {
      language: kind === "postgres" || !kind ? "postgresql" : "sql",
      tabWidth: 2,
      keywordCase: "preserve",
    });
  } catch {
    return null;
  }
}

/** Registers the completion and formatting providers once for the 'sql' language. */
export function registerSqlCompletion(): void {
  if (registered) return;
  registered = true;
  const fmt = (
    model: monaco.editor.ITextModel,
    range: monaco.IRange,
  ): monaco.languages.TextEdit[] => {
    const out = formatSql(
      model.getValueInRange(range),
      targets.get(model.uri.toString())?.kind,
    );
    return out === null ? [] : [{ range, text: out }];
  };
  monaco.languages.registerDocumentFormattingEditProvider("sql", {
    provideDocumentFormattingEdits: (model) =>
      fmt(model, model.getFullModelRange()),
  });
  monaco.languages.registerDocumentRangeFormattingEditProvider("sql", {
    provideDocumentRangeFormattingEdits: (model, range) => fmt(model, range),
  });
  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", '"'],
    async provideCompletionItems(model, position) {
      const t = targets.get(model.uri.toString());
      if (!t || t.kind !== "postgres") return { suggestions: [] };
      const meta = await load(t);
      if (!meta || model.isDisposed()) return { suggestions: [] };
      const text = model.getValue();
      const { stmt, at } = statementAround(
        text,
        model.getOffsetAt(position),
        t.kind,
      );
      // Replace the word being typed, including an opening double quote.
      const w = model.getWordUntilPosition(position);
      const line = model.getLineContent(position.lineNumber);
      const startCol =
        line[w.startColumn - 2] === '"' ? w.startColumn - 1 : w.startColumn;
      const range = new monaco.Range(
        position.lineNumber,
        startCol,
        position.lineNumber,
        position.column,
      );
      const suggestions = suggest(meta, stmt, at).map(
        (s, i): monaco.languages.CompletionItem => ({
          label: s.detail ? { label: s.label, description: s.detail } : s.label,
          kind: KIND[s.kind],
          insertText: s.insert ?? s.label,
          filterText: s.label,
          sortText: `${s.rank}${String(i).padStart(5, "0")}`,
          range,
        }),
      );
      return { suggestions, incomplete: false };
    },
  });
}

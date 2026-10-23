import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Copy } from "lucide-react";
import type { Plan, PlanNode } from "../../../../../main/db/explain";
import { useT } from "../../../i18n";
import { Segmented } from "../../../components/ui/Controls";

// An EXPLAIN plan as an indented tree: per node the estimate, the actuals when
// ANALYZE ran, and a bar of its own share of the time (or cost), so the slow
// node stands out. Raw shows the JSON as the server sent it.

const fmtNum = (n: number): string =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e4
      ? `${(n / 1e3).toFixed(1)}k`
      : String(Math.round(n * 100) / 100);
const fmtMs = (n: number): string =>
  n >= 1000
    ? `${(n / 1000).toFixed(2)} s`
    : n >= 10
      ? `${n.toFixed(1)} ms`
      : `${n.toFixed(2)} ms`;

export default function PlanView({
  plan,
  raw,
}: {
  plan: Plan;
  raw: string;
}): JSX.Element {
  const t = useT();
  const [mode, setMode] = useState<"tree" | "raw">("tree");
  const [closed, setClosed] = useState<Set<number>>(() => new Set());
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }, [raw]);

  const warn = (w: string): string => {
    const [key, n] = w.split(":");
    return t(`db.plan.w.${key}`, { n: n ?? "" });
  };

  const rows: JSX.Element[] = [];
  const walk = (n: PlanNode, depth: number): void => {
    const open = !closed.has(n.id);
    const self = plan.analyze ? (n.selfMs ?? 0) : n.selfCost;
    const share = plan.maxSelf > 0 ? self / plan.maxSelf : 0;
    const total = plan.analyze
      ? (plan.executionMs ?? plan.root.totalMs ?? 0)
      : plan.root.totalCost;
    const pct = total > 0 ? (self / total) * 100 : 0;
    rows.push(
      <div key={n.id} className={`dbx-plan-row${pct >= 30 ? " hot" : ""}`}>
        <div className="dbx-plan-node" style={{ paddingLeft: depth * 16 + 4 }}>
          <div className="dbx-plan-head">
            {n.children.length ? (
              <button
                className="dbx-plan-caret"
                onClick={() =>
                  setClosed((s) => {
                    const x = new Set(s);
                    if (open) x.add(n.id);
                    else x.delete(n.id);
                    return x;
                  })
                }
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            ) : (
              <span className="dbx-plan-caret" />
            )}
            <span className="dbx-plan-label">{n.label}</span>
            {n.warnings.map((w) => (
              <span key={w} className="dbx-plan-warn" title={warn(w)}>
                <AlertTriangle size={10} /> {warn(w)}
              </span>
            ))}
          </div>
          {n.detail.map((d, i) => (
            <div key={i} className="dbx-plan-detail">
              {d}
            </div>
          ))}
        </div>
        <div className="dbx-plan-num" title={t("db.plan.rowsHint")}>
          {n.actualRows !== undefined ? (
            <>
              {fmtNum(n.actualRows)}
              <span className="dbx-dim">
                {" "}
                / {fmtNum(n.planRows * (n.loops || 1))}
              </span>
            </>
          ) : (
            fmtNum(n.planRows)
          )}
          {n.loops !== undefined && n.loops > 1 && (
            <span className="dbx-dim"> ×{n.loops}</span>
          )}
        </div>
        <div
          className="dbx-plan-num"
          title={`${t("db.plan.cost")} ${n.startupCost}..${n.totalCost}`}
        >
          {fmtNum(n.totalCost)}
        </div>
        <div className="dbx-plan-num">
          {plan.analyze && n.totalMs !== undefined ? fmtMs(n.totalMs) : ""}
        </div>
        <div className="dbx-plan-bar" title={`${pct.toFixed(1)}%`}>
          <span
            style={{ width: `${Math.max(share * 100, self > 0 ? 2 : 0)}%` }}
          />
          <em>{plan.analyze ? fmtMs(self) : fmtNum(self)}</em>
        </div>
      </div>,
    );
    if (open) for (const c of n.children) walk(c, depth + 1);
  };
  if (mode === "tree") walk(plan.root, 0);

  return (
    <div className="dbx-plan">
      <div className="dbx-plan-bar-top">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "tree", label: t("db.plan.tree") },
            { value: "raw", label: "JSON" },
          ]}
        />
        <span className="dbx-meta">
          {plan.analyze ? "EXPLAIN ANALYZE" : "EXPLAIN"}
        </span>
        {plan.planningMs !== undefined && (
          <span className="dbx-meta">
            {t("db.plan.planning")} {fmtMs(plan.planningMs)}
          </span>
        )}
        {plan.executionMs !== undefined && (
          <span className="dbx-meta">
            {t("db.plan.execution")} {fmtMs(plan.executionMs)}
          </span>
        )}
        <span className="dbx-meta">
          {t("db.plan.nodes", { n: String(plan.nodes) })}
        </span>
        <span className="dbx-spacer" />
        <button
          className="dbx-icon-btn"
          title={t("db.plan.copy")}
          onClick={() => void navigator.clipboard.writeText(pretty)}
        >
          <Copy size={12} />
        </button>
      </div>
      {mode === "tree" ? (
        <div className="dbx-plan-tree">
          <div className="dbx-plan-row head">
            <div className="dbx-plan-node">{t("db.plan.node")}</div>
            <div className="dbx-plan-num">
              {plan.analyze ? t("db.plan.rowsActual") : t("db.plan.rows")}
            </div>
            <div className="dbx-plan-num">{t("db.plan.cost")}</div>
            <div className="dbx-plan-num">
              {plan.analyze ? t("db.plan.time") : ""}
            </div>
            <div className="dbx-plan-bar">
              {plan.analyze ? t("db.plan.selfTime") : t("db.plan.selfCost")}
            </div>
          </div>
          {rows}
        </div>
      ) : (
        <pre className="dbx-plan-raw">{pretty}</pre>
      )}
    </div>
  );
}

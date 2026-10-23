import React, { useEffect, useState } from "react";
import { LEVELS, scoreLabel, type Finding, type InspectState, type Level } from "../../shared/inspector";
import ConsentCard from "../ConsentCard";
import { command, useAiJob, useInspect } from "../hooks";
import type { SidePanelSectionProps } from "./index";

const SEVERITY_LABEL: Record<Level, string> = { high: "High", medium: "Medium", low: "Low" };
const SOURCE_LABEL: Record<string, string> = { local: "Local AI", cloud: "Cloud AI", demo: "Demo mode, no AI" };

/** Outline (and scroll to) one element on the page; null clears it. */
function outline(tabId: number, id: string | null): void {
  chrome.tabs.sendMessage(tabId, { type: "OUTLINE_ELEMENT", id }, () => void chrome.runtime.lastError);
}

function Score({ report, previous }: { report: NonNullable<InspectState["report"]>; previous?: number }): React.ReactElement {
  const { value, contributors } = report.score;
  return (
    <div className="card score-card">
      <div className="score-line">
        <span className={`score score-${value >= 85 ? "good" : value >= 65 ? "fair" : "poor"}`} aria-label={`Readability score ${value} out of 100`}>{value}</span>
        <div>
          <strong>Readability score · {scoreLabel(value)}</strong>
          {previous !== undefined && previous !== value && <p className="muted small">was {previous} before the last change</p>}
        </div>
      </div>
      {contributors.length > 0
        ? <ul className="changes small">{contributors.slice(0, 3).map((item) => <li key={item.category}>{item.label}: −{item.penalty} ({item.findings} finding{item.findings === 1 ? "" : "s"})</li>)}</ul>
        : <p className="muted small">No issues found by the checks.</p>}
      <p className="muted small">Checked {report.scanned} elements in {report.durationMs} ms{report.capped ? " (page is large: the scan stopped at its limit)" : ""}.</p>
    </div>
  );
}

function FindingItem({ finding, tabId, pinnedRef, onPin, onApply, busy }: {
  finding: Finding;
  tabId: number;
  /** The element outlined by "Show on page", which hovering must not lose. */
  pinnedRef: string | null;
  onPin: (id: string | null) => void;
  onApply: (ids: string[]) => void;
  busy: boolean;
}): React.ReactElement {
  const ref = finding.elementRef;
  const pinned = Boolean(ref) && pinnedRef === ref;
  return (
    <li
      className={`finding${pinned ? " pinned" : ""}`}
      onMouseEnter={() => ref && outline(tabId, ref)}
      onMouseLeave={() => ref && outline(tabId, pinnedRef)}
    >
      <div className="finding-head">
        <strong>{finding.title}</strong>
        <span className={`chip conf-${finding.confidence}`} title="How sure the measurement is">{finding.confidence} confidence</span>
      </div>
      <p className="small finding-detail">{finding.detail}</p>
      {finding.label && <p className="muted small element-label">{finding.label}</p>}
      <div className="row">
        {ref && <button className="link" onClick={() => onPin(pinned ? null : ref)}>{pinned ? "Hide outline" : "Show on page"}</button>}
        {finding.suggestedFix && <button disabled={busy} onClick={() => onApply([finding.id])}>Apply fix: {finding.suggestedFix.description}</button>}
      </div>
      {!finding.suggestedFix && finding.advice && <p className="muted small">{finding.advice}</p>}
    </li>
  );
}

function Interpretation({ state }: { state: InspectState }): React.ReactElement | null {
  const interpretation = state.interpretation;
  if (!interpretation) return null;
  const byId = new Map(state.report?.findings.map((finding) => [finding.id, finding]));
  return (
    <div className="card interpretation">
      <div className="meta"><strong>AI interpretation</strong><span className="chip">{SOURCE_LABEL[interpretation.source]}</span></div>
      <p className="muted small">Inference from the measurements above, not a measurement itself.</p>
      <p>{interpretation.summary}</p>
      {interpretation.priorities.length > 0 && (
        <ol className="changes">
          {interpretation.priorities.map((item) => <li key={item.id}><strong>{byId.get(item.id)?.title ?? item.id}</strong>: {item.why}</li>)}
        </ol>
      )}
      {interpretation.dropped > 0 && <p className="muted small">Left out {interpretation.dropped} item(s) that named no real finding.</p>}
    </div>
  );
}

/** "Inspect": measured findings, a readability score, fixes through the AI job's Apply/Undo. */
export default function InspectPanel({ tab, settings }: SidePanelSectionProps): React.ReactElement {
  const tabId = tab?.id ?? null;
  const state = useInspect(tabId);
  const job = useAiJob(tabId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  useEffect(() => { setError(null); setPinned(null); }, [tabId]);
  const usable = Boolean(tab?.hostname) && /^https?:/.test(tab?.url ?? "");
  const send = async (message: Record<string, unknown>) => {
    if (tabId === null) return;
    setBusy(true);
    setError(await command({ ...message, tabId }));
    setBusy(false);
  };
  const pin = (id: string | null) => { setPinned(id); if (tabId !== null) outline(tabId, id); };

  const report = state?.report;
  const highConfidence = report?.findings.filter((finding) => finding.confidence === "high" && finding.suggestedFix) ?? [];
  const fixApplied = job?.source === "inspector" && job.status === "applied" ? job : null;

  return (
    <div className="inspect-panel">
      <div className="row">
        <button className="primary" disabled={!usable || busy || Boolean(state?.running)} onClick={() => void send({ type: "INSPECT_RUN" })}>{report ? "Check again" : "Inspect this page"}</button>
        {report && report.findings.length > 0 && (
          <button disabled={busy || Boolean(state?.running)} onClick={() => void send({ type: "INSPECT_EXPLAIN" })} title="Sends the measured numbers (no page text) to the AI to prioritise and explain them">Explain with AI</button>
        )}
      </div>
      <p className="muted small">This tool highlights potential issues and does not make a site WCAG compliant.</p>
      {!usable && <p className="muted">Open a regular web page to inspect it.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {state?.running && (
        <div className="card" aria-live="polite">
          <div className="stage"><span className="spinner" aria-hidden="true" />{state.running.stage}</div>
          {state.running.stage.startsWith("Asking") && <button onClick={() => void send({ type: "INSPECT_CANCEL" })}>Cancel</button>}
        </div>
      )}
      {state?.error && (
        <div className="card error" role="alert">
          <strong>{state.error.message}</strong>
          <p className="muted">{state.error.hint}</p>
          {state.error.code === "consent-required" && tab && (
            <ConsentCard hostname={tab.hostname} backend={settings.ai.cloudBackend} onDecided={(decision) => { if (decision !== "deny") void send({ type: "INSPECT_EXPLAIN" }); }} />
          )}
        </div>
      )}
      {report && <Score report={report} previous={state?.previousScore} />}
      {fixApplied && (
        <div className="card">
          <strong>Fixes saved for {fixApplied.hostname}</strong>
          <ul className="changes small">{fixApplied.descriptions?.map((line) => <li key={line}>{line}</li>)}</ul>
          <div className="row"><button disabled={busy} onClick={() => void send({ type: "INSPECT_UNDO" })}>Undo fixes</button></div>
        </div>
      )}
      {state && <Interpretation state={state} />}
      {highConfidence.length > 0 && (
        <button className="primary" disabled={busy} onClick={() => void send({ type: "INSPECT_APPLY", ids: highConfidence.map((finding) => finding.id) })}>
          Apply all high-confidence fixes ({highConfidence.length})
        </button>
      )}
      {report && LEVELS.map((level) => {
        const findings = report.findings.filter((finding) => finding.severity === level);
        if (!findings.length) return null;
        return (
          <div key={level} className="finding-group">
            <h3 className={`severity-${level}`}>{SEVERITY_LABEL[level]} ({findings.length})</h3>
            <ul className="finding-list">
              {findings.map((finding) => (
                <FindingItem key={finding.id} finding={finding} tabId={tabId!} pinnedRef={pinned} onPin={pin} onApply={(ids) => void send({ type: "INSPECT_APPLY", ids })} busy={busy} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

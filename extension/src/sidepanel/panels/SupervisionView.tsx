import React, { useState } from "react";
import { z } from "zod";
import type { AiJob, Step, Supervision } from "../../shared/aiJob";
import { PROTECT_LABEL, type ElementAction } from "../../shared/elementPlan";
import type { LedgerEntry, LedgerSource } from "../../shared/review";
import type { Settings } from "../../shared/settings";
import ConsentCard from "../ConsentCard";
import { ScreenshotHint } from "../ScreenshotAccess";
import { command, useSessionRecord } from "../hooks";

// P10: the supervised fix, as the reader sees it: draft → measured →
// reviewed → final, what happened to each item and why, and the evidence
// (score before/after, before/after screenshots).

const STEP_LABEL: Record<Step["id"], string> = { draft: "Draft", measure: "Measured", review: "Reviewed", final: "Final" };
const SOURCE_LABEL: Record<LedgerSource, string> = { local: "local AI", cloud: "cloud reviewer", demo: "demo rules", rules: "built-in rules", inspector: "inspector", you: "you" };
const KIND_LABEL: Record<LedgerEntry["kind"], string> = { setting: "Setting", hide: "Hide", dim: "Dim", highlight: "Highlight" };
const STATUS_LABEL: Record<LedgerEntry["status"], string> = { kept: "kept", added: "added", dropped: "removed", reverted: "undone" };

function Stepper({ steps }: { steps: readonly Step[] }): React.ReactElement {
  return (
    <ol className="stepper" aria-label="Progress">
      {steps.map((step) => (
        <li key={step.id} className={`step step-${step.status}`} aria-current={step.status === "running" ? "step" : undefined} title={step.note}>
          <span className="step-dot" aria-hidden="true">{step.status === "done" ? "✓" : step.status === "failed" ? "!" : step.status === "skipped" ? "–" : ""}</span>
          <span>{STEP_LABEL[step.id]}</span>
          <span className="visually-hidden">: {step.status}{step.note ? `, ${step.note}` : ""}</span>
        </li>
      ))}
    </ol>
  );
}

function Scores({ scores }: { scores: Supervision["scores"] }): React.ReactElement | null {
  const parts = [["Before", scores.before], ["Draft", scores.draft], ["Final", scores.final]].filter((part): part is [string, number] => typeof part[1] === "number");
  if (parts.length === 0) return null;
  return (
    <p className="score-path" aria-label={`Readability score: ${parts.map(([label, value]) => `${label.toLowerCase()} ${value}`).join(", ")}`}>
      Readability {parts.map(([label, value], index) => <span key={label}>{index > 0 && <span aria-hidden="true"> → </span>}<span className="muted small">{label}</span> <strong>{value}</strong></span>)}
    </p>
  );
}

function ReviewChip({ supervision }: { supervision: Supervision }): React.ReactElement {
  if (supervision.review === "reviewed") return <span className="chip ok">Reviewed by {supervision.reviewer ?? "cloud AI"}{supervision.verdict === "approve" ? " · approved" : ""}</span>;
  if (supervision.review === "running" || supervision.review === "pending") return <span className="chip">Cloud review…</span>;
  if (supervision.review === "failed") return <span className="chip bad">Review failed</span>;
  return <span className="chip">Not reviewed</span>;
}

/** One draft item: kept, added, removed (with the reviewer's reason) or undone (with the measurement). */
function Entry({ entry, job, editable, onError }: { entry: LedgerEntry; job: AiJob; editable: boolean; onError: (error: string | null) => void }): React.ReactElement {
  const item = entry.kind !== "setting" ? job.elements?.find((element) => element.id === entry.ref && element.action === entry.kind) : undefined;
  const live = entry.status === "kept" || entry.status === "added";
  const toggle = async (enabled: boolean) => onError(await command({ type: "AI_SET_ELEMENT", tabId: job.tabId, id: entry.ref, enabled }));
  const outline = (id: string | null) => chrome.tabs.sendMessage(job.tabId, { type: "OUTLINE_ELEMENT", id }, () => void chrome.runtime.lastError);
  const element = entry.kind !== "setting";
  const needsConfirm = editable && item?.protect && !item.enabled;
  const off = live && item && !item.enabled && !needsConfirm;
  return (
    <li
      className={`ledger-entry status-${entry.status}${off ? " off" : ""}${needsConfirm ? " pending" : ""}`}
      onMouseEnter={element ? () => outline(entry.ref) : undefined}
      onMouseLeave={element ? () => outline(null) : undefined}
      onFocus={element ? () => outline(entry.ref) : undefined}
      onBlur={element ? () => outline(null) : undefined}
    >
      <label>
        {editable && live && item && <input type="checkbox" checked={item.enabled} onChange={(event) => void toggle(event.target.checked)} aria-label={`${KIND_LABEL[entry.kind]} ${entry.label}`} />}
        <span className={`badge action-${element ? entry.kind as ElementAction : "setting"}`}>{KIND_LABEL[entry.kind]}</span>
        <span className="ledger-label">{entry.label}</span>
      </label>
      <p className="ledger-why small">
        <span className={`status-word status-${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
        <span className="muted"> · {entry.status === "kept" ? SOURCE_LABEL[entry.source] : entry.status === "reverted" ? "by code" : SOURCE_LABEL[entry.source]}</span>
        {entry.reason && <span className="muted">: {entry.reason}</span>}
      </p>
      {needsConfirm && item?.protect && <p className="warning">This is {PROTECT_LABEL[item.protect]}. Tick it to confirm.</p>}
    </li>
  );
}

const ShotsSchema = z.object({ before: z.string().optional(), after: z.string().optional() });
const shotsKey = (tabId: number) => `awl_shots_${tabId}`;

function Shots({ tabId }: { tabId: number }): React.ReactElement | null {
  const shots = useSessionRecord(tabId, shotsKey, ShotsSchema);
  const [showAfter, setShowAfter] = useState(true);
  if (!shots?.before && !shots?.after) return null;
  const src = showAfter ? shots.after ?? shots.before : shots.before ?? shots.after;
  return (
    <details className="shots">
      <summary>Screenshots the reviewer saw</summary>
      <div className="row" role="group" aria-label="Which screenshot">
        <button aria-pressed={!showAfter} onClick={() => setShowAfter(false)} disabled={!shots.before}>Before</button>
        <button aria-pressed={showAfter} onClick={() => setShowAfter(true)} disabled={!shots.after}>After the draft</button>
      </div>
      {src && <img src={src} alt={showAfter ? "The page with the local draft applied, with numbered boxes" : "The page before any change, with numbered boxes; red boxes are what the draft changes"} />}
      <p className="muted small">Red boxes: what the local draft changes. Blue: other parts of the page.</p>
    </details>
  );
}

export default function SupervisionView({ job, settings, onError }: { job: AiJob; settings: Settings; onError: (error: string | null) => void }): React.ReactElement | null {
  const supervision = job.supervision;
  if (!supervision) return null;
  const editable = job.status === "preview";
  const review = async () => onError(await command({ type: "AI_REVIEW", tabId: job.tabId }));
  const pending = (job.elements ?? []).filter((item) => item.protect && !item.enabled).length;
  return (
    <div className="supervision">
      <Stepper steps={supervision.steps} />
      <div className="meta"><ReviewChip supervision={supervision} /></div>
      <Scores scores={supervision.scores} />
      {supervision.note && <p className={supervision.review === "reviewed" ? "review-note" : "muted small"}>{supervision.note}</p>}
      {supervision.ledger.length > 0 && <ul className="ledger" aria-label="What changes and why">{supervision.ledger.map((entry) => <Entry key={`${entry.kind}-${entry.ref}-${entry.status}`} entry={entry} job={job} editable={editable} onError={onError} />)}</ul>}
      {editable && pending > 0 && <p className="muted small">{pending} item{pending === 1 ? " needs" : "s need"} your OK before {pending === 1 ? "it is" : "they are"} hidden. Hover an item to see it on the page.</p>}
      {supervision.reverted.length > 0 && <p className="muted small">Code undid {supervision.reverted.length} change{supervision.reverted.length === 1 ? "" : "s"} that made the page measurably worse.</p>}
      {supervision.shots && <Shots tabId={job.tabId} />}
      {supervision.review === "reviewed" && !supervision.shots && <ScreenshotHint settings={settings} />}
      {editable && supervision.needsConsent && (
        <ConsentCard hostname={job.hostname} backend={settings.ai.cloudBackend} onDecided={(decision) => { if (decision !== "deny") void review(); }} />
      )}
      {editable && supervision.canReview && !supervision.needsConsent && supervision.review !== "running" && (
        <div className="row"><button onClick={() => void review()}>{supervision.review === "failed" ? "Try the review again" : "Review with cloud AI"}</button></div>
      )}
    </div>
  );
}

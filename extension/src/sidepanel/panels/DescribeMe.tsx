import React, { useEffect, useState } from "react";
import { MAX_DESCRIPTION_CHARS } from "../../shared/describe";
import ConsentCard from "../ConsentCard";
import { command, useAiJob } from "../hooks";
import type { SidePanelSectionProps } from "./index";

const SOURCE_LABEL: Record<string, string> = { local: "Local AI", cloud: "Cloud AI", demo: "Demo mode, no AI", rules: "Built-in rules" };

/** P11 "Describe how reading feels": a starting profile, previewed, then saved; the fit test confirms it. */
export default function DescribeMe({ tab, settings, onConfirm }: SidePanelSectionProps & { onConfirm: () => void }): React.ReactElement {
  const tabJob = useAiJob(tab?.id ?? null);
  const job = tabJob?.kind === "describeMe" ? tabJob : null;
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (job?.profile?.name) setName(job.profile.name); }, [job?.id, job?.profile?.name]);
  const usable = Boolean(tab?.hostname) && /^https?:/.test(tab?.url ?? "");
  const act = async (message: Record<string, unknown>) => { if (tab) setError(await command({ ...message, tabId: tab.id })); };
  const run = () => void act({ type: "AI_RUN", request: text.trim(), kind: "describeMe" });

  return (
    <div className="describe">
      <form onSubmit={(event) => { event.preventDefault(); if (text.trim()) run(); }}>
        <label className="small" htmlFor="describe-text">Describe how reading feels, in your own words</label>
        <textarea id="describe-text" rows={3} maxLength={MAX_DESCRIPTION_CHARS} value={text} placeholder='e.g. "letters crowd together, I lose my line, white pages are too bright"' onChange={(event) => setText(event.target.value)} />
        <div className="row">
          <button className="primary" type="submit" disabled={!usable || !text.trim() || tabJob?.status === "running"}>Suggest settings</button>
          <span className="muted small">Previewed on this page first.</span>
        </div>
      </form>
      {!usable && <p className="muted small">Open a regular web page to preview the settings.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {job?.status === "running" && (
        <div className="card" aria-live="polite">
          <div className="stage"><span className="spinner" aria-hidden="true" />{job.stage}</div>
          <button onClick={() => void act({ type: "AI_CANCEL" })}>Cancel</button>
        </div>
      )}
      {job?.status === "error" && job.error && (
        <div className="card error" role="alert">
          <strong>{job.error.message}</strong>
          <p className="muted">{job.error.hint}</p>
          {job.error.code === "consent-required" && tab && <ConsentCard hostname={tab.hostname} backend={settings.ai.cloudBackend} onDecided={(decision) => { if (decision !== "deny") void act({ type: "AI_RUN", request: job.request, kind: "describeMe" }); }} />}
          {job.fallback && <button onClick={() => void act({ type: "AI_USE_FALLBACK" })}>Preview a suggestion without AI</button>}
        </div>
      )}
      {job?.status === "preview" && (
        <div className="card">
          <div className="meta">{job.source && <span className="badge">{SOURCE_LABEL[job.source] ?? job.source}</span>}<strong>{job.interpretedRequest}</strong></div>
          <ul className="changes">{job.descriptions?.map((line) => <li key={line}>{line}</li>)}</ul>
          {job.reasons?.map((reason) => <p key={reason} className="muted small">{reason}</p>)}
          {job.warnings?.map((warning) => <p key={warning} className="warning">{warning}</p>)}
          <p className="muted small">{job.profile?.note} It does not treat dyslexia; no setting helps every reader.</p>
          <div className="row">
            <input aria-label="Profile name" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
            <button className="primary" disabled={!name.trim()} onClick={() => void act({ type: "AI_SAVE_PROFILE", name: name.trim(), activate: true })}>Save as my profile</button>
            <button onClick={() => void act({ type: "AI_DISCARD" })}>Discard</button>
          </div>
          <button className="link" onClick={onConfirm}>Confirm with the reading-fit test (a measurement beats a guess)</button>
        </div>
      )}
      {job?.status === "nothing" && job.stage === "Saved" && (
        <div className="card">
          <strong>{job.interpretedRequest}</strong>
          <p className="muted small">A starting point, adjust anytime in Settings → Profiles.</p>
          <button className="link" onClick={onConfirm}>Confirm it with the reading-fit test</button>
        </div>
      )}
    </div>
  );
}

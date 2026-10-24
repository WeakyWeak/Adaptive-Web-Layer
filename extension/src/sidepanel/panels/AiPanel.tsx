import React, { useEffect, useState } from "react";
import type { AiJob } from "../../shared/aiJob";
import { CLEAN_PAGE_REQUEST, FIX_PAGE_REQUEST } from "../../shared/elementPlan";
import type { Settings } from "../../shared/settings";
import ConsentCard from "../ConsentCard";
import { command, useAiJob, type ActiveTab } from "../hooks";
import ElementList from "./ElementList";
import SavedRules from "./SavedRules";
import SupervisionView from "./SupervisionView";

const SOURCE_LABEL: Record<NonNullable<AiJob["source"]>, string> = {
  local: "Local AI",
  cloud: "Cloud AI",
  demo: "Demo mode",
  rules: "Built-in rules",
  inspector: "Inspector fix",
};

function ChangeList({ items }: { items: string[] }): React.ReactElement {
  return <ul className="changes">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

function SaveProfile({ tabId, onError }: { tabId: number; onError: (error: string | null) => void }): React.ReactElement {
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const error = await command({ type: "AI_SAVE_PROFILE", tabId, name });
    onError(error);
    if (!error) { setSaved(true); setName(""); }
  };
  return (
    <form className="row" onSubmit={(event) => void save(event)}>
      <input aria-label="Profile name" placeholder="Save as profile…" value={name} maxLength={64} onChange={(event) => { setName(event.target.value); setSaved(false); }} />
      <button type="submit" disabled={!name.trim()}>Save</button>
      {saved && <span className="muted">Saved</span>}
    </form>
  );
}

function JobResult({ job, settings, onRerun, onError }: {
  job: AiJob;
  settings: Settings;
  onRerun: () => void;
  onError: (error: string | null) => void;
}): React.ReactElement | null {
  const act = async (type: string) => onError(await command({ type, tabId: job.tabId }));

  if (job.status === "running") {
    return (
      <div className="card" aria-live="polite">
        {job.supervision && <SupervisionView job={job} settings={settings} onError={onError} />}
        <div className="stage"><span className="spinner" aria-hidden="true" />{job.stage}{job.received > 0 ? ` · ${job.received} chars` : ""}</div>
        <button onClick={() => void act("AI_CANCEL")}>Cancel</button>
      </div>
    );
  }

  if (job.status === "error" && job.error) {
    return (
      <div className="card error" role="alert">
        <strong>{job.error.message}</strong>
        <p className="muted">{job.error.hint}</p>
        {job.error.code === "consent-required" && (
          <ConsentCard hostname={job.hostname} backend={settings.ai.cloudBackend} onDecided={(decision) => { if (decision !== "deny") onRerun(); }} />
        )}
        {job.fallback && (
          <div className="fallback">
            <p>Suggested without AI:</p>
            <ChangeList items={[...job.fallback.descriptions, ...(job.fallback.elements ?? []).map((item) => `Hide ${item.label}`)]} />
            <button className="primary" onClick={() => void act("AI_USE_FALLBACK")}>Preview suggestion</button>
          </div>
        )}
      </div>
    );
  }

  if (job.status === "nothing") {
    return (
      <div className="card">
        <strong>{job.interpretedRequest ?? "Done"}</strong>
        {job.source !== "rules" && <p className="muted">No setting needed to change.</p>}
        {job.reasons?.map((reason) => <p key={reason} className="muted">{reason}</p>)}
        {job.warnings?.map((warning) => <p key={warning} className="warning">{warning}</p>)}
        {job.supervision ? <SupervisionView job={job} settings={settings} onError={onError} /> : <ElementList job={job} onError={onError} />}
      </div>
    );
  }

  if (job.status === "cancelled") return <p className="muted">{job.stage}.</p>;

  // preview or applied
  return (
    <div className="card">
      <div className="meta">
        {job.source && <span className="badge">{SOURCE_LABEL[job.source]}</span>}
        {job.confidence !== undefined && <span className="muted">confidence {Math.round(job.confidence * 100)}%</span>}
      </div>
      <strong>{job.interpretedRequest}</strong>
      {job.supervision ? (
        <>
          <SupervisionView job={job} settings={settings} onError={onError} />
          {(job.rejectedElements?.length ?? 0) > 0 && (
            <details>
              <summary>Not applied ({job.rejectedElements!.length})</summary>
              <ul className="changes">{job.rejectedElements!.map((item) => <li key={`${item.action}-${item.id}`}>{item.label}: {item.reason}</li>)}</ul>
            </details>
          )}
          {job.unsaved && job.unsaved.length > 0 && <p className="warning">Could not save {job.unsaved.length} item(s) for later visits: {job.unsaved.join(", ")}.</p>}
        </>
      ) : (
        <>
          {(job.descriptions?.length ?? 0) > 0 && <ChangeList items={job.descriptions ?? []} />}
          <ElementList job={job} onError={onError} />
        </>
      )}
      {job.reasons && job.reasons.length > 0 && (
        <details><summary>Why</summary>{job.reasons.map((reason) => <p key={reason} className="muted">{reason}</p>)}</details>
      )}
      {job.warnings?.map((warning) => <p key={warning} className="warning">{warning}</p>)}
      {job.status === "preview" ? (
        <>
          <p className="muted">Previewing on the page. Nothing is saved yet.</p>
          <div className="row">
            <button className="primary" disabled={job.supervision?.review === "running"} onClick={() => void act("AI_APPLY")}>Apply to {job.hostname}</button>
            {job.supervision?.review === "running" && <button onClick={() => void act("AI_CANCEL")}>Stop the review</button>}
            <button onClick={() => void act("AI_DISCARD")}>Discard</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Saved for {job.hostname}.</p>
          <div className="row"><button onClick={() => void act("AI_UNDO")}>Undo</button></div>
        </>
      )}
      <SaveProfile tabId={job.tabId} onError={onError} />
    </div>
  );
}

export default function AiPanel({ tab, settings }: { tab: ActiveTab | null; settings: Settings }): React.ReactElement {
  const job = useAiJob(tab?.id ?? null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [tab?.id]);

  const run = async (request: string, kind: "ask" | "clean" | "fix" = "ask") => {
    if (!tab || !request.trim()) return;
    setError(await command({ type: "AI_RUN", tabId: tab.id, request: request.trim(), kind }));
  };
  const usable = Boolean(tab?.hostname) && /^https?:/.test(tab?.url ?? "");

  return (
    <div className="ai-panel">
      <form className="row" onSubmit={(event) => { event.preventDefault(); void run(input); }}>
        <input
          aria-label="What should change on this page?"
          placeholder='e.g. "Make the text larger, keep code colours"'
          value={input}
          maxLength={1000}
          disabled={!usable || job?.status === "running"}
          onChange={(event) => setInput(event.target.value)}
        />
        <button className="primary" type="submit" disabled={!usable || !input.trim() || job?.status === "running"}>Go</button>
      </form>
      <div className="row">
        <button onClick={() => void run(FIX_PAGE_REQUEST, "fix")} disabled={!usable || job?.status === "running"} title="The local AI drafts readability fixes, code measures them, and in hybrid mode a cloud model reviews them">
          Fix this page
        </button>
        <button onClick={() => void run(CLEAN_PAGE_REQUEST, "clean")} disabled={!usable || job?.status === "running"} title="Hide cookie banners, pop-ups, promos, share buttons, author boxes and related posts; keep the main content and navigation">
          Clean this page
        </button>
      </div>
      <SavedRules tab={tab} settings={settings} />
      {!usable && <p className="muted">Open a regular web page to use AI commands.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {job && <JobResult job={job} settings={settings} onRerun={() => void run(job.request, job.kind)} onError={setError} />}
    </div>
  );
}

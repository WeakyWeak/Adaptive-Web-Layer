import React, { useEffect, useState } from "react";
import type { ReadingViewResult, SelectionResult, UnderstandState } from "../../shared/comprehension";
import { languageName } from "../../shared/languages";
import ConsentCard from "../ConsentCard";
import { command, useUnderstand } from "../hooks";
import type { SidePanelSectionProps } from "./index";

const SOURCE_LABEL: Record<string, string> = { local: "Local AI", cloud: "Cloud AI", sarvam: "Sarvam (cloud)", demo: "Demo mode, no AI" };
const KIND_LABEL: Record<string, string> = { summarize: "TL;DR", glossary: "Glossary", readingView: "Dyslexia reading view", simplify: "Explain simply", define: "Define", translate: "Translate" };

const REVIEW_LABEL: Record<ReadingViewResult["checks"]["review"], string> = {
  reviewed: "reviewed by the cloud",
  "not-allowed": "not reviewed by the cloud",
  failed: "cloud review failed",
};

/** P11: draft → code check → cloud review → preview, and the way back to the original. */
function ReadingViewCard({ view, hostname, settings, send, running }: { view: ReadingViewResult; hostname: string; running: boolean; send: (message: Record<string, unknown>) => Promise<void> } & Pick<SidePanelSectionProps, "settings">): React.ReactElement {
  const { checks } = view;
  const canAskCloud = checks.review === "not-allowed" && view.source !== "demo" && settings.ai.mode !== "local";
  return (
    <div className="card">
      <div className="meta"><strong>Dyslexia reading view</strong><Source source={view.source} cached={view.cached} /></div>
      <ol className="steps small">
        <li>Drafted: {view.blocks.length} short blocks{view.summary.length ? " and a 3-line summary" : ""}{view.coverage < 0.99 ? ` (first ${Math.round(view.coverage * 100)}% of the article)` : ""}</li>
        <li>Checked by code: {checks.flagged ? `${checks.flagged} of ${checks.parts} part(s) flagged` : "no changed numbers, names or negations"}</li>
        <li>{checks.review === "reviewed" ? `Reviewed by the cloud: ${checks.reviewedParts} of ${checks.parts} part(s)` : REVIEW_LABEL[checks.review]}</li>
        <li>{view.shown ? "Shown over the page; the page itself is unchanged" : "Hidden; the page shows its original text"}</li>
      </ol>
      <Notes notes={view.notes} />
      <div className="row">
        {view.shown
          ? <button onClick={() => void send({ type: "UNDERSTAND_HIDE", what: "readingView" })}>Back to the original</button>
          : <button className="primary" disabled={running} onClick={() => void send({ type: "UNDERSTAND_RUN", kind: "readingView" })}>Show the reading view</button>}
        <button disabled={running} onClick={() => void send({ type: "UNDERSTAND_RUN", kind: "readingView", refresh: true })}>Make it again</button>
      </div>
      {canAskCloud && (
        <details>
          <summary>Have the cloud check it against the original</summary>
          <p className="muted small">The cloud reviewer needs to read this page's text. Tick "Also share page text with the reviewer" to allow it for {hostname}.</p>
          <ConsentCard hostname={hostname} backend={settings.ai.cloudBackend} onDecided={(decision) => { if (decision !== "deny") void send({ type: "UNDERSTAND_RUN", kind: "readingView", refresh: true }); }} />
        </details>
      )}
    </div>
  );
}

function Source({ source, cached }: { source: string; cached: boolean }): React.ReactElement {
  return <span className="chip">{SOURCE_LABEL[source] ?? source}{cached ? " · saved result" : ""}</span>;
}

function Notes({ notes }: { notes: string[] }): React.ReactElement | null {
  return notes.length ? <>{notes.map((note) => <p key={note} className="muted small">{note}</p>)}</> : null;
}

function Selection({ result }: { result: SelectionResult }): React.ReactElement {
  return (
    <div className="card">
      <div className="meta"><strong>{KIND_LABEL[result.kind]}</strong>{result.target && <span className="muted">→ {languageName(result.target)}</span>}<Source source={result.source} cached={result.cached} /></div>
      {result.term
        ? <p><strong>{result.term.term}:</strong> {result.term.definition}</p>
        : <p className="result-text" lang={result.kind === "translate" ? "hi" : undefined}>{result.text}</p>}
      {result.gradeLevel !== undefined && <p className="muted small">About grade {Math.round(result.gradeLevel)}</p>}
      <Notes notes={result.notes} />
      <details><summary>Original text</summary><blockquote className="muted small quote">{result.original}</blockquote></details>
    </div>
  );
}

function ErrorCard({ state, settings, onError }: { state: UnderstandState; onError: (error: string | null) => void } & Pick<SidePanelSectionProps, "settings">): React.ReactElement | null {
  const error = state.error;
  if (!error) return null;
  const retry = async (local = false) => onError(await command({ type: "UNDERSTAND_RETRY", tabId: state.tabId, local }));
  return (
    <div className="card error" role="alert">
      <strong>{KIND_LABEL[error.kind]}: {error.message}</strong>
      <p className="muted">{error.hint}</p>
      {error.kind === "translate" && error.code === "unsupported" && error.selection && (
        <button onClick={() => void retry(true)}>Translate with the local model (lower quality)</button>
      )}
      {error.code === "consent-required" && (
        <ConsentCard hostname={hostnameOf(state.url)} backend={settings.ai.cloudBackend} onDecided={(decision) => { if (decision !== "deny") void retry(); }} />
      )}
    </div>
  );
}

const hostnameOf = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };

/** "Understand this page": TL;DR, glossary underlines, and the last selection result. */
export default function UnderstandPanel({ tab, settings }: SidePanelSectionProps): React.ReactElement {
  const state = useUnderstand(tab?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [tab?.id]);
  const usable = Boolean(tab?.hostname) && /^https?:/.test(tab?.url ?? "");
  const running = state?.running;
  const send = async (message: Record<string, unknown>) => { if (tab) setError(await command({ ...message, tabId: tab.id })); };
  // The plain reading view needs no model: the page builds it from its own main content.
  const plainView = () => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: "SHOW_PLAIN_READER" }, (response?: { ok?: boolean; error?: string }) => {
      if (chrome.runtime.lastError) setError("Could not open the reading view. Reload the page (the extension may have been updated after it loaded).");
      else setError(response?.ok === false ? response.error ?? "Could not open the reading view." : null);
    });
  };

  return (
    <div className="understand-panel">
      <div className="row">
        <button className="primary" disabled={!usable || Boolean(running)} onClick={() => void send({ type: "UNDERSTAND_RUN", kind: "summarize" })}>TL;DR</button>
        {state?.glossary?.shown
          ? <button disabled={!usable} onClick={() => void send({ type: "UNDERSTAND_HIDE", what: "glossary" })}>Hide glossary</button>
          : <button disabled={!usable || Boolean(running)} onClick={() => void send({ type: "UNDERSTAND_RUN", kind: "glossary" })}>Show glossary</button>}
        <button disabled={!usable} onClick={plainView} title="The main content exactly as written, in your reading settings, without the rest of the page. No AI, no summary">Plain reading view</button>
        <button disabled={!usable || Boolean(running)} onClick={() => void send({ type: "UNDERSTAND_RUN", kind: "readingView" })} title="The AI rewrites the main text into short paragraphs and lists, code checks the facts, and (with your consent) the cloud reviews it">Dyslexia reading view</button>
      </div>
      <ul className="muted small help">
        <li><strong>TL;DR</strong>: 3–5 sentence summary of the article, shown at the top of the page.</li>
        <li><strong>Glossary</strong>: the AI picks up to 12 hard words or jargon used in this article (for example "basis points"), underlines them on the page and explains each in plain English. Hover an underlined word, or press Show below, to see its meaning.</li>
        <li><strong>Plain reading view</strong>: the main content exactly as written, in your reading settings, without menus, sidebars or ads. No AI, no summary, instant.</li>
        <li><strong>Dyslexia reading view</strong>: the main text as short paragraphs and lists with a 3-line summary first, checked against the original for changed facts. It opens over the page; the original stays one click away.</li>
        <li><strong>Selection</strong>: select text on the page and press ✨ Understand to explain it simply, define it or translate it to Hindi.</li>
      </ul>
      <p className="muted small">The page's own text is never changed.</p>
      {!usable && <p className="muted">Open a regular web page to use these.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {running && (
        <div className="card" aria-live="polite">
          <div className="stage"><span className="spinner" aria-hidden="true" />{KIND_LABEL[running.kind]}: {running.stage}</div>
          <button onClick={() => void send({ type: "UNDERSTAND_CANCEL" })}>Cancel</button>
        </div>
      )}
      {state && <ErrorCard state={state} settings={settings} onError={setError} />}
      {state?.summary && (
        <div className="card">
          <div className="meta"><strong>TL;DR</strong><span className="muted">{state.summary.readingMinutes} min read</span><Source source={state.summary.source} cached={state.summary.cached} /></div>
          <ul className="changes">{state.summary.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
          <Notes notes={state.summary.notes} />
          <div className="row">
            <button onClick={() => void send({ type: "UNDERSTAND_HIDE", what: "summary" })}>Hide card on page</button>
            <button onClick={() => void send({ type: "UNDERSTAND_RUN", kind: "summarize", refresh: true })} disabled={Boolean(running)}>Summarise again</button>
          </div>
        </div>
      )}
      {state?.glossary && (
        <details className="card" open={state.glossary.shown}>
          <summary>Glossary ({state.glossary.terms.length} terms){state.glossary.shown ? " · underlined on the page" : ""}</summary>
          <dl className="glossary">
            {state.glossary.terms.map((item) => (
              <React.Fragment key={item.term}>
                <dt>
                  <span>{item.term}</span>
                  {state.glossary!.shown && (item.count
                    ? <><span className="chip">{item.count}× on page</span><button className="link" onClick={() => tab && chrome.tabs.sendMessage(tab.id, { type: "GLOSSARY_REVEAL", term: item.term }, () => void chrome.runtime.lastError)}>Show</button></>
                    : <span className="chip" title="The word is in the article text, but split by formatting (for example half of it in bold or a link), so it could not be underlined.">not underlined</span>)}
                </dt>
                <dd>{item.definition}</dd>
              </React.Fragment>
            ))}
          </dl>
          <Source source={state.glossary.source} cached={state.glossary.cached} />
          <Notes notes={state.glossary.notes} />
        </details>
      )}
      {state?.readingView && tab && <ReadingViewCard view={state.readingView} hostname={tab.hostname} settings={settings} send={send} running={Boolean(running)} />}
      {state?.selection && <Selection result={state.selection} />}
    </div>
  );
}

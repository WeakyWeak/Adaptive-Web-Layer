// ─── "Find my reading settings": the reading-fit test UI (P11) ──────────────
// Works with no AI at all: fixed passages, timing in the page, results kept
// in chrome.storage.local only (the last 5 runs, each deletable).

import React, { useEffect, useState } from "react";
import { passageWords } from "../shared/fitPassages";
import {
  DIMENSION_LABEL,
  deleteFitRun,
  fitResult,
  loadFitHistory,
  MAX_ROUNDS,
  replay,
  saveFitRun,
  type FitRun,
  type Rating,
  type RoundResult,
} from "../shared/fitTest";
import FitReader from "./FitReader";
import FitResultView from "./FitResultView";
import "./fit.css";

type Phase = "intro" | "ready" | "reading" | "question" | "rating" | "result";

const RATING_LABEL: Record<Rating, string> = { easier: "Easier", same: "About the same", harder: "Harder" };

function History({ history, onOpen, onDelete }: { history: FitRun[]; onOpen: (run: FitRun) => void; onDelete: (id: string) => void }): React.ReactElement | null {
  if (!history.length) return null;
  return (
    <details className="fit-history">
      <summary>Earlier results ({history.length}, kept on this computer only)</summary>
      <ul>
        {history.map((run) => {
          const result = fitResult(run.rounds);
          return (
            <li key={run.id}>
              <span>{new Date(run.at).toLocaleDateString()}: {result.changes.length ? result.changes.join(", ") : "starting settings"}</span>
              <span className="fit-row">
                <button onClick={() => onOpen(run)}>Show</button>
                <button onClick={() => onDelete(run.id)} aria-label={`Delete the result from ${new Date(run.at).toLocaleString()}`}>Delete</button>
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export default function FitTest(): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("intro");
  const [rounds, setRounds] = useState<RoundResult[]>([]);
  const [rendered, setRendered] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [answer, setAnswer] = useState<boolean | null>(null);
  const [run, setRun] = useState<FitRun | null>(null);
  const [history, setHistory] = useState<FitRun[]>([]);
  useEffect(() => { void loadFitHistory().then(setHistory); }, []);

  const trial = replay(rounds).next;

  const begin = () => { setRounds([]); setRun(null); setRendered(false); setPhase("ready"); };
  const start = () => { setStartedAt(performance.now()); setPhase("reading"); };
  const done = () => { setElapsed(performance.now() - startedAt); setPhase("question"); };
  const commit = async (correct: boolean, rating: Rating | null) => {
    if (!trial) return;
    const next = [...rounds, { passageId: trial.passage.id, settings: trial.settings, dimension: trial.dimension, words: passageWords(trial.passage), ms: Math.round(elapsed), correct, rating }];
    setRounds(next);
    setAnswer(null);
    setRendered(false);
    if (replay(next).next) { setPhase("ready"); return; }
    const finished: FitRun = { id: `${Date.now()}`, at: Date.now(), rounds: next };
    setRun(finished);
    setHistory(await saveFitRun(finished));
    setPhase("result");
  };
  const choose = (index: number) => {
    const correct = index === trial?.passage.question.answer;
    if (rounds.length === 0) void commit(correct, null);
    else { setAnswer(correct); setPhase("rating"); }
  };

  if (phase === "result" && run) {
    return (
      <div className="fit">
        <FitResultView run={run} onRetake={begin} />
        <History history={history} onOpen={(item) => setRun(item)} onDelete={(id) => void deleteFitRun(id).then(setHistory)} />
      </div>
    );
  }

  if (phase === "intro" || !trial) {
    return (
      <div className="fit">
        <p>Read up to {MAX_ROUNDS} short passages, each in slightly different settings (font, size, letter spacing, background, line spacing). After each one, answer one question. It takes about 5 minutes.</p>
        <p className="fit-muted">The test times how fast you read with understanding and keeps what works best for you. No font or colour helps every reader, so it measures instead of guessing. Results stay on this computer; nothing is sent anywhere, and no AI is used.</p>
        <p className="fit-muted">The first passage shows plain starting settings. Where those win, sites keep their own font, size or line spacing; only what you changed is applied.</p>
        <div className="fit-row"><button className="primary" onClick={begin}>Start the test</button></div>
        <History history={history} onOpen={(item) => { setRun(item); setPhase("result"); }} onDelete={(id) => void deleteFitRun(id).then(setHistory)} />
      </div>
    );
  }

  return (
    <div className="fit">
      <div className="fit-progress">
        <span>Round {trial.round + 1} of up to {MAX_ROUNDS}</span>
        <span className="fit-muted">{trial.round === 0 ? "starting settings" : `trying a different ${DIMENSION_LABEL[trial.dimension]}`}</span>
      </div>
      {(phase === "ready" || phase === "reading") && (
        <>
          <FitReader passage={trial.passage} settings={trial.settings} hidden={phase === "ready"} onRendered={() => setRendered(true)} />
          <div className="fit-row">
            {phase === "ready"
              ? <button className="primary" disabled={!rendered} onClick={start}>Start reading</button>
              : <button className="primary" onClick={done}>Done</button>}
            <span className="fit-muted">{phase === "ready" ? "Read at your normal pace, then press Done." : "Timing…"}</span>
          </div>
        </>
      )}
      {phase === "question" && (
        <fieldset className="fit-question">
          <legend>{trial.passage.question.prompt}</legend>
          {trial.passage.question.options.map((option, index) => (
            <button key={option} onClick={() => choose(index)}>{option}</button>
          ))}
        </fieldset>
      )}
      {phase === "rating" && answer !== null && (
        <fieldset className="fit-question">
          <legend>Did this passage feel easier or harder to read than the one before?</legend>
          {(["easier", "same", "harder"] as const).map((rating) => (
            <button key={rating} onClick={() => void commit(answer, rating)}>{RATING_LABEL[rating]}</button>
          ))}
        </fieldset>
      )}
      <div className="fit-row"><button className="link" onClick={() => setPhase("intro")}>Stop the test</button></div>
    </div>
  );
}

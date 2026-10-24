import React, { useState } from "react";
import { fitProfile, fitResult, type FitRun } from "../shared/fitTest";
import { loadSettings, saveSettings } from "../shared/storage";

/** "You read about X% faster with …", honestly worded, with Save as profile and Retake. */
export default function FitResultView({ run, onRetake }: { run: FitRun; onRetake: () => void }): React.ReactElement {
  const result = fitResult(run.rounds);
  const [name, setName] = useState("My reading settings");
  const [status, setStatus] = useState<string | null>(null);
  const changed = result.changes.length > 0;
  const headline = !changed
    ? "Your starting settings read best in this test."
    : result.fasterPercent === null
      ? `These settings did best in the rounds that counted: ${result.changes.join(", ")}.`
      : result.fasterPercent > 0
        ? `You read about ${result.fasterPercent}% faster with ${result.changes.join(", ")}.`
        : `You preferred ${result.changes.join(", ")}: it felt easier, at about the same speed.`;

  const save = async () => {
    const settings = await loadSettings();
    const trimmed = name.trim() || "My reading settings";
    if (settings.profiles.some((profile) => profile.name.toLowerCase() === trimmed.toLowerCase())) { setStatus(`A profile named "${trimmed}" already exists; pick another name.`); return; }
    const profile = fitProfile(result, `fit-${run.id}`, trimmed);
    const ok = await saveSettings({ ...settings, profiles: [...settings.profiles, profile], activeProfileId: profile.id });
    setStatus(ok ? `Saved as "${trimmed}" and turned on for every site. Change it anytime in Settings → Profiles.` : "Could not save the profile.");
  };

  return (
    <div className="fit-result" aria-live="polite">
      <strong className="fit-headline">{headline}</strong>
      {result.baselineWpm !== null && result.bestWpm !== null && changed && (
        <p className="fit-muted">Starting settings: {Math.round(result.baselineWpm)} words a minute · best settings: {Math.round(result.bestWpm)} words a minute.</p>
      )}
      <p className="fit-muted">
        {result.counted} of {result.rounds} rounds counted (a wrong answer or a skipped passage does not count for speed).
        Short tests are noisy, so treat this as a starting point and retake it anytime. It measures what helps you read; it is not a diagnosis.
      </p>
      <div className="fit-row">
        <input aria-label="Profile name" value={name} maxLength={64} onChange={(event) => { setName(event.target.value); setStatus(null); }} />
        <button className="primary" onClick={() => void save()}>Save as my profile</button>
        <button onClick={onRetake}>Retake</button>
      </div>
      {status && <p className="fit-muted" role="status">{status}</p>}
    </div>
  );
}

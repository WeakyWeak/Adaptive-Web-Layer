import React, { useState } from "react";
import { SARVAM_NOTICE } from "../shared/languages";
import type { Settings } from "../shared/settings";

type Decision = "allow-once" | "allow-site" | "deny";

const BACKEND_NOTICE: Record<Settings["ai"]["cloudBackend"], string> = {
  gemini: "Google's free-tier Gemini service may retain inputs, use them to improve models, and allow human review.",
  anthropic: "Anthropic's API processes the request under your API account's data-retention terms.",
  openai: "The OpenAI-compatible provider set in server/.env processes the request under its own data terms.",
};

const PROVIDER_NAME: Record<Settings["ai"]["cloudBackend"], string> = { gemini: "Google (Gemini)", anthropic: "Anthropic (Claude)", openai: "the OpenAI-compatible provider in server/.env" };

/** Asks before any page data leaves the machine; states exactly what is sent. */
export default function ConsentCard({ hostname, backend, onDecided }: {
  hostname: string;
  backend: Settings["ai"]["cloudBackend"];
  onDecided: (decision: Decision) => void;
}): React.ReactElement {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(false);

  const decide = (decision: Decision) => {
    setSaving(true);
    chrome.runtime.sendMessage({ type: "SET_CLOUD_CONSENT", hostname, decision, text: decision === "deny" ? false : text }, (response?: { ok?: boolean }) => {
      setSaving(false);
      if (chrome.runtime.lastError || !response?.ok) { setError("Could not save your choice."); return; }
      onDecided(decision);
    });
  };

  return (
    <section className="consent" aria-label="Cloud consent">
      <h3>Use cloud AI on {hostname}?</h3>
      <p>Nothing has left your computer yet. If you allow it, your local proxy sends this to {PROVIDER_NAME[backend]} (or to Sarvam for translation):</p>
      <ul className="consent-list">
        <li><strong>Page commands:</strong> your command, your reading settings and an outline of the page (title, headings, up to 60 page parts with their class names and first ~80 characters).</li>
        <li><strong>Reviews of the local AI's draft:</strong> the draft, code measurements, the same outline, and two screenshots of the visible part of the page (before and after).</li>
        <li><strong>TL;DR, glossary, selection tools:</strong> the article text or your selection, with code, links, emails and identifiers replaced.</li>
        <li>Never what you typed into forms.</li>
      </ul>
      <label className="consent-option">
        <input type="checkbox" checked={text} onChange={(event) => setText(event.target.checked)} />
        <span>
          <strong>Also share page text with the reviewer</strong>
          <span className="muted small">Optional. Lets the cloud check that “Explain simply” kept every number, name and “not”. Without it, only the code checks run.</span>
        </span>
      </label>
      <p className="muted small">{BACKEND_NOTICE[backend]} {SARVAM_NOTICE}</p>
      <div className="row">
        <button className="primary" disabled={saving} onClick={() => decide("allow-once")}>Allow once</button>
        <button disabled={saving} onClick={() => decide("allow-site")}>Allow for this site</button>
        <button disabled={saving} onClick={() => decide("deny")}>Deny</button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

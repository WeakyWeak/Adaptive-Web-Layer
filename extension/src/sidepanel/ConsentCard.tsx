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
      <p>
        Page commands send your command, your current reading settings and a short summary of the page
        (title, headings, counts of images/tables/code, and up to 60 page blocks such as banners
        and sidebars with their class names and first ~80 characters of text).
        TL;DR, glossary and selection actions send the article's main text or the text you selected, with code,
        links, emails and identifiers replaced by placeholders.
        Reviews of the local AI's draft send the draft, code measurements, the same page blocks and two screenshots
        of the visible part of the page (before and after, with numbered boxes).
        It goes to your local proxy and then to {PROVIDER_NAME[backend]}, or to Sarvam for translation.
        Form values are never sent.
      </p>
      <label className="row small">
        <input type="checkbox" checked={text} onChange={(event) => setText(event.target.checked)} />
        Also let the reviewer read page text excerpts, to check that simplified text kept every fact (off by default)
      </label>
      <p>{BACKEND_NOTICE[backend]} {SARVAM_NOTICE}</p>
      <div className="row">
        <button className="primary" disabled={saving} onClick={() => decide("allow-once")}>Allow once</button>
        <button disabled={saving} onClick={() => decide("allow-site")}>Allow for this site</button>
        <button disabled={saving} onClick={() => decide("deny")}>Deny</button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

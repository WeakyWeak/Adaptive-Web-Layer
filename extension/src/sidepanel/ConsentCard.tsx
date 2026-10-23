import React, { useState } from "react";
import { SARVAM_NOTICE } from "../shared/languages";
import type { Settings } from "../shared/settings";

type Decision = "allow-once" | "allow-site" | "deny";

const BACKEND_NOTICE: Record<Settings["ai"]["cloudBackend"], string> = {
  gemini: "Google's free-tier Gemini service may retain inputs, use them to improve models, and allow human review.",
  anthropic: "Anthropic's API processes the request under your API account's data-retention terms.",
};

/** Asks before any page data leaves the machine; states exactly what is sent. */
export default function ConsentCard({ hostname, backend, onDecided }: {
  hostname: string;
  backend: Settings["ai"]["cloudBackend"];
  onDecided: (decision: Decision) => void;
}): React.ReactElement {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = (decision: Decision) => {
    setSaving(true);
    chrome.runtime.sendMessage({ type: "SET_CLOUD_CONSENT", hostname, decision }, (response?: { ok?: boolean }) => {
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
        links, emails and identifiers replaced by placeholders. It goes to your local proxy and then to{" "}
        {backend === "anthropic" ? "Anthropic (Claude)" : "Google (Gemini)"}, or to Sarvam for translation.
        Form values and screenshots are never sent.
      </p>
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

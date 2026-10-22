import React, { useState } from "react";
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
        This sends your command, your current reading settings and a short summary of the page
        (title, headings, counts of images/tables/code) to your local proxy and then to{" "}
        {backend === "anthropic" ? "Anthropic (Claude)" : "Google (Gemini)"}. It does not send form values, selected text or screenshots.
      </p>
      <p>{BACKEND_NOTICE[backend]}</p>
      <div className="row">
        <button className="primary" disabled={saving} onClick={() => decide("allow-once")}>Allow once</button>
        <button disabled={saving} onClick={() => decide("allow-site")}>Allow for this site</button>
        <button disabled={saving} onClick={() => decide("deny")}>Deny</button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

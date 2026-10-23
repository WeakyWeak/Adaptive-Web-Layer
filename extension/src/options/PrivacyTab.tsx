import React from "react";
import { SARVAM_NOTICE } from "../shared/languages";
import type { Settings } from "../shared/settings";
import { ScreenshotSettings } from "../sidepanel/ScreenshotAccess";

export default function PrivacyTab({ settings, update, clear }: { settings: Settings; update: (settings: Settings) => Promise<void>; clear: () => Promise<void> }): React.ReactElement {
  const revoke = (hostname: string) => {
    const { [hostname]: _removed, ...cloudSiteConsents } = settings.privacy.cloudSiteConsents;
    const { [hostname]: _text, ...cloudTextSites } = settings.privacy.cloudTextSites;
    void update({ ...settings, privacy: { ...settings.privacy, cloudSiteConsents, cloudTextSites } });
  };
  const entries = Object.entries(settings.privacy.cloudSiteConsents);
  return <section className="tab-panel privacy-settings"><h2 className="tab-heading">Privacy &amp; Consent</h2>
    <p>Cloud AI is optional. Before cloud use, Adaptive Web Layer shows exactly which page data the request will send. Gemini free-tier services may retain inputs, use them to improve models, and allow human review. Claude requests are processed under your Anthropic API account terms. In hybrid mode, reviews of the local AI's drafts also send screenshots of the visible page; page text goes to the reviewer only on sites where you ticked it. {SARVAM_NOTICE} Summaries, glossaries and selection results are cached on this computer for 24 hours; Clear all data removes them.</p>
    <h3>Screenshots for reviews</h3>
    <ScreenshotSettings settings={settings} update={update} />
    <h3>Saved site decisions</h3>
    {entries.length === 0 ? <p className="settings-note">No saved cloud consent decisions.</p> : entries.map(([hostname, decision]) => <div className="profile-row" key={hostname}><strong>{hostname}</strong><span>{decision === "allow" ? (settings.privacy.cloudTextSites[hostname] ? "Allowed, incl. page text for reviews" : "Allowed") : "Denied"}</span><button onClick={() => revoke(hostname)}>Revoke</button></div>)}
    <button className="danger-button" onClick={() => void clear()}>Clear all data and caches</button>
    <p className="settings-note">This removes saved preferences, consent decisions, and cached extension data from this browser.</p>
  </section>;
}

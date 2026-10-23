import React, { useState } from "react";
import { requestScreenshotAccess } from "../shared/screenshotAccess";
import type { Settings } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/storage";

async function savePrivacy(patch: Partial<Settings["privacy"]>): Promise<boolean> {
  const settings = await loadSettings();
  return saveSettings({ ...settings, privacy: { ...settings.privacy, ...patch } });
}

/**
 * "Allow screenshots on every site": Chrome asks once. Without it, reviews
 * include screenshots only after the toolbar button or shortcut on that tab.
 */
export function AllowScreenshotsButton({ onDone }: { onDone?: (granted: boolean) => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const allow = async () => {
    setBusy(true);
    // Chrome needs the request inside the click, before any other await.
    const granted = await requestScreenshotAccess();
    if (granted) await savePrivacy({ screenshotsEverySite: true, reviewScreenshots: true });
    setBusy(false);
    setRefused(!granted);
    onDone?.(granted);
  };
  return (
    <span className="screenshot-allow">
      <button disabled={busy} onClick={() => void allow()}>Allow screenshots on every site</button>
      {refused && <span className="refused-note" role="status"> Chrome did not grant it.</span>}
    </span>
  );
}

/** Side panel: offered after a review that had no screenshots, until granted or turned off. */
export function ScreenshotHint({ settings }: { settings: Settings }): React.ReactElement | null {
  if (settings.privacy.screenshotsEverySite || !settings.privacy.reviewScreenshots) return null;
  return (
    <div className="screenshot-hint">
      <p className="small">The reviewer only saw text. With screenshots it can also spot clutter by how the page looks. Chrome will ask you once.</p>
      <AllowScreenshotsButton />
    </div>
  );
}

/** Settings → Privacy: turn screenshots off, or allow them on every site. */
export function ScreenshotSettings({ settings, update }: { settings: Settings; update: (settings: Settings) => Promise<void> }): React.ReactElement {
  const on = settings.privacy.reviewScreenshots;
  return (
    <div className="screenshot-settings">
      <label className="option-row">
        <input type="checkbox" checked={on} onChange={(event) => void update({ ...settings, privacy: { ...settings.privacy, reviewScreenshots: event.target.checked } })} />
        <span>
          <strong>Send screenshots with cloud reviews</strong>
          <span className="settings-note">Two pictures of the visible part of the page (before and after the draft), only on sites where you allowed cloud AI.</span>
        </span>
      </label>
      {on && (settings.privacy.screenshotsEverySite
        ? <p className="settings-note">Allowed on every site. Chrome keeps this permission while the extension is installed; untick the box above to stop sending screenshots.</p>
        : <p className="settings-note">Right now Chrome allows screenshots only after you click the toolbar button on a tab (or press Alt+Shift+F). <AllowScreenshotsButton /></p>)}
    </div>
  );
}

import { normalizeHostname } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/storage";

/** "Allow once" covers one cloud call: clear it after the cloud was really used. */
export async function consumeAllowOnce(hostname: string, usedCloud: boolean): Promise<void> {
  if (!usedCloud) return;
  const latest = await loadSettings();
  if (latest.privacy.cloudAllowOnceFor !== normalizeHostname(hostname)) return;
  await saveSettings({ ...latest, privacy: { ...latest.privacy, cloudAllowOnceFor: undefined } });
}

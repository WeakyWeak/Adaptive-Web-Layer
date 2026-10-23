// ─── Screenshot access for the cloud reviewer (opt-in) ───────────────────────
// Chrome captures a tab only with the explicit "<all_urls>" permission, or
// after the reader invoked the extension on that tab (activeTab: the toolbar
// button or the shortcut). The content script's matches do not count. The
// every-site permission is optional and asked once, from a button. Chrome
// cannot take it back while the content script runs on every site, so the
// reviewScreenshots setting is what turns screenshots off.

const EVERY_SITE: chrome.permissions.Permissions = { origins: ["<all_urls>"] };

/** Ask Chrome for the every-site permission. Must run inside a click handler. */
export async function requestScreenshotAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.request(EVERY_SITE);
  } catch {
    return false;
  }
}

# Permissions

## `activeTab`
Required so the popup can query and communicate with the current active tab.

## `storage`
Required for persisting user preferences, named profiles, per-site overrides, and caches to `chrome.storage.local`. No cloud sync is used.

## `scripting`
Required for dynamic content script injection (used in later phases for on-demand style application and DOM inspection).

## `tabs`
Required for the background service worker to query the list of open tabs and identify the active tab when the popup asks for page info.

## `tts`
Required for the text-to-speech feature (F4/P09). Requested upfront so the user sees it in the install prompt.

## Host permissions: `http://localhost:11434/*`, `http://localhost:*/*`
Required to allow the extension to make requests to the local llama.cpp server (llama-server, port 11434 default) and the local proxy server (added in P06). These are the only external endpoints the extension ever contacts in `local` mode. No production remote URLs are in host permissions — cloud calls are proxied through the local server.

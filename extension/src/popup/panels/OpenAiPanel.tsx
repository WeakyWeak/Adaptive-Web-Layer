import React, { useState } from "react";

/** The AI assistant lives in the side panel, which stays open while you use the page. */
export default function OpenAiPanel(): React.ReactElement {
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    chrome.windows.getCurrent((win) => {
      if (win.id === undefined) return;
      // Must run inside the click (user gesture); the popup then closes itself.
      chrome.sidePanel.open({ windowId: win.id })
        .then(() => window.close())
        .catch((caught: unknown) => setError(String(caught)));
    });
  };
  return (
    <div className="ai-open">
      <p>Describe what you need (“larger text, keep code colours”) and preview the result before saving.</p>
      <button className="btn-primary" onClick={open}>Open AI assistant</button>
      {error && <p className="ai-error-msg">{error}</p>}
    </div>
  );
}

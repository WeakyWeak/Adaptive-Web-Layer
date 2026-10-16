import React, { useEffect, useState } from "react";
import type { PageInfo } from "../shared/messages";
import { panels } from "./panels/index";
import "./popup.css";

export default function App(): React.ReactElement {
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Ask the active tab's content script for page info
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        setError("No active tab");
        return;
      }
      chrome.tabs.sendMessage(
        tab.id,
        { type: "GET_PAGE_INFO" },
        (response) => {
          if (chrome.runtime.lastError) {
            setError(chrome.runtime.lastError.message ?? "Content script unavailable");
            return;
          }
          if (response?.type === "PAGE_INFO" && response.payload) {
            setPageInfo(response.payload as PageInfo);
          } else {
            setError("Unexpected response");
          }
        }
      );
    });
  }, []);

  return (
    <div className="popup-root">
      <header className="popup-header">
        <span className="popup-logo">⬡</span>
        <span className="popup-title">Adaptive Web Layer</span>
      </header>

      <section className="popup-status">
        {error ? (
          <div className="status-badge status-restricted">⚠ {error}</div>
        ) : pageInfo ? (
          <>
            <div className="status-badge status-active">● Extension active</div>
            <div className="page-info">
              <span className="page-hostname">{pageInfo.hostname}</span>
            </div>
          </>
        ) : (
          <div className="status-badge status-loading">Loading…</div>
        )}
      </section>

      {/* Registered panels — empty in P00, phases will add here */}
      {panels.length > 0 && (
        <section className="popup-panels">
          {panels.map(({ id, title, Component }) => (
            <details key={id} className="panel-item">
              <summary className="panel-title">{title}</summary>
              <div className="panel-body">
                <Component />
              </div>
            </details>
          ))}
        </section>
      )}

      <footer className="popup-footer">
        <button
          className="btn-options"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          Settings
        </button>
      </footer>
    </div>
  );
}

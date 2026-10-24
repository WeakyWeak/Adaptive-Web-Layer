import React, { useEffect, useRef, useState } from "react";
import type { FitPassage } from "../shared/fitPassages";
import type { FitSettings } from "../shared/fitTest";

/**
 * The passage, shown in the isolated reader page (an extension iframe) that
 * styles it with the real registry operations. `onRendered` fires once the
 * passage and its fonts are ready, so timing never includes loading.
 */
export default function FitReader({ passage, settings, hidden, onRendered }: {
  passage: FitPassage;
  settings: FitSettings;
  hidden: boolean;
  onRendered: () => void;
}): React.ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const renderId = `${passage.id}:${JSON.stringify(settings)}`;
  const latest = useRef(onRendered);
  latest.current = onRendered;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string; id?: string };
      if (data.type === "FIT_READY") setReady(true);
      if (data.type === "FIT_RENDERED" && data.id === renderId) latest.current();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [renderId]);

  useEffect(() => {
    if (!ready) return;
    frame.current?.contentWindow?.postMessage({ type: "FIT_RENDER", id: renderId, passage: { title: passage.title, paragraphs: passage.paragraphs }, settings }, location.origin);
  }, [ready, renderId, passage, settings]);

  return (
    <div className="fit-reader">
      <iframe ref={frame} title="Reading-fit passage" src={chrome.runtime.getURL("fitreader/index.html")} />
      {hidden && <div className="fit-cover" aria-hidden="true">The passage appears when you press Start.</div>}
    </div>
  );
}

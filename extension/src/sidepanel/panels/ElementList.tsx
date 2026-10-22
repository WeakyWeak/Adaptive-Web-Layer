import React from "react";
import type { AiJob } from "../../shared/aiJob";
import { PROTECT_LABEL, type ElementAction, type ElementItem } from "../../shared/elementPlan";
import { command } from "../hooks";

const ACTION_LABEL: Record<ElementAction, string> = { hide: "Hide", dim: "Dim", highlight: "Highlight" };

/** Outline the element on the page while its item is hovered or focused. */
function outline(tabId: number, id: string | null): void {
  chrome.tabs.sendMessage(tabId, { type: "OUTLINE_ELEMENT", id }, () => void chrome.runtime.lastError);
}

function Item({ item, tabId, editable, onError }: { item: ElementItem; tabId: number; editable: boolean; onError: (error: string | null) => void }): React.ReactElement {
  const toggle = async (enabled: boolean) => onError(await command({ type: "AI_SET_ELEMENT", tabId, id: item.id, enabled }));
  const needsConfirm = editable && item.protect && !item.enabled;
  return (
    <li
      className={`element${needsConfirm ? " pending" : item.enabled ? "" : " off"}`}
      onMouseEnter={() => outline(tabId, item.id)}
      onMouseLeave={() => outline(tabId, null)}
      onFocus={() => outline(tabId, item.id)}
      onBlur={() => outline(tabId, null)}
    >
      <label>
        {editable && <input type="checkbox" checked={item.enabled} onChange={(event) => void toggle(event.target.checked)} aria-label={`${ACTION_LABEL[item.action]} ${item.label}`} />}
        <span className={`badge action-${item.action}`}>{ACTION_LABEL[item.action]}</span>
        <span className="element-label">{item.label}</span>
      </label>
      {needsConfirm && <p className="warning">This is {PROTECT_LABEL[item.protect!]}. Tick it to confirm hiding it.</p>}
    </li>
  );
}

/** The element part of a plan: per-item toggles in preview, read-only once applied. */
export default function ElementList({ job, onError }: { job: AiJob; onError: (error: string | null) => void }): React.ReactElement | null {
  const items = job.elements ?? [];
  const rejected = job.rejectedElements ?? [];
  if (items.length === 0 && rejected.length === 0) return null;
  const editable = job.status === "preview";
  const shown = editable ? items : items.filter((item) => item.enabled);
  const pending = items.filter((item) => item.protect && !item.enabled).length;
  return (
    <div className="elements">
      {shown.length > 0 && <ul className="element-list">{shown.map((item) => <Item key={item.id} item={item} tabId={job.tabId} editable={editable} onError={onError} />)}</ul>}
      {editable && pending > 0 && <p className="muted small">{pending} item{pending === 1 ? " needs" : "s need"} your OK before {pending === 1 ? "it is" : "they are"} hidden. Hover an item to see it on the page.</p>}
      {job.unsaved && job.unsaved.length > 0 && <p className="warning">Could not save {job.unsaved.length} item(s) for later visits (no stable way to find them again): {job.unsaved.join(", ")}.</p>}
      {rejected.length > 0 && (
        <details>
          <summary>Not applied ({rejected.length})</summary>
          <ul className="changes">{rejected.map((item) => <li key={`${item.action}-${item.id}`}>{item.label}: {item.reason}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

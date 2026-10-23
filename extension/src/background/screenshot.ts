// ─── Screenshots for the cloud reviewer (P10) ────────────────────────────────
// The visible viewport only (no full-page stitching), downscaled so the long
// side is ≤ 1280 px, with numbered boxes (Set-of-Mark) drawn on a canvas copy,
// never on the page. Callers only capture in hybrid/cloud mode with consent;
// local mode never reaches this file. Any failure returns null and the review
// goes ahead on text and measurements alone.

import type { ImageInput } from "../shared/llmProvider";
import { MarksSchema } from "../shared/messages";
import { tabMessage } from "./tabs";

export const MAX_SIDE = 1280;
// Chrome allows two captureVisibleTab calls per second.
const MIN_GAP_MS = 600;
let lastCapture = 0;

export interface Mark { id: string; x: number; y: number; w: number; h: number }
export interface DrawnMark extends Mark { colour: string; label: { x: number; y: number; w: number; h: number } }

const DRAFT_COLOUR = "#d62828";
const OTHER_COLOUR = "#1d4ed8";

/**
 * Box and label positions in image pixels. `scale` maps CSS px to image px.
 * Draft items (what the local model wants to change) are red, the rest blue.
 */
export function layoutMarks(marks: readonly Mark[], scale: number, imageWidth: number, imageHeight: number, draft: ReadonlySet<string>): DrawnMark[] {
  return marks.map((mark) => {
    const x = Math.round(mark.x * scale);
    const y = Math.round(mark.y * scale);
    const w = Math.max(1, Math.round(mark.w * scale));
    const h = Math.max(1, Math.round(mark.h * scale));
    const labelW = 8 + mark.id.length * 9;
    // The label sits inside the box's top-left corner, clamped to the image.
    const label = { x: Math.min(Math.max(0, x), imageWidth - labelW), y: Math.min(Math.max(0, y), imageHeight - 18), w: labelW, h: 18 };
    return { ...mark, x, y, w, h, colour: draft.has(mark.id) ? DRAFT_COLOUR : OTHER_COLOUR, label };
  });
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/**
 * Screenshot of the tab with numbered boxes on the given blocks. The tab must
 * be the active tab of its window (captureVisibleTab captures whatever is
 * shown); otherwise there is no screenshot.
 */
export async function captureWithMarks(tabId: number, ids: readonly string[], draft: ReadonlySet<string>): Promise<ImageInput | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || tab.windowId === undefined) return null;
    const parsed = MarksSchema.safeParse(await tabMessage(tabId, { type: "GET_MARKS", ids: ids.slice(0, 60) }));
    const wait = lastCapture + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCapture = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const shrink = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * shrink), Math.round(bitmap.height * shrink));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (parsed.success && parsed.data.width > 0) {
      const scale = canvas.width / parsed.data.width;
      context.font = "bold 13px sans-serif";
      context.textBaseline = "top";
      for (const mark of layoutMarks(parsed.data.marks, scale, canvas.width, canvas.height, draft)) {
        context.lineWidth = 3;
        context.strokeStyle = mark.colour;
        context.strokeRect(mark.x + 1.5, mark.y + 1.5, Math.max(1, mark.w - 3), Math.max(1, mark.h - 3));
        context.fillStyle = mark.colour;
        context.fillRect(mark.label.x, mark.label.y, mark.label.w, mark.label.h);
        context.fillStyle = "#ffffff";
        context.fillText(mark.id, mark.label.x + 4, mark.label.y + 3);
      }
    }
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
    return { mimeType: "image/jpeg", data: await toBase64(blob) };
  } catch (error) {
    console.debug("[AWL] screenshot skipped:", error);
    return null;
  }
}

// Screenshots shown in the side panel's before/after view: session storage,
// one record per tab, removed with the job.
export const SHOTS_KEY_PREFIX = "awl_shots_";
export const shotsKey = (tabId: number): string => `${SHOTS_KEY_PREFIX}${tabId}`;

export async function saveShots(tabId: number, shots: { before?: ImageInput | null; after?: ImageInput | null }): Promise<boolean> {
  const url = (image?: ImageInput | null) => (image ? `data:${image.mimeType};base64,${image.data}` : undefined);
  if (!shots.before && !shots.after) return false;
  await chrome.storage.session.set({ [shotsKey(tabId)]: { before: url(shots.before), after: url(shots.after) } });
  return true;
}

export function clearShots(tabId: number): Promise<void> {
  return chrome.storage.session.remove(shotsKey(tabId));
}

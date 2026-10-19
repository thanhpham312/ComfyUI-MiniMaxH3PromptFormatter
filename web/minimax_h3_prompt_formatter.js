import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "MiniMaxH3PromptFormatter";
const TASK_TYPES = [
  "keyframe completion",
  "reference generation",
  "video editing",
  "video continuation",
  "audio reuse",
  "audio reference",
];
const RETENTION_MARKERS = [
  "fully_preserved",
  "partially_preserved",
  "attribute_transfer",
  "weak_reference",
];
const AUDIO_RETENTION_MARKERS = [
  "fully_copy",
  "partially_copy",
  "reference",
  "weak_reference",
];
const SEC_OPTIONS = Array.from({ length: 16 }, (_, i) => i);
const MS_OPTIONS = Array.from({ length: 10 }, (_, i) => i * 100);

const DEFAULT_STATE = {
  pictures: {},
  videos: {},
  audios: {},
  subjects: [],
  summary: {
    task_types: Object.fromEntries(
      TASK_TYPES.map((t) => [t, t === "reference generation"])
    ),
    text: "",
  },
  retention: [],
  style_opening: "",
  shots: [],
  overall_soundscape: "",
  non_diegetic_music: { enabled: false, text: "" },
  // Last assembled prompt text — kept across workflow load / node updates.
  saved_prompt: "",
};

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function normalizeRefRole(role) {
  const r = String(role || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (r === "storyboard" || r === "storyboard_reference" || r === "storyboard_ref") {
    return "storyboard";
  }
  return "first_frame";
}

function normalizeShotReferences(shot) {
  const raw = Array.isArray(shot?.references) ? shot.references : null;
  const refs = [];
  const seen = new Set();
  if (raw && raw.length) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const pid = parseInt(item.picture_id, 10);
      if (!Number.isFinite(pid) || seen.has(pid)) continue;
      seen.add(pid);
      refs.push({ picture_id: pid, role: normalizeRefRole(item.role) });
    }
  } else {
    let picture_id = shot?.picture_id;
    if (picture_id === "" || picture_id == null) picture_id = null;
    else picture_id = parseInt(picture_id, 10);
    if (Number.isFinite(picture_id)) {
      refs.push({ picture_id, role: "first_frame" });
    }
  }
  // At most one first_frame and one storyboard per shot.
  let first = null;
  let board = null;
  for (const ref of refs) {
    if (ref.role === "first_frame") {
      if (!first) first = ref;
      else if (!board && ref.picture_id !== first.picture_id) {
        board = { picture_id: ref.picture_id, role: "storyboard" };
      }
    } else if (!board) {
      if (!first || ref.picture_id !== first.picture_id) board = ref;
    }
  }
  const out = [];
  if (first) out.push(first);
  if (board) out.push(board);
  return out;
}

function anyShotHasFirstFrame(shots) {
  return (shots || []).some((shot) =>
    normalizeShot(shot).references.some((r) => r.role === "first_frame")
  );
}

function syncDerivedFlags(state) {
  if (anyShotHasFirstFrame(state.shots)) {
    state.summary.task_types["keyframe completion"] = true;
  }
  const firstFrameIds = new Set();
  for (const shot of state.shots || []) {
    for (const ref of normalizeShot(shot).references || []) {
      if (ref.role === "first_frame") firstFrameIds.add(ref.picture_id);
    }
  }
  for (const entry of state.retention || []) {
    if (entry.kind === "picture" && firstFrameIds.has(entry.pictureId)) {
      entry.enabled = true;
    }
  }
  applyAutoRetentionContext(state);
}

function shotFirstFramePictureId(shot) {
  for (const ref of shot?.references || []) {
    if (ref.role === "first_frame") return ref.picture_id;
  }
  return null;
}

function joinShotLabels(indices) {
  const labels = (indices || []).map((i) => `[Shot ${i}]`);
  if (!labels.length) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function pictureRoleShots(pictureId, shots) {
  const firstFrames = [];
  const storyboards = [];
  (shots || []).forEach((shot, i) => {
    const n = i + 1;
    for (const ref of normalizeShot(shot).references || []) {
      if (ref.picture_id !== pictureId) continue;
      if (ref.role === "storyboard") {
        if (!storyboards.includes(n)) storyboards.push(n);
      } else if (!firstFrames.includes(n)) {
        firstFrames.push(n);
      }
    }
  });
  return { firstFrames, storyboards };
}

function formatPictureLine(index, text, firstFrameShots, storyboardShots) {
  const t = String(text || "").trim();
  const first = firstFrameShots || [];
  const boards = storyboardShots || [];
  if (t.toLowerCase().startsWith("<picture")) return asSentence(t);
  if (first.length || boards.length) {
    const clauses = [];
    if (first.length) clauses.push(`the first frame of ${joinShotLabels(first)}`);
    if (boards.length) {
      clauses.push(`a storyboard reference for ${joinShotLabels(boards)}`);
    }
    const role = clauses.join(" and ");
    if (t) {
      if (first.length && !boards.length) {
        return asSentence(`<Picture ${index}> is ${role}, showing ${asClause(t)}`);
      }
      return asSentence(`<Picture ${index}> is ${role}, ${asClause(t)}`);
    }
    return asSentence(`<Picture ${index}> is ${role}`);
  }
  if (!t) return null;
  return `<Picture ${index}> is ${asSentence(t)}`;
}

function normalizeShot(shot) {
  if (!shot || typeof shot !== "object") {
    return {
      references: [],
      subject_ids: [],
      events: [{ sec: 0, ms: 0, text: "", enabled: true }],
    };
  }
  let events = Array.isArray(shot.events) ? shot.events : null;
  if (!events || !events.length) {
    events = [{ sec: 0, ms: 0, text: shot.text || "", enabled: true }];
  }
  events = events.map((ev) => {
    let sec = parseInt(ev?.sec ?? 0, 10);
    let ms = parseInt(ev?.ms ?? 0, 10);
    if (!Number.isFinite(sec)) sec = 0;
    if (!Number.isFinite(ms)) ms = 0;
    sec = Math.max(0, Math.min(15, sec));
    ms = Math.max(0, Math.min(900, Math.floor(ms / 100) * 100));
    return {
      sec,
      ms,
      text: ev?.text || "",
      enabled: ev?.enabled !== false,
    };
  });
  const subject_ids = [
    ...new Set(
      (shot.subject_ids || [])
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n))
    ),
  ].sort((a, b) => a - b);
  return {
    references: normalizeShotReferences(shot),
    subject_ids,
    events,
  };
}

function parseState(raw) {
  const base = deepClone(DEFAULT_STATE);
  if (!raw) return base;
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return base;
    }
  }
  if (!data || typeof data !== "object") return base;
  base.pictures = data.pictures || {};
  base.videos = data.videos || {};
  base.audios = data.audios || {};
  base.subjects = Array.isArray(data.subjects) ? data.subjects : [];
  base.summary.text = data.summary?.text || "";
  for (const t of TASK_TYPES) {
    if (data.summary?.task_types && t in data.summary.task_types) {
      base.summary.task_types[t] = !!data.summary.task_types[t];
    }
  }
  base.retention = Array.isArray(data.retention) ? data.retention : [];
  base.style_opening =
    typeof data.style_opening === "string" ? data.style_opening : "";
  base.shots = Array.isArray(data.shots) ? data.shots.map(normalizeShot) : [];
  base.overall_soundscape = data.overall_soundscape || "";
  base.non_diegetic_music = {
    enabled: !!data.non_diegetic_music?.enabled,
    text: data.non_diegetic_music?.text || "",
  };
  base.saved_prompt =
    typeof data.saved_prompt === "string" ? data.saved_prompt : "";
  return base;
}

function injectStyles() {
  let style = document.getElementById("mmh3-prompt-formatter-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "mmh3-prompt-formatter-styles";
    document.head.appendChild(style);
  }
  style.textContent = `
.mmh3-root {
  font-family: Inter, system-ui, sans-serif;
  font-size: 12px;
  color: var(--fg-color, #ddd);
  background: var(--bg-color, #1e1e1e);
  border: 1px solid var(--border-color, #444);
  border-radius: 6px;
  padding: 8px;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}
.mmh3-root * { box-sizing: border-box; }
.mmh3-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  border-bottom: 1px solid #333;
  padding-bottom: 6px;
  flex-shrink: 0;
}
.mmh3-tab {
  background: #2a2a2a !important;
  border: 1px solid #444 !important;
  color: #ccc !important;
  border-radius: 4px 4px 0 0 !important;
  padding: 5px 10px !important;
  cursor: pointer;
}
.mmh3-tab.active {
  background: #3a4a5a !important;
  border-color: #6af !important;
  color: #fff !important;
}
.mmh3-panel {
  display: none;
  flex: 1 1 auto;
  min-height: 0;
  padding: 6px 2px;
  overflow: hidden;
}
.mmh3-panel.active {
  display: flex;
  flex-direction: column;
}
/* Inner body fills the panel and scrolls (all tabs). */
.mmh3-panel > div {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
/* Preview: scroll inside the <pre>, not the whole panel chrome. */
.mmh3-panel[data-tab="preview"] > div {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}
.mmh3-panel[data-tab="preview"] .mmh3-muted {
  flex-shrink: 0;
}
.mmh3-panel[data-tab="debug"] > div {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}
.mmh3-panel[data-tab="debug"] .mmh3-debug-json {
  flex: 1 1 auto;
  min-height: 120px;
  max-height: none;
  overflow: auto;
}
.mmh3-panel[data-tab="debug"] .mmh3-toolbar,
.mmh3-panel[data-tab="debug"] .mmh3-muted {
  flex-shrink: 0;
}
.mmh3-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-top: 8px;
}
.mmh3-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 4px;
  background: #111;
  border: 1px solid #444;
  flex-shrink: 0;
}
.mmh3-thumb-sm {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 3px;
  background: #111;
  border: 1px solid #444;
  flex-shrink: 0;
}
.mmh3-thumb-placeholder {
  width: 56px;
  height: 56px;
  border-radius: 4px;
  background: #2a2a2a;
  border: 1px dashed #555;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #888;
  font-size: 10px;
  text-align: center;
  flex-shrink: 0;
}
.mmh3-thumb-placeholder.sm {
  width: 36px;
  height: 36px;
  font-size: 9px;
}
.mmh3-label {
  font-weight: 600;
  color: #9cdcfe;
  margin-bottom: 4px;
}
.mmh3-grow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.mmh3-retention {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid #333;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mmh3-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
  cursor: pointer;
  color: #ccc;
}
.mmh3-root textarea,
.mmh3-root input[type="text"],
.mmh3-root select {
  width: 100%;
  background: #111;
  color: #ddd;
  border: 1px solid #444;
  border-radius: 3px;
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  line-height: 1.45;
  resize: vertical;
}
.mmh3-root select.mmh3-time { width: auto; min-width: 64px; }
.mmh3-root textarea { min-height: 112px; }
.mmh3-root input[type="text"] { min-height: 36px; }
.mmh3-root button {
  background: #333;
  color: #eee;
  border: 1px solid #555;
  border-radius: 3px;
  padding: 4px 8px;
  cursor: pointer;
  font: inherit;
}
.mmh3-root button:hover { background: #444; }
.mmh3-root button.danger { border-color: #833; color: #f88; }
.mmh3-ref-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  margin-top: 4px;
}
.mmh3-ref-slot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 88px;
}
.mmh3-ref-chip {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 88px;
  padding: 4px;
  border: 1px solid #444;
  border-radius: 4px;
  background: #1a1a1a;
  position: relative;
}
.mmh3-ref-chip .mmh3-ref-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  padding: 0 !important;
  line-height: 14px;
  font-size: 11px;
  border-radius: 2px !important;
  background: #422 !important;
  border-color: #833 !important;
  color: #f88 !important;
}
.mmh3-ref-chip > span {
  font-size: 10px;
  color: #9cdcfe;
  line-height: 1.2;
  text-align: center;
}
.mmh3-ref-add {
  width: 56px;
  height: 56px;
  padding: 0 !important;
  border: 1px dashed #555 !important;
  border-radius: 4px !important;
  background: #2a2a2a !important;
  color: #aaa !important;
  font-size: 22px !important;
  line-height: 1 !important;
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}
.mmh3-ref-add:hover {
  border-color: #6af !important;
  color: #fff !important;
  background: #243040 !important;
}
.mmh3-ref-picker {
  margin-top: 6px;
  padding: 6px;
  border: 1px solid #444;
  border-radius: 4px;
  background: #161616;
}
.mmh3-pic-opt {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 72px;
  padding: 4px;
  border: 1px solid #444;
  border-radius: 4px;
  background: #1a1a1a;
  cursor: pointer;
  text-align: center;
  white-space: normal;
}
.mmh3-pic-opt.selected {
  border-color: #6af;
  background: #243040;
}
.mmh3-pic-opt input { margin: 0; }
.mmh3-pic-opt span { font-size: 10px; color: #9cdcfe; line-height: 1.2; }
.mmh3-toolbar {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.mmh3-muted { color: #888; font-size: 11px; margin-top: 4px; }
.mmh3-entry {
  border-top: 1px solid #333;
  padding-top: 8px;
  margin-top: 8px;
}
.mmh3-entry:first-of-type { border-top: none; padding-top: 0; }
.mmh3-shot-box {
  border: 1px solid #4a5568;
  border-radius: 6px;
  padding: 10px;
  margin-top: 10px;
  background: rgba(255,255,255,0.03);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.25);
}
.mmh3-shot-box:first-of-type { margin-top: 8px; }
.mmh3-event-row {
  display: flex;
  gap: 6px;
  align-items: stretch;
  margin-top: 6px;
}
.mmh3-event-row.disabled {
  opacity: 0.45;
}
.mmh3-event-row.drag-over {
  outline: 1px dashed #6af;
  outline-offset: 2px;
  border-radius: 4px;
}
.mmh3-event-controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  padding-top: 4px;
  flex-shrink: 0;
}
.mmh3-event-controls .mmh3-drag-handle {
  width: 22px;
  height: 22px;
  padding: 0 !important;
  line-height: 1;
  font-size: 14px;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.mmh3-event-controls .mmh3-drag-handle:active { cursor: grabbing; }
.mmh3-event-controls input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  cursor: pointer;
}
.mmh3-event {
  flex: 1;
  min-width: 0;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 6px;
  background: rgba(255,255,255,0.02);
}
.mmh3-time-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.mmh3-preview {
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  background: #0d0d0d;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 8px;
  flex: 1 1 auto;
  min-height: 120px;
  max-height: none;
  overflow: auto;
  margin: 0;
  color: #ccc;
}
.mmh3-debug-json {
  width: 100%;
  min-height: 120px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.35;
  resize: none;
}
.mmh3-ac-wrap {
  position: relative;
  width: 100%;
}
.mmh3-ac-menu {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 50;
  max-height: 160px;
  overflow: auto;
  background: #1a1a1a;
  border: 1px solid #5a7a9a;
  border-radius: 4px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.45);
  display: none;
}
.mmh3-ac-menu.open { display: block; }
.mmh3-ac-item {
  padding: 5px 8px;
  cursor: pointer;
  color: #ddd;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}
.mmh3-ac-item small {
  display: block;
  color: #888;
  font-family: Inter, system-ui, sans-serif;
  font-size: 10px;
  margin-top: 1px;
}
.mmh3-ac-item.active,
.mmh3-ac-item:hover {
  background: #2a4058;
  color: #fff;
}
`;
}

const STATE_PROP = "mmh3_prompt_state";
const SAVED_PROMPT_PROP = "mmh3_saved_prompt";

function writePromptState(node, widget, json) {
  if (!node.properties) node.properties = {};
  node.properties[STATE_PROP] = json;
  try {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    if (parsed && typeof parsed.saved_prompt === "string") {
      node.properties[SAVED_PROMPT_PROP] = parsed.saved_prompt;
    }
  } catch (_) {
    /* ignore */
  }
  if (!widget) return;
  try {
    widget.value = json;
  } catch (_) {
    /* ignore broken setters */
  }
  const ta = widget.element || widget.inputEl;
  if (ta && "value" in ta) ta.value = json;
}

function looksLikePromptState(raw) {
  if (raw == null || raw === "") return false;
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  return !!(data && typeof data === "object" && ("summary" in data || "shots" in data));
}

function promptStateRichness(raw) {
  const s = parseState(raw);
  let n = 0;
  if (s.summary?.text) n += 3;
  n += Object.values(s.summary?.task_types || {}).filter(Boolean).length;
  n += (s.subjects || []).length * 2;
  for (const sub of s.subjects || []) {
    if (sub?.text) n += 2;
  }
  n += (s.shots || []).length * 2;
  for (const shot of s.shots || []) {
    if (shot?.text) n += 2;
    n += (shot?.events || []).length;
    n += (shot?.references || []).length;
    if (shot?.picture_id) n += 1;
  }
  if ((s.style_opening || "").trim()) n += 3;
  n += (s.retention || []).filter((e) => e?.text || e?.enabled).length;
  if (s.overall_soundscape) n += 2;
  if (s.non_diegetic_music?.text) n += 2;
  n += Object.keys(s.pictures || {}).length;
  // A long saved prompt is strong evidence of a real workflow snapshot.
  if ((s.saved_prompt || "").trim().length > 80) n += 8;
  return n;
}

/** Prefer the richest valid snapshot (properties / widget / widgets_values). */
function resolveSavedPromptState(node, stateWidget, info) {
  const candidates = [
    info?.properties?.[STATE_PROP],
    node?.properties?.[STATE_PROP],
    stateWidget?.value,
    stateWidget?.element?.value,
    stateWidget?.inputEl?.value,
  ];
  const wv = info?.widgets_values;
  if (Array.isArray(wv)) {
    for (const v of wv) candidates.push(v);
  }

  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    if (!looksLikePromptState(c)) continue;
    let json = typeof c === "string" ? c : JSON.stringify(c);
    // If this snapshot lacks saved_prompt, graft from dedicated property.
    const grafted = info?.properties?.[SAVED_PROMPT_PROP] || node?.properties?.[SAVED_PROMPT_PROP];
    if (grafted && typeof grafted === "string" && grafted.trim()) {
      try {
        const obj = JSON.parse(json);
        if (!obj.saved_prompt) {
          obj.saved_prompt = grafted;
          json = JSON.stringify(obj);
        }
      } catch (_) {
        /* ignore */
      }
    }
    const score = promptStateRichness(json);
    if (score > bestScore) {
      best = json;
      bestScore = score;
    }
  }
  return best ?? stateWidget?.value ?? JSON.stringify(DEFAULT_STATE);
}

function isSparsePreview(text) {
  const t = (text || "").trim();
  if (!t) return true;
  const noneCount = (t.match(/\(none\)/g) || []).length;
  const hasShot = /\[Shot\s+\d+\]/i.test(t);
  const hasSubjectDef = /<Subject\s+\d+>\s+is\s+(?!an undefined)/i.test(t);
  const hasSummaryBody = /\]\s+\S/.test(t); // "[prefix] something"
  return noneCount >= 3 && !hasShot && !hasSubjectDef && !hasSummaryBody;
}

function hideWidget(widget) {
  if (!widget) return;
  // Hide visually but KEEP serialization — "converted-widget" / disabled
  // can drop the value from saved workflows.
  widget.computeSize = () => [0, -4];
  widget.hidden = true;
  if (widget.options) widget.options.hidden = true;
  else widget.options = { hidden: true };
  // Must remain serializable for workflow + API prompt.
  widget.serialize = true;
  widget.options.serialize = true;
  if (widget.type === "converted-widget") {
    widget.type = "customtext";
  }
  if (widget.element) {
    widget.element.style.display = "none";
    widget.element.style.height = "0";
    widget.element.style.overflow = "hidden";
    widget.element.style.position = "absolute";
    widget.element.style.pointerEvents = "none";
  }
  if (widget.inputEl) {
    widget.inputEl.style.display = "none";
    widget.inputEl.style.height = "0";
  }
}

function getRefInputsByKind(node, kind) {
  // kind: "image" | "video" | "video_audio" | "audio"
  return (node.inputs || [])
    .filter((i) => {
      if (!i?.name) return false;
      const n = i.name;
      if (kind === "image") {
        return (
          /^ref_image_\d+$/.test(n) ||
          n.includes(".ref_image_") ||
          /^ref_images\./.test(n)
        );
      }
      if (kind === "video") {
        // Exclude ref_video_audio_*
        return /^ref_video_\d+$/.test(n) || /(?:^|\.)ref_video_\d+$/.test(n);
      }
      if (kind === "video_audio") {
        return (
          /^ref_video_audio_\d+$/.test(n) || n.includes(".ref_video_audio_")
        );
      }
      if (kind === "audio") {
        return (
          /^ref_audio_\d+$/.test(n) ||
          (n.includes(".ref_audio_") && !n.includes("video_audio"))
        );
      }
      return false;
    })
    .sort((a, b) => refOrdinal(a.name) - refOrdinal(b.name));
}

function getRefImageInputs(node) {
  return getRefInputsByKind(node, "image");
}

function refOrdinal(name) {
  const m = String(name).match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

const MODE_MUTED = 2; // LGraphEventMode.NEVER (Mute)
const MODE_BYPASS = 4; // LGraphEventMode.BYPASS
const MAX_REF_IMAGES = 9;
const MAX_REF_VIDEOS = 3;
const MAX_REF_AUDIOS = 3;

/** Group order matching MiniMaxH3ReferenceToVideo Autogrow blocks. */
const REF_GROUP_ORDER = [
  "ref_image_",
  "ref_video_",
  "ref_video_audio_",
  "ref_audio_",
];

function matchesRefPrefix(name, prefix) {
  if (!name) return false;
  if (prefix === "ref_video_") return /^ref_video_\d+$/.test(name);
  if (prefix === "ref_audio_") return /^ref_audio_\d+$/.test(name);
  if (prefix === "ref_video_audio_") return /^ref_video_audio_\d+$/.test(name);
  if (prefix === "ref_image_") {
    return (
      /^ref_image_\d+$/.test(name) ||
      name.includes(".ref_image_") ||
      /^ref_images\./.test(name)
    );
  }
  return name.startsWith(prefix);
}

function reindexInputLinks(node) {
  const graph = node.graph || app.graph;
  if (!graph?.links || !node.inputs) return;
  for (let i = 0; i < node.inputs.length; i++) {
    const inp = node.inputs[i];
    if (inp?.link == null) continue;
    const link = graph.links[inp.link];
    if (link) link.target_slot = i;
  }
}

/**
 * Keep ref_* inputs grouped like MiniMax: images, videos, video_audios, audios.
 * Non-ref inputs stay at the front.
 */
function reorderRefInputGroups(node) {
  if (!node?.inputs?.length) return;
  const others = [];
  const buckets = REF_GROUP_ORDER.map(() => []);
  for (const inp of node.inputs) {
    let placed = false;
    for (let g = 0; g < REF_GROUP_ORDER.length; g++) {
      if (matchesRefPrefix(inp.name, REF_GROUP_ORDER[g])) {
        buckets[g].push(inp);
        placed = true;
        break;
      }
    }
    if (!placed) others.push(inp);
  }
  for (const b of buckets) {
    b.sort((a, b2) => refOrdinal(a.name) - refOrdinal(b2.name));
  }
  node.inputs = [...others, ...buckets.flat()];
  reindexInputLinks(node);
}

function findLastIndexMatching(node, prefix) {
  const inputs = node.inputs || [];
  for (let i = inputs.length - 1; i >= 0; i--) {
    if (matchesRefPrefix(inputs[i]?.name, prefix)) return i;
  }
  return -1;
}

/** Index at which to insert the next slot for this prefix (after last of group). */
function groupInsertIndex(node, prefix) {
  const lastOwn = findLastIndexMatching(node, prefix);
  if (lastOwn >= 0) return lastOwn + 1;

  const orderIdx = REF_GROUP_ORDER.indexOf(prefix);
  let insertAt = 0;
  // After the last slot of any earlier ref group; skip past leading non-ref inputs.
  for (let i = 0; i < (node.inputs || []).length; i++) {
    const n = node.inputs[i]?.name || "";
    const isRef = REF_GROUP_ORDER.some((p) => matchesRefPrefix(n, p));
    if (!isRef) {
      insertAt = i + 1;
      continue;
    }
    break;
  }
  for (let g = 0; g < orderIdx; g++) {
    const last = findLastIndexMatching(node, REF_GROUP_ORDER[g]);
    if (last >= 0) insertAt = last + 1;
  }
  return insertAt;
}

function insertInputAt(node, index, name, type) {
  if ((node.inputs || []).some((i) => i.name === name)) return;
  node.addInput(name, type);
  const added = node.inputs.pop();
  if (index < 0 || index >= node.inputs.length) {
    node.inputs.push(added);
  } else {
    node.inputs.splice(index, 0, added);
  }
  reindexInputLinks(node);
}

/**
 * V1 Autogrow: keep connected slots + one empty spare.
 * New slots are inserted immediately after the previous slot of the same type
 * (not appended after other Autogrow groups).
 */
function syncAutogrowGroup(node, { prefix, type, max, minKeep = 1 }) {
  const getRefs = () =>
    (node.inputs || [])
      .filter((i) => matchesRefPrefix(i?.name, prefix))
      .sort((a, b) => refOrdinal(a.name) - refOrdinal(b.name));

  let refs = getRefs();
  // Migrate legacy 1-based names (ref_image_1…) → 0-based (ref_image_0…).
  if (refs.length && refOrdinal(refs[0].name) === 1 && !refs.some((r) => refOrdinal(r.name) === 0)) {
    refs.forEach((inp, i) => {
      inp.name = `${prefix}${i}`;
    });
    refs = getRefs();
  }

  if (!refs.length) {
    insertInputAt(node, groupInsertIndex(node, prefix), `${prefix}0`, type);
    refs = getRefs();
  }

  for (;;) {
    refs = getRefs();
    if (refs.length >= max) break;
    const last = refs[refs.length - 1];
    if (!last || last.link == null) break;
    const maxOrd = refs.reduce((m, r) => Math.max(m, refOrdinal(r.name)), -1);
    const next = maxOrd + 1;
    if (next >= max) break;
    if (refs.some((r) => r.name === `${prefix}${next}`)) break;
    insertInputAt(
      node,
      groupInsertIndex(node, prefix),
      `${prefix}${next}`,
      type
    );
  }

  for (;;) {
    refs = getRefs();
    if (refs.length <= minKeep) break;
    const last = refs[refs.length - 1];
    const prev = refs[refs.length - 2];
    if (last.link == null && prev.link == null) {
      const idx = node.inputs.indexOf(last);
      if (idx < 0) break;
      node.removeInput(idx);
    } else {
      break;
    }
  }
}

function syncAutogrowSlots(node) {
  if (!node?.inputs) return;
  syncAutogrowGroup(node, {
    prefix: "ref_image_",
    type: "IMAGE",
    max: MAX_REF_IMAGES,
  });
  syncAutogrowGroup(node, {
    prefix: "ref_video_",
    type: "IMAGE",
    max: MAX_REF_VIDEOS,
  });
  // Soundtrack slots pair by index with ref_video_N (same as MiniMax).
  syncAutogrowGroup(node, {
    prefix: "ref_video_audio_",
    type: "AUDIO",
    max: MAX_REF_VIDEOS,
  });
  syncAutogrowGroup(node, {
    prefix: "ref_audio_",
    type: "AUDIO",
    max: MAX_REF_AUDIOS,
  });
  reorderRefInputGroups(node);
  node.setDirtyCanvas?.(true, true);
}

function refImageOrdinal(name) {
  return refOrdinal(name);
}

function getNodeMode(n) {
  if (!n) return 0;
  // Newer frontends may expose enum-like values; normalize to number.
  const raw = n.mode ?? n.flags?.mode ?? 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

function isNodeInactive(n) {
  if (!n) return true;
  const mode = getNodeMode(n);
  if (mode === MODE_MUTED || mode === MODE_BYPASS) return true;
  // Some builds expose helpers / flags.
  if (n.flags?.muted || n.flags?.bypassed) return true;
  if (typeof n.isMuted === "function" && n.isMuted()) return true;
  if (typeof n.isBypassed === "function" && n.isBypassed()) return true;
  return false;
}

function isRerouteLike(n) {
  if (!n) return false;
  if (n.isReroute || n.isVirtualNode) return true;
  const t = String(n.type || n.comfyClass || n.constructor?.type || "");
  return /reroute/i.test(t);
}

function getLinkedOrigin(input) {
  if (input?.link == null) return null;
  const link = app.graph?.links?.[input.link];
  if (!link) return null;
  const id = link.origin_id;
  return (
    app.graph.getNodeById(id) ||
    app.graph.getNodeById(String(id)) ||
    app.graph.getNodeById(Number(id)) ||
    null
  );
}

/**
 * Walk through reroutes / virtual pass-throughs to the real source.
 * Inactive if ANY node on the chain is muted/bypassed.
 */
function resolveSourceChain(input) {
  let current = getLinkedOrigin(input);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isNodeInactive(current)) {
      return { node: current, inactive: true };
    }
    if (!isRerouteLike(current)) {
      return { node: current, inactive: false };
    }
    const in0 = (current.inputs || []).find((i) => i.link != null) || current.inputs?.[0];
    current = getLinkedOrigin(in0);
  }
  return { node: current, inactive: !current || isNodeInactive(current) };
}

function isEffectiveLink(input) {
  if (input?.link == null) return false;
  const { inactive } = resolveSourceChain(input);
  return !inactive;
}

function isEffectiveImageLink(input) {
  return isEffectiveLink(input);
}

function connectedPictures(node) {
  return connectedMedia(node).pictures;
}

/**
 * Match MiniMaxH3ReferenceToVideo ordinals:
 * pictures (dense) → for each video: optional paired Audio then Video → standalone Audios.
 */
function connectedMedia(node) {
  const pictures = getRefInputsByKind(node, "image")
    .filter(isEffectiveLink)
    .map((input, idx) => ({
      id: idx + 1,
      slotName: input.name,
      url: resolveLinkedImageUrl(node, input),
      kind: "picture",
      label: `<Picture ${idx + 1}>`,
    }));

  const videos = [];
  const audios = [];
  let audioOrd = 0;
  let videoOrd = 0;
  const videoAudios = getRefInputsByKind(node, "video_audio");

  for (const vin of getRefInputsByKind(node, "video").filter(isEffectiveLink)) {
    const slot = refOrdinal(vin.name);
    const pairedIn = videoAudios.find((a) => refOrdinal(a.name) === slot);
    let pairedAudioId = null;
    if (pairedIn && isEffectiveLink(pairedIn)) {
      audioOrd += 1;
      pairedAudioId = audioOrd;
      audios.push({
        id: audioOrd,
        kind: "paired",
        videoId: videoOrd + 1,
        videoSlot: slot,
        slotName: pairedIn.name,
        label: `<Audio ${audioOrd}>`,
      });
    }
    videoOrd += 1;
    videos.push({
      id: videoOrd,
      slot,
      slotName: vin.name,
      pairedAudioId,
      url: resolveLinkedImageUrl(node, vin),
      kind: "video",
      label: `<Video ${videoOrd}>`,
    });
  }

  for (const ain of getRefInputsByKind(node, "audio").filter(isEffectiveLink)) {
    audioOrd += 1;
    audios.push({
      id: audioOrd,
      kind: "standalone",
      videoId: null,
      slotName: ain.name,
      label: `<Audio ${audioOrd}>`,
    });
  }

  return { pictures, videos, audios };
}

/** Upstream image identity for thumbnail refresh (widget value and/or preview URL). */
function linkedMediaPreviewKey(node, input) {
  const { node: src, inactive } = resolveSourceChain(input);
  if (!src || inactive) return "off";
  const imageWidget = src.widgets?.find(
    (w) => w.name === "image" || w.name === "upload"
  );
  const widgetVal = imageWidget?.value != null ? String(imageWidget.value) : "";
  // imgs[0] updates when Load Image swaps files; include src so thumbs refresh
  // even if the widget string is briefly unchanged.
  const imgSrc = src.imgs?.[0]?.src || src.imgs?.[0]?.currentSrc || "";
  const resolved = resolveLinkedImageUrl(node, input) || "";
  return `${widgetVal}|${imgSrc}|${resolved}`;
}

/** Signature includes upstream modes + media preview so image swaps refresh thumbs. */
function graphLinksSignature(node) {
  const kinds = ["image", "video", "video_audio", "audio"];
  return kinds
    .flatMap((k) => getRefInputsByKind(node, k))
    .map((inp) => {
      if (inp.link == null) return `${inp.name}:open`;
      const { node: src, inactive } = resolveSourceChain(inp);
      const preview = linkedMediaPreviewKey(node, inp);
      return `${inp.name}:${inp.link}:${src?.id ?? "?"}:${getNodeMode(src)}:${inactive ? "off" : "on"}:${preview}`;
    })
    .join("|");
}

function ensureRetention(state, pictures, subjects, videos = [], audios = []) {
  const wanted = [];
  for (let i = 0; i < subjects.length; i++) {
    wanted.push({
      key: `subject:${i + 1}`,
      label: `<Subject ${i + 1}>`,
      kind: "subject",
      subjectIndex: i + 1,
      context: "",
      marker: "fully_preserved",
      text: "",
      enabled: true,
    });
  }
  for (const pic of pictures) {
    wanted.push({
      key: `picture:${pic.id}`,
      label: `<Picture ${pic.id}>`,
      kind: "picture",
      pictureId: pic.id,
      context: "",
      marker: "fully_preserved",
      text: "",
      enabled: false,
    });
  }
  for (const vid of videos) {
    wanted.push({
      key: `video:${vid.id}`,
      label: `<Video ${vid.id}>`,
      kind: "video",
      videoId: vid.id,
      context: "",
      marker: "fully_preserved",
      text: "",
      enabled: true,
    });
  }
  for (const aud of audios) {
    wanted.push({
      key: `audio:${aud.id}`,
      label: `<Audio ${aud.id}>`,
      kind: "audio",
      audioId: aud.id,
      context:
        aud.kind === "paired" && aud.videoId
          ? `synchronized track of <Video ${aud.videoId}>`
          : "",
      marker: "reference",
      text: "",
      enabled: true,
    });
  }
  const existing = new Map(
    (state.retention || []).map((e) => [e.key || e.label, e])
  );
  // Reuse prior entry objects so UI handlers keep live references.
  state.retention = wanted.map((w) => {
    const prev = existing.get(w.key) || existing.get(w.label);
    if (!prev) return { ...w };
    const markers =
      w.kind === "audio" ? AUDIO_RETENTION_MARKERS : RETENTION_MARKERS;
    prev.key = w.key;
    prev.label = w.label;
    prev.kind = w.kind;
    prev.subjectIndex = w.subjectIndex;
    prev.pictureId = w.pictureId;
    prev.videoId = w.videoId;
    prev.audioId = w.audioId;
    if (prev.context == null || prev.context === "") {
      prev.context = w.context;
    }
    prev.marker = markers.includes(prev.marker) ? prev.marker : w.marker;
    if (typeof prev.text !== "string") prev.text = "";
    if (typeof prev.enabled !== "boolean") prev.enabled = w.enabled;
    return prev;
  });
}

function syncMediaState(state, media) {
  const { pictures, videos, audios } = media;
  const nextPics = {};
  for (const pic of pictures) {
    const prev = state.pictures[String(pic.id)] || state.pictures[pic.id] || {};
    nextPics[String(pic.id)] = { text: prev.text || "" };
  }
  state.pictures = nextPics;

  const nextVideos = {};
  for (const vid of videos) {
    const prev = state.videos[String(vid.id)] || state.videos[vid.id] || {};
    nextVideos[String(vid.id)] = { text: prev.text || "" };
  }
  state.videos = nextVideos;

  const nextAudios = {};
  for (const aud of audios) {
    const prev = state.audios[String(aud.id)] || state.audios[aud.id] || {};
    nextAudios[String(aud.id)] = {
      text: prev.text || "",
      kind: aud.kind,
      video_id: aud.videoId ?? null,
    };
  }
  state.audios = nextAudios;

  for (const subject of state.subjects) {
    subject.picture_ids = (subject.picture_ids || []).filter((id) =>
      pictures.some((p) => p.id === id)
    );
  }
  const subjectCount = state.subjects.length;
  for (const shot of state.shots) {
    const n = normalizeShot(shot);
    Object.assign(shot, n);
    delete shot.picture_id;
    shot.references = (shot.references || []).filter((ref) =>
      pictures.some((p) => p.id === ref.picture_id)
    );
    shot.subject_ids = (shot.subject_ids || []).filter(
      (sid) => sid >= 1 && sid <= subjectCount
    );
  }
  syncDerivedFlags(state);
}

function syncPicturesState(state, pictures) {
  syncMediaState(state, { pictures, videos: [], audios: [] });
}

function parseImageWidgetValue(value) {
  if (!value || typeof value !== "string") return null;
  let filename = value;
  let type = "input";
  let subfolder = "";
  const annotated = value.match(/^(.*)\s+\[(input|output|temp)\]$/i);
  if (annotated) {
    filename = annotated[1].trim();
    type = annotated[2].toLowerCase();
  }
  const parts = filename.replace(/\\/g, "/").split("/");
  if (parts.length > 1) {
    subfolder = parts.slice(0, -1).join("/");
    filename = parts[parts.length - 1];
  }
  return { filename, type, subfolder };
}

function resolveLinkedImageUrl(node, input) {
  const { node: origin, inactive } = resolveSourceChain(input);
  if (inactive || !origin) return null;

  if (origin.imgs?.[0]?.src) return origin.imgs[0].src;

  const imageWidget = origin.widgets?.find(
    (w) => w.name === "image" || w.name === "upload"
  );
  if (imageWidget?.value) {
    const parsed = parseImageWidgetValue(String(imageWidget.value));
    if (parsed) {
      const params = new URLSearchParams({
        filename: parsed.filename,
        type: parsed.type,
        subfolder: parsed.subfolder,
      });
      return api.apiURL(`/view?${params.toString()}`);
    }
  }

  const outputs = app.nodeOutputs?.[origin.id];
  const images = outputs?.images;
  if (Array.isArray(images) && images[0]) {
    const img = images[0];
    const params = new URLSearchParams({
      filename: img.filename,
      type: img.type || "output",
      subfolder: img.subfolder || "",
    });
    return api.apiURL(`/view?${params.toString()}`);
  }
  return null;
}

function applyAutoRetentionContext(state) {
  const shots = state.shots || [];
  for (const entry of state.retention || []) {
    if (entry.kind === "subject") {
      const found = [];
      shots.forEach((shot, i) => {
        if ((shot.subject_ids || []).includes(entry.subjectIndex)) {
          found.push(`[Shot ${i + 1}]`);
        }
      });
      entry.context = found.length ? `appears in ${found.join(", ")}` : "";
    } else if (entry.kind === "picture") {
      const found = [];
      shots.forEach((shot, i) => {
        for (const ref of normalizeShot(shot).references || []) {
          if (ref.picture_id !== entry.pictureId) continue;
          if (ref.role === "storyboard") {
            found.push(`[Shot ${i + 1}] storyboard`);
          } else {
            found.push(`[Shot ${i + 1}] first frame`);
          }
        }
      });
      entry.context = found.join(", ");
    }
  }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "checked") node.checked = !!v;
    else if (k === "value") node.value = v ?? "";
    else if (k === "selected") {
      if (v) node.selected = true;
    } else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child
    );
  }
  return node;
}

const STATIC_TAG_SUGGESTIONS = [
  { insert: "<d>[English] ", label: "<d>[English] …</d>", hint: "dialogue / lyrics" },
  { insert: "</d>", label: "</d>", hint: "close dialogue" },
  { insert: "<scenetrans>", label: "<scenetrans>", hint: "dialogue across a cut" },
  { insert: "<cutoff>", label: "<cutoff>", hint: "speech truncated by end" },
];

function buildTagSuggestions(state, pictures, videos = [], audios = []) {
  const items = [];
  for (const pic of pictures || []) {
    items.push({
      insert: `<Picture ${pic.id}>`,
      label: `<Picture ${pic.id}>`,
      hint: "reference image",
    });
  }
  for (const vid of videos || []) {
    items.push({
      insert: `<Video ${vid.id}>`,
      label: `<Video ${vid.id}>`,
      hint: "reference video",
    });
  }
  for (const aud of audios || []) {
    items.push({
      insert: `<Audio ${aud.id}>`,
      label: `<Audio ${aud.id}>`,
      hint:
        aud.kind === "paired"
          ? `paired with <Video ${aud.videoId}>`
          : "standalone audio",
    });
  }
  (state.subjects || []).forEach((_, i) => {
    const n = i + 1;
    items.push({
      insert: `<Subject ${n}>`,
      label: `<Subject ${n}>`,
      hint: "defined subject",
    });
    items.push({
      insert: `<Subject ${n}> (S${n})`,
      label: `<Subject ${n}> (S${n})`,
      hint: "subject as speaker",
    });
  });
  (state.shots || []).forEach((_, i) => {
    const n = i + 1;
    items.push({
      insert: `[Shot ${n}]`,
      label: `[Shot ${n}]`,
      hint: "shot marker",
    });
  });
  items.push(...STATIC_TAG_SUGGESTIONS);
  return items;
}

/** Active `<…` or `[…` token immediately before the caret. */
function getActiveTagToken(value, caret) {
  const before = value.slice(0, caret);
  const lt = before.lastIndexOf("<");
  const lb = before.lastIndexOf("[");
  const start = Math.max(lt, lb);
  if (start < 0) return null;
  const token = before.slice(start);
  // Closed already — not suggesting.
  if (token.startsWith("<") && token.includes(">")) return null;
  if (token.startsWith("[") && token.includes("]")) return null;
  // Only word-like unfinished tags: <Picture, <s, [Shot, [
  if (!/^[<\[][A-Za-z0-9_ ()]*$/.test(token)) return null;
  return { start, token };
}

function attachTagAutocomplete(textarea, getSuggestions) {
  const wrap = el("div", { className: "mmh3-ac-wrap" });
  const menu = el("div", { className: "mmh3-ac-menu" });
  // Caller may have already put textarea in the tree; wrap it in place if needed.
  const parent = textarea.parentNode;
  if (parent) {
    parent.insertBefore(wrap, textarea);
  }
  wrap.appendChild(textarea);
  wrap.appendChild(menu);

  let filtered = [];
  let active = 0;
  let tokenMeta = null;

  function close() {
    menu.classList.remove("open");
    menu.innerHTML = "";
    filtered = [];
    tokenMeta = null;
  }

  function renderMenu() {
    menu.innerHTML = "";
    if (!filtered.length) {
      close();
      return;
    }
    filtered.forEach((item, idx) => {
      const row = el("div", {
        className: "mmh3-ac-item" + (idx === active ? " active" : ""),
        onMouseDown: (e) => {
          e.preventDefault();
          applyItem(item);
        },
      });
      row.appendChild(document.createTextNode(item.label));
      if (item.hint) row.appendChild(el("small", { text: item.hint }));
      menu.appendChild(row);
    });
    menu.classList.add("open");
  }

  function applyItem(item) {
    if (!tokenMeta) return;
    const { start } = tokenMeta;
    const end = textarea.selectionStart;
    const v = textarea.value;
    const next = v.slice(0, start) + item.insert + v.slice(end);
    textarea.value = next;
    const caret = start + item.insert.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    textarea.focus();
  }

  function update() {
    const caret = textarea.selectionStart;
    tokenMeta = getActiveTagToken(textarea.value, caret);
    if (!tokenMeta) {
      close();
      return;
    }
    const q = tokenMeta.token.toLowerCase();
    const all = getSuggestions() || [];
    filtered = all.filter((it) => {
      const lab = (it.label || it.insert || "").toLowerCase();
      // Match prefix of the insert/label against typed token.
      return lab.startsWith(q) || lab.includes(q.slice(1));
    });
    // Prefer startsWith order.
    filtered.sort((a, b) => {
      const al = a.label.toLowerCase();
      const bl = b.label.toLowerCase();
      const as = al.startsWith(q) ? 0 : 1;
      const bs = bl.startsWith(q) ? 0 : 1;
      return as - bs || al.localeCompare(bl);
    });
    filtered = filtered.slice(0, 12);
    active = 0;
    renderMenu();
  }

  textarea.addEventListener("input", update);
  textarea.addEventListener("click", update);
  textarea.addEventListener("keyup", (e) => {
    if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key))
      return;
    update();
  });
  textarea.addEventListener("keydown", (e) => {
    if (!menu.classList.contains("open") || !filtered.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % filtered.length;
      renderMenu();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + filtered.length) % filtered.length;
      renderMenu();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applyItem(filtered[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  textarea.addEventListener("blur", () => {
    // Delay so mousedown on an item can fire first.
    setTimeout(close, 120);
  });

  return wrap;
}

function thumbEl(url, { small = false, label = "" } = {}) {
  if (url) {
    return el("img", {
      className: small ? "mmh3-thumb-sm" : "mmh3-thumb",
      src: url,
      title: label,
    });
  }
  return el("div", {
    className: small ? "mmh3-thumb-placeholder sm" : "mmh3-thumb-placeholder",
    text: label || "—",
  });
}

function formatTs(sec, ms) {
  return `00:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function eventTimeValue(ev) {
  return (Number(ev?.sec) || 0) * 1000 + (Number(ev?.ms) || 0);
}

/** Smallest selectable time strictly after sec/ms (grid: SEC_OPTIONS × MS_OPTIONS). */
function nextSelectableTime(sec, ms) {
  const s = Number(sec) || 0;
  const m = Number(ms) || 0;
  const msIdx = MS_OPTIONS.indexOf(m);
  if (msIdx >= 0 && msIdx < MS_OPTIONS.length - 1) {
    return { sec: s, ms: MS_OPTIONS[msIdx + 1] };
  }
  const maxSec = SEC_OPTIONS[SEC_OPTIONS.length - 1];
  if (s < maxSec) return { sec: s + 1, ms: MS_OPTIONS[0] };
  return { sec: maxSec, ms: MS_OPTIONS[MS_OPTIONS.length - 1] };
}

/** Prefer +1s for a new shot start; fall back to +100ms near the timeline end. */
function nextShotStartTime(sec, ms) {
  const s = Number(sec) || 0;
  const m = Number(ms) || 0;
  const maxSec = SEC_OPTIONS[SEC_OPTIONS.length - 1];
  if (s < maxSec) return { sec: s + 1, ms: m };
  return nextSelectableTime(s, m);
}

/** Prior event in timeline order (previous event in shot, else last of previous shot). */
function previousTimelineEvent(shots, shotIdx, eventIdx) {
  const shot = shots?.[shotIdx];
  if (!shot) return null;
  if (eventIdx > 0) return shot.events?.[eventIdx - 1] || null;
  if (shotIdx > 0) {
    const prev = shots[shotIdx - 1];
    const evs = prev?.events || [];
    return evs.length ? evs[evs.length - 1] : null;
  }
  return null;
}

/** Minimum allowed time for this event; null = opening (any / omitted). */
function minTimeForEvent(shots, shotIdx, eventIdx) {
  const prev = previousTimelineEvent(shots, shotIdx, eventIdx);
  if (!prev) return null;
  return nextSelectableTime(prev.sec, prev.ms);
}

function clampEventToMin(ev, min) {
  if (!min) return false;
  if (eventTimeValue(ev) >= eventTimeValue(min)) return false;
  ev.sec = min.sec;
  ev.ms = min.ms;
  return true;
}

function allowedSeconds(min) {
  if (!min) return SEC_OPTIONS.slice();
  return SEC_OPTIONS.filter((s) => s >= min.sec);
}

function allowedMillis(sec, min) {
  if (!min) return MS_OPTIONS.slice();
  if (sec > min.sec) return MS_OPTIONS.slice();
  if (sec < min.sec) return [];
  return MS_OPTIONS.filter((m) => m >= min.ms);
}

const SENTENCE_END_CHARS = ".!?…";

/** Mid-sentence fragment: strip trailing .!?… */
function asClause(text) {
  let t = String(text || "").trim();
  while (t && SENTENCE_END_CHARS.includes(t.slice(-1))) {
    t = t.slice(0, -1).trimEnd();
  }
  return t.trim();
}

/** Sentence / line ending: ensure terminal . (keep !?… if present). */
function asSentence(text) {
  const t = String(text || "").trim();
  if (!t) return t;
  if (SENTENCE_END_CHARS.includes(t.slice(-1))) return t;
  return `${t}.`;
}

function buildClientPreview(state, pictures, videos = [], audios = []) {
  const subjectLines = (state.subjects || []).map((s, i) => {
    const n = i + 1;
    const pics = (s.picture_ids || [])
      .filter((id) => pictures.some((p) => p.id === id))
      .map((id) => `<Picture ${id}>`);
    const text = (s.text || "").trim();
    const joined = pics.join(", ");
    if (text) {
      const mentions = pics.some((p) => text.includes(p));
      if (pics.length && !mentions)
        return `<Subject ${n}> is ${asClause(text)}, from ${joined}.`;
      return `<Subject ${n}> is ${asSentence(text)}`;
    }
    if (joined) return `<Subject ${n}> is defined by ${joined}.`;
    return `<Subject ${n}> is an undefined subject.`;
  });
  for (const pic of pictures) {
    const text = (state.pictures[String(pic.id)]?.text || "").trim();
    const { firstFrames, storyboards } = pictureRoleShots(pic.id, state.shots);
    const line = formatPictureLine(pic.id, text, firstFrames, storyboards);
    if (line) subjectLines.push(line);
  }
  for (const vid of videos) {
    const text = (state.videos[String(vid.id)]?.text || "").trim();
    if (text) {
      subjectLines.push(
        text.toLowerCase().startsWith("<video")
          ? asSentence(text)
          : `<Video ${vid.id}> is ${asSentence(text)}`
      );
    }
  }
  for (const aud of audios) {
    const text = (state.audios[String(aud.id)]?.text || "").trim();
    if (text) {
      subjectLines.push(
        text.toLowerCase().startsWith("<audio")
          ? asSentence(text)
          : `<Audio ${aud.id}> is ${asSentence(text)}`
      );
    }
  }
  const enabledTasks = TASK_TYPES.filter((t) => state.summary.task_types[t]);
  const prefix = enabledTasks.length
    ? enabledTasks.join(" + ")
    : "reference generation";
  const summaryBody = (state.summary.text || "").trim();
  const summary = summaryBody
    ? `[${prefix}] ${asSentence(summaryBody)}`
    : `[${prefix}]`;

  applyAutoRetentionContext(state);
  syncDerivedFlags(state);
  const retention = (state.retention || [])
    .filter((e) => e.enabled !== false && e.label)
    .map((e) => {
      const markers =
        e.kind === "audio" ? AUDIO_RETENTION_MARKERS : RETENTION_MARKERS;
      const fallback = e.kind === "audio" ? "reference" : "fully_preserved";
      const marker = markers.includes(e.marker) ? e.marker : fallback;
      const head = e.context
        ? `${e.label} (${e.context}): ${marker}`
        : `${e.label}: ${marker}`;
      const detail = (e.text || "").trim();
      return detail ? `${head} - ${asSentence(detail)}` : `${head}.`;
    });

  const shotBlocks = (state.shots || [])
    .map((shot, i) => {
      const n = i + 1;
      const s = normalizeShot(shot);
      const events = (s.events || []).filter((ev) => ev.enabled !== false);
      if (!events.length) return "";
      return events
        .map((ev, ei) => {
          const text = (ev.text || "").trim();
          const parts = [];
          if (ei === 0) {
            const firstPic = shotFirstFramePictureId(s);
            if (firstPic) {
              const mention = `<Picture ${firstPic}>`;
              if (!text.includes(mention)) {
                parts.push(`the shot begins from ${mention}.`);
              }
            }
          }
          if (text) parts.push(text);
          let body = parts.join(" ").trim() || "...";
          if (body !== "...") body = asSentence(body);
          if (ei === 0) {
            if (n === 1) return `[Shot ${n}] ${body}`;
            return `[Shot ${n}] At ${formatTs(ev.sec, ev.ms)}, ${body}`;
          }
          return `At ${formatTs(ev.sec, ev.ms)}, ${body}`;
        })
        .join("\n");
    })
    .filter(Boolean);

  const styleOpening = asSentence((state.style_opening || "").trim());
  const detailedParts = [];
  if (styleOpening) detailedParts.push(styleOpening);
  if (shotBlocks.length) detailedParts.push(shotBlocks.join("\n"));
  const detailedBody = detailedParts.length
    ? detailedParts.join("\n")
    : "(none)";

  const musicRaw = (state.non_diegetic_music.text || "").trim();
  const music =
    state.non_diegetic_music.enabled && musicRaw
      ? asSentence(musicRaw)
      : "N/A";
  const soundscapeRaw = (state.overall_soundscape || "").trim();
  const soundscape = soundscapeRaw ? asSentence(soundscapeRaw) : "N/A";

  return [
    "subject_definitions:",
    subjectLines.join("\n") || "(none)",
    "",
    "summary:",
    summary,
    "",
    "retention_analysis:",
    retention.join("\n") || "(none)",
    "",
    "detailed_description:",
    detailedBody,
    "",
    "overall_soundscape:",
    soundscape,
    "",
    "non_diegetic_music:",
    music,
    "",
  ].join("\n");
}

function createFormatterUI(node, stateWidget) {
  injectStyles();
  let state = parseState(stateWidget.value);
  let pictures = [];
  let videos = [];
  let audios = [];
  let activeTab = "references";

  const TABS = [
    { id: "references", label: "References" },
    { id: "subjects", label: "Subjects" },
    { id: "summary", label: "Summary" },
    { id: "shots", label: "Shots" },
    { id: "sounds", label: "Sounds" },
    { id: "preview", label: "Preview" },
    { id: "debug", label: "Debug" },
  ];

  const root = el("div", { className: "mmh3-root" });
  const tabBar = el("div", { className: "mmh3-tabs" });
  const panels = {};
  const bodies = {};
  const tabButtons = {};

  for (const t of TABS) {
    const btn = el("button", {
      className: "mmh3-tab" + (t.id === activeTab ? " active" : ""),
      text: t.label,
      type: "button",
      onClick: () => setTab(t.id),
    });
    btn.dataset.tab = t.id;
    tabButtons[t.id] = btn;
    tabBar.appendChild(btn);
    const panel = el("div", {
      className: "mmh3-panel" + (t.id === activeTab ? " active" : ""),
    });
    panel.dataset.tab = t.id;
    const body = el("div");
    panel.appendChild(body);
    panels[t.id] = panel;
    bodies[t.id] = body;
  }

  root.appendChild(tabBar);
  for (const t of TABS) root.appendChild(panels[t.id]);

  function setDebugVisible(show) {
    if (!node.properties) node.properties = {};
    node.properties.mmh3ShowDebug = !!show;
    const btn = tabButtons.debug;
    if (btn) btn.style.display = show ? "" : "none";
    if (!show && activeTab === "debug") setTab("preview");
    node.setDirtyCanvas?.(true, true);
  }

  function setTab(id) {
    if (id === "debug" && !node.properties?.mmh3ShowDebug) return;
    activeTab = id;
    tabBar.querySelectorAll(".mmh3-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === id);
    });
    Object.entries(panels).forEach(([k, p]) => {
      p.classList.toggle("active", k === id);
    });
    if (id === "debug") renderDebug();
  }

  // Debug tab hidden by default (toggle via node right-click).
  if (!node.properties) node.properties = {};
  if (typeof node.properties.mmh3ShowDebug !== "boolean") {
    node.properties.mmh3ShowDebug = false;
  }
  setDebugVisible(node.properties.mmh3ShowDebug);

  function suggestionCatalog() {
    return buildTagSuggestions(state, pictures, videos, audios);
  }

  /** Textarea with < / [ tag autocomplete. */
  function taggedTextarea(attrs = {}) {
    const ta = el("textarea", { rows: 5, ...attrs });
    attachTagAutocomplete(ta, suggestionCatalog);
    return ta.parentNode; // wrap
  }

  function taggedTextInput(attrs = {}) {
    const input = el("input", { ...attrs, type: "text" });
    attachTagAutocomplete(input, suggestionCatalog);
    return input.parentNode;
  }

  function persist({ force = false } = {}) {
    const live = buildClientPreview(state, pictures, videos, audios);
    // Keep a prior assembled prompt across load / node updates when the live
    // rebuild is still empty (e.g. pictures not reconnected yet, or schema
    // migration left structured fields blank).
    if (!isSparsePreview(live)) {
      state.saved_prompt = live;
    } else if (!state.saved_prompt) {
      state.saved_prompt = live;
    }

    const display = state.saved_prompt || live;
    const showingRestored =
      isSparsePreview(live) &&
      !!(state.saved_prompt || "").trim() &&
      state.saved_prompt.trim() !== live.trim();

    bodies.preview.innerHTML = "";
    if (showingRestored) {
      bodies.preview.appendChild(
        el("div", {
          className: "mmh3-muted",
          text: "Showing last saved prompt from the workflow. Edit any field to regenerate from the structured sections.",
        })
      );
    }
    bodies.preview.appendChild(
      el("pre", {
        className: "mmh3-preview",
        text: display,
      })
    );

    // Avoid clobbering restored widgets_values during load (connections /
    // first refresh can run before onConfigure hydrates the UI).
    if (!force && !node._mmh3PersistReady) {
      node.setDirtyCanvas?.(true, true);
      return;
    }
    const json = JSON.stringify(state);
    writePromptState(node, stateWidget, json);
    stateWidget.callback?.(json);
    node.setDirtyCanvas?.(true, true);
  }

  function pictureById(id) {
    return pictures.find((p) => p.id === id);
  }

  function makePicturePicker({
    mode,
    selectedIds,
    selectedId,
    groupName,
    onToggle,
    onSelect,
    pictureList,
  }) {
    const source = pictureList || pictures;
    const grid = el("div", { className: "mmh3-pic-grid" });
    if (!source.length) {
      grid.appendChild(
        el("div", { className: "mmh3-muted", text: "No pictures connected" })
      );
      return grid;
    }
    for (const pic of source) {
      const selected =
        mode === "multi"
          ? (selectedIds || []).includes(pic.id)
          : selectedId === pic.id;
      const opt = el("label", {
        className: "mmh3-pic-opt" + (selected ? " selected" : ""),
      });
      const inputAttrs = {
        type: mode === "multi" ? "checkbox" : "radio",
        checked: selected,
        onChange: (e) => {
          if (mode === "multi") onToggle?.(pic.id, e.target.checked);
          else onSelect?.(pic.id);
        },
      };
      if (mode === "single" && groupName) inputAttrs.name = groupName;
      const input = el("input", inputAttrs);
      opt.appendChild(input);
      opt.appendChild(thumbEl(pic.url, { small: true, label: `P${pic.id}` }));
      opt.appendChild(el("span", { text: `<Picture ${pic.id}>` }));
      grid.appendChild(opt);
    }
    if (mode === "single" && pictureList == null) {
      const none = el("label", {
        className: "mmh3-pic-opt" + (selectedId == null ? " selected" : ""),
      });
      const inputAttrs = {
        type: "radio",
        checked: selectedId == null,
        onChange: () => onSelect?.(null),
      };
      if (groupName) inputAttrs.name = groupName;
      none.appendChild(el("input", inputAttrs));
      none.appendChild(
        el("div", { className: "mmh3-thumb-placeholder sm", text: "None" })
      );
      none.appendChild(el("span", { text: "(none)" }));
      grid.appendChild(none);
    }
    return grid;
  }

  function refreshShotRefs() {
    ensureRetention(state, pictures, state.subjects, videos, audios);
    syncDerivedFlags(state);
    persist();
    renderShots();
    renderReferences();
    renderSubjects();
    renderSummary();
  }

  function makeShotReferencesEditor(shot, shotIdx) {
    const wrap = el("div", { className: "mmh3-refs" });
    const row = el("div", { className: "mmh3-ref-row" });
    const pickerHost = el("div");

    const firstRef = (shot.references || []).find((r) => r.role === "first_frame");
    const boardRef = (shot.references || []).find((r) => r.role === "storyboard");

    function setSlot(role, pictureId) {
      const next = (shot.references || []).filter((r) => r.role !== role);
      if (pictureId != null) {
        // A picture can only occupy one slot on this shot.
        const cleaned = next.filter((r) => r.picture_id !== pictureId);
        cleaned.push({ picture_id: pictureId, role });
        shot.references = cleaned;
      } else {
        shot.references = next;
      }
      Object.assign(shot, normalizeShot(shot));
      refreshShotRefs();
    }

    function openPicker(role, excludeId) {
      const open = pickerHost.dataset.role === role;
      pickerHost.innerHTML = "";
      pickerHost.dataset.role = "";
      if (open) return;

      // All pictures except the one already used in the other slot.
      const otherId =
        role === "first_frame" ? boardRef?.picture_id : firstRef?.picture_id;
      const choices = pictures.filter((p) => p.id !== otherId);
      if (!choices.length) {
        pickerHost.appendChild(
          el("div", {
            className: "mmh3-muted",
            text: pictures.length
              ? "No other pictures available for this slot."
              : "Connect ref images to choose a picture.",
          })
        );
        pickerHost.dataset.role = role;
        return;
      }
      const panel = el("div", { className: "mmh3-ref-picker" });
      panel.appendChild(
        el("div", {
          className: "mmh3-muted",
          text:
            role === "first_frame"
              ? "Choose first-frame picture:"
              : "Choose storyboard reference:",
        })
      );
      panel.appendChild(
        makePicturePicker({
          mode: "single",
          selectedId: excludeId ?? null,
          groupName: `shot-ref-${role}-${shotIdx}`,
          pictureList: choices,
          onSelect: (id) => {
            if (id == null) return;
            setSlot(role, id);
          },
        })
      );
      pickerHost.appendChild(panel);
      pickerHost.dataset.role = role;
    }

    function makeSlot(role, label, ref) {
      const slot = el("div", { className: "mmh3-ref-slot" });
      slot.appendChild(el("div", { className: "mmh3-label", text: label }));
      if (ref) {
        const pic = pictureById(ref.picture_id);
        const chip = el("div", { className: "mmh3-ref-chip" });
        chip.appendChild(
          el("button", {
            className: "mmh3-ref-remove",
            type: "button",
            text: "×",
            title: "Remove",
            onClick: () => setSlot(role, null),
          })
        );
        const thumb = thumbEl(pic?.url, {
          small: true,
          label: `P${ref.picture_id}`,
        });
        thumb.style.cursor = "pointer";
        thumb.title = "Change picture";
        thumb.addEventListener("click", () => openPicker(role, ref.picture_id));
        chip.appendChild(thumb);
        chip.appendChild(el("span", { text: `<Picture ${ref.picture_id}>` }));
        slot.appendChild(chip);
      } else {
        slot.appendChild(
          el("button", {
            className: "mmh3-ref-add",
            type: "button",
            text: "+",
            title: `Add ${label.toLowerCase()}`,
            onClick: () => openPicker(role, null),
          })
        );
      }
      return slot;
    }

    row.appendChild(makeSlot("first_frame", "First frame", firstRef));
    row.appendChild(makeSlot("storyboard", "Storyboard", boardRef));
    wrap.appendChild(row);
    wrap.appendChild(pickerHost);
    return wrap;
  }

  function subjectThumbUrl(subjectIndex) {
    const sub = state.subjects[subjectIndex - 1];
    const firstId = sub?.picture_ids?.[0];
    return firstId != null ? pictureById(firstId)?.url : null;
  }

  function makeSubjectPicker({ selectedIds, onToggle }) {
    const grid = el("div", { className: "mmh3-pic-grid" });
    if (!state.subjects.length) {
      grid.appendChild(
        el("div", {
          className: "mmh3-muted",
          text: "No subjects defined yet (add some in Subjects).",
        })
      );
      return grid;
    }
    state.subjects.forEach((subject, idx) => {
      const sid = idx + 1;
      const selected = (selectedIds || []).includes(sid);
      const opt = el("label", {
        className: "mmh3-pic-opt" + (selected ? " selected" : ""),
      });
      opt.appendChild(
        el("input", {
          type: "checkbox",
          checked: selected,
          onChange: (e) => onToggle?.(sid, e.target.checked),
        })
      );
      opt.appendChild(
        thumbEl(subjectThumbUrl(sid), {
          small: true,
          label: `S${sid}`,
        })
      );
      opt.appendChild(el("span", { text: `<Subject ${sid}>` }));
      grid.appendChild(opt);
    });
    return grid;
  }

  function retentionEntryFor(kind, id) {
    // Do not rebuild retention here — ensureRetention replaces the array and
    // would leave earlier checkbox handlers holding discarded objects.
    const list = state.retention || [];
    if (kind === "picture") {
      return list.find((e) => e.kind === "picture" && e.pictureId === id);
    }
    if (kind === "video") {
      return list.find((e) => e.kind === "video" && e.videoId === id);
    }
    if (kind === "audio") {
      return list.find((e) => e.kind === "audio" && e.audioId === id);
    }
    return list.find((e) => e.kind === "subject" && e.subjectIndex === id);
  }

  function liveRetentionEntry(entry) {
    if (!entry) return null;
    const list = state.retention || [];
    if (entry.key) {
      const byKey = list.find((e) => e.key === entry.key);
      if (byKey) return byKey;
    }
    return (
      list.find((e) => e.kind === entry.kind && e.label === entry.label) || entry
    );
  }

  /** Relationship marker + retention description (was the Retention tab). */
  function appendRetentionFields(parent, entry, { onToggle } = {}) {
    if (!entry) return;
    const included = entry.enabled !== false;
    const markers =
      entry.kind === "audio" ? AUDIO_RETENTION_MARKERS : RETENTION_MARKERS;
    const defaultMarker =
      entry.kind === "audio" ? "reference" : "fully_preserved";
    const box = el("div", { className: "mmh3-retention" });
    box.appendChild(
      el("div", { className: "mmh3-label", text: "Retention analysis" })
    );
    box.appendChild(
      el("label", { className: "mmh3-inline" }, [
        el("input", {
          type: "checkbox",
          checked: included,
          onChange: (e) => {
            const live = liveRetentionEntry(entry);
            live.enabled = e.target.checked;
            persist();
            onToggle?.();
          },
        }),
        el("span", { text: "Include in retention_analysis" }),
      ])
    );
    if (!included) {
      parent.appendChild(box);
      return;
    }
    box.appendChild(
      el("div", { className: "mmh3-label", text: "Relationship marker" })
    );
    const marker = el("select", {
      onChange: (e) => {
        liveRetentionEntry(entry).marker = e.target.value;
        persist();
      },
    });
    for (const m of markers) {
      const opt = el("option", { value: m, text: m });
      if (m === (entry.marker || defaultMarker)) opt.selected = true;
      marker.appendChild(opt);
    }
    box.appendChild(marker);
    if (entry.context) {
      box.appendChild(
        el("div", { className: "mmh3-muted", text: entry.context })
      );
    } else if (entry.kind === "subject") {
      box.appendChild(
        el("div", {
          className: "mmh3-muted",
          text: "No shot associations yet — pick this subject on Shots.",
        })
      );
    } else if (entry.kind === "picture") {
      box.appendChild(
        el("div", {
          className: "mmh3-muted",
          text: "Not used as a shot reference yet.",
        })
      );
    } else if (entry.kind === "video") {
      box.appendChild(
        el("div", {
          className: "mmh3-muted",
          text: "e.g. cut and pacing structure, camera movement…",
        })
      );
    }
    box.appendChild(
      el("div", { className: "mmh3-label", text: "Retention description" })
    );
    box.appendChild(
      taggedTextarea({
        value: entry.text || "",
        placeholder: "Retention detail…",
        onInput: (e) => {
          liveRetentionEntry(entry).text = e.target.value;
          persist();
        },
      })
    );
    parent.appendChild(box);
  }

  function renderReferences() {
    const body = bodies.references;
    body.innerHTML = "";
    ensureRetention(state, pictures, state.subjects, videos, audios);
    syncDerivedFlags(state);

    const hasAny = pictures.length || videos.length || audios.length;
    if (!hasAny) {
      body.appendChild(
        el("div", {
          className: "mmh3-muted",
          text: "Connect ref images (≤9), videos (≤3, IMAGE frames), optional paired soundtracks (ref_video_audio_N), and standalone audios (≤3). Slot names are 0-based like MiniMax (ref_image_0 → <Picture 1>).",
        })
      );
      return;
    }

    if (pictures.length) {
      body.appendChild(
        el("div", { className: "mmh3-label", text: "Pictures" })
      );
    }
    for (const pic of pictures) {
      const picState = state.pictures[String(pic.id)] || { text: "" };
      const row = el("div", { className: "mmh3-row mmh3-entry" });
      row.appendChild(thumbEl(pic.url, { label: `<P${pic.id}>` }));
      const grow = el("div", { className: "mmh3-grow" });
      grow.appendChild(
        el("div", { className: "mmh3-label", text: `<Picture ${pic.id}>` })
      );
      grow.appendChild(
        taggedTextarea({
          value: picState.text,
          placeholder:
            "Description shown after the role (first frame “showing …” / storyboard clause). Leave empty to omit.",
          onInput: (e) => {
            state.pictures[String(pic.id)] = { text: e.target.value };
            persist();
          },
        })
      );
      appendRetentionFields(grow, retentionEntryFor("picture", pic.id), {
        onToggle: () => renderReferences(),
      });
      row.appendChild(grow);
      body.appendChild(row);
    }

    if (videos.length) {
      body.appendChild(
        el("div", {
          className: "mmh3-label",
          text: "Videos",
          style: "margin-top:12px",
        })
      );
      body.appendChild(
        el("div", {
          className: "mmh3-muted",
          text: "Wire the same-index soundtrack to ref_video_audio_N to create a paired <Audio> before this <Video> (e.g. ref_video_audio_0 ↔ ref_video_0).",
        })
      );
    }
    for (const vid of videos) {
      const vState = state.videos[String(vid.id)] || { text: "" };
      const row = el("div", { className: "mmh3-row mmh3-entry" });
      row.appendChild(
        thumbEl(vid.url, { label: `<V${vid.id}>` })
      );
      const grow = el("div", { className: "mmh3-grow" });
      let title = `<Video ${vid.id}>`;
      if (vid.pairedAudioId) {
        title += `  ·  paired <Audio ${vid.pairedAudioId}>`;
      }
      grow.appendChild(el("div", { className: "mmh3-label", text: title }));
      grow.appendChild(
        taggedTextarea({
          value: vState.text,
          placeholder:
            "e.g. the source video for the target video edit…",
          onInput: (e) => {
            state.videos[String(vid.id)] = { text: e.target.value };
            persist();
          },
        })
      );
      appendRetentionFields(grow, retentionEntryFor("video", vid.id), {
        onToggle: () => renderReferences(),
      });
      row.appendChild(grow);
      body.appendChild(row);
    }

    if (audios.length) {
      body.appendChild(
        el("div", {
          className: "mmh3-label",
          text: "Audios",
          style: "margin-top:12px",
        })
      );
    }
    for (const aud of audios) {
      const aState = state.audios[String(aud.id)] || { text: "" };
      const row = el("div", { className: "mmh3-row mmh3-entry" });
      row.appendChild(
        thumbEl(null, {
          label: aud.kind === "paired" ? "♪ paired" : "♪ audio",
        })
      );
      const grow = el("div", { className: "mmh3-grow" });
      let title = `<Audio ${aud.id}>`;
      if (aud.kind === "paired" && aud.videoId) {
        title += `  ·  soundtrack of <Video ${aud.videoId}>`;
      } else {
        title += "  ·  standalone";
      }
      grow.appendChild(el("div", { className: "mmh3-label", text: title }));
      grow.appendChild(
        taggedTextarea({
          value: aState.text,
          placeholder:
            "e.g. the voice-timbre reference for <Subject 1> (S1)…",
          onInput: (e) => {
            state.audios[String(aud.id)] = {
              ...(state.audios[String(aud.id)] || {}),
              text: e.target.value,
              kind: aud.kind,
              video_id: aud.videoId ?? null,
            };
            persist();
          },
        })
      );
      appendRetentionFields(grow, retentionEntryFor("audio", aud.id), {
        onToggle: () => renderReferences(),
      });
      row.appendChild(grow);
      body.appendChild(row);
    }
  }

  function renderSubjects() {
    const body = bodies.subjects;
    body.innerHTML = "";
    ensureRetention(state, pictures, state.subjects, videos, audios);
    syncDerivedFlags(state);
    body.appendChild(
      el("div", {
        className: "mmh3-muted",
        text: "Add subjects and associate pictures.",
      })
    );
    state.subjects.forEach((subject, idx) => {
      const entry = el("div", { className: "mmh3-entry" });
      const head = el("div", { className: "mmh3-row" });
      const firstId = (subject.picture_ids || [])[0];
      const firstPic = firstId != null ? pictureById(firstId) : null;
      head.appendChild(
        thumbEl(firstPic?.url, { label: firstPic ? `P${firstId}` : "Subject" })
      );
      const grow = el("div", { className: "mmh3-grow" });
      grow.appendChild(
        el("div", { className: "mmh3-label", text: `<Subject ${idx + 1}>` })
      );
      grow.appendChild(
        makePicturePicker({
          mode: "multi",
          selectedIds: subject.picture_ids || [],
          onToggle: (id, checked) => {
            const set = new Set(subject.picture_ids || []);
            if (checked) set.add(id);
            else set.delete(id);
            subject.picture_ids = [...set].sort((a, b) => a - b);
            ensureRetention(state, pictures, state.subjects, videos, audios);
            persist();
            renderSubjects();
          },
        })
      );
      grow.appendChild(
        taggedTextarea({
          value: subject.text || "",
          placeholder:
            "e.g. the young woman in <Picture 1>, with long dark hair…",
          onInput: (e) => {
            subject.text = e.target.value;
            persist();
          },
        })
      );
      appendRetentionFields(grow, retentionEntryFor("subject", idx + 1), {
        onToggle: () => renderSubjects(),
      });
      grow.appendChild(
        el("div", { className: "mmh3-toolbar" }, [
          el("button", {
            className: "danger",
            text: "Remove subject",
            type: "button",
            onClick: () => {
              state.subjects.splice(idx, 1);
              // Re-index subject_ids on shots (drop removed / shift down).
              for (const shot of state.shots) {
                shot.subject_ids = (shot.subject_ids || [])
                  .filter((sid) => sid !== idx + 1)
                  .map((sid) => (sid > idx + 1 ? sid - 1 : sid));
              }
              ensureRetention(state, pictures, state.subjects, videos, audios);
              syncDerivedFlags(state);
              persist();
              renderSubjects();
              renderShots();
              renderReferences();
              renderSummary();
            },
          }),
        ])
      );
      head.appendChild(grow);
      entry.appendChild(head);
      body.appendChild(entry);
    });
    body.appendChild(
      el("div", { className: "mmh3-toolbar" }, [
        el("button", {
          text: "+ Add Subject",
          type: "button",
          onClick: () => {
            state.subjects.push({ picture_ids: [], text: "" });
            ensureRetention(state, pictures, state.subjects, videos, audios);
            syncDerivedFlags(state);
            persist();
            renderSubjects();
            renderShots();
            renderReferences();
            renderSummary();
          },
        }),
      ])
    );
  }

  function renderSummary() {
    const body = bodies.summary;
    body.innerHTML = "";
    body.appendChild(
      el("div", {
        className: "mmh3-muted",
        text: "Enable task types for the [prefix] line, then describe the target video.",
      })
    );
    const checks = el("div", { className: "mmh3-pic-grid" });
    for (const t of TASK_TYPES) {
      checks.appendChild(
        el("label", { className: "mmh3-pic-opt" }, [
          el("input", {
            type: "checkbox",
            checked: !!state.summary.task_types[t],
            onChange: (e) => {
              state.summary.task_types[t] = e.target.checked;
              persist();
            },
          }),
          el("span", { text: t }),
        ])
      );
    }
    body.appendChild(checks);
    body.appendChild(
      taggedTextarea({
        value: state.summary.text || "",
        placeholder: "The target video shows <Subject 1> in <Subject 2>…",
        onInput: (e) => {
          state.summary.text = e.target.value;
          persist();
        },
      })
    );
  }

  function renderShots() {
    const body = bodies.shots;
    body.innerHTML = "";
    body.appendChild(
      el("div", { className: "mmh3-label", text: "Style opening" })
    );
    body.appendChild(
      el("div", {
        className: "mmh3-muted",
        text: "One or two English sentences before [Shot 1] establishing overall look (full-reference style opening).",
      })
    );
    body.appendChild(
      taggedTextarea({
        value: state.style_opening || "",
        placeholder:
          "e.g. The target video is in a cinematic, literary music-video style with soft lighting and a slightly desaturated color palette.",
        onInput: (e) => {
          state.style_opening = e.target.value;
          persist();
        },
      })
    );
    body.appendChild(
      el("div", {
        className: "mmh3-label",
        text: "Shots",
        style: "margin-top:10px",
      })
    );
    body.appendChild(
      el("div", {
        className: "mmh3-muted",
        text: "Optional first-frame and storyboard picture slots, subjects that appear, and timed events.",
      })
    );
    state.shots.forEach((shot, idx) => {
      Object.assign(shot, normalizeShot(shot));
      delete shot.picture_id;
      const entry = el("div", { className: "mmh3-shot-box" });
      const head = el("div", { className: "mmh3-row" });
      const firstPicId = shotFirstFramePictureId(shot);
      const headerPic =
        pictureById(firstPicId) ||
        pictureById(shot.references?.[0]?.picture_id);
      head.appendChild(
        thumbEl(headerPic?.url, {
          label: firstPicId
            ? `<P${firstPicId}>`
            : shot.references?.[0]
              ? `<P${shot.references[0].picture_id}>`
              : "Shot",
        })
      );
      const grow = el("div", { className: "mmh3-grow" });
      grow.appendChild(
        el("div", { className: "mmh3-label", text: `[Shot ${idx + 1}]` })
      );

      grow.appendChild(
        el("div", { className: "mmh3-label", text: "References" })
      );
      grow.appendChild(makeShotReferencesEditor(shot, idx));

      grow.appendChild(
        el("div", {
          className: "mmh3-label",
          text: "Subjects in this shot",
        })
      );
      grow.appendChild(
        makeSubjectPicker({
          selectedIds: shot.subject_ids || [],
          onToggle: (sid, checked) => {
            const set = new Set(shot.subject_ids || []);
            if (checked) set.add(sid);
            else set.delete(sid);
            shot.subject_ids = [...set].sort((a, b) => a - b);
            applyAutoRetentionContext(state);
            persist();
            renderShots();
            renderReferences();
            renderSubjects();
          },
        })
      );

      grow.appendChild(el("div", { className: "mmh3-label", text: "Events" }));

      let timelineDirty = false;
      let dragFrom = null;
      shot.events.forEach((ev, ei) => {
        const minT = minTimeForEvent(state.shots, idx, ei);
        if (clampEventToMin(ev, minT)) timelineDirty = true;

        const row = el("div", {
          className:
            "mmh3-event-row" + (ev.enabled === false ? " disabled" : ""),
        });
        row.dataset.eventIndex = String(ei);

        const controls = el("div", { className: "mmh3-event-controls" });
        const dragBtn = el("button", {
          className: "mmh3-drag-handle",
          type: "button",
          text: "⠿",
          title: "Drag to reorder",
          draggable: "true",
        });
        dragBtn.addEventListener("dragstart", (e) => {
          dragFrom = ei;
          row.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(ei));
        });
        dragBtn.addEventListener("dragend", () => {
          dragFrom = null;
          row.classList.remove("dragging");
          grow
            .querySelectorAll(".mmh3-event-row.drag-over")
            .forEach((n) => n.classList.remove("drag-over"));
        });
        controls.appendChild(dragBtn);
        controls.appendChild(
          el("input", {
            type: "checkbox",
            checked: ev.enabled !== false,
            title: "Include this event in the prompt",
            onChange: (e) => {
              ev.enabled = !!e.target.checked;
              persist();
              renderShots();
            },
          })
        );
        row.appendChild(controls);

        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          row.classList.add("drag-over");
        });
        row.addEventListener("dragleave", () => {
          row.classList.remove("drag-over");
        });
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          row.classList.remove("drag-over");
          const from = dragFrom ?? parseInt(e.dataTransfer.getData("text/plain"), 10);
          const to = ei;
          if (!Number.isFinite(from) || from === to) return;
          const [moved] = shot.events.splice(from, 1);
          shot.events.splice(to, 0, moved);
          persist();
          renderShots();
        });

        const box = el("div", { className: "mmh3-event" });
        const timeRow = el("div", { className: "mmh3-time-row" });
        const isOpening = idx === 0 && ei === 0;

        if (isOpening) {
          timeRow.appendChild(
            el("span", {
              className: "mmh3-muted",
              text: "Opening (time omitted in prompt)",
            })
          );
        } else {
          timeRow.appendChild(el("span", { text: "00 :" }));
          const secOpts = allowedSeconds(minT);
          const msOptsFor = (sec) => {
            const opts = allowedMillis(sec, minT);
            return opts.length
              ? opts
              : allowedMillis(secOpts[0] ?? minT?.sec ?? 0, minT);
          };

          const secSel = el("select", { className: "mmh3-time" });
          for (const s of secOpts) {
            const o = el("option", {
              value: String(s),
              text: String(s).padStart(2, "0"),
            });
            if (s === ev.sec) o.selected = true;
            secSel.appendChild(o);
          }
          if (!secOpts.includes(ev.sec) && secOpts.length) {
            ev.sec = secOpts[0];
            timelineDirty = true;
          }

          let msOpts = msOptsFor(ev.sec);
          if (!msOpts.includes(ev.ms) && msOpts.length) {
            ev.ms = msOpts[0];
            timelineDirty = true;
          }

          const msSel = el("select", { className: "mmh3-time" });
          const refillMs = (sec) => {
            msSel.innerHTML = "";
            msOpts = msOptsFor(sec);
            for (const m of msOpts) {
              const o = el("option", {
                value: String(m),
                text: String(m).padStart(3, "0"),
              });
              if (m === ev.ms) o.selected = true;
              msSel.appendChild(o);
            }
            if (!msOpts.includes(ev.ms) && msOpts.length) {
              ev.ms = msOpts[0];
              msSel.value = String(ev.ms);
            }
          };
          refillMs(ev.sec);

          secSel.addEventListener("change", () => {
            ev.sec = parseInt(secSel.value, 10);
            refillMs(ev.sec);
            persist();
            renderShots();
          });
          msSel.addEventListener("change", () => {
            ev.ms = parseInt(msSel.value, 10);
            persist();
            renderShots();
          });

          timeRow.appendChild(secSel);
          timeRow.appendChild(el("span", { text: " :" }));
          timeRow.appendChild(msSel);
          if (minT) {
            const prev = previousTimelineEvent(state.shots, idx, ei);
            timeRow.appendChild(
              el("span", {
                className: "mmh3-muted",
                text: prev ? `(after ${formatTs(prev.sec, prev.ms)})` : "",
              })
            );
          }
        }

        box.appendChild(timeRow);
        box.appendChild(
          taggedTextarea({
            value: ev.text || "",
            placeholder: "Event description…",
            onInput: (e) => {
              ev.text = e.target.value;
              persist();
            },
          })
        );
        const tools = el("div", { className: "mmh3-toolbar" });
        if (shot.events.length > 1) {
          tools.appendChild(
            el("button", {
              className: "danger",
              text: "Remove event",
              type: "button",
              onClick: () => {
                shot.events.splice(ei, 1);
                persist();
                renderShots();
              },
            })
          );
        }
        box.appendChild(tools);
        row.appendChild(box);
        grow.appendChild(row);
      });
      if (timelineDirty) persist();

      grow.appendChild(
        el("div", { className: "mmh3-toolbar" }, [
          el("button", {
            text: "+ Add Event",
            type: "button",
            onClick: () => {
              const last = shot.events[shot.events.length - 1];
              const t = last
                ? nextSelectableTime(last.sec, last.ms)
                : minTimeForEvent(state.shots, idx, 0) || { sec: 0, ms: 0 };
              shot.events.push({
                sec: t.sec,
                ms: t.ms,
                text: "",
                enabled: true,
              });
              persist();
              renderShots();
            },
          }),
          el("button", {
            className: "danger",
            text: "Remove shot",
            type: "button",
            onClick: () => {
              state.shots.splice(idx, 1);
              applyAutoRetentionContext(state);
              persist();
              renderShots();
              renderReferences();
              renderSubjects();
            },
          }),
        ])
      );
      head.appendChild(grow);
      entry.appendChild(head);
      body.appendChild(entry);
    });
    body.appendChild(
      el("div", { className: "mmh3-toolbar" }, [
        el("button", {
          text: "+ Add Shot",
          type: "button",
          onClick: () => {
            const prevShot = state.shots[state.shots.length - 1];
            const lastEv = prevShot?.events?.[prevShot.events.length - 1];
            const t = lastEv
              ? nextShotStartTime(lastEv.sec, lastEv.ms)
              : { sec: 0, ms: 0 };
            state.shots.push({
              references: [],
              subject_ids: [],
              events: [{ sec: t.sec, ms: t.ms, text: "", enabled: true }],
            });
            persist();
            renderShots();
          },
        }),
      ])
    );
  }

  function renderSounds() {
    const body = bodies.sounds;
    body.innerHTML = "";

    body.appendChild(
      el("div", { className: "mmh3-label", text: "Overall soundscape" })
    );
    body.appendChild(
      el("div", {
        className: "mmh3-muted",
        text: "Ambience and physical sounds across the full video.",
      })
    );
    body.appendChild(
      taggedTextarea({
        value: state.overall_soundscape || "",
        placeholder: "Ambience and physical sounds across the full video…",
        onInput: (e) => {
          state.overall_soundscape = e.target.value;
          persist();
        },
      })
    );

    body.appendChild(
      el("div", {
        className: "mmh3-label",
        text: "Non-diegetic music",
        style: "margin-top:10px",
      })
    );
    body.appendChild(
      el("label", { className: "mmh3-inline" }, [
        el("input", {
          type: "checkbox",
          checked: !!state.non_diegetic_music.enabled,
          onChange: (e) => {
            state.non_diegetic_music.enabled = e.target.checked;
            persist();
            renderSounds();
          },
        }),
        el("span", { text: "Enable non-diegetic music" }),
      ])
    );
    if (state.non_diegetic_music.enabled) {
      body.appendChild(
        taggedTextarea({
          value: state.non_diegetic_music.text || "",
          placeholder: "Instrumentation, tempo, dynamics…",
          onInput: (e) => {
            state.non_diegetic_music.text = e.target.value;
            persist();
          },
        })
      );
    } else {
      body.appendChild(
        el("div", {
          className: "mmh3-muted",
          text: 'Outputs "N/A" when disabled.',
        })
      );
    }
  }

  function renderDebug() {
    const body = bodies.debug;
    body.innerHTML = "";
    body.appendChild(
      el("div", {
        className: "mmh3-muted",
        text: "Editable prompt_state JSON. Parse & load applies it to the UI (and saved widget). Use after node updates or to restore from a backup.",
      })
    );
    const status = el("div", { className: "mmh3-muted", text: "" });
    const ta = el("textarea", {
      className: "mmh3-debug-json",
      value: JSON.stringify(state, null, 2),
      spellcheck: false,
    });
    body.appendChild(ta);
    body.appendChild(
      el("div", { className: "mmh3-toolbar", style: "margin-top:8px" }, [
        el("button", {
          text: "Refresh from node",
          type: "button",
          onClick: () => {
            ta.value = JSON.stringify(state, null, 2);
            status.textContent = "Refreshed from current UI state.";
          },
        }),
        el("button", {
          text: "Parse & load into node",
          type: "button",
          onClick: () => {
            try {
              const raw = ta.value;
              JSON.parse(raw); // validate
              state = parseState(raw);
              lastSig = "";
              refreshFromGraph({ force: true });
              persist({ force: true });
              ta.value = JSON.stringify(state, null, 2);
              status.textContent = "Loaded into node successfully.";
              status.style.color = "#8c8";
            } catch (err) {
              status.textContent = `Parse error: ${err?.message || err}`;
              status.style.color = "#f88";
            }
          },
        }),
      ])
    );
    body.appendChild(status);
  }

  function renderAll() {
    renderReferences();
    renderSubjects();
    renderSummary();
    renderShots();
    renderSounds();
    if (activeTab === "debug") renderDebug();
    persist();
  }

  let lastSig = "";
  function refreshFromGraph({ force = false } = {}) {
    const sig = graphLinksSignature(node);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const media = connectedMedia(node);
    pictures = media.pictures;
    videos = media.videos;
    audios = media.audios;
    syncMediaState(state, media);
    ensureRetention(state, pictures, state.subjects, videos, audios);
    syncDerivedFlags(state);
    renderAll();
  }

  refreshFromGraph({ force: true });

  return {
    root,
    refreshFromGraph,
    getState: () => state,
    setState: (raw) => {
      state = parseState(raw);
      lastSig = "";
      refreshFromGraph({ force: true });
    },
    setDebugVisible,
    isDebugVisible: () => !!node.properties?.mmh3ShowDebug,
    /** Call after workflow values are applied (or for a brand-new node). */
    markPersistReady: () => {
      node._mmh3PersistReady = true;
      persist({ force: true });
    },
    flushToWidget: () => persist({ force: true }),
  };
}

app.registerExtension({
  name: "Comfy.MiniMaxH3PromptFormatter",
  getNodeMenuItems(node) {
    const type = node?.comfyClass || node?.type || "";
    if (type !== NODE_TYPE) return [];
    const showing = !!node.properties?.mmh3ShowDebug;
    return [
      {
        content: showing
          ? "Hide MiniMax H3 Debug tab"
          : "Show MiniMax H3 Debug tab",
        callback: () => {
          const next = !showing;
          if (!node.properties) node.properties = {};
          node.properties.mmh3ShowDebug = next;
          node.mmh3Ui?.setDebugVisible?.(next);
        },
      },
    ];
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const name = nodeData?.name || nodeType?.comfyClass || "";
    if (name !== NODE_TYPE) return;

    // Fallback for older frontends without getNodeMenuItems.
    const prevMenu = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const r = prevMenu?.apply(this, arguments);
      const showing = !!this.properties?.mmh3ShowDebug;
      options?.push?.(null, {
        content: showing
          ? "Hide MiniMax H3 Debug tab"
          : "Show MiniMax H3 Debug tab",
        callback: () => {
          const next = !showing;
          if (!this.properties) this.properties = {};
          this.properties.mmh3ShowDebug = next;
          this.mmh3Ui?.setDebugVisible?.(next);
        },
      });
      return r;
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);

      const stateWidget =
        this.widgets?.find((w) => w.name === "prompt_state") ||
        this.addWidget(
          "text",
          "prompt_state",
          JSON.stringify(DEFAULT_STATE),
          () => {}
        );

      // Block widget writes until configure hydrates (or new-node timeout).
      this._mmh3PersistReady = false;
      this._mmh3Configured = false;
      if (!this.properties) this.properties = {};
      if (typeof this.properties.mmh3ShowDebug !== "boolean") {
        this.properties.mmh3ShowDebug = false;
      }

      hideWidget(stateWidget);
      // Re-hide after Comfy finishes building widgets (prevents leftover textarea).
      queueMicrotask(() => hideWidget(stateWidget));
      requestAnimationFrame(() => hideWidget(stateWidget));

      const ui = createFormatterUI(this, stateWidget);
      ui.root.style.height = "100%";
      ui.root.style.minHeight = "100%";
      const domWidget = this.addDOMWidget(
        "mmh3_formatter_ui",
        "mmh3_formatter",
        ui.root,
        {
          serialize: false,
          hideOnZoom: false,
          getMinHeight: () => 400,
          getHeight: () => {
            const nodeH = this.size?.[1] ?? 920;
            // Leave room for title + input slots above the DOM widget.
            return Math.max(400, nodeH - 120);
          },
        }
      );
      // DOM chrome must not occupy a widgets_values slot — and MUST be last
      // so skipped serialize indexes do not shift prompt_state on load.
      if (domWidget) {
        domWidget.serialize = false;
        if (domWidget.options) domWidget.options.serialize = false;
      }
      this.mmh3Ui = ui;

      const prevResize = this.onResize;
      this.onResize = function () {
        const result = prevResize?.apply(this, arguments);
        // Recompute DOM widget height from node.size (see getHeight above).
        this.setDirtyCanvas?.(true, true);
        return result;
      };

      // API prompt path reads serializeValue when present.
      stateWidget.serializeValue = () => {
        if (this.mmh3Ui?.getState) {
          return JSON.stringify(this.mmh3Ui.getState());
        }
        return stateWidget.value;
      };

      // Flush UI → prompt_state + properties before LiteGraph reads widget.value.
      const prevSerialize = this.serialize;
      this.serialize = function () {
        try {
          const w = this.widgets?.find((x) => x.name === "prompt_state") || stateWidget;
          if (this.mmh3Ui?.getState) {
            const json = JSON.stringify(this.mmh3Ui.getState());
            writePromptState(this, w, json);
            hideWidget(w);
          }
        } catch (_) {
          /* ignore */
        }
        return prevSerialize?.apply(this, arguments);
      };

      const prevOnSerialize = this.onSerialize;
      this.onSerialize = function (o) {
        try {
          const w = this.widgets?.find((x) => x.name === "prompt_state") || stateWidget;
          const json = this.mmh3Ui?.getState
            ? JSON.stringify(this.mmh3Ui.getState())
            : w?.value;
          if (json != null) {
            writePromptState(this, w, json);
            if (o) {
              if (!o.properties) o.properties = {};
              o.properties[STATE_PROP] = json;
              try {
                const parsed = JSON.parse(json);
                if (parsed?.saved_prompt) {
                  o.properties[SAVED_PROMPT_PROP] = parsed.saved_prompt;
                }
              } catch (_) {
                /* ignore */
              }
              if (this.widgets && Array.isArray(o.widgets_values)) {
                for (const [i, widget] of this.widgets.entries()) {
                  if (widget.serialize === false) continue;
                  if (widget.name === "prompt_state") {
                    o.widgets_values[i] = json;
                  }
                }
              }
            }
          }
        } catch (_) {
          /* ignore */
        }
        return prevOnSerialize?.apply(this, arguments);
      };

      const prevConnections = this.onConnectionsChange;
      this.onConnectionsChange = function () {
        const result = prevConnections?.apply(this, arguments);
        syncAutogrowSlots(this);
        queueMicrotask(() => {
          syncAutogrowSlots(this);
          ui.refreshFromGraph({ force: true });
        });
        return result;
      };

      const prevConfigure = this.onConfigure;
      this.onConfigure = function (info) {
        const result = prevConfigure?.apply(this, arguments);
        this._mmh3Configured = true;
        // Keep persist blocked until we apply saved JSON (avoids race with
        // onConnectionsChange microtasks that would persist DEFAULT_STATE).
        this._mmh3PersistReady = false;
        const saved = resolveSavedPromptState(this, stateWidget, info);
        queueMicrotask(() => {
          syncAutogrowSlots(this);
          const w = this.widgets?.find((x) => x.name === "prompt_state") || stateWidget;
          hideWidget(w);
          writePromptState(this, w, saved);
          ui.setState(saved);
          ui.setDebugVisible?.(!!this.properties?.mmh3ShowDebug);
          ui.markPersistReady();
        });
        return result;
      };

      // Brand-new node (not loaded from workflow): enable persist shortly.
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (!this._mmh3Configured) ui.markPersistReady();
        }, 0);
      });

      const poll = setInterval(() => {
        if (!this.graph) {
          clearInterval(poll);
          return;
        }
        ui.refreshFromGraph();
      }, 750);
      this._mmh3Poll = poll;

      const prevRemoved = this.onRemoved;
      this.onRemoved = function () {
        if (this._mmh3Poll) clearInterval(this._mmh3Poll);
        return prevRemoved?.apply(this, arguments);
      };

      syncAutogrowSlots(this);
      // Larger default size once (does not fight later user resizes).
      // LiteGraph canvas grid is 10px → 50 tiles = 500px wide.
      if (!this.properties) this.properties = {};
      if (!this.properties.mmh3DefaultSized) {
        this.properties.mmh3DefaultSized = true;
        this.setSize?.([50 * 10, 920]);
      }
      return r;
    };
  },
});

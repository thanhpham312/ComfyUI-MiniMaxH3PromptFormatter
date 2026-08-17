"""Assemble MiniMax H3 full-reference rewrite prompts from structured UI state."""

from __future__ import annotations

import json
from typing import Any

TASK_TYPES = [
    "keyframe completion",
    "reference generation",
    "video editing",
    "video continuation",
    "audio reuse",
    "audio reference",
]

RETENTION_MARKERS = [
    "fully_preserved",
    "partially_preserved",
    "attribute_transfer",
    "weak_reference",
]

AUDIO_RETENTION_MARKERS = [
    "fully_copy",
    "partially_copy",
    "reference",
    "weak_reference",
]

DEFAULT_STATE: dict[str, Any] = {
    "pictures": {},
    "videos": {},
    "audios": {},
    "subjects": [],
    "summary": {
        "task_types": {t: t == "reference generation" for t in TASK_TYPES},
        "text": "",
    },
    "retention": [],
    "style_opening": "",
    "shots": [],
    "overall_soundscape": "",
    "non_diegetic_music": {"enabled": False, "text": ""},
    # Last assembled prompt — survives UI/schema updates when structured
    # fields fail to migrate. Updated by the frontend on every edit.
    "saved_prompt": "",
}


def _normalize_ref_role(role: Any) -> str:
    r = str(role or "").strip().lower().replace(" ", "_")
    if r in ("storyboard", "storyboard_reference", "storyboard_ref"):
        return "storyboard"
    return "first_frame"


def _normalize_shot_references(shot: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize shot picture refs: at most one first_frame and one storyboard."""
    raw = shot.get("references")
    refs: list[dict[str, Any]] = []
    seen: set[int] = set()
    if isinstance(raw, list) and raw:
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                pid = int(item.get("picture_id"))
            except (TypeError, ValueError):
                continue
            if pid in seen:
                continue
            seen.add(pid)
            refs.append(
                {"picture_id": pid, "role": _normalize_ref_role(item.get("role"))}
            )
    else:
        pic = shot.get("picture_id")
        try:
            pic = int(pic) if pic is not None and pic != "" else None
        except (TypeError, ValueError):
            pic = None
        if pic is not None:
            refs.append({"picture_id": pic, "role": "first_frame"})

    first: dict[str, Any] | None = None
    board: dict[str, Any] | None = None
    for ref in refs:
        if ref["role"] == "first_frame":
            if first is None:
                first = ref
            elif board is None and ref["picture_id"] != first["picture_id"]:
                board = {"picture_id": ref["picture_id"], "role": "storyboard"}
        elif board is None:
            if first is None or ref["picture_id"] != first["picture_id"]:
                board = ref
    out: list[dict[str, Any]] = []
    if first is not None:
        out.append(first)
    if board is not None:
        out.append(board)
    return out


def _shot_has_first_frame(shots: list[dict[str, Any]]) -> bool:
    for shot in shots or []:
        for ref in _normalize_shot(shot).get("references") or []:
            if ref.get("role") == "first_frame":
                return True
    return False


def _sync_derived_flags(state: dict[str, Any]) -> None:
    """Auto-enable keyframe completion + picture retention for first-frame refs."""
    shots = state.get("shots") or []
    if _shot_has_first_frame(shots):
        state.setdefault("summary", {}).setdefault("task_types", {})[
            "keyframe completion"
        ] = True

    first_frame_ids: set[int] = set()
    for shot in shots:
        for ref in _normalize_shot(shot).get("references") or []:
            if ref.get("role") == "first_frame":
                try:
                    first_frame_ids.add(int(ref["picture_id"]))
                except (TypeError, ValueError, KeyError):
                    continue

    for entry in state.get("retention") or []:
        if entry.get("kind") != "picture":
            continue
        try:
            pid = int(entry.get("pictureId") or 0)
        except (TypeError, ValueError):
            continue
        if pid in first_frame_ids:
            entry["enabled"] = True


def _normalize_shot(shot: dict[str, Any]) -> dict[str, Any]:
    """Migrate legacy shot.text into events[], ensure at least one event."""
    if not isinstance(shot, dict):
        return {
            "references": [],
            "subject_ids": [],
            "events": [{"sec": 0, "ms": 0, "text": ""}],
        }
    events = shot.get("events")
    if not isinstance(events, list) or not events:
        legacy = (shot.get("text") or "").strip()
        events = [{"sec": 0, "ms": 0, "text": legacy}]
    normalized_events = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        try:
            sec = int(ev.get("sec", 0))
        except (TypeError, ValueError):
            sec = 0
        try:
            ms = int(ev.get("ms", 0))
        except (TypeError, ValueError):
            ms = 0
        sec = max(0, min(15, sec))
        ms = max(0, min(900, (ms // 100) * 100))
        normalized_events.append(
            {"sec": sec, "ms": ms, "text": ev.get("text") or ""}
        )
    if not normalized_events:
        normalized_events = [{"sec": 0, "ms": 0, "text": ""}]
    subject_ids = []
    for s in shot.get("subject_ids") or []:
        try:
            subject_ids.append(int(s))
        except (TypeError, ValueError):
            continue
    subject_ids = sorted(set(subject_ids))
    return {
        "references": _normalize_shot_references(shot),
        "subject_ids": subject_ids,
        "events": normalized_events,
    }


def parse_state(raw: str | dict | None) -> dict[str, Any]:
    if raw is None or raw == "":
        return json.loads(json.dumps(DEFAULT_STATE))
    if isinstance(raw, dict):
        data = raw
    else:
        try:
            data = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            data = {}
    merged = json.loads(json.dumps(DEFAULT_STATE))
    if not isinstance(data, dict):
        return merged
    merged["pictures"] = data.get("pictures") or {}
    merged["videos"] = data.get("videos") or {}
    merged["audios"] = data.get("audios") or {}
    merged["subjects"] = data.get("subjects") or []
    summary = data.get("summary") or {}
    merged["summary"]["text"] = summary.get("text") or ""
    task_types = summary.get("task_types") or {}
    for t in TASK_TYPES:
        if t in task_types:
            merged["summary"]["task_types"][t] = bool(task_types[t])
    merged["retention"] = data.get("retention") or []
    merged["style_opening"] = data.get("style_opening") or ""
    merged["shots"] = [_normalize_shot(s) for s in (data.get("shots") or [])]
    merged["overall_soundscape"] = data.get("overall_soundscape") or ""
    ndm = data.get("non_diegetic_music") or {}
    merged["non_diegetic_music"]["enabled"] = bool(ndm.get("enabled", False))
    merged["non_diegetic_music"]["text"] = ndm.get("text") or ""
    merged["saved_prompt"] = data.get("saved_prompt") or ""
    return merged


def state_has_user_content(state: dict[str, Any]) -> bool:
    """True when structured fields hold more than empty defaults."""
    if (state.get("summary") or {}).get("text", "").strip():
        return True
    for subject in state.get("subjects") or []:
        if (subject.get("text") or "").strip() or subject.get("picture_ids"):
            return True
    for pic in (state.get("pictures") or {}).values():
        if isinstance(pic, dict) and (pic.get("text") or "").strip():
            return True
        if isinstance(pic, str) and pic.strip():
            return True
    for vid in (state.get("videos") or {}).values():
        if isinstance(vid, dict) and (vid.get("text") or "").strip():
            return True
    for aud in (state.get("audios") or {}).values():
        if isinstance(aud, dict) and (aud.get("text") or "").strip():
            return True
    for entry in state.get("retention") or []:
        if (entry.get("text") or "").strip():
            return True
        if entry.get("kind") in ("picture", "video", "audio") and entry.get("enabled"):
            return True
        marker = entry.get("marker") or "fully_preserved"
        if entry.get("kind") == "subject" and marker != "fully_preserved":
            return True
    if (state.get("style_opening") or "").strip():
        return True
    for shot in state.get("shots") or []:
        nshot = _normalize_shot(shot)
        if nshot.get("references") or nshot.get("subject_ids"):
            return True
        for ev in nshot.get("events") or []:
            if (ev.get("text") or "").strip():
                return True
        if (shot.get("text") or "").strip():
            return True
    if (state.get("overall_soundscape") or "").strip():
        return True
    ndm = state.get("non_diegetic_music") or {}
    if ndm.get("enabled") and (ndm.get("text") or "").strip():
        return True
    return False


def resolve_prompt_output(
    state_raw: str | dict | None,
    ref_images: dict | None = None,
    ref_videos: dict | None = None,
    ref_video_audios: dict | None = None,
    ref_audios: dict | None = None,
) -> str:
    """Build from structured state; fall back to saved_prompt when structure is empty."""
    state = parse_state(state_raw)
    built = build_prompt(
        state, ref_images, ref_videos, ref_video_audios, ref_audios
    )
    saved = (state.get("saved_prompt") or "").strip()
    if saved and not state_has_user_content(state):
        return saved if saved.endswith("\n") else saved + "\n"
    return built


def _sorted_connected_slots(ref_map: dict | None) -> list[tuple[int, Any]]:
    """Return (slot_index, value) for non-null refs, sorted by slot index."""
    if not ref_map:
        return []
    items: list[tuple[int, Any]] = []
    for name, val in ref_map.items():
        if val is None:
            continue
        suffix = str(name).rsplit("_", 1)[-1]
        try:
            slot = int(suffix)
        except ValueError:
            slot = len(items) + 1
        items.append((slot, val))
    items.sort(key=lambda x: x[0])
    return items


def connected_picture_ids(ref_images: dict | None) -> list[int]:
    """Return 1-based Picture indices for non-null ref images in connection order."""
    return list(range(1, len(_sorted_connected_slots(ref_images)) + 1))


def resolve_media_labels(
    ref_images: dict | None = None,
    ref_videos: dict | None = None,
    ref_video_audios: dict | None = None,
    ref_audios: dict | None = None,
) -> dict[str, Any]:
    """Match MiniMaxH3ReferenceToVideo presentation order.

    Images first → Picture 1..N.
    For each video: optional paired soundtrack gets the next Audio ordinal,
    then the Video ordinal. Standalone audios follow.
    """
    pictures = [{"id": i} for i in connected_picture_ids(ref_images)]
    videos: list[dict[str, Any]] = []
    audios: list[dict[str, Any]] = []
    audio_n = 0
    video_n = 0
    video_audios = ref_video_audios or {}
    for slot, _video in _sorted_connected_slots(ref_videos):
        paired_key = f"ref_video_audio_{slot}"
        paired = video_audios.get(paired_key)
        paired_audio_id = None
        if paired is not None:
            audio_n += 1
            paired_audio_id = audio_n
            audios.append(
                {
                    "id": audio_n,
                    "kind": "paired",
                    "video_id": video_n + 1,
                    "video_slot": slot,
                }
            )
        video_n += 1
        videos.append(
            {
                "id": video_n,
                "slot": slot,
                "paired_audio_id": paired_audio_id,
            }
        )
    for _slot, _audio in _sorted_connected_slots(ref_audios):
        audio_n += 1
        audios.append({"id": audio_n, "kind": "standalone", "video_id": None})
    return {"pictures": pictures, "videos": videos, "audios": audios}


def _picture_mentions(text: str, picture_ids: list[int]) -> bool:
    return any(f"<Picture {pid}>" in text for pid in picture_ids)


_SENTENCE_END_CHARS = ".!?…"


def _strip_trailing_sentence_punct(text: str) -> str:
    """Remove trailing .!?… (and spaces) so a fragment can sit mid-sentence."""
    t = (text or "").strip()
    while t and t[-1] in _SENTENCE_END_CHARS:
        t = t[:-1].rstrip()
    return t.strip()


def as_clause(text: str) -> str:
    """Normalize user text injected into the middle of a sentence (no terminal .)."""
    return _strip_trailing_sentence_punct(text)


def as_sentence(text: str) -> str:
    """Normalize user text that should stand as / end a sentence (ensure terminal .)."""
    t = (text or "").strip()
    if not t:
        return t
    # Keep ! ? … if the user chose them; only add . when missing.
    if t[-1] in _SENTENCE_END_CHARS:
        return t
    return t + "."


def _format_subject_line(index: int, picture_ids: list[int], text: str) -> str:
    text = (text or "").strip()
    pics = ", ".join(f"<Picture {pid}>" for pid in picture_ids)
    if text:
        if picture_ids and not _picture_mentions(text, picture_ids):
            # Clause before ", from <Picture N>." — strip a trailing stop.
            return f"<Subject {index}> is {as_clause(text)}, from {pics}."
        # Predicate after "is …" closes the sentence; keep !?… if present.
        return f"<Subject {index}> is {as_sentence(text)}"
    if pics:
        return f"<Subject {index}> is defined by {pics}."
    return f"<Subject {index}> is an undefined subject."


def _join_shot_labels(shot_indices: list[int]) -> str:
    labels = [f"[Shot {i}]" for i in shot_indices]
    if not labels:
        return ""
    if len(labels) == 1:
        return labels[0]
    if len(labels) == 2:
        return f"{labels[0]} and {labels[1]}"
    return ", ".join(labels[:-1]) + f", and {labels[-1]}"


def _picture_role_shots(
    picture_id: int, shots: list[dict[str, Any]]
) -> tuple[list[int], list[int]]:
    """Return (first_frame_shot_indices, storyboard_shot_indices) for a picture."""
    first_frames: list[int] = []
    storyboards: list[int] = []
    for i, shot in enumerate(shots, start=1):
        for ref in _normalize_shot(shot).get("references") or []:
            if ref.get("picture_id") != picture_id:
                continue
            if ref.get("role") == "storyboard":
                if i not in storyboards:
                    storyboards.append(i)
            else:
                if i not in first_frames:
                    first_frames.append(i)
    return first_frames, storyboards


def _format_picture_line(
    index: int,
    text: str,
    first_frame_shots: list[int] | None = None,
    storyboard_shots: list[int] | None = None,
) -> str | None:
    text = (text or "").strip()
    first_frame_shots = first_frame_shots or []
    storyboard_shots = storyboard_shots or []
    if text.lower().startswith("<picture"):
        return as_sentence(text)

    if first_frame_shots or storyboard_shots:
        clauses: list[str] = []
        if first_frame_shots:
            clauses.append(
                f"the first frame of {_join_shot_labels(first_frame_shots)}"
            )
        if storyboard_shots:
            clauses.append(
                f"a storyboard reference for {_join_shot_labels(storyboard_shots)}"
            )
        role = " and ".join(clauses)
        if text:
            if first_frame_shots and not storyboard_shots:
                return as_sentence(
                    f"<Picture {index}> is {role}, showing {as_clause(text)}"
                )
            return as_sentence(f"<Picture {index}> is {role}, {as_clause(text)}")
        return as_sentence(f"<Picture {index}> is {role}")

    if not text:
        return None
    return f"<Picture {index}> is {as_sentence(text)}"


def _format_video_line(index: int, text: str) -> str | None:
    text = (text or "").strip()
    if not text:
        return None
    if text.lower().startswith("<video"):
        return as_sentence(text)
    return f"<Video {index}> is {as_sentence(text)}"


def _format_audio_line(index: int, text: str) -> str | None:
    text = (text or "").strip()
    if not text:
        return None
    if text.lower().startswith("<audio"):
        return as_sentence(text)
    return f"<Audio {index}> is {as_sentence(text)}"


def _format_summary(state: dict[str, Any]) -> str:
    enabled = [t for t in TASK_TYPES if state["summary"]["task_types"].get(t)]
    prefix = " + ".join(enabled) if enabled else "reference generation"
    body = (state["summary"].get("text") or "").strip()
    if body:
        return f"[{prefix}] {as_sentence(body)}"
    return f"[{prefix}]"


def _format_retention_line(entry: dict[str, Any]) -> str | None:
    if not entry.get("enabled", True):
        return None
    label = (entry.get("label") or "").strip()
    if not label:
        return None
    kind = entry.get("kind") or ""
    if kind == "audio":
        allowed = AUDIO_RETENTION_MARKERS
        default_marker = "reference"
    else:
        allowed = RETENTION_MARKERS
        default_marker = "fully_preserved"
    marker = entry.get("marker") or default_marker
    if marker not in allowed:
        marker = default_marker
    context = (entry.get("context") or "").strip()
    detail = (entry.get("text") or "").strip()
    if context:
        head = f"{label} ({context}): {marker}"
    else:
        head = f"{label}: {marker}"
    if detail:
        return f"{head} - {as_sentence(detail)}"
    return f"{head}."


def _subject_appears_context(subject_index: int, shots: list[dict[str, Any]]) -> str:
    found = []
    for i, shot in enumerate(shots, start=1):
        sids = _normalize_shot(shot).get("subject_ids") or []
        if subject_index in sids:
            found.append(f"[Shot {i}]")
    if not found:
        return ""
    return f"appears in {', '.join(found)}"


def _picture_reference_context(picture_id: int, shots: list[dict[str, Any]]) -> str:
    found = []
    for i, shot in enumerate(shots, start=1):
        for ref in _normalize_shot(shot).get("references") or []:
            if ref.get("picture_id") != picture_id:
                continue
            if ref.get("role") == "storyboard":
                found.append(f"[Shot {i}] storyboard")
            else:
                found.append(f"[Shot {i}] first frame")
    return ", ".join(found)


def _enrich_retention_contexts(state: dict[str, Any]) -> None:
    """Fill retention context from shot associations (subjects / first frames)."""
    _sync_derived_flags(state)
    shots = state.get("shots") or []
    for entry in state.get("retention") or []:
        key = entry.get("key") or ""
        if key.startswith("subject:") or (entry.get("label") or "").startswith(
            "<Subject"
        ):
            try:
                sid = int(entry.get("subjectIndex") or key.split(":")[-1])
            except (TypeError, ValueError):
                continue
            entry["context"] = _subject_appears_context(sid, shots)
        elif key.startswith("picture:") or (entry.get("label") or "").startswith(
            "<Picture"
        ):
            try:
                pid = int(entry.get("pictureId") or key.split(":")[-1])
            except (TypeError, ValueError):
                continue
            entry["context"] = _picture_reference_context(pid, shots)


def _format_timestamp(sec: int, ms: int) -> str:
    return f"00:{int(sec):02d}.{int(ms):03d}"


def _shot_first_frame_picture_id(shot: dict[str, Any]) -> int | None:
    for ref in shot.get("references") or []:
        if ref.get("role") == "first_frame":
            return ref.get("picture_id")
    return None


def _format_shot_block(index: int, shot: dict[str, Any]) -> str:
    shot = _normalize_shot(shot)
    picture_id = _shot_first_frame_picture_id(shot)
    events = shot.get("events") or []
    lines: list[str] = []
    for ei, ev in enumerate(events):
        text = (ev.get("text") or "").strip()
        parts: list[str] = []
        if ei == 0 and picture_id:
            mention = f"<Picture {picture_id}>"
            if mention not in text:
                parts.append(f"the shot begins from {mention}.")
        if text:
            # Freeform shot prose — keep internal punctuation; ensure the
            # event line ends as a sentence when this is the only/last part.
            parts.append(text)
        body = " ".join(parts).strip() or "..."
        if body != "...":
            body = as_sentence(body)
        if ei == 0:
            if index == 1:
                lines.append(f"[Shot {index}] {body}")
            else:
                ts = _format_timestamp(ev.get("sec", 0), ev.get("ms", 0))
                lines.append(f"[Shot {index}] At {ts}, {body}")
        else:
            # Extra events in the same shot: timestamp only (no repeated [Shot N]).
            ts = _format_timestamp(ev.get("sec", 0), ev.get("ms", 0))
            lines.append(f"At {ts}, {body}")
    return "\n".join(lines)


def build_prompt(
    state_raw: str | dict | None,
    ref_images: dict | None = None,
    ref_videos: dict | None = None,
    ref_video_audios: dict | None = None,
    ref_audios: dict | None = None,
) -> str:
    state = parse_state(state_raw)
    media = resolve_media_labels(ref_images, ref_videos, ref_video_audios, ref_audios)
    picture_ids = [p["id"] for p in media["pictures"]]
    video_ids = [v["id"] for v in media["videos"]]
    audio_ids = [a["id"] for a in media["audios"]]

    # Fall back to state keys when no tensors are attached (UI-only / preview).
    if not picture_ids:
        try:
            picture_ids = sorted(int(k) for k in (state.get("pictures") or {}).keys())
        except (TypeError, ValueError):
            picture_ids = []
    if not video_ids:
        try:
            video_ids = sorted(int(k) for k in (state.get("videos") or {}).keys())
        except (TypeError, ValueError):
            video_ids = []
    if not audio_ids:
        try:
            audio_ids = sorted(int(k) for k in (state.get("audios") or {}).keys())
        except (TypeError, ValueError):
            audio_ids = []

    subject_lines: list[str] = []
    for i, subject in enumerate(state.get("subjects") or [], start=1):
        raw_pics = []
        for p in subject.get("picture_ids") or []:
            try:
                raw_pics.append(int(p))
            except (TypeError, ValueError):
                continue
        if picture_ids:
            pics = [p for p in raw_pics if p in picture_ids]
        else:
            pics = raw_pics
        subject_lines.append(_format_subject_line(i, pics, subject.get("text") or ""))

    shots = state.get("shots") or []
    for pid in picture_ids:
        pic_state = (state.get("pictures") or {}).get(str(pid)) or (
            state.get("pictures") or {}
        ).get(pid) or {}
        if isinstance(pic_state, str):
            pic_state = {"text": pic_state}
        first_frames, storyboards = _picture_role_shots(pid, shots)
        line = _format_picture_line(
            pid,
            pic_state.get("text") or "",
            first_frames,
            storyboards,
        )
        if line:
            subject_lines.append(line)

    for vid in video_ids:
        vstate = (state.get("videos") or {}).get(str(vid)) or (
            state.get("videos") or {}
        ).get(vid) or {}
        if isinstance(vstate, str):
            vstate = {"text": vstate}
        line = _format_video_line(vid, vstate.get("text") or "")
        if line:
            subject_lines.append(line)

    for aid in audio_ids:
        astate = (state.get("audios") or {}).get(str(aid)) or (
            state.get("audios") or {}
        ).get(aid) or {}
        if isinstance(astate, str):
            astate = {"text": astate}
        line = _format_audio_line(aid, astate.get("text") or "")
        if line:
            subject_lines.append(line)

    retention_lines = []
    _enrich_retention_contexts(state)
    for entry in state.get("retention") or []:
        line = _format_retention_line(entry)
        if line:
            retention_lines.append(line)

    shot_lines = []
    for i, shot in enumerate(state.get("shots") or [], start=1):
        shot_lines.append(_format_shot_block(i, shot))

    style_opening = as_sentence((state.get("style_opening") or "").strip())
    detailed_parts: list[str] = []
    if style_opening:
        detailed_parts.append(style_opening)
    if shot_lines:
        detailed_parts.append("\n".join(shot_lines))
    detailed_body = "\n".join(detailed_parts) if detailed_parts else "(none)"

    ndm = state.get("non_diegetic_music") or {}
    if ndm.get("enabled") and (ndm.get("text") or "").strip():
        music = as_sentence((ndm.get("text") or "").strip())
    else:
        music = "N/A"

    soundscape_raw = (state.get("overall_soundscape") or "").strip()
    soundscape = as_sentence(soundscape_raw) if soundscape_raw else "N/A"

    sections = [
        "subject_definitions:",
        "\n".join(subject_lines) if subject_lines else "(none)",
        "",
        "summary:",
        _format_summary(state),
        "",
        "retention_analysis:",
        "\n".join(retention_lines) if retention_lines else "(none)",
        "",
        "detailed_description:",
        detailed_body,
        "",
        "overall_soundscape:",
        soundscape,
        "",
        "non_diegetic_music:",
        music,
    ]
    return "\n".join(sections).strip() + "\n"

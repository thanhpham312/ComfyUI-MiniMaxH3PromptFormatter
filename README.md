# MiniMax H3 Prompt Formatter (ComfyUI)

Custom ComfyUI node that builds [MiniMax H3 full-reference rewrite prompts](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md) through a structured editor, then outputs text you can pipe into **MiniMax H3 Reference to Video**.

## Install

Copy this folder into your ComfyUI `custom_nodes` directory (e.g.
`ComfyUI-MiniMaxH3PromptFormatter`), then restart ComfyUI.

Requires ComfyUI **0.33+** (Native MiniMax H3 support).

## Node: MiniMax H3 Prompt Formatter

| | |
|---|---|
| **Category** | `conditioning/minimax` |
| **Output node** | Can be queued on its own |
| **Inputs** | Same layout as `MiniMaxH3ReferenceToVideo`: ≤9 `ref_image_0…8`, ≤3 `ref_video_0…2` (IMAGE frames), ≤3 paired `ref_video_audio_0…2`, ≤3 standalone `ref_audio_0…2` |
| **Output** | `prompt` (`STRING`) |

### UI sections

1. **References**: `<Picture N>`, `<Video N>`, `<Audio N>` with definition text + retention (audio uses `fully_copy` / `partially_copy` / `reference` / `weak_reference`).
2. **Subjects**: Subjects, picture associations, retention.
3. **Summary**: Task-type toggles + summary text.
4. **Shots**: Style opening (1–2 sentences before `[Shot 1]`), then picture references (first frame or storyboard), subjects, timed events.
5. **Sounds**: Overall soundscape; non-diegetic music on/off.
6. **Preview**: Assembled prompt.
7. **Debug** (hidden by default): Right-click the node → “Show MiniMax H3 Debug tab” to edit/reload `prompt_state` JSON.

### Tag numbering (matches MiniMax)

Dense among active (non-muted) links:

1. Images → `<Picture 1…N>`
2. For each video: optional paired soundtrack → next `<Audio>`, then `<Video>`
3. Standalone audios → remaining `<Audio>` tags

Pair soundtracks by **slot index**: `ref_video_audio_0` belongs to `ref_video_0`. Prompt tags stay 1-based (`ref_image_0` → `<Picture 1>`).

### Suggested graph

Load media → **MiniMax H3 Prompt Formatter** → `prompt` → **MiniMax H3 Reference to Video**  
(and wire the same media into that node’s matching `ref_*` slots).

## Notes

- Prompt state (including `saved_prompt`) serializes with the workflow.
- If structured fields are empty after a node update, Preview/output fall back to `saved_prompt`.

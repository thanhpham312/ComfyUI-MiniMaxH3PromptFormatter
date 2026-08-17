"""V1 MiniMax H3 Prompt Formatter — always registers via NODE_CLASS_MAPPINGS."""

from __future__ import annotations

import json

try:
    from .prompt_builder import DEFAULT_STATE, parse_state, resolve_prompt_output
except ImportError:
    from prompt_builder import DEFAULT_STATE, parse_state, resolve_prompt_output

# Slot name prefixes that may be added dynamically from the frontend Autogrow UI.
_DYNAMIC_PREFIXES = (
    "ref_image_",
    "ref_video_",
    "ref_video_audio_",
    "ref_audio_",
)

_DYNAMIC_TYPES = {
    "ref_image_": ("IMAGE",),
    "ref_video_": ("IMAGE",),  # video frames (same as MiniMaxH3ReferenceToVideo)
    "ref_video_audio_": ("AUDIO",),
    "ref_audio_": ("AUDIO",),
}


def _dynamic_type(key: str):
    if not isinstance(key, str):
        return None
    for prefix, spec in _DYNAMIC_TYPES.items():
        if key.startswith(prefix):
            return spec
    return None


class ContainsAnyDict(dict):
    """Accept dynamically added ref_* slots from the frontend.

    ComfyUI's graph walker uses both ``in`` and ``dict[key]``. Overriding only
    ``__contains__`` is not enough — ``__getitem__`` must resolve too.
    """

    def __contains__(self, key):
        if dict.__contains__(self, key):
            return True
        return _dynamic_type(key) is not None

    def __getitem__(self, key):
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        spec = _dynamic_type(key)
        if spec is not None:
            return spec
        raise KeyError(key)

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default


class MiniMaxH3PromptFormatterV1:
    """Build a MiniMax H3 full-reference rewrite prompt from structured sections."""

    @classmethod
    def INPUT_TYPES(cls):
        # Declare full slot sets so the server can resolve linked inputs. JS
        # Autogrow still shows only connected + one spare on the canvas.
        optional = {}
        for i in range(0, 9):
            optional[f"ref_image_{i}"] = ("IMAGE",)
        for i in range(0, 3):
            optional[f"ref_video_{i}"] = ("IMAGE",)
            optional[f"ref_video_audio_{i}"] = ("AUDIO",)
            optional[f"ref_audio_{i}"] = ("AUDIO",)
        return {
            "required": {
                "prompt_state": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": json.dumps(DEFAULT_STATE),
                    },
                ),
            },
            "optional": ContainsAnyDict(optional),
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "format_prompt"
    CATEGORY = "conditioning/minimax"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Structured editor for MiniMax H3 full-reference prompts. "
        "Up to 9 images, 3 videos (+ optional paired soundtracks), and 3 "
        "standalone audios — same layout as MiniMax H3 Reference to Video."
    )
    SEARCH_ALIASES = [
        "minimax prompt",
        "h3 prompt formatter",
        "reference prompt",
        "minimax h3",
    ]

    def format_prompt(self, prompt_state, **kwargs):
        parse_state(prompt_state)
        ref_images = {}
        for i in range(0, 9):
            key = f"ref_image_{i}"
            if kwargs.get(key) is not None:
                ref_images[key] = kwargs[key]
        # Legacy 1-based slots from older builds of this node.
        for i in range(1, 10):
            key = f"ref_image_{i}"
            if key not in ref_images and kwargs.get(key) is not None:
                ref_images[key] = kwargs[key]
        ref_videos = {}
        ref_video_audios = {}
        ref_audios = {}
        for i in range(0, 3):
            vk = f"ref_video_{i}"
            ak = f"ref_video_audio_{i}"
            sk = f"ref_audio_{i}"
            if kwargs.get(vk) is not None:
                ref_videos[vk] = kwargs[vk]
            if kwargs.get(ak) is not None:
                ref_video_audios[ak] = kwargs[ak]
            if kwargs.get(sk) is not None:
                ref_audios[sk] = kwargs[sk]
        for i in range(1, 4):
            for prefix, bucket in (
                ("ref_video_", ref_videos),
                ("ref_video_audio_", ref_video_audios),
                ("ref_audio_", ref_audios),
            ):
                key = f"{prefix}{i}"
                if key not in bucket and kwargs.get(key) is not None:
                    bucket[key] = kwargs[key]
        prompt = resolve_prompt_output(
            prompt_state,
            ref_images or None,
            ref_videos or None,
            ref_video_audios or None,
            ref_audios or None,
        )
        return (prompt,)

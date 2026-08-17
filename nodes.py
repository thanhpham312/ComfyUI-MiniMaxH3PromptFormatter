"""MiniMax H3 Prompt Formatter — optional V3 Autogrow schema (registration is V1)."""

from __future__ import annotations

import json

from comfy_api.latest import ComfyExtension, io

try:
    from .prompt_builder import DEFAULT_STATE, parse_state, resolve_prompt_output
except ImportError:
    from prompt_builder import DEFAULT_STATE, parse_state, resolve_prompt_output


class MiniMaxH3PromptFormatter(io.ComfyNode):
    """Build a MiniMax H3 full-reference rewrite prompt from structured sections."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MiniMaxH3PromptFormatter",
            display_name="MiniMax H3 Prompt Formatter",
            category="conditioning/minimax",
            description=(
                "Structured editor for MiniMax H3 full-reference prompts. "
                "Same reference layout as MiniMax H3 Reference to Video: "
                "≤9 images, ≤3 videos (+ optional paired soundtracks), ≤3 standalone audios."
            ),
            search_aliases=[
                "minimax prompt",
                "h3 prompt formatter",
                "reference prompt",
                "minimax h3",
            ],
            is_output_node=True,
            inputs=[
                io.String.Input(
                    "prompt_state",
                    multiline=True,
                    default=json.dumps(DEFAULT_STATE),
                    tooltip="Structured prompt state (managed by the node UI).",
                ),
                io.Autogrow.Input(
                    "ref_images",
                    optional=True,
                    template=io.Autogrow.TemplatePrefix(
                        input=io.Image.Input("ref_image"),
                        prefix="ref_image_",
                        min=0,
                        max=9,
                    ),
                ),
                io.Autogrow.Input(
                    "ref_videos",
                    optional=True,
                    template=io.Autogrow.TemplatePrefix(
                        input=io.Image.Input(
                            "ref_video",
                            tooltip="Reference video frames at 24 fps (2–15s)",
                        ),
                        prefix="ref_video_",
                        min=0,
                        max=3,
                    ),
                ),
                io.Autogrow.Input(
                    "ref_video_audios",
                    optional=True,
                    template=io.Autogrow.TemplatePrefix(
                        input=io.Audio.Input(
                            "ref_video_audio",
                            tooltip="Soundtrack paired with the same-numbered ref_video",
                        ),
                        prefix="ref_video_audio_",
                        min=0,
                        max=3,
                    ),
                ),
                io.Autogrow.Input(
                    "ref_audios",
                    optional=True,
                    template=io.Autogrow.TemplatePrefix(
                        input=io.Audio.Input("ref_audio"),
                        prefix="ref_audio_",
                        min=0,
                        max=3,
                    ),
                ),
            ],
            outputs=[
                io.String.Output(display_name="prompt"),
            ],
        )

    @classmethod
    def execute(
        cls,
        prompt_state: str,
        ref_images=None,
        ref_videos=None,
        ref_video_audios=None,
        ref_audios=None,
    ) -> io.NodeOutput:
        parse_state(prompt_state)
        prompt = resolve_prompt_output(
            prompt_state, ref_images, ref_videos, ref_video_audios, ref_audios
        )
        return io.NodeOutput(prompt)


class MiniMaxH3PromptFormatterExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [MiniMaxH3PromptFormatter]


async def comfy_entrypoint() -> MiniMaxH3PromptFormatterExtension:
    return MiniMaxH3PromptFormatterExtension()

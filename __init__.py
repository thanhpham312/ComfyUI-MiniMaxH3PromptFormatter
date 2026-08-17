"""ComfyUI custom node: MiniMax H3 Prompt Formatter."""

from __future__ import annotations

WEB_DIRECTORY = "./web"

from .nodes_v1 import MiniMaxH3PromptFormatterV1

NODE_CLASS_MAPPINGS = {
    "MiniMaxH3PromptFormatter": MiniMaxH3PromptFormatterV1,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3PromptFormatter": "MiniMax H3 Prompt Formatter",
}

print(
    "[MiniMaxH3PromptFormatter] Loaded — search for 'MiniMax H3 Prompt Formatter' "
    "(category: conditioning/minimax)"
)

__all__ = [
    "WEB_DIRECTORY",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]

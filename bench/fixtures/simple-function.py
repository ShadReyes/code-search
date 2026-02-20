"""A simple utility module."""

import os
from pathlib import Path


def greet(name: str) -> str:
    """Return a greeting message."""
    return f"Hello, {name}!"


def add(a: int, b: int) -> int:
    return a + b

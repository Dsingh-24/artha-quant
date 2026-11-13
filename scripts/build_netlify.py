"""Assemble the static Netlify publish directory (`dist/`) from `static/`.

Uses only Python standard library modules so Netlify CI builds complete in <1s
with zero pip/npm install overhead.
"""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_SRC = ROOT_DIR / "static"
DIST_DIR = ROOT_DIR / "dist"


def build_dist() -> None:
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    (DIST_DIR / "static").mkdir(parents=True, exist_ok=True)

    # Root entry HTML
    shutil.copy2(STATIC_SRC / "index.html", DIST_DIR / "index.html")

    # Copy all static assets (`/static/*`)
    for item in STATIC_SRC.iterdir():
        dest = DIST_DIR / "static" / item.name
        if item.is_dir():
            shutil.copytree(item, dest)
        else:
            shutil.copy2(item, dest)

    print(f"Built Netlify publish directory at {DIST_DIR}")


if __name__ == "__main__":
    build_dist()

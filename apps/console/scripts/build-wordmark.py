"""Derive public/brand/solmate-wordmark.png from public/brand/solmate.png.

The splash lockup needs SOLMATE *without* the TECHNOLOGY tagline, because the
tagline sits exactly where MARINE now goes. The trimmed file is committed (the
console is a static deploy and cannot run Python at build time), so this script
exists to keep it reproducible -- a derived asset committed without its
generator is how the asset and its source silently drift apart.

Run from the repo root, with the project venv (it has Pillow; system Python
does not):

    .venv/Scripts/python apps/console/scripts/build-wordmark.py

Why a BOX and not a row crop
----------------------------
The obvious approach -- crop everything below the wordmark -- is wrong here.
The tagline is not the lowest ink in the file: the sunburst's lower-left rays
run to y=246, below the tagline's y=226, so a row crop takes the rays with it
and the mark loses the burst that makes it recognisable.

Within the tagline's row band the ink instead falls into two well-separated
column runs -- x 141..184 (ray tails) and x 574..730 (the glyphs), with ~390px
of nothing between them. Erasing only the right-hand box cannot touch the
sunburst. The constants below are those measurements, not guesses; if the source
logo is ever redrawn they must be re-measured rather than nudged.
"""

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "brand" / "solmate.png"
DST = ROOT / "public" / "brand" / "solmate-wordmark.png"

# Cut below SOLMATE's baseline (y=190) and right of the sunburst's ray tails
# (which end at x=184), leaving the tagline at x>=574 with nowhere to hide.
CUT_Y = 196
CUT_X = 560


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    a = np.array(im)

    before = int((a[..., 3] > 24).sum())
    a[CUT_Y:, CUT_X:, 3] = 0
    erased = before - int((a[..., 3] > 24).sum())
    if erased == 0:
        raise SystemExit(
            f"{SRC.name}: nothing erased at y>={CUT_Y}, x>={CUT_X}. The source "
            "logo has changed; re-measure the tagline band before trusting this."
        )

    ys, xs = np.nonzero(a[..., 3] > 8)
    out = Image.fromarray(a).crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    out.save(DST)
    print(f"{DST.name}: erased {erased}px of tagline, trimmed to {out.size}")


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runtime_dir="${1:-${ATLAS_CONFIG_DIR:-${HOME}/.atlas}/runtime/python}"
python_binary="${ATLAS_BOOTSTRAP_PYTHON:-python3}"

case "$runtime_dir" in
  /*) ;;
  *) printf 'Runtime directory must be absolute.\n' >&2; exit 1 ;;
esac

"$python_binary" -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ is required"'
"$python_binary" -m venv "$runtime_dir"
"$runtime_dir/bin/python3" -m pip install --disable-pip-version-check --requirement "$script_dir/file-runtime/requirements.txt"
"$runtime_dir/bin/python3" -m pip check
"$runtime_dir/bin/python3" -I - <<'PYTHON'
from io import BytesIO

import pandas, openpyxl, docx, pptx, pypdf, reportlab, fontTools, uharfbuzz, bidi
from PIL import Image

with Image.new("RGB", (16, 12), (150, 90, 30)) as source:
    for image_format in ("JPEG", "PNG"):
        with BytesIO() as encoded:
            source.save(encoded, format=image_format)
            encoded.seek(0)
            with Image.open(encoded) as decoded:
                decoded.load()
                assert decoded.format == image_format
                assert decoded.size == source.size
                assert decoded.mode == "RGB"

print("Atlas file runtime ready (JPEG/PNG encode and decode verified)")
PYTHON
printf 'ATLAS_PYTHON_PATH=%s/bin/python3\n' "$runtime_dir"

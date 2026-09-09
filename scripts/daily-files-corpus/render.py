"""Render every Office/PDF reference returned by a corpus attempt for visual QA.

Conversion success is not a visual verdict. Inspect every generated page and
record layout defects separately from the structural/content oracle.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from xml.sax.saxutils import escape


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("attempt", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--soffice", required=True, type=Path)
    parser.add_argument("--pdftoppm", required=True, type=Path)
    parser.add_argument("--font-dir", type=Path, action="append", default=[])
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    environment = dict(os.environ)
    if args.font_dir:
        config = output / "fonts.conf"
        config.write_text(
            '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>'
            + "".join(f"<dir>{escape(str(directory.resolve()))}</dir>" for directory in args.font_dir)
            + f"<cachedir>{escape(str(output / 'cache'))}</cachedir></fontconfig>"
        )
        environment["FONTCONFIG_FILE"] = str(config)
        environment["XDG_CACHE_HOME"] = str(output / "cache")
    records = json.loads((args.attempt / "execution.json").read_text())["records"]
    results = []
    for record in records:
        references = set()
        for step in record["steps"]:
            result = step.get("output")
            if isinstance(result, dict) and isinstance(result.get("path"), str):
                references.add(result["path"])
        for reference in sorted(references):
            source = args.attempt.resolve() / record["id"] / reference
            if source.suffix not in {".docx", ".pptx", ".xlsx", ".pdf"}:
                continue
            folder = output / record["id"] / source.name
            folder.mkdir(parents=True, exist_ok=False)
            original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
            result = {"case": record["id"], "reference": reference, "sha256": original_hash}
            try:
                pdf = source
                if source.suffix != ".pdf":
                    with tempfile.TemporaryDirectory(prefix="atlas-render-profile-") as profile:
                        converted = subprocess.run(
                            [str(args.soffice.resolve()), "-env:UserInstallation=" + Path(profile).as_uri(),
                             "--headless", "--convert-to", "pdf", "--outdir", str(folder), str(source)],
                            env=environment, capture_output=True, timeout=60,
                        )
                    (folder / "convert.stdout").write_bytes(converted.stdout)
                    (folder / "convert.stderr").write_bytes(converted.stderr)
                    converted.check_returncode()
                    pdf = folder / (source.stem + ".pdf")
                rendered = subprocess.run(
                    [str(args.pdftoppm.resolve()), "-png", "-scale-to", "1400", str(pdf), str(folder / "page")],
                    env=environment, capture_output=True, timeout=60,
                )
                (folder / "render.stderr").write_bytes(rendered.stderr)
                rendered.check_returncode()
                result["pages"] = [str(page.relative_to(output)) for page in sorted(folder.glob("page-*.png"))]
                if not result["pages"]:
                    raise RuntimeError("No rendered pages")
                result["conversion"] = "success"
                result["visualVerdict"] = "requires-inspection"
            except Exception as error:
                result["conversion"] = "failure"
                result["error"] = str(error)
            result["sourceUnchanged"] = hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
            results.append(result)
            (output / "render-ledger.json").write_text(json.dumps(results, indent=2))
    print(json.dumps({"files": len(results), "conversionFailures": sum(item["conversion"] != "success" for item in results)}))
    if any(item["conversion"] != "success" or not item["sourceUnchanged"] for item in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()

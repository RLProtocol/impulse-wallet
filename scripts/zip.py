"""Zip a build directory for store submission.

    python scripts/zip.py dist-firefox impulse-firefox.zip

PowerShell's Compress-Archive is not usable here: it writes Windows path
separators into the archive entries ("assets\\main.js"). The ZIP spec requires
forward slashes. Chrome accepts the malformed form, so it goes unnoticed, but
AMO rejects the upload outright with "Invalid file name in archive".

This walks the directory and writes entries with explicit forward slashes,
deflated, with no directory entries.
"""
import os
import sys
import zipfile


def build(src: str, out: str) -> None:
    if not os.path.isdir(src):
        sys.exit(f"{src} is not a directory. Build it first.")
    if os.path.exists(out):
        os.remove(out)

    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, _dirs, files in os.walk(src):
            for name in sorted(files):
                full = os.path.join(root, name)
                # Relative to src, always forward-slashed.
                arc = os.path.relpath(full, src).replace(os.sep, "/")
                z.write(full, arc)
                count += 1

    with zipfile.ZipFile(out) as z:
        bad = [n for n in z.namelist() if "\\" in n]
        assert not bad, f"backslashes survived in: {bad[:3]}"

    size = os.path.getsize(out)
    print(f"{out}  {count} files  {size / 1024:.0f}K  (forward slashes verified)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python scripts/zip.py <dir> <out.zip>")
    build(sys.argv[1], sys.argv[2])

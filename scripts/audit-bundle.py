"""Build the source bundle sent to an external auditor.

    python scripts/audit-bundle.py impulse-audit-2.4.0.zip

Allowlisted, not denylisted. A denylist ships whatever it forgets, and this
repository sits next to `server/` — which holds OWNER_PRIVATE_KEY and BUYER_KEY
in server/.env. Nothing outside INCLUDE can enter the archive, so forgetting a
new secret file cannot leak it.

Every file is scanned for key-shaped strings on the way in, and the build fails
rather than writing an archive that carries one.
"""
import os
import re
import sys
import zipfile

# Only these paths are considered. Directories are walked; files are taken as-is.
INCLUDE = [
    "src",              # all extension source
    "public",           # icons, static rules
    "scripts",          # build + packaging
    "docs",             # design notes
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",   # the manifest is generated here
    "tailwind.config.js",
    "postcss.config.js",
    "index.html",
    "bubble.html",
    "README.md",
    "PRIVACY.md",
    "STORE_LISTING.md",
    "REVIEWERS.md",
    "AUDIT.md",          # this review, for the external reviewer
]

# Never, even if reached through an included directory.
SKIP_DIRS = {"node_modules", ".git", "dist", "dist-firefox", "__pycache__",
             ".venv", "venv", "server", ".claude", "store-assets"}
SKIP_EXT = {".zip", ".log", ".tsbuildinfo", ".session", ".mp3", ".mp4"}
SKIP_NAMES = {".env", ".env.local", ".env.production"}

# Anything that looks like a live credential. Checked against every file.
SECRETS = [
    (re.compile(rb"fsk_live_[A-Za-z0-9_-]{10,}"), "FomoScan API key"),
    (re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY"), "PEM private key"),
    (re.compile(rb"\b[0-9]{9,10}:AA[A-Za-z0-9_-]{33}\b"), "Telegram bot token"),
    (re.compile(rb"\bsk-[A-Za-z0-9]{20,}"), "OpenAI-style key"),
    (re.compile(rb"(?i)(private_?key|mnemonic|seed_?phrase)\s*[:=]\s*[\"'][^\"']{16,}"), "assigned secret"),
    # A bare 32-byte hex literal is almost always a private key. The few real
    # 0x-hex constants in this codebase are 20-byte addresses.
    (re.compile(rb"0x[a-fA-F0-9]{64}\b"), "32-byte hex literal"),
]

# A transaction hash, pool id and block hash are all 32 bytes of hex, exactly
# like a private key, and the notes in docs/ quote plenty of them. Rather than
# drop the rule -- it is the one that would catch a pasted key -- a match is
# cleared only when the text right before it names what it is. A private key
# assignment never reads "tx 0x...", and if one somehow did, the separate
# assigned-secret rule still fires on it.
PUBLIC_HEX = re.compile(
    rb"(?i)\b(tx|txn|hash|txhash|poolid|pool|block|commitment|sig|signature|id)\b[\s:=]{1,4}$")


def scan(path: str, data: bytes) -> list:
    hits = []
    for pattern, label in SECRETS:
        for m in pattern.finditer(data):
            if label == "32-byte hex literal":
                before = data[max(0, m.start() - 40):m.start()]
                if PUBLIC_HEX.search(before):
                    continue   # a labelled hash, not a key
            hits.append(f"{path}: {label} — {m.group(0)[:24].decode('utf8', 'replace')}…")
            break
    return hits


def collect() -> list:
    out = []
    for entry in INCLUDE:
        if os.path.isfile(entry):
            out.append(entry)
        elif os.path.isdir(entry):
            for root, dirs, files in os.walk(entry):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                for f in files:
                    if f in SKIP_NAMES or os.path.splitext(f)[1].lower() in SKIP_EXT:
                        continue
                    out.append(os.path.join(root, f))
    return sorted(out)


def main(out_path: str) -> None:
    files = collect()
    if not files:
        sys.exit("nothing collected — run from the repository root")

    findings = []
    for f in files:
        with open(f, "rb") as fh:
            findings += scan(f, fh.read())
    if findings:
        print("REFUSING to build — secret-shaped strings found:")
        for f in findings:
            print("   " + f)
        sys.exit(1)

    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            # Forward slashes: PowerShell's Compress-Archive writes backslashes
            # and some tools reject the result outright.
            z.write(f, f.replace(os.sep, "/"))

    size = os.path.getsize(out_path)
    print(f"{out_path}  {len(files)} files  {size/1024:.0f}K")
    print("clean: no secret-shaped strings; server/ and node_modules excluded by allowlist")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "impulse-audit.zip")

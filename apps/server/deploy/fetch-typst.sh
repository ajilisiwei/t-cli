#!/bin/sh
# Fetch the PDF renderer of POST /v1/exports/pdf (docs/v3-plan.html §8):
# Typst 0.13.1 (static musl binary for Linux) and the six static font files
# the templates use, each pinned by version and SHA-256, plus their license
# texts. The single source of truth for apps/server/Dockerfile and the CI
# workflow.
#
#   sh fetch-typst.sh <dest> [amd64|arm64]
#     <dest>/bin/typst
#     <dest>/fonts/*.otf          (+ the OFL texts of both families)
#     <dest>/licenses/typst-*     (Typst's Apache-2.0 LICENSE and NOTICE)
#
# amd64 (x86_64) is the production host, CI and the default; arm64 only
# serves native local images on Apple Silicon (amd64 under emulation needs
# far more than the container's 256 MB).
#
# Typst 0.13 only uses the default instance of a variable font, hence the
# static Regular/Bold (Noto Serif SC) and Regular/It/Semibold/Bold (Source
# Serif 4) files. Bumping a version means updating its URL and checksum here.
set -eu

dest=${1:?usage: fetch-typst.sh <dest> [amd64|arm64]}
arch=${2:-amd64}

TYPST_VERSION=0.13.1
case "$arch" in
  amd64) TYPST_TARGET=x86_64-unknown-linux-musl; TYPST_SHA256=7d214bfeffc2e585dc422d1a09d2b144969421281e8c7f5d784b65fc69b5673f ;;
  arm64) TYPST_TARGET=aarch64-unknown-linux-musl; TYPST_SHA256=4f5b7ee6e57fb639019ee0f6bffcf940edad228ede6ff5269a9f05a1544ceed4 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac
TYPST_URL="https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${TYPST_TARGET}.tar.xz"

# notofonts/noto-cjk tag Serif2.003; adobe-fonts/source-serif tag 4.005R.
NOTO=https://raw.githubusercontent.com/notofonts/noto-cjk/Serif2.003/Serif
SOURCE=https://raw.githubusercontent.com/adobe-fonts/source-serif/4.005R

download() { # url file
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

verify() { # sha256 file
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$1  $2" | sha256sum -c - || { echo "checksum mismatch: $2" >&2; exit 1; }
  else
    echo "$1  $2" | shasum -a 256 -c - || { echo "checksum mismatch: $2" >&2; exit 1; }
  fi
}

fetch() { # url sha256 file
  download "$1" "$3"
  verify "$2" "$3"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$dest/bin" "$dest/fonts" "$dest/licenses"

fetch "$TYPST_URL" "$TYPST_SHA256" "$work/typst.tar.xz"
tar -xJf "$work/typst.tar.xz" -C "$work"
install -m 0755 "$work/typst-${TYPST_TARGET}/typst" "$dest/bin/typst"
cp "$work/typst-${TYPST_TARGET}/LICENSE" "$dest/licenses/typst-LICENSE"
cp "$work/typst-${TYPST_TARGET}/NOTICE" "$dest/licenses/typst-NOTICE"

fetch "$NOTO/SubsetOTF/SC/NotoSerifSC-Regular.otf" e8f396decc1f0963a016a989c3d8852e863d1350996f573860a80767c83a1cd3 "$dest/fonts/NotoSerifSC-Regular.otf"
fetch "$NOTO/SubsetOTF/SC/NotoSerifSC-Bold.otf" 24693d48bdb9152f0a06b02af625638a1097abd6de4010ebba027f6e82710527 "$dest/fonts/NotoSerifSC-Bold.otf"
fetch "$NOTO/LICENSE" 6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2 "$dest/fonts/LICENSE-NotoSerifSC.txt"
fetch "$SOURCE/OTF/SourceSerif4-Regular.otf" edf160d0d584deee8a3bb2c3371b2a7624ca63580fbe02c57c1f4c91e84d8787 "$dest/fonts/SourceSerif4-Regular.otf"
fetch "$SOURCE/OTF/SourceSerif4-It.otf" f8062257f4693e438a8e317c9fe2b4393f0d4eed84d897edcbfd733c30a1c1a1 "$dest/fonts/SourceSerif4-It.otf"
fetch "$SOURCE/OTF/SourceSerif4-Semibold.otf" 25e034392847d9965c92f98971b3646436b7ab919ece9118b0c0e5ec94c02efc "$dest/fonts/SourceSerif4-Semibold.otf"
fetch "$SOURCE/OTF/SourceSerif4-Bold.otf" f5fb9a7b1611353fdfebcf8b1e46c7d9108470f25999b841816d8b643b1856ff "$dest/fonts/SourceSerif4-Bold.otf"
fetch "$SOURCE/LICENSE.md" 75784a295293a8992f5a8d99210566e0064a012e6dab6731305e3787f15896c7 "$dest/fonts/LICENSE-SourceSerif4.md"

echo "typst ${TYPST_VERSION} and fonts installed in $dest"

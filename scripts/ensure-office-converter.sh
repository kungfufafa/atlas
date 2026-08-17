#!/usr/bin/env bash
# Install or locate LibreOffice so Office artifact previews/thumbnails work.
set -euo pipefail

soffice_on_path() {
  if [[ -n "${ATLAS_OFFICE_CONVERTER_PATH:-}" && -x "${ATLAS_OFFICE_CONVERTER_PATH}" ]]; then
    echo "${ATLAS_OFFICE_CONVERTER_PATH}"
    return 0
  fi

  local candidate
  for candidate in \
    /opt/homebrew/bin/soffice \
    /usr/local/bin/soffice \
    /usr/bin/soffice \
    /Applications/LibreOffice.app/Contents/MacOS/soffice \
    soffice
  do
    if [[ "${candidate}" == /* ]]; then
      if [[ -x "${candidate}" ]]; then
        echo "${candidate}"
        return 0
      fi
    elif command -v "${candidate}" >/dev/null 2>&1; then
      command -v "${candidate}"
      return 0
    fi
  done
  return 1
}

install_libreoffice() {
  if command -v apt-get >/dev/null 2>&1; then
    if [[ "$(id -u)" -eq 0 ]]; then
      apt-get update
      apt-get install -y --no-install-recommends \
        fonts-liberation \
        libreoffice-calc \
        libreoffice-impress \
        libreoffice-writer
      return 0
    fi
    if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
      sudo apt-get update
      sudo apt-get install -y --no-install-recommends \
        fonts-liberation \
        libreoffice-calc \
        libreoffice-impress \
        libreoffice-writer
      return 0
    fi
    echo "Install LibreOffice with: sudo apt-get install -y libreoffice-writer libreoffice-impress libreoffice-calc fonts-liberation"
    return 1
  fi

  if command -v brew >/dev/null 2>&1; then
    brew install --formula libreoffice
    return 0
  fi

  echo "Install LibreOffice, then retry. Atlas uses soffice for PPTX/DOCX/XLSX previews."
  return 1
}

if path="$(soffice_on_path)"; then
  echo "Office preview converter ready: ${path}"
  exit 0
fi

echo "LibreOffice not found. Installing so Office artifact previews work..."
if install_libreoffice && path="$(soffice_on_path)"; then
  echo "Office preview converter ready: ${path}"
  exit 0
fi

echo "LibreOffice is required for PPTX/DOCX/XLSX thumbnails and fidelity previews."
echo "Semantic previews still work without it."
exit 1

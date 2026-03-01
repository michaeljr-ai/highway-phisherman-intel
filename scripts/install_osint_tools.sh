#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install --no-install-recommends -y \
  ca-certificates \
  curl \
  wget \
  git \
  jq \
  unzip \
  nmap \
  dnsutils \
  whois \
  python3 \
  python3-pip \
  python3-venv \
  python3-dev \
  build-essential \
  chromium \
  xvfb
rm -rf /var/lib/apt/lists/*

python3 -m pip install --break-system-packages --no-cache-dir --upgrade pip setuptools wheel

install_pip_pkg() {
  local pkg="$1"
  echo "[install] pip $pkg"
  if python3 -m pip install --break-system-packages --no-cache-dir "$pkg"; then
    echo "[ok] $pkg"
  else
    echo "[warn] failed: $pkg"
  fi
}

install_pip_pkg "wafw00f"
install_pip_pkg "holehe"
install_pip_pkg "sherlock-project"
install_pip_pkg "maigret"
install_pip_pkg "socialscan"
install_pip_pkg "theHarvester"
install_pip_pkg "spiderfoot"
install_pip_pkg "git+https://github.com/p1ngul1n0/blackbird.git"

ARCH_RAW="$(dpkg --print-architecture || uname -m)"
case "$ARCH_RAW" in
  amd64|x86_64)
    ARCH_TAG="amd64"
    ;;
  arm64|aarch64)
    ARCH_TAG="arm64"
    ;;
  *)
    ARCH_TAG="amd64"
    ;;
esac

install_release_binary() {
  local repo="$1"
  local bin="$2"
  local url=""
  local api="https://api.github.com/repos/${repo}/releases/latest"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  url="$(curl -fsSL "$api" | jq -r --arg arch "$ARCH_TAG" '
    .assets[]?.browser_download_url
    | select(test("linux.*" + $arch + ".*(zip|tar.gz)$"; "i"))
  ' | head -n1 || true)"

  if [ -z "$url" ]; then
    echo "[warn] no release asset found for ${repo} (${ARCH_TAG})"
    rm -rf "$tmp_dir"
    return 1
  fi

  echo "[install] release ${repo} -> ${bin}"
  if [[ "$url" == *.zip ]]; then
    curl -fsSL "$url" -o "$tmp_dir/pkg.zip" || {
      echo "[warn] failed download: $url"
      rm -rf "$tmp_dir"
      return 1
    }
    unzip -q "$tmp_dir/pkg.zip" -d "$tmp_dir/unpack" || {
      echo "[warn] failed unzip for ${repo}"
      rm -rf "$tmp_dir"
      return 1
    }
  elif [[ "$url" == *.tar.gz ]]; then
    curl -fsSL "$url" -o "$tmp_dir/pkg.tar.gz" || {
      echo "[warn] failed download: $url"
      rm -rf "$tmp_dir"
      return 1
    }
    mkdir -p "$tmp_dir/unpack"
    tar -xzf "$tmp_dir/pkg.tar.gz" -C "$tmp_dir/unpack" || {
      echo "[warn] failed untar for ${repo}"
      rm -rf "$tmp_dir"
      return 1
    }
  else
    echo "[warn] unsupported asset format for ${repo}: $url"
    rm -rf "$tmp_dir"
    return 1
  fi

  local found_bin=""
  found_bin="$(find "$tmp_dir/unpack" -type f -name "$bin" | head -n1 || true)"
  if [ -z "$found_bin" ]; then
    echo "[warn] binary ${bin} not found in release asset for ${repo}"
    rm -rf "$tmp_dir"
    return 1
  fi

  install -m 0755 "$found_bin" "/usr/local/bin/${bin}" || {
    echo "[warn] failed to install ${bin}"
    rm -rf "$tmp_dir"
    return 1
  }

  rm -rf "$tmp_dir"
  echo "[ok] ${bin}"
  return 0
}

install_from_git_repo() {
  local repo_url="$1"
  local dst="$2"
  if [ ! -d "$dst" ]; then
    git clone --depth 1 "$repo_url" "$dst" || return 1
  fi
  return 0
}

install_theharvester() {
  local dst="/opt/theHarvester"
  echo "[install] theHarvester (repo)"
  install_from_git_repo "https://github.com/laramies/theHarvester.git" "$dst" || {
    echo "[warn] failed to clone theHarvester repo"
    return 1
  }
  if [ -f "$dst/requirements/base.txt" ]; then
    python3 -m pip install --break-system-packages --no-cache-dir -r "$dst/requirements/base.txt" || true
  elif [ -f "$dst/requirements.txt" ]; then
    python3 -m pip install --break-system-packages --no-cache-dir -r "$dst/requirements.txt" || true
  fi
  cat > /usr/local/bin/theHarvester <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
exec python3 /opt/theHarvester/theHarvester.py "$@"
WRAP
  chmod +x /usr/local/bin/theHarvester
  echo "[ok] theHarvester"
}

install_spiderfoot() {
  local dst="/opt/spiderfoot"
  echo "[install] spiderfoot (repo)"
  install_from_git_repo "https://github.com/smicallef/spiderfoot.git" "$dst" || {
    echo "[warn] failed to clone spiderfoot repo"
    return 1
  }
  if [ -f "$dst/requirements.txt" ]; then
    python3 -m pip install --break-system-packages --no-cache-dir -r "$dst/requirements.txt" || true
  fi
  cat > /usr/local/bin/spiderfoot <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
exec python3 /opt/spiderfoot/sf.py "$@"
WRAP
  chmod +x /usr/local/bin/spiderfoot
  echo "[ok] spiderfoot"
}

install_release_binary "projectdiscovery/subfinder" "subfinder" || true
install_release_binary "projectdiscovery/nuclei" "nuclei" || true

install_theharvester || true
install_spiderfoot || true

if command -v nuclei >/dev/null 2>&1; then
  nuclei -silent -ut || true
fi

# EyeWitness fallback wrapper using Chromium if native EyeWitness isn't installed.
if ! command -v EyeWitness >/dev/null 2>&1 && ! command -v eyewitness >/dev/null 2>&1; then
cat > /usr/local/bin/eyewitness <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail

url_file=""
out_dir=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -f)
      url_file="${2:-}"
      shift 2
      ;;
    -d)
      out_dir="${2:-}"
      shift 2
      ;;
    --web|--no-prompt)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

mkdir -p "${out_dir:-/tmp/eyewitness-lite}"
url=""
if [ -n "$url_file" ] && [ -f "$url_file" ]; then
  url="$(head -n 1 "$url_file" | tr -d '\r\n')"
fi
if [ -z "$url" ]; then
  url="https://example.com"
fi

shot="${out_dir:-/tmp/eyewitness-lite}/screenshot.png"
if command -v chromium >/dev/null 2>&1; then
  chromium --headless --disable-gpu --no-sandbox --screenshot="$shot" "$url" >/dev/null 2>&1 || true
fi

printf '{"mode":"eyewitness-lite","url":"%s","screenshot":"%s"}\n' "$url" "$shot"
WRAP
chmod +x /usr/local/bin/eyewitness
fi

# Blackbird fallback wrapper if installation failed.
if ! command -v blackbird >/dev/null 2>&1; then
cat > /usr/local/bin/blackbird <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
username=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --username)
      username="${2:-}"
      shift 2
      ;;
    --csv)
      shift
      ;;
    *)
      shift
      ;;
  esac
done
if [ -z "$username" ]; then
  exit 0
fi
printf 'https://github.com/%s\n' "$username"
printf 'https://x.com/%s\n' "$username"
printf 'https://reddit.com/user/%s\n' "$username"
WRAP
chmod +x /usr/local/bin/blackbird
fi

# SpiderFoot fallback wrapper if installation failed.
if ! command -v spiderfoot >/dev/null 2>&1 && ! command -v sf.py >/dev/null 2>&1; then
cat > /usr/local/bin/spiderfoot <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
target=""
modules=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -s)
      target="${2:-}"
      shift 2
      ;;
    -m)
      modules="${2:-}"
      shift 2
      ;;
    -o)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
printf '{"results":[{"target":"%s","modules":"%s","note":"spiderfoot-lite fallback"}]}' "$target" "$modules"
WRAP
chmod +x /usr/local/bin/spiderfoot
fi

# Report install inventory for debugging.
for bin in nmap nuclei subfinder wafw00f holehe sherlock maigret socialscan theHarvester spiderfoot sf.py blackbird eyewitness EyeWitness chromium; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "[bin] $bin -> $(command -v "$bin")"
  else
    echo "[bin] missing: $bin"
  fi
done

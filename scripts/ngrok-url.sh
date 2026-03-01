#!/usr/bin/env bash
set -euo pipefail

node -e '
(async () => {
  const res = await fetch("http://127.0.0.1:4040/api/tunnels");
  if (!res.ok) {
    throw new Error(`ngrok api unavailable: ${res.status}`);
  }
  const data = await res.json();
  const tunnels = Array.isArray(data.tunnels) ? data.tunnels : [];
  const httpsTunnel = tunnels.find((t) => t.proto === "https") ?? tunnels[0];
  if (!httpsTunnel?.public_url) {
    throw new Error("no active ngrok tunnel found");
  }
  console.log(httpsTunnel.public_url);
})();
'

const form = document.getElementById("jobForm");
const jobsEl = document.getElementById("jobs");
const summaryBody = document.getElementById("summaryBody");
const reportFrame = document.getElementById("reportFrame");
const actions = document.getElementById("actions");
const tlpEl = document.getElementById("tlp");
const activeReconEl = document.getElementById("activeRecon");

let selectedJobId = null;
let pollHandle = null;

function authHeaders() {
  return {
    "ngrok-skip-browser-warning": "true"
  };
}

function statusIcon(status) {
  if (status === "completed") return "[DONE]";
  if (status === "running") return "[RUN]";
  if (status === "failed") return "[FAIL]";
  return "[QUEUED]";
}

function syncScanMode() {
  if (!tlpEl || !activeReconEl) return;
  const aggressive = (tlpEl.value || "").toUpperCase() === "TLP:RED";
  if (aggressive) {
    activeReconEl.checked = true;
    activeReconEl.disabled = true;
  } else {
    activeReconEl.disabled = false;
  }
}

async function fetchProtected(path, init = {}) {
  const headers = {
    ...authHeaders(),
    ...(init.headers || {})
  };
  return fetch(path, { ...init, headers });
}

async function readApiPayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 240) || `HTTP ${response.status}` };
  }
}

async function openProtectedFile(path, contentType) {
  const response = await fetchProtected(path);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: ${response.status}`);
  }
  const blob = await response.blob();
  const type = blob.type || contentType;
  const wrapped = type ? blob.slice(0, blob.size, type) : blob;
  const objectUrl = URL.createObjectURL(wrapped);
  window.open(objectUrl, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

async function setReportFrame(jobId) {
  try {
    const response = await fetchProtected(`/api/jobs/${jobId}/report`);
    if (!response.ok) {
      reportFrame.srcdoc = `<pre>Report fetch failed (${response.status})</pre>`;
      return;
    }
    const html = await response.text();
    reportFrame.srcdoc = html;
  } catch (error) {
    console.error(error);
    reportFrame.srcdoc = "<pre>Report fetch failed</pre>";
  }
}

function renderSummary(job) {
  if (!job) {
    summaryBody.textContent = "No job selected.";
    actions.innerHTML = "";
    reportFrame.srcdoc = "";
    return;
  }

  const lines = [
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Target: ${job.target}`,
    `Type: ${job.normalizedType ?? "n/a"}`,
    `TLP: ${job.tlp}`,
    `Recon Mode: ${job.reconMode ?? (String(job.tlp).toUpperCase() === "TLP:RED" ? "aggressive" : "standard")}`,
    `Active Recon: ${job.activeRecon ? "enabled" : "disabled"}`,
    `Created: ${job.createdAtUtc}`,
    `Started: ${job.startedAtUtc ?? "-"}`,
    `Completed: ${job.completedAtUtc ?? "-"}`
  ];

  if (job.error) {
    lines.push(`Error: ${job.error}`);
  }

  if (job.result) {
    lines.push(`Case ID: ${job.result.caseId}`);
    lines.push(`Score: ${job.result.score}`);
    lines.push(`Severity: ${job.result.severity}`);
    lines.push(`Confidence: ${job.result.confidencePct}%`);
    lines.push(`Tool Runs: ${job.result.toolRuns}`);
    if (job.result.flyRiskEngine) {
      lines.push(`Fly Risk Engine: ${JSON.stringify(job.result.flyRiskEngine)}`);
    }
    if (job.result.railsPolyglotRisk) {
      lines.push(`Rails/Rust/Haskell Risk: ${JSON.stringify(job.result.railsPolyglotRisk)}`);
    }
  }

  summaryBody.textContent = lines.join("\n");

  actions.innerHTML = "";
  if (job.status === "completed") {
    const reportLink = document.createElement("button");
    reportLink.type = "button";
    reportLink.textContent = "Open report.html";
    reportLink.addEventListener("click", async () => {
      try {
        await openProtectedFile(`/api/jobs/${job.id}/report`, "text/html");
      } catch (error) {
        console.error(error);
        summaryBody.textContent = `Report fetch failed: ${String(error)}`;
      }
    });
    actions.appendChild(reportLink);

    const evidenceLink = document.createElement("button");
    evidenceLink.type = "button";
    evidenceLink.textContent = "Open evidence.json";
    evidenceLink.addEventListener("click", async () => {
      try {
        await openProtectedFile(`/api/jobs/${job.id}/evidence`, "application/json");
      } catch (error) {
        console.error(error);
        summaryBody.textContent = `Evidence fetch failed: ${String(error)}`;
      }
    });
    actions.appendChild(evidenceLink);

    setReportFrame(job.id).catch((error) => {
      console.error(error);
    });
  }
}

function renderJobs(items) {
  jobsEl.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "job-item";
    empty.innerHTML = `<div class="job-title">No jobs yet</div><div class="meta">Submit a target to start a briefing run.</div>`;
    jobsEl.appendChild(empty);
    return;
  }

  for (const job of items) {
    const div = document.createElement("div");
    div.className = `job-item status-${job.status}${selectedJobId === job.id ? " selected" : ""}`;
    div.dataset.id = job.id;
    div.innerHTML = `
      <div class="job-title">${statusIcon(job.status)} ${job.target}</div>
      <div class="meta">${job.createdAtUtc}</div>
      <div class="meta">${job.id.slice(0, 8)}...</div>
    `;
    div.addEventListener("click", () => {
      selectedJobId = job.id;
      for (const node of jobsEl.querySelectorAll(".job-item")) {
        node.classList.remove("selected");
      }
      div.classList.add("selected");
      renderSummary(job);
      startPolling();
    });
    jobsEl.appendChild(div);
  }
}

async function fetchJobs() {
  const res = await fetchProtected("/api/jobs");
  if (!res.ok) throw new Error("Failed to load jobs");
  const data = await readApiPayload(res);
  return data.jobs || [];
}

async function fetchJob(id) {
  const res = await fetchProtected(`/api/jobs/${id}`);
  if (!res.ok) throw new Error("Failed to load job");
  const data = await readApiPayload(res);
  return data.job;
}

async function refreshJobs() {
  try {
    const jobs = await fetchJobs();
    renderJobs(jobs);
    if (selectedJobId) {
      const current = jobs.find((j) => j.id === selectedJobId);
      if (current) renderSummary(current);
    }
  } catch (error) {
    console.error(error);
  }
}

function startPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  pollHandle = setInterval(async () => {
    if (!selectedJobId) return;
    try {
      const job = await fetchJob(selectedJobId);
      renderSummary(job);
      if (job.status === "completed" || job.status === "failed") {
        await refreshJobs();
        clearInterval(pollHandle);
        pollHandle = null;
      }
    } catch (error) {
      console.error(error);
    }
  }, 2000);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = document.getElementById("target").value.trim();
  const tlp = tlpEl.value;
  const activeRecon = activeReconEl.checked;

  if (!target) return;

  try {
    const response = await fetchProtected("/api/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ target, tlp, activeRecon })
    });

    const data = await readApiPayload(response);
    if (!response.ok) {
      summaryBody.textContent = `Request failed: ${data.error || response.statusText || `HTTP ${response.status}`}`;
      return;
    }

    selectedJobId = data.job.id;
    renderSummary(data.job);
    await refreshJobs();
    startPolling();
  } catch (error) {
    summaryBody.textContent = `Request failed: ${error instanceof Error ? error.message : String(error)}`;
  }
});

refreshJobs();
syncScanMode();
if (tlpEl) {
  tlpEl.addEventListener("change", syncScanMode);
}

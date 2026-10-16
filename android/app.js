// Client-side port of kayak_tides/api.py: talks to the waterinfo.be (HIC) KIWIS
// API directly from the browser. The API returns "Access-Control-Allow-Origin: *",
// so no backend/proxy is needed.

const HIC_BASE = "https://hicws.vlaanderen.be/KiWIS/KiWIS";
const HIC_DATASOURCE = "4";
const TIDE_GROUP_ID = "350099"; // astronomical HW/LW predictions (TAW datum, meters)
const MD_RETURNFIELDS =
  "ts_id,ts_path,ts_name,ts_shortname,station_no,station_id,station_name," +
  "stationparameter_name,stationparameter_no,stationparameter_longname," +
  "ts_unitname,ts_unitsymbol,parametertype_id,parametertype_name,ca_sta";

function kiwisUrl(params) {
  const url = new URL(HIC_BASE);
  const query = {
    service: "kisters",
    type: "QueryServices",
    format: "json",
    datasource: HIC_DATASOURCE,
    ...params,
  };
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

async function fetchStations() {
  const url = kiwisUrl({
    request: "getTimeseriesValueLayer",
    timeseriesgroup_id: TIDE_GROUP_ID,
    metadata: "TRUE",
    md_returnfields: MD_RETURNFIELDS,
    ca_sta_returnfields: "dataprovider",
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load station list (HTTP ${res.status}).`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("The API returned no tide stations.");
  }
  return data
    .map((row) => ({ tsId: String(row.ts_id), name: row.station_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// A value is HW iff it's >= both its immediate neighbors (handles the
// spring/neap amplitude drift that breaks a simple global-median threshold).
function classifyTideKinds(values) {
  const n = values.length;
  return values.map((value, i) => {
    const prev = i > 0 ? values[i - 1] : -Infinity;
    const next = i < n - 1 ? values[i + 1] : -Infinity;
    return value >= prev && value >= next ? "HW" : "LW";
  });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Format a local calendar-day boundary as "YYYY-MM-DD HH:MM:SS"; the KIWIS
// API interprets from/to values as CET/CEST wall-clock time.
function formatKiwisDateTime(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

async function fetchTideEvents(tsId, dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const url = kiwisUrl({
    request: "getTimeseriesValues",
    ts_id: tsId,
    from: formatKiwisDateTime(start),
    to: formatKiwisDateTime(end),
    timezone: "CET",
    returnfields: "Timestamp,Value",
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load tide data (HTTP ${res.status}).`);
  const data = await res.json();
  const section = data[0];
  if (!section || !section.data || section.data.length === 0) return [];

  const rows = section.data; // [[timestamp, value], ...]
  const kinds = classifyTideKinds(rows.map((r) => r[1]));
  const events = rows.map(([timestamp, levelM], i) => ({
    timestamp: new Date(timestamp),
    levelM,
    kind: kinds[i],
  }));
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function createTidePanel(container, titleText, defaultStationName) {
  container.innerHTML = `
    <h2>${titleText}</h2>
    <div class="field-row">
      <label>Location</label>
      <select class="location-select"></select>
    </div>
    <div class="field-row">
      <label>Date</label>
      <input type="date" class="date-input" />
    </div>
    <p class="status"></p>
    <table class="tide-table">
      <thead><tr><th>Time</th><th>Level (m)</th><th>Type</th></tr></thead>
      <tbody></tbody>
    </table>
  `;

  const locationSelect = container.querySelector(".location-select");
  const dateInput = container.querySelector(".date-input");
  const statusEl = container.querySelector(".status");
  const tbody = container.querySelector("tbody");

  dateInput.value = todayIsoDate();

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle("error", Boolean(isError));
  }

  function renderEvents(events) {
    tbody.innerHTML = "";
    if (events.length === 0) {
      setStatus("No tide events found for this date.", false);
      return;
    }
    for (const event of events) {
      const tr = document.createElement("tr");
      const badgeClass = event.kind === "HW" ? "hw" : "lw";
      tr.innerHTML = `
        <td>${formatTime(event.timestamp)}</td>
        <td>${event.levelM.toFixed(2)}</td>
        <td><span class="badge ${badgeClass}">${event.kind}</span></td>
      `;
      tbody.appendChild(tr);
    }
    setStatus(`${events.length} tide event(s) loaded.`, false);
  }

  async function refresh() {
    const tsId = locationSelect.value;
    if (!tsId || !dateInput.value) return;
    tbody.innerHTML = "";
    setStatus("Loading tide times...", false);
    try {
      const events = await fetchTideEvents(tsId, dateInput.value);
      renderEvents(events);
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  }

  locationSelect.addEventListener("change", refresh);
  dateInput.addEventListener("change", refresh);

  return {
    setStations(stations) {
      locationSelect.innerHTML = stations
        .map((s) => `<option value="${s.tsId}">${s.name}</option>`)
        .join("");
      const defaultStation = stations.find((s) => s.name === defaultStationName);
      if (defaultStation) locationSelect.value = defaultStation.tsId;
      refresh();
    },
    setStatus,
  };
}

async function init() {
  const departurePanel = createTidePanel(
    document.getElementById("panel-departure"),
    "Departure location",
    "Wintam Sluis Afwaarts DVW tij/Zeeschelde"
  );
  const destinationPanel = createTidePanel(
    document.getElementById("panel-destination"),
    "Destination location"
  );

  departurePanel.setStatus("Loading stations...", false);
  destinationPanel.setStatus("Loading stations...", false);

  try {
    const stations = await fetchStations();
    departurePanel.setStations(stations);
    destinationPanel.setStations(stations);
  } catch (err) {
    const message = err.message || String(err);
    departurePanel.setStatus(message, true);
    destinationPanel.setStatus(message, true);
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

init();

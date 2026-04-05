'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let parcelsData    = null;   // raw GeoJSON FeatureCollection
let nbhdData       = null;   // neighborhoods GeoJSON
let currentYear    = '2026';
let currentMeasure = 't';    // 't' | 'l' | 'i'
let currentScale   = 'quantile';
let colorScale     = null;
let markerLayer    = null;
let nbhdLayer      = null;
let nbhdLabelLayer = null;
let activeMarker   = null;   // highlighted marker
let showNbhds      = true;
let showLabels     = false;

const MEASURE_LABELS = { t: 'Total Assessed Value', l: 'Land Value', i: 'Improvement Value' };

// ── DOM refs ───────────────────────────────────────────────────────────────
const loadingEl      = document.getElementById('loading');
const tooltipEl      = document.getElementById('tooltip');
const yearSlider     = document.getElementById('year-slider');
const yearDisplay    = document.getElementById('year-display');
const detailPanel    = document.getElementById('detail-panel');
const panelContent   = document.getElementById('panel-content');
const panelClose     = document.getElementById('panel-close');
const searchInput    = document.getElementById('search-input');
const searchClear    = document.getElementById('search-clear');
const searchResults  = document.getElementById('search-results');
const legendTitle    = document.getElementById('legend-title');
const legendCanvas   = document.getElementById('legend-canvas');
const legendMin      = document.getElementById('legend-min');
const legendMax      = document.getElementById('legend-max');

document.getElementById('year-copy').textContent = new Date().getFullYear();

// ── Map init ───────────────────────────────────────────────────────────────
const map = L.map('map', {
  center: [38.033, -78.488],
  zoom: 13,
  preferCanvas: true,   // canvas renderer for performance with 14k+ markers
  zoomControl: true,
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 20,
}).addTo(map);

// ── Color helpers ──────────────────────────────────────────────────────────
const COLOR_INTERP = d3.interpolateOrRd;

function buildColorScale(values) {
  const valid = values.filter(v => v != null && isFinite(v) && v > 0);
  if (!valid.length) return () => '#aaa';

  if (currentScale === 'quantile') {
    return d3.scaleQuantile().domain(valid).range(
      d3.quantize(COLOR_INTERP, 8)
    );
  }
  if (currentScale === 'log') {
    const mn = d3.min(valid), mx = d3.max(valid);
    return d3.scaleSequentialLog(COLOR_INTERP).domain([Math.max(mn, 1), mx]).clamp(true);
  }
  // linear
  return d3.scaleSequential(COLOR_INTERP).domain(d3.extent(valid)).clamp(true);
}

function getColor(feat) {
  const hist = feat.properties.hist;
  if (!hist) return '#aaa';
  const entry = hist[currentYear];
  if (!entry) return '#aaa';
  const v = entry[currentMeasure];
  if (v == null || v === 0) return '#aaa';
  return colorScale(v) || '#aaa';
}

function getValue(feat) {
  const hist = feat.properties.hist;
  if (!hist) return null;
  const entry = hist[currentYear];
  if (!entry) return null;
  return entry[currentMeasure] || null;
}

// ── Legend ─────────────────────────────────────────────────────────────────
function drawLegend() {
  legendTitle.textContent = MEASURE_LABELS[currentMeasure];
  const ctx = legendCanvas.getContext('2d');
  const W = legendCanvas.width;
  for (let x = 0; x < W; x++) {
    ctx.fillStyle = COLOR_INTERP(x / W);
    ctx.fillRect(x, 0, 1, 10);
  }

  const values = parcelsData.features.map(getValue).filter(v => v != null && v > 0);
  if (!values.length) return;
  const [mn, mx] = d3.extent(values);
  legendMin.textContent = formatDollars(mn);
  legendMax.textContent = formatDollars(mx);
}

// ── Markers ────────────────────────────────────────────────────────────────
function buildMarkers() {
  if (markerLayer) map.removeLayer(markerLayer);

  // Gather all values for the current year/measure to build color scale
  const values = parcelsData.features.map(getValue);
  colorScale = buildColorScale(values);

  const markers = [];
  for (const feat of parcelsData.features) {
    const color = getColor(feat);
    const [lon, lat] = feat.geometry.coordinates;
    const m = L.circleMarker([lat, lon], {
      radius: 4,
      fillColor: color,
      color: 'rgba(0,0,0,0.15)',
      weight: 0.5,
      fillOpacity: 0.85,
      pane: 'markerPane',
    });

    m._feat = feat;

    m.on('mouseover', function (e) {
      showTooltip(e.originalEvent, feat);
      if (this !== activeMarker) {
        this.setStyle({ radius: 6, weight: 1.5, color: '#1a2340' });
      }
    });
    m.on('mouseout', function () {
      hideTooltip();
      if (this !== activeMarker) {
        this.setStyle({ radius: 4, weight: 0.5, color: 'rgba(0,0,0,0.15)' });
      }
    });
    m.on('click', function () {
      selectParcel(feat, this);
    });

    markers.push(m);
  }

  markerLayer = L.layerGroup(markers).addTo(map);
  drawLegend();
  updateSummaryStats();
}

function refreshColors() {
  if (!markerLayer) return;
  const values = parcelsData.features.map(getValue);
  colorScale = buildColorScale(values);

  markerLayer.eachLayer(function (m) {
    const color = getColor(m._feat);
    m.setStyle({ fillColor: color });
    if (m === activeMarker) m.setStyle({ radius: 6, weight: 2, color: '#1a2340' });
  });

  drawLegend();
  updateSummaryStats();
}

// ── Summary stats ──────────────────────────────────────────────────────────
function updateSummaryStats() {
  const values = parcelsData.features.map(getValue).filter(v => v != null && v > 0);
  document.getElementById('stat-year').textContent = currentYear;
  document.getElementById('stat-parcels').textContent = values.length.toLocaleString();
  document.getElementById('stat-median').textContent = formatDollars(d3.median(values));
  document.getElementById('stat-total').textContent  = formatDollarsBig(d3.sum(values));
}

// ── Neighborhood layer ─────────────────────────────────────────────────────
function buildNeighborhoods() {
  if (nbhdLayer) map.removeLayer(nbhdLayer);
  if (nbhdLabelLayer) map.removeLayer(nbhdLabelLayer);

  nbhdLayer = L.geoJSON(nbhdData, {
    style: {
      fill: false,
      color: '#1a2340',
      weight: 1.5,
      opacity: 0.35,
      dashArray: '4 3',
    },
    onEachFeature(feat, layer) {
      layer.on('mouseover', function (e) {
        const name = feat.properties.NeighHood || feat.properties.NeighCode;
        layer.setStyle({ opacity: 0.7, weight: 2 });
      });
      layer.on('mouseout', function () {
        layer.setStyle({ opacity: 0.35, weight: 1.5 });
      });
    },
  });

  if (showNbhds) nbhdLayer.addTo(map);

  // Labels as divIcon markers
  nbhdLabelLayer = L.layerGroup();
  for (const feat of nbhdData.features) {
    if (!feat.geometry) continue;
    const coords = feat.geometry.coordinates;
    // find centroid-ish: average of all ring points
    let allPoints = [];
    const flatCoords = (feat.geometry.type === 'Polygon') ? [coords] : coords;
    for (const poly of flatCoords) {
      for (const ring of poly) {
        for (const pt of ring) allPoints.push(pt);
      }
    }
    if (!allPoints.length) continue;
    const cx = d3.mean(allPoints, p => p[0]);
    const cy = d3.mean(allPoints, p => p[1]);

    const name = feat.properties.NeighHood || feat.properties.NeighCode || '';
    const label = L.marker([cy, cx], {
      icon: L.divIcon({
        className: '',
        html: `<div style="
          font-family:'DM Sans',sans-serif;
          font-size:9px;
          font-weight:500;
          letter-spacing:0.05em;
          color:#1a2340;
          text-transform:uppercase;
          white-space:nowrap;
          pointer-events:none;
          text-shadow:0 0 3px #fff, 0 0 3px #fff;
          opacity:0.8;
        ">${name}</div>`,
        iconAnchor: [0, 0],
      }),
      interactive: false,
    });
    nbhdLabelLayer.addLayer(label);
  }
  if (showLabels) nbhdLabelLayer.addTo(map);
}

// ── Tooltip ────────────────────────────────────────────────────────────────
function showTooltip(e, feat) {
  const v = getValue(feat);
  const p = feat.properties;
  const vStr = v != null ? formatDollars(v) : 'No data';
  tooltipEl.innerHTML = `
    <div class="tt-addr">${p.addr}</div>
    <div class="tt-neigh">${p.neigh || '—'}</div>
    <div class="tt-value">${vStr}</div>
    <div class="tt-sub">${MEASURE_LABELS[currentMeasure]} &middot; ${currentYear}</div>
  `;
  tooltipEl.classList.add('visible');
  moveTooltip(e);
}

function hideTooltip() {
  tooltipEl.classList.remove('visible');
}

document.addEventListener('mousemove', function (e) {
  if (tooltipEl.classList.contains('visible')) moveTooltip(e);
});

function moveTooltip(e) {
  const W = window.innerWidth, H = window.innerHeight;
  const tw = tooltipEl.offsetWidth + 16, th = tooltipEl.offsetHeight + 16;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + tw > W) x = e.clientX - tw;
  if (y + th > H) y = e.clientY - th;
  tooltipEl.style.left = x + 'px';
  tooltipEl.style.top  = y + 'px';
}

// ── Detail panel ───────────────────────────────────────────────────────────
function selectParcel(feat, marker) {
  // Reset previous active marker
  if (activeMarker && activeMarker !== marker) {
    activeMarker.setStyle({ radius: 4, weight: 0.5, color: 'rgba(0,0,0,0.15)' });
  }
  activeMarker = marker;
  marker.setStyle({ radius: 7, weight: 2, color: '#1a2340', fillColor: '#b5895a' });

  openPanel(feat);
  map.panTo(marker.getLatLng(), { animate: true, duration: 0.4 });
}

function openPanel(feat) {
  const p = feat.properties;
  const hist = p.hist || {};
  const years = Object.keys(hist).sort((a, b) => +a - +b);

  // Current year values
  const cur = hist[currentYear] || {};

  // Build the HTML for the detail panel
  let metaParts = [];
  if (p.neigh)    metaParts.push(`<span>${p.neigh}</span>`);
  if (p.zone)     metaParts.push(`<span>Zone: ${p.zone}</span>`);
  if (p.taxType)  metaParts.push(`<span>${p.taxType}</span>`);
  if (p.acreage)  metaParts.push(`<span>${p.acreage} ac.</span>`);
  if (p.id)       metaParts.push(`<span>Parcel: ${p.id}</span>`);
  if (p.legal)    metaParts.push(`<span>${p.legal}</span>`);

  panelContent.innerHTML = `
    <div class="panel-addr">${p.addr}</div>
    <div class="panel-meta">${metaParts.join(' ')}</div>

    <div class="panel-section-title">Assessment &mdash; ${currentYear}</div>
    <div class="panel-value-grid">
      <div class="panel-val-item">
        <span class="panel-val-label">Total</span>
        <span class="panel-val-num">${cur.t != null ? formatDollars(cur.t) : '—'}</span>
      </div>
      <div class="panel-val-item">
        <span class="panel-val-label">Land</span>
        <span class="panel-val-num">${cur.l != null ? formatDollars(cur.l) : '—'}</span>
      </div>
      <div class="panel-val-item">
        <span class="panel-val-label">Improvement</span>
        <span class="panel-val-num">${cur.i != null ? formatDollars(cur.i) : '—'}</span>
      </div>
    </div>

    <div class="panel-section-title">Assessment History</div>
    <div id="history-chart"></div>

    <div class="panel-section-title">All Years</div>
    <table class="hist-table">
      <thead>
        <tr>
          <th>Year</th>
          <th>Total</th>
          <th>Land</th>
          <th>Improvement</th>
        </tr>
      </thead>
      <tbody>
        ${years.slice().reverse().map(yr => `
          <tr class="${yr === currentYear ? 'current-year' : ''}">
            <td>${yr}</td>
            <td>${hist[yr].t != null ? formatDollars(hist[yr].t) : '—'}</td>
            <td>${hist[yr].l != null ? formatDollars(hist[yr].l) : '—'}</td>
            <td>${hist[yr].i != null ? formatDollars(hist[yr].i) : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  // Draw history chart with D3
  drawHistoryChart(hist, years, currentYear);

  detailPanel.classList.remove('panel-hidden');
  setTimeout(() => map.invalidateSize(), 220);
}

function closePanel() {
  detailPanel.classList.add('panel-hidden');
  if (activeMarker) {
    activeMarker.setStyle({ radius: 4, weight: 0.5, color: 'rgba(0,0,0,0.15)', fillColor: getColor(activeMarker._feat) });
    activeMarker = null;
  }
  setTimeout(() => map.invalidateSize(), 220);
}

panelClose.addEventListener('click', closePanel);

// ── History chart ──────────────────────────────────────────────────────────
function drawHistoryChart(hist, years, highlightYear) {
  const container = document.getElementById('history-chart');
  container.innerHTML = '';

  const W = 292;  // fixed width matching panel content area (340px panel - 2×1.25rem padding)
  const H = 110;
  const margin = { top: 8, right: 10, bottom: 22, left: 52 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top - margin.bottom;

  const data = years.map(yr => ({
    year: +yr,
    t: hist[yr].t || 0,
    l: hist[yr].l || 0,
    i: hist[yr].i || 0,
  }));

  const xScale = d3.scaleLinear()
    .domain(d3.extent(data, d => d.year))
    .range([0, iW]);

  const yMax = d3.max(data, d => d.t);
  const yScale = d3.scaleLinear()
    .domain([0, yMax * 1.05])
    .range([iH, 0]);

  const svg = d3.select(container).append('svg')
    .attr('width', W).attr('height', H)
    .append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  // Grid lines
  svg.append('g').selectAll('line')
    .data(yScale.ticks(4))
    .join('line')
    .attr('x1', 0).attr('x2', iW)
    .attr('y1', d => yScale(d)).attr('y2', d => yScale(d))
    .attr('stroke', '#ddd8d0').attr('stroke-width', 0.5);

  // Lines
  const lineGen = key => d3.line()
    .x(d => xScale(d.year))
    .y(d => yScale(d[key]))
    .curve(d3.curveMonotoneX);

  const lineStyles = [
    { key: 't', color: '#b5895a', label: 'Total' },
    { key: 'l', color: '#4a7c59', label: 'Land' },
    { key: 'i', color: '#3d6ca8', label: 'Improvement' },
  ];

  for (const s of lineStyles) {
    svg.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', s.color)
      .attr('stroke-width', 1.5)
      .attr('d', lineGen(s.key));
  }

  // Highlight current year
  if (highlightYear && hist[highlightYear]) {
    const xPos = xScale(+highlightYear);
    svg.append('line')
      .attr('x1', xPos).attr('x2', xPos)
      .attr('y1', 0).attr('y2', iH)
      .attr('stroke', '#1a2340')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3 2')
      .attr('opacity', 0.5);
  }

  // X axis (year labels)
  svg.append('g').attr('transform', `translate(0,${iH})`)
    .call(d3.axisBottom(xScale).ticks(5).tickFormat(d3.format('d')))
    .call(g => {
      g.select('.domain').remove();
      g.selectAll('.tick line').remove();
      g.selectAll('text').style('font-size', '9px').style('fill', '#8a95a3');
    });

  // Y axis
  svg.append('g')
    .call(d3.axisLeft(yScale).ticks(4).tickFormat(d => formatDollarsTick(d)))
    .call(g => {
      g.select('.domain').remove();
      g.selectAll('.tick line').remove();
      g.selectAll('text').style('font-size', '9px').style('fill', '#8a95a3');
    });

  // Simple legend
  const leg = svg.append('g').attr('transform', `translate(0,${iH + 14})`);
  lineStyles.forEach((s, i) => {
    const g = leg.append('g').attr('transform', `translate(${i * 70}, 0)`);
    g.append('line').attr('x1', 0).attr('x2', 12).attr('y1', -3).attr('y2', -3)
      .attr('stroke', s.color).attr('stroke-width', 1.5);
    g.append('text').attr('x', 15).attr('y', 0)
      .text(s.label).style('font-size', '8.5px').style('fill', '#8a95a3');
  });
}

// ── Search ─────────────────────────────────────────────────────────────────
let searchTimeout = null;

searchInput.addEventListener('input', function () {
  clearTimeout(searchTimeout);
  const q = this.value.trim().toLowerCase();
  if (q.length < 2) { searchResults.style.display = 'none'; return; }
  searchTimeout = setTimeout(() => runSearch(q), 200);
});

searchInput.addEventListener('focus', function () {
  if (this.value.trim().length >= 2) searchResults.style.display = 'block';
});

document.addEventListener('click', function (e) {
  if (!e.target.closest('.search-group')) searchResults.style.display = 'none';
});

searchClear.addEventListener('click', function () {
  searchInput.value = '';
  searchResults.style.display = 'none';
  searchResults.innerHTML = '';
});

function runSearch(q) {
  if (!parcelsData) return;
  const hits = [];
  for (const feat of parcelsData.features) {
    const p = feat.properties;
    if (p.addr.toLowerCase().includes(q) || p.id.includes(q)) {
      hits.push(feat);
      if (hits.length >= 15) break;
    }
  }

  searchResults.innerHTML = '';
  if (!hits.length) {
    searchResults.innerHTML = '<div class="search-result-item" style="color:#8a95a3">No results</div>';
    searchResults.style.display = 'block';
    return;
  }

  for (const feat of hits) {
    const p = feat.properties;
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.innerHTML = `
      <div class="search-result-addr">${p.addr}</div>
      <div class="search-result-sub">${p.neigh || ''} &middot; Parcel ${p.id}</div>
    `;
    div.addEventListener('click', () => {
      searchResults.style.display = 'none';
      searchInput.value = p.addr;
      zoomToParcel(feat);
    });
    searchResults.appendChild(div);
  }
  searchResults.style.display = 'block';
}

function zoomToParcel(feat) {
  const [lon, lat] = feat.geometry.coordinates;
  map.setView([lat, lon], 17, { animate: true });
  // find and click the marker
  markerLayer.eachLayer(m => {
    if (m._feat === feat) {
      selectParcel(feat, m);
    }
  });
}

// ── Controls event handlers ────────────────────────────────────────────────
yearSlider.addEventListener('input', function () {
  currentYear = this.value;
  yearDisplay.textContent = currentYear;
  refreshColors();
  if (activeMarker) {
    // Refresh detail panel for new year
    openPanel(activeMarker._feat);
  }
});

document.querySelectorAll('input[name="measure"]').forEach(el => {
  el.addEventListener('change', function () {
    currentMeasure = this.value;
    refreshColors();
    if (activeMarker) openPanel(activeMarker._feat);
  });
});

document.querySelectorAll('input[name="scale"]').forEach(el => {
  el.addEventListener('change', function () {
    currentScale = this.value;
    refreshColors();
  });
});

document.getElementById('toggle-neighborhoods').addEventListener('change', function () {
  showNbhds = this.checked;
  if (nbhdLayer) {
    if (showNbhds) nbhdLayer.addTo(map);
    else map.removeLayer(nbhdLayer);
  }
});

document.getElementById('toggle-labels').addEventListener('change', function () {
  showLabels = this.checked;
  if (nbhdLabelLayer) {
    if (showLabels) nbhdLabelLayer.addTo(map);
    else map.removeLayer(nbhdLabelLayer);
  }
});

// ── Format helpers ─────────────────────────────────────────────────────────
function formatDollars(v) {
  if (v == null) return '—';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
  return '$' + v.toLocaleString();
}

function formatDollarsBig(v) {
  if (v == null) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M';
  return '$' + v.toLocaleString();
}

function formatDollarsTick(v) {
  if (v === 0) return '$0';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + v;
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [parcelsResp, nbhdResp] = await Promise.all([
      fetch('data/parcels.geojson'),
      fetch('data/neighborhoods.geojson'),
    ]);

    if (!parcelsResp.ok) throw new Error('Failed to load parcels.geojson');
    if (!nbhdResp.ok)    throw new Error('Failed to load neighborhoods.geojson');

    parcelsData = await parcelsResp.json();
    nbhdData    = await nbhdResp.json();

    buildNeighborhoods();
    buildMarkers();

    loadingEl.classList.add('hidden');
  } catch (err) {
    loadingEl.innerHTML = `<div class="loading-inner"><p style="color:#c0392b">Error: ${err.message}<br><small>Run this app through a local web server.<br>e.g. <code>python -m http.server 8000</code></small></p></div>`;
  }
}

init();

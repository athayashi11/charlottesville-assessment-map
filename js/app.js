'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let parcelsData    = null;   // raw GeoJSON FeatureCollection
let nbhdData       = null;   // neighborhoods GeoJSON
let indexData      = null;   // price index JSON
let currentYear    = '2026';
let currentMeasure = 't';    // 't' | 'l' | 'i'
let currentScale   = 'quantile';
let colorScale     = null;
let markerLayer    = null;
let nbhdLayer      = null;
let nbhdLabelLayer = null;
let activeMarker   = null;   // highlighted marker
let activePanel      = null;   // 'property' | 'neighborhood'

const MEASURE_LABELS = {
  t:   'Total Assessed Value',
  l:   'Land Value',
  i:   'Improvement Value',
  ar:  'Assessment Ratio (index-adjusted)',
  ars: 'Assessment Ratio (prior-year sale)',
};

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

  // Assessment ratio: diverging scale centered on 1.0
  if (currentMeasure === 'ar' || currentMeasure === 'ars') {
    const maxDev = Math.min(d3.max(valid.map(v => Math.abs(v - 1))), 0.6);
    return d3.scaleDivergingSqrt(d3.interpolateRdBu)
      .domain([1 + maxDev, 1, 1 - maxDev])
      .clamp(true);
  }

  return d3.scaleQuantile().domain(valid).range(d3.quantize(COLOR_INTERP, 8));
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
  if (currentMeasure === 'ar')  return entry.ar  ?? null;
  if (currentMeasure === 'ars') return entry.ars ?? null;
  return entry[currentMeasure] || null;
}

// ── Legend ─────────────────────────────────────────────────────────────────
function drawLegend() {
  legendTitle.textContent = MEASURE_LABELS[currentMeasure];
  const ctx = legendCanvas.getContext('2d');
  const W = legendCanvas.width;

  if (currentMeasure === 'ar' || currentMeasure === 'ars') {
    // Diverging: blue (under) → white (= 1) → red (over)
    for (let x = 0; x < W; x++) {
      ctx.fillStyle = d3.interpolateRdBu(1 - x / W);
      ctx.fillRect(x, 0, 1, 10);
    }
    const values = parcelsData.features.map(getValue).filter(v => v != null && v > 0);
    if (!values.length) return;
    const maxDev = Math.min(d3.max(values.map(v => Math.abs(v - 1))), 0.6);
    legendMin.textContent = `${(1 - maxDev).toFixed(2)} (under)`;
    legendMax.textContent = `${(1 + maxDev).toFixed(2)} (over)`;
  } else {
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

function isVisible(feat) {
  // When viewing prior-year sale AR, only show properties sold in the prior year
  if (currentMeasure === 'ars') {
    return feat.properties.hist?.[currentYear]?.ars != null;
  }
  return true;
}

function refreshColors() {
  if (!markerLayer) return;
  const values = parcelsData.features.filter(isVisible).map(getValue);
  colorScale = buildColorScale(values);

  markerLayer.eachLayer(function (m) {
    const vis = isVisible(m._feat);
    if (!vis) {
      m.setStyle({ fillOpacity: 0, opacity: 0 });
      return;
    }
    const color = getColor(m._feat);
    m.setStyle({ fillColor: color, fillOpacity: 0.85, opacity: 1 });
    if (m === activeMarker) m.setStyle({ radius: 6, weight: 2, color: '#1a2340' });
  });

  drawLegend();
  updateSummaryStats();
  drawDecileChart();
}

// ── Decile chart ───────────────────────────────────────────────────────────
function drawDecileChart() {
  const container = document.getElementById('decile-chart');
  container.innerHTML = '';

  // Collect (marketValue, measureValue) pairs for visible parcels this year
  const pairs = [];
  for (const feat of parcelsData.features) {
    if (!isVisible(feat)) continue;
    const entry = feat.properties.hist?.[currentYear];
    if (!entry) continue;

    // Market value: use mv (index-adjusted est.) if available, fall back to t
    const mv = entry.mv ?? entry.t;
    if (!mv || mv <= 0) continue;

    const m = getValue(feat);
    if (m == null || !isFinite(m)) continue;

    pairs.push({ mv, m });
  }

  if (pairs.length < 10) return;

  // Sort by market value and divide into 10 equal-count deciles
  pairs.sort((a, b) => a.mv - b.mv);
  const n = pairs.length;
  const deciles = Array.from({ length: 10 }, (_, d) => {
    const lo = Math.floor(d * n / 10);
    const hi = Math.floor((d + 1) * n / 10);
    const slice = pairs.slice(lo, hi);
    const avgM  = d3.mean(slice, p => p.m);
    // x-label: upper-bound market value of this decile
    const mvUpper = slice[slice.length - 1].mv;
    return { d: d + 1, avgM, mvUpper };
  });

  // Dimensions — full controls width, compact height
  const W      = container.clientWidth || 900;
  const H      = 90;
  const margin = { top: 8, right: 8, bottom: 34, left: 42 };
  const iW     = W - margin.left - margin.right;
  const iH     = H - margin.top - margin.bottom;

  const isRatio = currentMeasure === 'ar' || currentMeasure === 'ars';

  const xScale = d3.scaleBand()
    .domain(deciles.map(d => d.d))
    .range([0, iW])
    .padding(0.18);

  const yExtent = d3.extent(deciles, d => d.avgM);
  // For ratio measures include 1.0 in domain; for dollar measures include 0
  const yMin = isRatio ? Math.min(yExtent[0] * 0.97, 0.9) : 0;
  const yMax = isRatio ? Math.max(yExtent[1] * 1.03, 1.1) : yExtent[1] * 1.08;

  const yScale = d3.scaleLinear().domain([yMin, yMax]).range([iH, 0]);

  const svg = d3.select(container).append('svg')
    .attr('width', W).attr('height', H)
    .append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  // Horizontal grid lines
  svg.append('g').selectAll('line')
    .data(yScale.ticks(4))
    .join('line')
    .attr('x1', 0).attr('x2', iW)
    .attr('y1', d => yScale(d)).attr('y2', d => yScale(d))
    .attr('stroke', '#ddd8d0').attr('stroke-width', 0.5);

  // Reference line at 1.0 for ratio measures
  if (isRatio) {
    svg.append('line')
      .attr('x1', 0).attr('x2', iW)
      .attr('y1', yScale(1)).attr('y2', yScale(1))
      .attr('stroke', '#888').attr('stroke-width', 0.8)
      .attr('stroke-dasharray', '3 2');
  }

  // Bars — color matches map color scale for the avg measure value
  const barGroups = svg.selectAll('.decile-bar')
    .data(deciles)
    .join('g')
    .attr('class', 'decile-bar')
    .attr('transform', d => `translate(${xScale(d.d)}, 0)`);

  // Bar fill: diverging red/blue for ratio measures, sequential navy for dollar measures
  function barFill(avgM) {
    if (isRatio) {
      if (avgM > 1.02) return '#b91c1c';   // over-assessed → red
      if (avgM < 0.98) return '#1d4ed8';   // under-assessed → blue
      return '#2d6a4f';                     // near parity → green
    }
    return '#2b3658';  // solid navy for dollar measures
  }

  barGroups.append('rect')
    .attr('x', 0)
    .attr('width', xScale.bandwidth())
    .attr('y', d => yScale(Math.min(d.avgM, yMax)))
    .attr('height', d => Math.abs(yScale(yMin) - yScale(Math.min(d.avgM, yMax))))
    .attr('fill', d => barFill(d.avgM))
    .attr('opacity', 0.82)
    .attr('rx', 1);

  // Value label above each bar
  barGroups.append('text')
    .attr('x', xScale.bandwidth() / 2)
    .attr('y', d => yScale(Math.max(d.avgM, yMin)) - 3)
    .attr('text-anchor', 'middle')
    .style('font-size', '7.5px')
    .style('fill', '#4a5568')
    .text(d => isRatio ? d.avgM.toFixed(2) : formatDollarsTick(d.avgM));

  // X-axis: market value upper bound per decile
  svg.append('g')
    .attr('transform', `translate(0,${iH})`)
    .call(d3.axisBottom(xScale)
      .tickFormat((d, i) => formatDollarsTick(deciles[i].mvUpper)))
    .call(g => {
      g.select('.domain').remove();
      g.selectAll('.tick line').remove();
      g.selectAll('text')
        .style('font-size', '8px')
        .style('fill', '#8a95a3')
        .attr('dy', '1em');
    });

  // X-axis label
  svg.append('text')
    .attr('x', iW / 2).attr('y', iH + 30)
    .attr('text-anchor', 'middle')
    .style('font-size', '8px').style('fill', '#aaa')
    .text('Market value decile upper bound');

  // Y-axis
  svg.append('g')
    .call(d3.axisLeft(yScale).ticks(4)
      .tickFormat(d => isRatio ? d.toFixed(2) : formatDollarsTick(d)))
    .call(g => {
      g.select('.domain').remove();
      g.selectAll('.tick line').remove();
      g.selectAll('text').style('font-size', '8px').style('fill', '#8a95a3');
    });

  // Update title
  document.getElementById('decile-chart-title').textContent =
    `Avg. ${MEASURE_LABELS[currentMeasure]} by market value decile \u2014 ${currentYear}${currentMeasure === 'ars' ? ' (prior-year sales only)' : ''}`;
}

// ── Summary stats ──────────────────────────────────────────────────────────
function updateSummaryStats() {
  const values = parcelsData.features.filter(isVisible).map(getValue).filter(v => v != null && v > 0);
  document.getElementById('stat-year').textContent = currentYear;
  document.getElementById('stat-parcels').textContent = values.length.toLocaleString();
  document.getElementById('stat-median').textContent = formatDollars(d3.median(values));
  document.getElementById('stat-total').textContent  = formatDollarsBig(d3.sum(values));
}

// ── Neighborhood colors ────────────────────────────────────────────────────
// 20 visually distinct, muted hues that work as background fills behind dots
const NBHD_PALETTE = [
  '#c8d9e6','#d4e8c8','#e8d9c0','#d9c8e8','#c8e8e0',
  '#e8e0c8','#e8c8d4','#c8e8cc','#e0c8e8','#cce8e4',
  '#e8d4c8','#c8d4e8','#dce8c8','#e8c8e0','#c8e8d8',
  '#e8e4c8','#d0c8e8','#c8e8e8','#e8d0c8','#dce8d8',
];

function nbhdColor(index) {
  return NBHD_PALETTE[index % NBHD_PALETTE.length];
}

// ── Neighborhood layer ─────────────────────────────────────────────────────
function buildNeighborhoods() {
  if (nbhdLayer) map.removeLayer(nbhdLayer);
  if (nbhdLabelLayer) map.removeLayer(nbhdLabelLayer);

  // Assign a stable color index to each neighborhood by sort order
  const nbhdIndex = {};
  nbhdData.features.forEach((feat, i) => {
    nbhdIndex[feat.properties.NeighCode] = i;
  });

  nbhdLayer = L.geoJSON(nbhdData, {
    style(feat) {
      const idx = nbhdIndex[feat.properties.NeighCode] ?? 0;
      const fill = nbhdColor(idx);
      return {
        fillColor: fill,
        fillOpacity: 0.45,
        color: '#1a2340',
        weight: 1.2,
        opacity: 0.4,
      };
    },
    onEachFeature(feat, layer) {
      const baseIdx = nbhdIndex[feat.properties.NeighCode] ?? 0;
      const baseFill = nbhdColor(baseIdx);
      layer.on('mouseover', function () {
        layer.setStyle({ fillOpacity: 0.65, opacity: 0.8, weight: 2 });
        layer.bringToFront();
      });
      layer.on('mouseout', function () {
        layer.setStyle({ fillColor: baseFill, fillOpacity: 0.45, opacity: 0.4, weight: 1.2 });
      });
      layer.on('click', function () {
        openNeighborhoodPanel(feat.properties.NeighCode, feat.properties.NeighHood);
      });
    },
  });

  nbhdLayer.addTo(map);

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
          font-size:9.5px;
          font-weight:600;
          letter-spacing:0.04em;
          color:#1a2340;
          text-transform:uppercase;
          white-space:nowrap;
          pointer-events:none;
          text-shadow:0 0 4px #fff,0 0 4px #fff,0 0 4px #fff,0 0 4px #fff;
          opacity:0.9;
        ">${name}</div>`,
        iconAnchor: [0, 0],
      }),
      interactive: false,
    });
    nbhdLabelLayer.addLayer(label);
  }
  nbhdLabelLayer.addTo(map);
}

// ── Tooltip ────────────────────────────────────────────────────────────────
function showTooltip(e, feat) {
  const v = getValue(feat);
  const p = feat.properties;
  const vStr = v != null ? (currentMeasure === 'ar' ? v.toFixed(3) : formatDollars(v)) : 'No data';
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
    ${cur.ar != null ? `
    <div class="panel-ar-row">
      <div class="panel-ar-block ${cur.ar > 1.05 ? 'ar-over' : cur.ar < 0.95 ? 'ar-under' : 'ar-fair'}">
        <span class="panel-ar-label">Assessment Ratio (index-adjusted)</span>
        <span class="panel-ar-num">${cur.ar.toFixed(3)}</span>
        <span class="panel-ar-sub">
          ${cur.ar > 1.05 ? 'Over-assessed' : cur.ar < 0.95 ? 'Under-assessed' : 'Near market value'}
          &mdash; est. market value ${formatDollars(cur.mv)}
          (sale ${cur.sy}, index-adjusted)
        </span>
      </div>
    </div>` : ''}
    ${cur.ars != null ? `
    <div class="panel-ar-row">
      <div class="panel-ar-block ${cur.ars > 1.05 ? 'ar-over' : cur.ars < 0.95 ? 'ar-under' : 'ar-fair'}">
        <span class="panel-ar-label">Assessment Ratio (prior-year sale)</span>
        <span class="panel-ar-num">${cur.ars.toFixed(3)}</span>
        <span class="panel-ar-sub">
          ${cur.ars > 1.05 ? 'Over-assessed' : cur.ars < 0.95 ? 'Under-assessed' : 'Near market value'}
          &mdash; sale price ${formatDollars(cur.sp)} in ${currentYear - 1}
        </span>
      </div>
    </div>` : ''}


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
          <th>AR</th>
          <th>Sale AR</th>
        </tr>
      </thead>
      <tbody>
        ${years.slice().reverse().map(yr => {
          const e = hist[yr];
          const arClass  = e.ar  == null ? '' : e.ar  > 1.05 ? 'ar-cell-over' : e.ar  < 0.95 ? 'ar-cell-under' : '';
          const arsClass = e.ars == null ? '' : e.ars > 1.05 ? 'ar-cell-over' : e.ars < 0.95 ? 'ar-cell-under' : '';
          return `
          <tr class="${yr === currentYear ? 'current-year' : ''}">
            <td>${yr}</td>
            <td>${e.t != null ? formatDollars(e.t) : '—'}</td>
            <td>${e.l != null ? formatDollars(e.l) : '—'}</td>
            <td>${e.i != null ? formatDollars(e.i) : '—'}</td>
            <td class="${arClass}">${e.ar != null ? e.ar.toFixed(3) : '—'}</td>
            <td class="${arsClass}">${e.ars != null ? e.ars.toFixed(3) : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  activePanel = 'property';

  // Draw assessment history chart
  drawHistoryChart(hist, years, currentYear);

  // Append neighborhood price index section
  const neighCode = p.neighCode;
  const hasIndex  = indexData && indexData.neighborhoods[neighCode];
  const idxSection = document.createElement('div');
  idxSection.innerHTML = `
    <div class="panel-section-title" style="margin-top:1.25rem">
      Neighborhood Price Index (2000 = 100)
      <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted);font-size:0.68rem">
        &mdash; ${p.neigh || 'this neighborhood'}
      </span>
    </div>
    ${hasIndex
      ? '<div id="index-chart"></div>'
      : '<p style="font-size:0.78rem;color:var(--muted);margin-top:0.35rem">Insufficient repeat sales in this neighborhood for a price index.</p>'
    }
  `;
  panelContent.appendChild(idxSection);
  if (hasIndex) drawIndexChart('index-chart', neighCode, indexData.city);

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

// ── Neighborhood panel ─────────────────────────────────────────────────────
function openNeighborhoodPanel(code, name) {
  // Deselect any active property marker
  if (activeMarker) {
    activeMarker.setStyle({ radius: 4, weight: 0.5, color: 'rgba(0,0,0,0.15)', fillColor: getColor(activeMarker._feat) });
    activeMarker = null;
  }
  activePanel = 'neighborhood';

  const nbhd = indexData && indexData.neighborhoods[code];
  const cityIdx = indexData ? indexData.city : null;
  const displayName = name || (nbhd && nbhd.name) || `Neighborhood ${code}`;

  let statsHtml = '';
  let indexHtml = '';
  if (nbhd) {
    const idx = nbhd.index;
    const years = Object.keys(idx).map(Number).sort((a, b) => a - b);
    const latest = idx[years[years.length - 1]];
    const base   = idx[2000] || 100;
    const pctChg = latest != null ? ((latest / base - 1) * 100).toFixed(1) : null;
    const peakYr = years.reduce((best, yr) => (idx[yr] > (idx[best] || 0) ? yr : best), years[0]);

    statsHtml = `
      <div class="panel-value-grid" style="grid-template-columns:1fr 1fr 1fr 1fr">
        <div class="panel-val-item">
          <span class="panel-val-label">Sales</span>
          <span class="panel-val-num">${nbhd.n_sales.toLocaleString()}</span>
        </div>
        <div class="panel-val-item">
          <span class="panel-val-label">Repeat pairs</span>
          <span class="panel-val-num">${nbhd.n_pairs.toLocaleString()}</span>
        </div>
        <div class="panel-val-item">
          <span class="panel-val-label">Index (2025)</span>
          <span class="panel-val-num">${latest != null ? latest.toFixed(0) : '—'}</span>
        </div>
        <div class="panel-val-item">
          <span class="panel-val-label">Since 2000</span>
          <span class="panel-val-num" style="color:${pctChg > 0 ? '#2d6a4f' : '#c0392b'}">${pctChg != null ? (pctChg > 0 ? '+' : '') + pctChg + '%' : '—'}</span>
        </div>
      </div>
    `;
    indexHtml = `<div class="panel-section-title">Price Index vs City (2000 = 100)</div>
                 <div id="index-chart"></div>`;
  } else {
    indexHtml = `<p style="font-size:0.78rem;color:var(--muted);margin-top:0.5rem">
      Insufficient repeat sales to estimate a price index for this neighborhood.
    </p>`;
  }

  panelContent.innerHTML = `
    <div class="panel-nbhd-badge">Neighborhood</div>
    <div class="panel-addr">${displayName}</div>
    <div class="panel-meta"><span>Code: ${code}</span></div>
    ${statsHtml}
    ${indexHtml}
  `;

  if (nbhd) {
    drawIndexChart('index-chart', code, cityIdx);

    // Assessment ratio trend section
    const arData = nbhd.ar;
    const cityAr = indexData.city_ar;
    if (arData && Object.keys(arData).length) {
      const arSection = document.createElement('div');
      arSection.innerHTML = `
        <div class="panel-section-title" style="margin-top:1.1rem">Median Assessment Ratio by Year</div>
        <div id="nbhd-ar-chart"></div>`;
      panelContent.appendChild(arSection);
      drawArChart('nbhd-ar-chart', arData, cityAr);
    }
  }

  detailPanel.classList.remove('panel-hidden');
  setTimeout(() => map.invalidateSize(), 220);
}

// ── Price index chart ──────────────────────────────────────────────────────
function drawIndexChart(containerId, nbhdCode, cityIdx) {
  const container = document.getElementById(containerId);
  if (!container || !indexData) return;
  container.innerHTML = '';

  const nbhd = indexData.neighborhoods[nbhdCode];
  if (!nbhd) return;

  const W = 292;
  const H = 130;
  const margin = { top: 10, right: 12, bottom: 24, left: 40 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top - margin.bottom;

  // Build series: neighborhood + city, years 1997–2025
  const years = indexData.years.map(Number).filter(y => y >= 1997 && y <= 2025);
  const nbhdSeries = years.map(y => ({ year: y, v: nbhd.index[String(y)] ?? null }));
  const citySeries = cityIdx ? years.map(y => ({ year: y, v: cityIdx[String(y)] ?? null })) : [];

  const allVals = [...nbhdSeries, ...citySeries].map(d => d.v).filter(v => v != null);
  const yMax = Math.max(d3.max(allVals), 110);
  const yMin = Math.min(d3.min(allVals), 90);

  const xScale = d3.scaleLinear().domain([d3.min(years), d3.max(years)]).range([0, iW]);
  const yScale = d3.scaleLinear().domain([yMin * 0.95, yMax * 1.05]).range([iH, 0]);

  const svg = d3.select(container).append('svg')
    .attr('width', W).attr('height', H)
    .append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  // Grid
  svg.append('g').selectAll('line')
    .data(yScale.ticks(5))
    .join('line')
    .attr('x1', 0).attr('x2', iW)
    .attr('y1', d => yScale(d)).attr('y2', d => yScale(d))
    .attr('stroke', '#ddd8d0').attr('stroke-width', 0.5);

  // Base-100 reference line
  svg.append('line')
    .attr('x1', 0).attr('x2', iW)
    .attr('y1', yScale(100)).attr('y2', yScale(100))
    .attr('stroke', '#aaa').attr('stroke-width', 0.8).attr('stroke-dasharray', '3 2');

  const lineGen = d3.line().defined(d => d.v != null)
    .x(d => xScale(d.year)).y(d => yScale(d.v)).curve(d3.curveMonotoneX);

  // City line (grey, behind)
  if (citySeries.length) {
    svg.append('path').datum(citySeries)
      .attr('fill', 'none').attr('stroke', '#aaa').attr('stroke-width', 1.2)
      .attr('stroke-dasharray', '4 2').attr('d', lineGen);
  }

  // Neighborhood line (accent, in front)
  svg.append('path').datum(nbhdSeries)
    .attr('fill', 'none').attr('stroke', '#b5895a').attr('stroke-width', 2)
    .attr('d', lineGen);

  // Axes
  svg.append('g').attr('transform', `translate(0,${iH})`)
    .call(d3.axisBottom(xScale).ticks(6).tickFormat(d3.format('d')))
    .call(g => { g.select('.domain').remove(); g.selectAll('.tick line').remove();
      g.selectAll('text').style('font-size', '9px').style('fill', '#8a95a3'); });

  svg.append('g')
    .call(d3.axisLeft(yScale).ticks(5).tickFormat(d => d.toFixed(0)))
    .call(g => { g.select('.domain').remove(); g.selectAll('.tick line').remove();
      g.selectAll('text').style('font-size', '9px').style('fill', '#8a95a3'); });

  // Legend
  const leg = svg.append('g').attr('transform', `translate(0,${iH + 16})`);
  [{ color: '#b5895a', label: 'This neighborhood' }, { color: '#aaa', label: 'City-wide', dash: '4 2' }]
    .forEach((s, i) => {
      const g = leg.append('g').attr('transform', `translate(${i * 120}, 0)`);
      const ln = g.append('line').attr('x1', 0).attr('x2', 14).attr('y1', -3).attr('y2', -3)
        .attr('stroke', s.color).attr('stroke-width', s.dash ? 1.2 : 2);
      if (s.dash) ln.attr('stroke-dasharray', s.dash);
      g.append('text').attr('x', 17).attr('y', 0)
        .text(s.label).style('font-size', '8.5px').style('fill', '#8a95a3');
    });
}

// ── Assessment Ratio trend chart ───────────────────────────────────────────
function drawArChart(containerId, nbhdAr, cityAr) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const W = 292, H = 120;
  const margin = { top: 10, right: 12, bottom: 24, left: 36 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top - margin.bottom;

  const years = Object.keys(nbhdAr).map(Number).sort((a, b) => a - b).filter(y => y >= 1997 && y <= 2025);
  const nbhdSeries = years.map(y => ({ year: y, v: nbhdAr[String(y)] ?? null }));
  const citySeries = cityAr ? years.map(y => ({ year: y, v: cityAr[String(y)] ?? null })) : [];

  const allVals = [...nbhdSeries, ...citySeries].map(d => d.v).filter(v => v != null);
  const yMin = Math.min(d3.min(allVals), 0.85);
  const yMax = Math.max(d3.max(allVals), 1.15);

  const xScale = d3.scaleLinear().domain([d3.min(years), d3.max(years)]).range([0, iW]);
  const yScale = d3.scaleLinear().domain([yMin * 0.97, yMax * 1.03]).range([iH, 0]);

  const svg = d3.select(container).append('svg')
    .attr('width', W).attr('height', H)
    .append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  // Grid
  svg.append('g').selectAll('line').data(yScale.ticks(5)).join('line')
    .attr('x1', 0).attr('x2', iW)
    .attr('y1', d => yScale(d)).attr('y2', d => yScale(d))
    .attr('stroke', '#ddd8d0').attr('stroke-width', 0.5);

  // AR = 1 reference line
  svg.append('line')
    .attr('x1', 0).attr('x2', iW)
    .attr('y1', yScale(1)).attr('y2', yScale(1))
    .attr('stroke', '#555').attr('stroke-width', 1).attr('stroke-dasharray', '3 2');
  svg.append('text').attr('x', iW + 3).attr('y', yScale(1) + 3)
    .text('1.0').style('font-size', '8px').style('fill', '#8a95a3');

  const lineGen = d3.line().defined(d => d.v != null)
    .x(d => xScale(d.year)).y(d => yScale(d.v)).curve(d3.curveMonotoneX);

  // City line
  if (citySeries.length) {
    svg.append('path').datum(citySeries)
      .attr('fill', 'none').attr('stroke', '#aaa').attr('stroke-width', 1.2)
      .attr('stroke-dasharray', '4 2').attr('d', lineGen);
  }

  // Neighborhood line
  svg.append('path').datum(nbhdSeries)
    .attr('fill', 'none').attr('stroke', '#b5895a').attr('stroke-width', 2)
    .attr('d', lineGen);

  // Axes
  svg.append('g').attr('transform', `translate(0,${iH})`)
    .call(d3.axisBottom(xScale).ticks(6).tickFormat(d3.format('d')))
    .call(g => { g.select('.domain').remove(); g.selectAll('.tick line').remove();
      g.selectAll('text').style('font-size', '9px').style('fill', '#8a95a3'); });

  svg.append('g')
    .call(d3.axisLeft(yScale).ticks(5).tickFormat(d => d.toFixed(2)))
    .call(g => { g.select('.domain').remove(); g.selectAll('.tick line').remove();
      g.selectAll('text').style('font-size', '9px').style('fill', '#8a95a3'); });

  // Legend
  const leg = svg.append('g').attr('transform', `translate(0,${iH + 16})`);
  [{ color: '#b5895a', label: 'This neighborhood' }, { color: '#aaa', label: 'City median', dash: '4 2' }]
    .forEach((s, i) => {
      const g = leg.append('g').attr('transform', `translate(${i * 120}, 0)`);
      const ln = g.append('line').attr('x1', 0).attr('x2', 14).attr('y1', -3).attr('y2', -3)
        .attr('stroke', s.color).attr('stroke-width', s.dash ? 1.2 : 2);
      if (s.dash) ln.attr('stroke-dasharray', s.dash);
      g.append('text').attr('x', 17).attr('y', 0)
        .text(s.label).style('font-size', '8.5px').style('fill', '#8a95a3');
    });
}

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
  if (activeMarker && activePanel === 'property') {
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
    const [parcelsResp, nbhdResp, indexResp] = await Promise.all([
      fetch('data/parcels.geojson'),
      fetch('data/neighborhoods.geojson'),
      fetch('data/price_index.json'),
    ]);

    if (!parcelsResp.ok) throw new Error('Failed to load parcels.geojson');
    if (!nbhdResp.ok)    throw new Error('Failed to load neighborhoods.geojson');

    parcelsData = await parcelsResp.json();
    nbhdData    = await nbhdResp.json();
    if (indexResp.ok) indexData = await indexResp.json();

    buildNeighborhoods();
    buildMarkers();
    drawDecileChart();

    loadingEl.classList.add('hidden');
  } catch (err) {
    loadingEl.innerHTML = `<div class="loading-inner"><p style="color:#c0392b">Error: ${err.message}<br><small>Run this app through a local web server.<br>e.g. <code>python -m http.server 8000</code></small></p></div>`;
  }
}

init();

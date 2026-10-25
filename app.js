// Sky Viewer — Phase 3 viewer.
//
// Loads site/manifest.json (built by prep/prepare_images.py), shows a
// DSS background, draws a footprint outline for every object, and lets
// you click a footprint or a sidebar entry to fly to that object and
// overlay its photo with an opacity slider.

// Approximate observing site (from the XISF OBSGEO keywords of the sample
// master). Good enough for a decorative horizon ring, not for anything
// precision-sensitive.
const OBSERVER_LAT_DEG = 40.69;
const OBSERVER_LON_DEG = -81.71;
const HORIZON_REFRESH_MS = 60 * 1000;

// An object auto-shows once the view center comes within this fraction of
// its own half-size, and only while the current FOV isn't more than this
// many times the object's size (so it doesn't pop in while zoomed way out).
const AUTO_SHOW_DISTANCE_FACTOR = 10;
const AUTO_SHOW_MAX_FOV_FACTOR = 50;

// Cap on how many photo overlays can be shown at once, so a very zoomed-out
// view with many qualifying objects doesn't load the whole manifest.
const MAX_VISIBLE_IMAGES = 6;

let aladin;
let manifest = [];
let discoverers = {};
let loadedImages = new Map(); // object id -> A.image instance, currently on screen
let opacitySlider;
let horizonOverlay;
let horizonDate = new Date();
let horizonIsLive = true;
let horizonDateLabel;
let sidebarEl;
let infoPanelEl;
let backdropEl;

A.init.then(async () => {
  aladin = A.aladin('#aladin-lite-div', {
    survey: 'P/DSS2/color',
    projection: 'AIT',
    fov: 360,
    target: '0 +0',
    cooFrame: 'ICRS',
    // Aladin's own built-in controls (coordinate frame display top-left,
    // layers/goto/projection/fullscreen icons top-right) are turned off:
    // they duplicate things this app already provides its own UI for
    // (the sidebar instead of goto, a single fixed survey/projection), and
    // they were overlapping the sidebar/info toggle buttons added for the
    // mobile layout. Fullscreen is still reachable via the settings menu.
    showFrame: false,
    showLayersControl: false,
    showGotoControl: false,
    showProjectionControl: false,
    showFullscreenControl: false,
  });

  opacitySlider = document.getElementById('opacity-slider');
  opacitySlider.addEventListener('input', onOpacityChange);

  // Mobile layout: the sidebar and info panel become off-canvas drawers
  // (see the max-width media query in style.css). These buttons/backdrop
  // exist in the DOM on desktop too, but stay hidden there via CSS, so
  // this wiring is simply never triggered on a wide screen.
  sidebarEl = document.getElementById('sidebar');
  infoPanelEl = document.getElementById('info-panel');
  backdropEl = document.getElementById('panel-backdrop');

  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    setPanelOpen(sidebarEl, !sidebarEl.classList.contains('open'));
    setPanelOpen(infoPanelEl, false);
  });
  document.getElementById('info-toggle').addEventListener('click', () => {
    setPanelOpen(infoPanelEl, !infoPanelEl.classList.contains('open'));
    setPanelOpen(sidebarEl, false);
  });
  backdropEl.addEventListener('click', () => {
    setPanelOpen(sidebarEl, false);
    setPanelOpen(infoPanelEl, false);
  });

  // Settings menu: a small dropdown under its own gear button, rather than
  // a full drawer, so it just toggles open/closed and closes on any click
  // outside itself (no backdrop needed).
  const settingsToggleEl = document.getElementById('settings-toggle');
  const settingsMenuEl = document.getElementById('settings-menu');
  const fullscreenButtonEl = document.getElementById('fullscreen-toggle');

  settingsToggleEl.addEventListener('click', (event) => {
    event.stopPropagation();
    settingsMenuEl.classList.toggle('open');
  });
  document.addEventListener('click', (event) => {
    if (settingsMenuEl.classList.contains('open') && !settingsMenuEl.contains(event.target)
      && event.target !== settingsToggleEl) {
      settingsMenuEl.classList.remove('open');
    }
  });

  fullscreenButtonEl.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.getElementById('app').requestFullscreen();
    }
    settingsMenuEl.classList.remove('open');
  });
  document.addEventListener('fullscreenchange', () => {
    fullscreenButtonEl.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  });

  // A long press on a touchscreen can register as a right-click in some
  // browsers (and always does when testing via a desktop device emulator),
  // which would pop the browser's own context menu on top of these
  // buttons. Suppress it here since these are just buttons, not links/text.
  document.querySelectorAll('.panel-toggle, #mobile-info-collapse, #mobile-info-tab').forEach((el) => {
    el.addEventListener('contextmenu', (event) => event.preventDefault());
  });

  // Compact mobile object-info overlay: collapses down to a small tab and
  // back via its own chevron buttons, independent of the full info drawer.
  const mobileInfoOverlayEl = document.getElementById('mobile-info-overlay');
  document.getElementById('mobile-info-collapse').addEventListener('click', () => {
    mobileInfoOverlayEl.classList.add('collapsed');
  });
  document.getElementById('mobile-info-tab').addEventListener('click', () => {
    mobileInfoOverlayEl.classList.remove('collapsed');
  });

  const response = await fetch('manifest.json');
  manifest = await response.json();

  const discoverersResponse = await fetch('discoverers.json');
  discoverers = await discoverersResponse.json();

  drawFootprints();
  buildSidebar();

  horizonOverlay = A.graphicOverlay({ color: '#8b5a2b', lineWidth: 2 });
  aladin.addOverlay(horizonOverlay);
  horizonDateLabel = document.getElementById('horizon-date-label');

  document.getElementById('horizon-back-month').addEventListener('click', () => shiftHorizonMonths(-1));
  document.getElementById('horizon-forward-month').addEventListener('click', () => shiftHorizonMonths(1));
  document.getElementById('horizon-back-day').addEventListener('click', () => shiftHorizonDays(-1));
  document.getElementById('horizon-forward-day').addEventListener('click', () => shiftHorizonDays(1));
  document.getElementById('horizon-now').addEventListener('click', resetHorizonToNow);
  document.getElementById('horizon-toggle').addEventListener('change', onHorizonToggle);

  drawHorizon();
  if (!document.getElementById('horizon-toggle').checked) {
    horizonOverlay.hide();
  }
  setInterval(() => {
    if (horizonIsLive) {
      horizonDate = new Date();
      drawHorizon();
    }
  }, HORIZON_REFRESH_MS);

  // Footprint click -> load that object. NOTE: this relies on the
  // 'objectClicked' event firing for A.polygon shapes and passing back
  // the same object we tagged with skyViewerId below. That part of the
  // Aladin Lite v3 API wasn't confirmed in the docs at the time this was
  // written, so it's logged to the console for verification — if
  // clicking a footprint does nothing, check the console output here
  // and adjust accordingly. The sidebar list is the reliable fallback.
  aladin.on('objectClicked', (object) => {
    console.log('objectClicked payload:', object);
    const id = object && (object.skyViewerId || (object.data && object.data.skyViewerId));
    if (id) {
      flyToObject(id);
    }
  });

  // Auto-show whichever object the view is currently centered on/near,
  // without requiring a click -- these fire on every pan/zoom (throttled
  // to ~100ms by Aladin itself).
  aladin.on('positionChanged', updateVisibleObject);
  aladin.on('zoomChanged', updateVisibleObject);

  // If the user grabs the map while a camera flight is in progress, give
  // them control immediately instead of fighting their input.
  const aladinDiv = document.getElementById('aladin-lite-div');
  ['mousedown', 'touchstart', 'wheel'].forEach((type) => {
    aladinDiv.addEventListener(type, stopCameraAnimation, { passive: true });
  });
});

// Local Sidereal Time in degrees, for a given JS Date and longitude.
// Standard GMST polynomial (Meeus-style), good to a few seconds.
function localSiderealTimeDeg(date, lonDeg) {
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  let gmst = 280.46061837 + 360.98564736629 * (JD - 2451545.0)
    + 0.000387933 * T * T - (T * T * T) / 38710000;
  gmst = ((gmst % 360) + 360) % 360;
  return ((gmst + lonDeg) % 360 + 360) % 360;
}

// RA/Dec of the alt=0 horizon circle, as seen from (latDeg, lonDeg) right now.
function horizonRingRaDec(latDeg, lonDeg, date) {
  const lat = (latDeg * Math.PI) / 180;
  const lst = localSiderealTimeDeg(date, lonDeg);
  const points = [];

  for (let az = 0; az < 360; az += 5) {
    const azRad = (az * Math.PI) / 180;
    const dec = Math.asin(Math.cos(lat) * Math.cos(azRad));
    const sinH = (-Math.sin(azRad)) / Math.cos(dec);
    const cosH = (-Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec));
    const hDeg = (Math.atan2(sinH, cosH) * 180) / Math.PI;
    const ra = ((lst - hDeg) % 360 + 360) % 360;
    points.push([ra, (dec * 180) / Math.PI]);
  }
  return points;
}

function drawHorizon() {
  horizonOverlay.removeAll();
  const points = horizonRingRaDec(OBSERVER_LAT_DEG, OBSERVER_LON_DEG, horizonDate);
  horizonOverlay.addFootprints(A.polyline(points, { closed: true, color: '#8b5a2b', lineWidth: 2 }));
  if (horizonDateLabel) {
    const suffix = horizonIsLive ? ' (now)' : '';
    horizonDateLabel.textContent = horizonDate.toLocaleString() + suffix;
  }
}

function shiftHorizonMonths(delta) {
  horizonIsLive = false;
  const d = new Date(horizonDate);
  d.setMonth(d.getMonth() + delta);
  horizonDate = d;
  drawHorizon();
}

function shiftHorizonDays(delta) {
  horizonIsLive = false;
  const d = new Date(horizonDate);
  d.setDate(d.getDate() + delta);
  horizonDate = d;
  drawHorizon();
}

function resetHorizonToNow() {
  horizonIsLive = true;
  horizonDate = new Date();
  drawHorizon();
}

function onHorizonToggle(event) {
  if (event.target.checked) {
    horizonOverlay.show();
  } else {
    horizonOverlay.hide();
  }
}

// Display order for known categories; anything else falls back to
// alphabetical and is appended after these.
const CATEGORY_ORDER = [
  'Emission Nebula',
  'Planetary Nebula',
  'Supernova Remnant',
  'Reflection Nebula',
  'Dark Nebula',
  'Open Cluster',
  'Globular Cluster',
  'Galaxy',
];

// Accent color per category, used for the footprint outline on the map, the
// sidebar entry name, and the info panel title/type.
const CATEGORY_COLORS = {
  Galaxy: '#4da6ff',
  'Emission Nebula': '#ff5c5c',
  'Planetary Nebula': '#c77dff',
  'Supernova Remnant': '#ffa94d',
  'Reflection Nebula': '#5ce1e6',
  'Dark Nebula': '#b08968',
  'Open Cluster': '#ffe066',
  'Globular Cluster': '#6bff8f',
};
const DEFAULT_CATEGORY_COLOR = '#00ffaa';

function categoryColor(category) {
  return CATEGORY_COLORS[category] || DEFAULT_CATEGORY_COLOR;
}

// manifest entries normally have a single string `category`, but a few
// images contain more than one kind of DSO (e.g. the Owl Nebula also has
// the Surfboard Galaxy, M108, in frame) and store an array instead.
function entryCategories(entry) {
  return Array.isArray(entry.category) ? entry.category : [entry.category];
}

// Which categories an entry is listed under in the sidebar -- normally the
// same as entryCategories(), but a manifest entry can override this with
// `sidebar_categories` to skip a heading its footprint/info panel still use
// (e.g. the Trifid only needs one sidebar listing, not one per nebula type).
function entrySidebarCategories(entry) {
  return entry.sidebar_categories || entryCategories(entry);
}

// Renders an entry's display name into `container`: for a single-category
// entry, the plain name in that category's color; for a multi-category
// entry with distinct per-object names (entry.category_labels), each name
// in its own category's color, joined by " & " in the default text color.
// Used for both the sidebar entries and the info panel title so they stay
// in sync.
function appendEntryNameSpans(container, entry) {
  const categories = entryCategories(entry);
  const nameLabels = categories.map((category, i) => ({
    text: (entry.category_labels && entry.category_labels[i]) || entry.name,
    color: categoryColor(category),
  }));

  container.innerHTML = '';
  if (new Set(nameLabels.map((l) => l.text)).size <= 1) {
    container.textContent = entry.name;
    container.style.color = categoryColor(categories[0]);
    return;
  }

  container.style.color = '';
  nameLabels.forEach((label, i) => {
    if (i > 0) {
      container.appendChild(document.createTextNode(' & '));
    }
    const span = document.createElement('span');
    span.textContent = label.text;
    span.style.color = label.color;
    container.appendChild(span);
  });
}

// Moves each corner of a footprint polygon away from its centroid by
// `factor`, so a second outline drawn with this sits just outside the real
// one (a negative factor would pull corners inward instead).
function scaleCornersFromCentroid(corners, factor) {
  const centroid = corners
    .reduce((acc, [ra, dec]) => [acc[0] + ra, acc[1] + dec], [0, 0])
    .map((v) => v / corners.length);
  return corners.map(([ra, dec]) => [
    centroid[0] + (ra - centroid[0]) * (1 + factor),
    centroid[1] + (dec - centroid[1]) * (1 + factor),
  ]);
}

// How far out from the real footprint the second color's outline is drawn,
// as a fraction of the distance from the centroid.
const FOOTPRINT_OUTSET_FRACTION = 0.08;

function drawFootprints() {
  const overlay = A.graphicOverlay({ color: DEFAULT_CATEGORY_COLOR, lineWidth: 2 });
  aladin.addOverlay(overlay);

  const polygons = [];
  manifest.forEach((entry) => {
    const categories = entryCategories(entry);

    const outer = A.polygon(entry.corners, { color: categoryColor(categories[0]) });
    outer.skyViewerId = entry.id;
    polygons.push(outer);

    // Multi-type objects get a second, slightly outset outline in the
    // second category's color, so the border reads as a "double border"
    // around the image instead of only showing one of the two types.
    if (categories.length > 1) {
      const outset = A.polygon(scaleCornersFromCentroid(entry.corners, FOOTPRINT_OUTSET_FRACTION), {
        color: categoryColor(categories[1]),
      });
      outset.skyViewerId = entry.id;
      polygons.push(outset);
    }
  });
  overlay.addFootprints(polygons);
}

function buildSidebar() {
  const list = document.getElementById('object-list');
  list.innerHTML = '';

  const byCategory = new Map();
  manifest.forEach((entry) => {
    // Multi-type objects are listed once under each of their categories
    // (the full name, each part in its own color -- see
    // appendEntryNameSpans), so every heading they belong to shows them.
    entrySidebarCategories(entry).forEach((category) => {
      if (!byCategory.has(category)) {
        byCategory.set(category, []);
      }
      byCategory.get(category).push(entry);
    });
  });

  const categories = [...byCategory.keys()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) {
      return a.localeCompare(b);
    }
    if (ai === -1 || bi === -1) {
      return ai === -1 ? 1 : -1;
    }
    return ai - bi;
  });

  categories.forEach((category) => {
    const header = document.createElement('li');
    header.textContent = category;
    header.className = 'category-header';
    list.appendChild(header);

    byCategory.get(category).forEach((entry) => {
      const li = document.createElement('li');
      li.dataset.id = entry.id;

      const thumb = document.createElement('img');
      thumb.className = 'object-thumb';
      thumb.src = entry.image_version ? `${entry.file}?v=${entry.image_version}` : entry.file;
      thumb.alt = '';
      thumb.loading = 'lazy';
      li.appendChild(thumb);

      const label = document.createElement('span');
      label.className = 'object-label';
      appendEntryNameSpans(label, entry);
      li.appendChild(label);

      li.addEventListener('click', () => {
        flyToObject(entry.id);
        setPanelOpen(sidebarEl, false);
      });
      list.appendChild(li);
    });
  });
}

// Accepts a single id, an iterable of ids, or null/undefined (clears all).
function setActiveSidebarEntry(ids) {
  const idSet = ids instanceof Set ? ids : new Set(ids ? [ids] : []);
  document.querySelectorAll('#object-list li').forEach((li) => {
    li.classList.toggle('active', idSet.has(li.dataset.id));
  });
}

function flyToObject(id) {
  const entry = manifest.find((e) => e.id === id);
  if (!entry) {
    return;
  }
  animateCameraTo(entry.ra, entry.dec, Math.max(entry.width_deg, entry.height_deg) * 1.5);
}

// --- Smooth camera flight ---------------------------------------------
// aladin.gotoRaDec()/setFoV() jump instantly, so we drive our own
// requestAnimationFrame loop: slerp the view center along the great-circle
// between start and target (so it doesn't take a weird path near the poles
// or across the RA 0/360 seam), and ease the FoV change in log-space since
// zoom reads as exponential, not linear.

const CAMERA_FLIGHT_MS = 2000;
// During the flight the FoV pulls back to this multiple of the larger of
// (start FoV, target FoV, angular distance travelled) before zooming back
// in, so a jump to a new target reads as "pull back to see where it is,
// then zoom in" rather than a flat zoom ramp.
const CAMERA_ZOOM_OUT_FACTOR = 2.2;
// Fraction of CAMERA_FLIGHT_MS spent zooming out; zooming back in starts
// immediately after, for the remaining (1 - this) fraction. The pan runs
// over the full CAMERA_FLIGHT_MS, so at 0.5 the zoom-out phase is exactly
// half as long as the pan.
const ZOOM_OUT_FRACTION = 0.5;
let cameraAnimationFrame = null;

function raDecToVector(raDeg, decDeg) {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}

function vectorToRaDec([x, y, z]) {
  const dec = Math.asin(Math.max(-1, Math.min(1, z)));
  const ra = (((Math.atan2(y, x) * 180) / Math.PI) % 360 + 360) % 360;
  return [ra, (dec * 180) / Math.PI];
}

function slerp(v0, v1, t) {
  const dot = Math.max(-1, Math.min(1, v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2]));
  const theta = Math.acos(dot);
  if (theta < 1e-6) {
    return v0;
  }
  const sinTheta = Math.sin(theta);
  const a = Math.sin((1 - t) * theta) / sinTheta;
  const b = Math.sin(t * theta) / sinTheta;
  return [a * v0[0] + b * v1[0], a * v0[1] + b * v1[1], a * v0[2] + b * v1[2]];
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Linear from edge to (1 - edge), with a smoothstep-based ramp in/out of
// that linear rate over the first and last `edge` fraction, so motion
// starts and ends at zero velocity instead of snapping into a constant
// rate. Used for the zoom phases so they aren't abrupt at full stop/peak.
function easeLinearWithSmoothedEdges(t, edge) {
  const smoothedArea = (u) => u * u * u - 0.5 * u * u * u * u; // antiderivative of the smoothstep ramp
  const rate = 1 / (1 - edge); // scales the ramps + linear middle to cover a total distance of 1
  if (t < edge) {
    return rate * edge * smoothedArea(t / edge);
  }
  if (t > 1 - edge) {
    return 1 - rate * edge * smoothedArea((1 - t) / edge);
  }
  return rate * edge * 0.5 + rate * (t - edge);
}

// How much of the start/end of each zoom phase (not the whole flight) eases
// in/out, with the rest of that phase moving at a constant rate.
const ZOOM_EDGE_SMOOTH_FRACTION = 0.05;

function stopCameraAnimation() {
  if (cameraAnimationFrame) {
    cancelAnimationFrame(cameraAnimationFrame);
    cameraAnimationFrame = null;
  }
}

function animateCameraTo(targetRa, targetDec, targetFov) {
  stopCameraAnimation();

  const [startRa, startDec] = aladin.getRaDec();
  const [startFovW, startFovH] = aladin.getFov();
  const startFov = Math.max(startFovW, startFovH);
  const startVec = raDecToVector(startRa, startDec);
  const targetVec = raDecToVector(targetRa, targetDec);
  const travelDeg = angularSeparationDeg(startRa, startDec, targetRa, targetDec);
  const peakFov = Math.min(360, Math.max(startFov, targetFov, travelDeg) * CAMERA_ZOOM_OUT_FACTOR);

  const logStartFov = Math.log(startFov);
  const logTargetFov = Math.log(targetFov);
  const logPeakFov = Math.log(peakFov);
  const startTime = performance.now();

  function step(now) {
    const t = Math.min(1, (now - startTime) / CAMERA_FLIGHT_MS);
    const panEased = easeInOutCubic(t);

    const [ra, dec] = vectorToRaDec(slerp(startVec, targetVec, panEased));
    aladin.gotoRaDec(ra, dec);

    // Zoom out to the peak over the first phase, then back in to the
    // target over the second; each phase is linear except for a smoothed
    // ramp in/out over its own first/last ZOOM_EDGE_SMOOTH_FRACTION.
    const logFov = t < ZOOM_OUT_FRACTION
      ? logStartFov + (logPeakFov - logStartFov)
        * easeLinearWithSmoothedEdges(t / ZOOM_OUT_FRACTION, ZOOM_EDGE_SMOOTH_FRACTION)
      : logPeakFov + (logTargetFov - logPeakFov)
        * easeLinearWithSmoothedEdges((t - ZOOM_OUT_FRACTION) / (1 - ZOOM_OUT_FRACTION), ZOOM_EDGE_SMOOTH_FRACTION);
    aladin.setFoV(Math.exp(logFov));

    if (t < 1) {
      cameraAnimationFrame = requestAnimationFrame(step);
    } else {
      cameraAnimationFrame = null;
    }
  }

  cameraAnimationFrame = requestAnimationFrame(step);
}

function loadImageOverlay(entry) {
  if (loadedImages.has(entry.id)) {
    return;
  }

  const cacheBustedFile = entry.image_version ? `${entry.file}?v=${entry.image_version}` : entry.file;
  const absoluteUrl = new URL(cacheBustedFile, window.location.href).href;
  console.log('loading image overlay:', absoluteUrl, entry.wcs);

  const image = A.image(absoluteUrl, {
    name: entry.name,
    imgFormat: 'jpeg',
    wcs: entry.wcs,
    opacity: Number(opacitySlider.value) / 100,
    successCallback: (ra, dec, fov, img) => {
      console.log('image overlay loaded ok:', entry.id, { ra, dec, fov });
    },
    errorCallback: (err) => {
      console.error('image overlay FAILED to load:', entry.id, err);
    },
  });
  aladin.setOverlayImageLayer(image, entry.id);
  loadedImages.set(entry.id, image);
}

function unloadImageOverlay(id) {
  if (!loadedImages.has(id)) {
    return;
  }
  aladin.removeImageLayer(id);
  loadedImages.delete(id);
}

// --- Info panel -----------------------------------------------------------
// Renders the "Position" block from the manifest's WCS-derived fields, and
// the "Capture"/"Equipment" blocks from the FITS keywords prepare_images.py
// pulled out of each object's PixInsight master (see xisf_common.py). Those
// keywords vary by capture software/pipeline, so any field can be missing.

function raToHms(raDeg) {
  const totalHours = ((raDeg % 360) + 360) % 360 / 15;
  const h = Math.floor(totalHours);
  const mFloat = (totalHours - h) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${h}h ${String(m).padStart(2, '0')}m ${s.toFixed(1).padStart(4, '0')}s`;
}

function decToDms(decDeg) {
  const sign = decDeg < 0 ? '-' : '+';
  const abs = Math.abs(decDeg);
  const d = Math.floor(abs);
  const mFloat = (abs - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${sign}${d}° ${String(m).padStart(2, '0')}′ ${s.toFixed(0).padStart(2, '0')}″`;
}

function formatDuration(totalSeconds) {
  const totalMinutes = Math.round(totalSeconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Formats a distance in light-years the way these are normally quoted --
// plain light-years below 1,000, then "thousand/million/billion ly" above
// that so big galaxy distances don't turn into unreadable digit strings.
function formatDistanceLy(ly) {
  if (ly === null || ly === undefined) {
    return null;
  }
  if (ly >= 1e9) {
    return `${(ly / 1e9).toFixed(ly >= 1e10 ? 0 : 1)} billion ly`;
  }
  if (ly >= 1e6) {
    return `${(ly / 1e6).toFixed(ly >= 1e7 ? 0 : 1)} million ly`;
  }
  if (ly >= 1e3) {
    return `${Math.round(ly).toLocaleString()} ly`;
  }
  return `${Math.round(ly)} ly`;
}

function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateSpan(startIso, endIso) {
  if (!startIso) {
    return null;
  }
  if (!endIso || formatDate(startIso) === formatDate(endIso)) {
    return formatDate(startIso);
  }
  return `${formatDate(startIso)} – ${formatDate(endIso)}`;
}

// Appends a <dt>label<dd>value row, skipping anything null/undefined so
// missing capture metadata just leaves that row out rather than showing
// "null" or "undefined".
function addRow(dl, label, value) {
  if (value === null || value === undefined || value === '') {
    return;
  }
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

// Renders an object's category list (e.g. "Galaxy" or "Nebula + Galaxy" for
// a multi-type entry) into `container`, each category in its own color.
// Shared by the full info panel and the compact mobile overlay.
function renderCategoryList(container, categories) {
  container.innerHTML = '';
  categories.forEach((category, i) => {
    if (i > 0) {
      container.appendChild(document.createTextNode(' + '));
    }
    const span = document.createElement('span');
    span.textContent = category;
    span.style.color = categoryColor(category);
    container.appendChild(span);
  });
}

// Fills a discovery <dl> with the standard set of rows, returning whether
// anything was added (so the caller can hide an all-empty section). Shared
// by the full info panel and the compact mobile overlay.
function populateDiscoveryDl(dl, discovery, discoverer) {
  dl.innerHTML = '';
  addRow(dl, 'Discovered by', discoverer ? discoverer.name : null);
  addRow(dl, 'Date', discovery ? discovery.date : null);
  addRow(dl, 'Location', discovery ? discovery.location : null);
  addRow(dl, 'Method', discovery ? discovery.method : null);
  addRow(dl, 'Notes', discovery ? discovery.notes : null);
  return dl.children.length > 0;
}

function updateInfoPanel(entry) {
  document.getElementById('info-empty').hidden = true;
  document.getElementById('info-content').hidden = false;
  const categories = entryCategories(entry);
  appendEntryNameSpans(document.getElementById('info-name'), entry);

  renderCategoryList(document.getElementById('info-category'), categories);

  // entry.distance is either one {value_ly, source} object (the image shows
  // a single physical object, however many nebula/galaxy types it's
  // classified under) or an array of them aligned 1:1 with
  // entry.category_labels, for frames like the Owl Nebula + M108 that show
  // two unrelated objects at very different distances.
  const infoDistance = document.getElementById('info-distance');
  infoDistance.innerHTML = '';
  const distanceList = Array.isArray(entry.distance)
    ? entry.distance
    : (entry.distance ? [entry.distance] : []);
  const distanceColors = (entry.category_labels && entry.category_labels.length === distanceList.length)
    ? categories
    : null;
  let shownDistances = 0;
  distanceList.forEach((d, i) => {
    const text = d ? formatDistanceLy(d.value_ly) : null;
    if (!text) {
      return;
    }
    if (shownDistances > 0) {
      infoDistance.appendChild(document.createTextNode(' · '));
    }
    const span = document.createElement('span');
    span.textContent = text;
    if (distanceColors) {
      span.style.color = categoryColor(distanceColors[i]);
    }
    if (d.source) {
      span.title = d.source;
    }
    infoDistance.appendChild(span);
    shownDistances += 1;
  });
  infoDistance.hidden = shownDistances === 0;

  const pixelScaleArcsecPerPx = (entry.wcs && entry.wcs.CDELT1)
    ? Math.abs(entry.wcs.CDELT1) * 3600
    : null;

  const position = document.getElementById('info-position');
  position.innerHTML = '';
  addRow(position, 'RA', raToHms(entry.ra));
  addRow(position, 'Dec', decToDms(entry.dec));
  addRow(position, 'Field size', `${(entry.width_deg * 60).toFixed(1)}′ × ${(entry.height_deg * 60).toFixed(1)}′`);
  addRow(position, 'Pixel scale', pixelScaleArcsecPerPx ? `${pixelScaleArcsecPerPx.toFixed(2)}″/px` : null);
  addRow(position, 'Position angle', `${entry.rotation_deg.toFixed(1)}°`);

  const capture = entry.capture || {};
  const captureSection = document.getElementById('info-capture-section');
  const captureDl = document.getElementById('info-capture');
  captureDl.innerHTML = '';
  addRow(captureDl, 'Captured', formatDateSpan(capture.date_obs, capture.date_end));
  addRow(captureDl, 'Total integration', capture.total_exposure_s ? formatDuration(capture.total_exposure_s) : null);
  addRow(captureDl, 'Frames', (capture.num_frames && capture.exptime_s) ? `${capture.num_frames} × ${capture.exptime_s}s` : null);
  addRow(captureDl, 'Filter', capture.filter);
  captureSection.hidden = captureDl.children.length === 0;

  const equipmentSection = document.getElementById('info-equipment-section');
  const equipmentDl = document.getElementById('info-equipment');
  equipmentDl.innerHTML = '';
  addRow(equipmentDl, 'Camera', capture.camera);
  addRow(equipmentDl, 'Telescope', capture.telescope);
  addRow(equipmentDl, 'Focal length', capture.focal_length_mm ? `${capture.focal_length_mm.toFixed(0)} mm` : null);
  addRow(equipmentDl, 'Pixel size', capture.pixel_size_um ? `${capture.pixel_size_um} µm` : null);
  addRow(equipmentDl, 'Gain', capture.gain_e_per_adu ? `${capture.gain_e_per_adu.toFixed(2)} e⁻/ADU` : null);
  equipmentSection.hidden = equipmentDl.children.length === 0;

  const discovery = entry.discovery || null;
  const discoverer = discovery ? discoverers[discovery.discoverer_id] : null;

  const discoverySection = document.getElementById('info-discovery-section');
  const hasDiscoveryRows = populateDiscoveryDl(document.getElementById('info-discovery'), discovery, discoverer);
  discoverySection.hidden = !hasDiscoveryRows;

  const photos = document.getElementById('info-discovery-photos');
  photos.innerHTML = '';
  if (discoverer) {
    addPhoto(photos, discoverer.portrait, discoverer.name);
    addPhoto(photos, discoverer.telescope_image, discoverer.telescope_name);
  }

  // Compact mobile overlay: a smaller mirror of name/type/discovery only
  // (no capture/equipment/photos -- that detail stays in the full drawer).
  document.getElementById('mobile-info-overlay').classList.add('has-object');
  appendEntryNameSpans(document.getElementById('mobile-info-name'), entry);
  renderCategoryList(document.getElementById('mobile-info-category'), categories);
  const mobileDiscoverySection = document.getElementById('mobile-info-discovery-section');
  const hasMobileDiscoveryRows = populateDiscoveryDl(
    document.getElementById('mobile-info-discovery'), discovery, discoverer,
  );
  mobileDiscoverySection.hidden = !hasMobileDiscoveryRows;
}

// Appends a <figure><img><figcaption> to a photo row, skipping entries with
// no image (e.g. discoverers predating photography, or naked-eye discoveries
// with no associated telescope).
function addPhoto(container, src, caption) {
  if (!src) {
    return;
  }
  const figure = document.createElement('figure');
  const img = document.createElement('img');
  img.src = src;
  img.alt = caption || '';
  img.loading = 'lazy';
  figure.appendChild(img);
  if (caption) {
    const figcaption = document.createElement('figcaption');
    figcaption.textContent = caption;
    figure.appendChild(figcaption);
  }
  container.appendChild(figure);
}

// Opens/closes a mobile drawer panel (#sidebar or #info-panel) and keeps
// the dimming backdrop in sync. No-op-ish on desktop, where the drawers
// are laid out as plain flex columns and .open has no visual effect.
function setPanelOpen(panelEl, open) {
  panelEl.classList.toggle('open', open);
  backdropEl.classList.toggle('open',
    sidebarEl.classList.contains('open') || infoPanelEl.classList.contains('open'));
}

function clearInfoPanel() {
  document.getElementById('info-empty').hidden = false;
  document.getElementById('info-content').hidden = true;
  document.getElementById('mobile-info-overlay').classList.remove('has-object');
}

// Great-circle angular separation between two RA/Dec points, in degrees.
function angularSeparationDeg(ra1, dec1, ra2, dec2) {
  const r1 = (dec1 * Math.PI) / 180;
  const r2 = (dec2 * Math.PI) / 180;
  const dRa = ((ra1 - ra2) * Math.PI) / 180;
  const cosC = Math.sin(r1) * Math.sin(r2) + Math.cos(r1) * Math.cos(r2) * Math.cos(dRa);
  return (Math.acos(Math.min(1, Math.max(-1, cosC))) * 180) / Math.PI;
}

function updateVisibleObject() {
  if (!manifest.length) {
    return;
  }

  const [viewRa, viewDec] = aladin.getRaDec();
  const [fovW, fovH] = aladin.getFov();
  const fov = Math.max(fovW, fovH);

  const candidates = [];
  for (const entry of manifest) {
    const dist = angularSeparationDeg(viewRa, viewDec, entry.ra, entry.dec);
    const halfSize = Math.max(entry.width_deg, entry.height_deg) / 2;
    const withinObject = dist < halfSize * AUTO_SHOW_DISTANCE_FACTOR;
    const zoomedInEnough = fov < Math.max(entry.width_deg, entry.height_deg) * AUTO_SHOW_MAX_FOV_FACTOR;
    if (withinObject && zoomedInEnough) {
      candidates.push({ entry, dist });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);
  const toShow = candidates.slice(0, MAX_VISIBLE_IMAGES);
  const toShowIds = new Set(toShow.map((c) => c.entry.id));

  for (const id of Array.from(loadedImages.keys())) {
    if (!toShowIds.has(id)) {
      unloadImageOverlay(id);
    }
  }
  for (const { entry } of toShow) {
    loadImageOverlay(entry);
  }

  setActiveSidebarEntry(toShowIds);

  if (toShow.length > 0) {
    updateInfoPanel(toShow[0].entry); // nearest to view center
  } else {
    clearInfoPanel();
  }
}

function onOpacityChange() {
  const value = Number(opacitySlider.value) / 100;
  for (const image of loadedImages.values()) {
    image.setOpacity(value);
  }
}

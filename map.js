// RDR2 Interactive Map - Polished, Responsive, Working
let map, defaultLayer, markerLayer, areaLayer;
let CATEGORY_LIST = [], COLOR_MAP = {};
const ICON_CACHE = {};
const CATEGORY_VISIBILITY = {};
const canvasRenderer = L.canvas({ padding: 0.5 });

const mapImageUrl = 'map.jpg';
const mapBounds = [[0, 0], [4096, 4096]];

let placing = false, pendingForm = null;
let isDrawingZone = false;
let currentZoneData = null;
let tempPoints = [];
let tempLayer = null;

function svgIconData(color) {
  const svg = encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><circle cx='9' cy='9' r='7' fill='${color}' stroke='white' stroke-width='2'/></svg>`
  );
  return `data:image/svg+xml;charset=UTF-8,${svg}`;
}

function getIcon(cat) {
  const color = COLOR_MAP[cat] || '#94a3b8';
  if (!ICON_CACHE[color]) {
    ICON_CACHE[color] = L.icon({
      iconUrl: svgIconData(color),
      iconSize: [18, 18],
      iconAnchor: [9, 9],
      popupAnchor: [0, -8]
    });
  }
  return ICON_CACHE[color];
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 1600);
}

const debounce = (fn, ms) => {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
};

function toggleCategory(cat, visible) {
  CATEGORY_VISIBILITY[cat] = visible;
  localStorage.setItem('rdr2map_visibility', JSON.stringify(CATEGORY_VISIBILITY));
  const toggleLayer = (layer) => {
    if (layer.data && layer.data.cat === cat) {
      if (visible) {
        map.addLayer(layer);
      } else {
        map.removeLayer(layer);
      }
    }
  };
  markerLayer.eachLayer(toggleLayer);
  areaLayer.eachLayer(toggleLayer);
}

function zoomToCategory(cat) {
  let bounds = null;
  const updateBounds = (ll) => {
    if (!bounds) bounds = L.latLngBounds(ll);
    else bounds.extend(ll);
  };
  const checkLayer = (layer) => {
    if (layer.data && layer.data.cat === cat) {
      if (layer instanceof L.Marker) {
        updateBounds(layer.getLatLng());
      } else if (layer instanceof L.Polygon) {
        if (!bounds) bounds = layer.getBounds();
        else bounds.extend(layer.getBounds());
      }
    }
  };
  markerLayer.eachLayer(checkLayer);
  areaLayer.eachLayer(checkLayer);
  if (bounds && bounds.isValid()) {
    map.fitBounds(bounds, { padding: [20, 20] });
    toast(`Zoomed to ${cat}`);
  } else {
    toast('No items in this category');
  }
}

async function initMap() {
  map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: 7,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120,
    wheelDebounceTime: 20,
    inertia: true,
    zoomAnimation: false,
    fadeAnimation: false,
    dragging: true // Enabled by default
  });

  L.imageOverlay(mapImageUrl, mapBounds).addTo(map);
  map.fitBounds(mapBounds);

  defaultLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  areaLayer = L.layerGroup().addTo(map);

  await loadConfigAndDefaults();
  loadUserData();

  // Zone drawing events (manual) - attached AFTER map creation
  map.on('click', (e) => {
    if (isDrawingZone) {
      addZonePoint(e);
    } else if (placing && pendingForm) {
      const { name, desc, cat } = pendingForm;
      const marker = L.marker(e.latlng, { icon: getIcon(cat), draggable: true }).addTo(markerLayer);
      marker.data = { name, desc, cat, latlng: [e.latlng.lat, e.latlng.lng] };
      marker.bindPopup(renderMarkerPopup(marker));
      marker.on('dragend', ev => {
        const ll = ev.target.getLatLng();
        marker.data.latlng = [ll.lat, ll.lng];
        saveUserData();
      });
      saveUserData();
      resetPlacing();
      toast('Marker added');
    }
  });
  map.on('dblclick', (e) => {
    if (isDrawingZone) {
      finishZoneDrawing(e);
    }
  });

  document.getElementById('defaultLayer').addEventListener('change', e => {
    if (e.target.checked) map.addLayer(defaultLayer);
    else map.removeLayer(defaultLayer);
  });

  document.getElementById('addMarkerBtn').addEventListener('click', openMarkerPanel);
  document.getElementById('drawAreaBtn').addEventListener('click', openZonePanel);
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importFile').addEventListener('change', importData);
  document.getElementById('clearBtn').addEventListener('click', clearUserData);
  document.getElementById('collapseBtn').addEventListener('click', toggleSidebar);
  document.getElementById('mobileClose')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
  });

  const addBtn = document.getElementById('addCatBtn');
  const addForm = document.getElementById('addCatForm');
  const cancelCatBtn = document.getElementById('cancelCatBtn');

  addBtn.addEventListener('click', () => {
    addForm.classList.toggle('hidden');
    if (!addForm.classList.contains('hidden')) document.getElementById('newCatName').focus();
  });
  cancelCatBtn.addEventListener('click', () => addForm.classList.add('hidden'));
  document.addEventListener('click', e => {
    if (!addForm.classList.contains('hidden')) {
      const within = addForm.contains(e.target) || addBtn.contains(e.target);
      if (!within) addForm.classList.add('hidden');
    }
  });
  document.getElementById('saveCatBtn').addEventListener('click', addCategoryFromForm);

  document.getElementById('closeListBtn').addEventListener('click', () => {
    document.getElementById('listPanel').classList.add('hidden');
  });
  document.getElementById('listSearch').addEventListener('input', debounce(() => {
    const q = document.getElementById('listSearch').value.toLowerCase().trim();
    filterList(q);
  }, 120));

  document.getElementById('zoomBtn').addEventListener('click', () => {
    const cat = document.getElementById('listTitle').textContent;
    zoomToCategory(cat);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      addForm.classList.add('hidden');
      closeMarkerPanel();
      closeZonePanel();
      document.getElementById('listPanel').classList.add('hidden');
      resetZoneDrawing();
    }
  });
}

// Build UI from JSON
async function loadConfigAndDefaults() {
  const res = await fetch('default-markers.json');
  const cfg = await res.json();

  const categories = cfg.categories || [];
  CATEGORY_LIST = categories.map(c => c.id);
  COLOR_MAP = Object.fromEntries(categories.map(c => [c.id, c.color]));

  rebuildLegendAndSelect();

  ;(cfg.markers || []).forEach(m => {
    const layer = L.marker(m.latlng, { icon: getIcon(m.cat) }).addTo(defaultLayer)
      .bindPopup(`<b>${escapeHtml(m.name)}</b><br>${escapeHtml(m.desc || '')}<br><i>${escapeHtml(m.cat)}</i>`);
  });
  ;(cfg.areas || []).forEach(a => {
    const color = COLOR_MAP[a.cat] || '#94a3b8';
    const layer = L.polygon(a.latlngs.map(([lat,lng]) => [lat,lng]), {
      color,
      fillOpacity: .25,
      weight: 2,
      renderer: canvasRenderer
    }).addTo(defaultLayer)
      .bindPopup(`<b>${escapeHtml(a.name)}</b> (${escapeHtml(a.cat)})`);
  });
}

function rebuildLegendAndSelect() {
  const ul = document.getElementById('legend');
  ul.innerHTML = '';
  CATEGORY_LIST.forEach(id => {
    const color = COLOR_MAP[id] || '#94a3b8';
    const li = document.createElement('li');
    li.dataset.cat = id;
    li.innerHTML = `<input type="checkbox" class="cat-toggle" checked> <span class="dot" style="background:${color}"></span>${id}<span class="right">›</span>`;
    const chk = li.querySelector('.cat-toggle');
    chk.dataset.cat = id;
    chk.addEventListener('change', e => toggleCategory(id, e.target.checked));
    li.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') openCategoryList(id);
    });
    ul.appendChild(li);
  });
  const mkSel = document.getElementById('mkCat');
  mkSel.innerHTML = '';
  const zoneSel = document.getElementById('zoneCat');
  zoneSel.innerHTML = '';
  CATEGORY_LIST.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    mkSel.appendChild(opt.cloneNode(true));
    zoneSel.appendChild(opt);
  });
  if (CATEGORY_LIST.includes('Custom')) {
    mkSel.value = 'Custom';
    zoneSel.value = 'Custom';
  } else {
    mkSel.selectedIndex = 0;
    zoneSel.selectedIndex = 0;
  }
}

function addCategoryFromForm() {
  const name = document.getElementById('newCatName').value.trim();
  const color = document.getElementById('newCatColor').value;
  if (!name) { toast('Name required'); return }
  if (CATEGORY_LIST.includes(name)) { toast('Category exists'); return }
  CATEGORY_LIST.push(name);
  COLOR_MAP[name] = color;
  CATEGORY_VISIBILITY[name] = true;
  document.getElementById('newCatName').value = '';
  document.getElementById('addCatForm').classList.add('hidden');
  rebuildLegendAndSelect();
  saveRuntimeCategories();
  toast('Category added');
}

function saveRuntimeCategories() {
  const obj = { categories: CATEGORY_LIST.map(id => ({ id, color: COLOR_MAP[id] })) };
  localStorage.setItem('rdr2map_categories', JSON.stringify(obj));
}

function loadRuntimeCategories() {
  const raw = localStorage.getItem('rdr2map_categories');
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    if (obj.categories) {
      CATEGORY_LIST = obj.categories.map(c => c.id);
      COLOR_MAP = Object.fromEntries(obj.categories.map(c => [c.id, c.color]));
    }
  } catch {}
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const app = document.getElementById('app');
  const btn = document.getElementById('collapseBtn');
  const isMobile = window.innerWidth < 768;
  if (isMobile) {
    sidebar.classList.toggle('open');
  } else {
    const collapsed = sidebar.classList.toggle('collapsed');
    app.classList.toggle('collapsed', collapsed);
    btn.textContent = collapsed ? '‹' : '›';
    requestAnimationFrame(() => requestAnimationFrame(() => map.invalidateSize()));
  }
}

function renderMarkerPopup(m) {
  const d = m.data;
  return `
    <b>${escapeHtml(d.name)}</b><br>
    ${escapeHtml(d.desc)}<br>
    <i>${escapeHtml(d.cat)}</i><br>
    <div style="margin-top:6px;display:flex;gap:6px">
      <button class="btn mini js-edit" data-id="${m._leaflet_id}">Edit</button>
      <button class="btn mini danger js-del" data-id="${m._leaflet_id}">Delete</button>
    </div>
  `;
}

function renderZonePopup(z) {
  const d = z.data;
  return `
    <b>${escapeHtml(d.name)}</b><br>
    ${escapeHtml(d.desc)}<br>
    <i>${escapeHtml(d.cat)}</i><br>
    <div style="margin-top:6px;display:flex;gap:6px">
      <button class="btn mini js-zone-edit" data-id="${z._leaflet_id}">Edit</button>
      <button class="btn mini danger js-zone-del" data-id="${z._leaflet_id}">Delete</button>
    </div>
  `;
}

function renderZoneTooltip(d) {
  return `
    <b>${escapeHtml(d.name)}</b><br>
    <small>${escapeHtml(d.desc)}</small>
  `;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

document.addEventListener('click', e => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.classList.contains('js-del')) {
    const id = +t.getAttribute('data-id');
    markerLayer.eachLayer(m => { if (m._leaflet_id === id) markerLayer.removeLayer(m) });
    saveUserData();
    toast('Marker deleted');
  }
  if (t.classList.contains('js-zone-del')) {
    const id = +t.getAttribute('data-id');
    areaLayer.eachLayer(a => { if (a._leaflet_id === id) areaLayer.removeLayer(a) });
    saveUserData();
    toast('Zone deleted');
  }
  if (t.classList.contains('js-edit')) {
    const id = +t.getAttribute('data-id');
    let target = null;
    markerLayer.eachLayer(m => { if (m._leaflet_id === id) target = m });
    if (!target) return;
    editMarker(target);
  }
  if (t.classList.contains('js-zone-edit')) {
    const id = +t.getAttribute('data-id');
    let target = null;
    areaLayer.eachLayer(a => { if (a._leaflet_id === id) target = a });
    if (!target) return;
    editZone(target);
  }
});

function resetPlacing() {
  placing = false;
  pendingForm = null;
  document.body.classList.remove('placing');
  map.getContainer().style.cursor = '';
}

function resetZoneDrawing() {
  isDrawingZone = false;
  currentZoneData = null;
  tempPoints = [];
  if (tempLayer) {
    map.removeLayer(tempLayer);
    tempLayer = null;
  }
  document.body.classList.remove('placing');
  map.dragging.enable(); // Re-enable panning
  map.getContainer().style.cursor = '';
}

function startZoneDrawing(data) {
  currentZoneData = data;
  isDrawingZone = true;
  tempPoints = [];
  tempLayer = L.layerGroup().addTo(map);
  document.body.classList.add('placing');
  map.dragging.disable(); // Disable panning during draw
  map.getContainer().style.cursor = 'crosshair';
  toast('Tap/click to add points, double-tap/dblclick to finish');
}

function addZonePoint(e) {
  if (!isDrawingZone) return;
  const latlng = e.latlng;
  tempPoints.push(latlng);

  // Add temporary marker
  L.circleMarker(latlng, { radius: 4, color: 'white', fillOpacity: 1 }).addTo(tempLayer);

  // Update temporary line (polyline preview)
  if (tempPoints.length > 1) {
    const polyline = L.polyline(tempPoints, { color: currentZoneData.color || '#94a3b8', weight: 2, dashArray: '5,5' }).addTo(tempLayer);
    tempLayer.clearLayers(); // Clear old preview, add new
    tempPoints.forEach(pt => L.circleMarker(pt, { radius: 4, color: 'white', fillOpacity: 1 }).addTo(tempLayer));
    tempLayer.addLayer(polyline);
  }
}

function finishZoneDrawing(e) {
  if (!isDrawingZone || tempPoints.length < 3) {
    toast('Need at least 3 points for a zone');
    return;
  }
  const color = currentZoneData.color || '#94a3b8';
  const polygon = L.polygon(tempPoints, {
    color,
    fillOpacity: 0.25,
    weight: 2,
    renderer: canvasRenderer
  }).addTo(areaLayer);
  polygon.data = {
    name: currentZoneData.name,
    desc: currentZoneData.desc,
    cat: currentZoneData.cat,
    type: 'polygon',
    latlngs: tempPoints.map(pt => [pt.lat, pt.lng])
  };
  polygon.bindPopup(renderZonePopup(polygon));
  polygon.bindTooltip(renderZoneTooltip(polygon.data), { permanent: false, sticky: true });
  polygon.on('mouseover', () => polygon.openTooltip());
  polygon.on('mouseout', () => polygon.closeTooltip());
  saveUserData();
  resetZoneDrawing();
  toast('Zone added');
}

function editMarker(target) {
  const d = target.data;
  const panel = document.getElementById('markerPanel');
  const title = document.getElementById('panelTitle');
  title.textContent = 'Edit marker';
  panel.classList.remove('hidden');
  const form = document.getElementById('markerForm');
  const nameEl = document.getElementById('mkName');
  const descEl = document.getElementById('mkDesc');
  const catEl = document.getElementById('mkCat');
  const hint = form.querySelector('.hint');
  hint.textContent = '';
  const submitBtn = form.querySelector('.btn.primary');
  submitBtn.textContent = 'Save';
  nameEl.value = d.name || '';
  descEl.value = d.desc || '';
  catEl.value = d.cat || CATEGORY_LIST[0];
  const onSubmit = ev => {
    ev.preventDefault();
    d.name = nameEl.value || 'Unnamed';
    d.desc = descEl.value || '';
    d.cat = catEl.value;
    target.setIcon(getIcon(d.cat));
    target.setPopupContent(renderMarkerPopup(target));
    saveUserData();
    closeMarkerPanel();
    toast('Marker updated');
  };
  const onCancel = () => {
    closeMarkerPanel();
    title.textContent = 'New marker';
    hint.textContent = 'Click on the map to place the marker';
    submitBtn.textContent = 'Ready to place';
  };
  form.addEventListener('submit', onSubmit, { once: true });
  document.getElementById('cancelPlace').addEventListener('click', onCancel, { once: true });
  document.getElementById('closePanelBtn').addEventListener('click', onCancel, { once: true });
}

function editZone(target) {
  const d = target.data;
  const panel = document.getElementById('zonePanel');
  const title = document.getElementById('zonePanelTitle');
  title.textContent = 'Edit zone';
  panel.classList.remove('hidden');
  const form = document.getElementById('zoneForm');
  const nameEl = document.getElementById('zoneName');
  const descEl = document.getElementById('zoneDesc');
  const catEl = document.getElementById('zoneCat');
  const hint = form.querySelector('.hint');
  hint.textContent = '';
  const submitBtn = form.querySelector('.btn.primary');
  submitBtn.textContent = 'Save';
  nameEl.value = d.name || '';
  descEl.value = d.desc || '';
  catEl.value = d.cat || CATEGORY_LIST[0];
  const onSubmit = ev => {
    ev.preventDefault();
    d.name = nameEl.value || 'Unnamed';
    d.desc = descEl.value || '';
    d.cat = catEl.value;
    const color = COLOR_MAP[d.cat] || '#94a3b8';
    target.setStyle({ color });
    target.setPopupContent(renderZonePopup(target));
    target.setTooltipContent(renderZoneTooltip(d));
    saveUserData();
    closeZonePanel();
    toast('Zone updated');
  };
  const onCancel = () => {
    closeZonePanel();
    title.textContent = 'New zone';
    hint.textContent = 'Draw the area on the map after submitting';
    submitBtn.textContent = 'Ready to draw';
  };
  form.addEventListener('submit', onSubmit, { once: true });
  document.getElementById('cancelZone').addEventListener('click', onCancel, { once: true });
  document.getElementById('closeZonePanelBtn').addEventListener('click', onCancel, { once: true });
}

function openMarkerPanel() {
  const panel = document.getElementById('markerPanel');
  panel.classList.remove('hidden');
  document.body.classList.add('placing');
  map.getContainer().style.cursor = 'crosshair';
  const form = document.getElementById('markerForm');
  const nameEl = document.getElementById('mkName');
  const descEl = document.getElementById('mkDesc');
  const catEl = document.getElementById('mkCat');
  nameEl.value = '';
  descEl.value = '';
  catEl.value = CATEGORY_LIST.includes('Custom') ? 'Custom' : CATEGORY_LIST[0];
  nameEl.focus();
  const onSubmit = ev => {
    ev.preventDefault();
    pendingForm = { name: nameEl.value || 'Unnamed', desc: descEl.value || '', cat: catEl.value };
    placing = true;
    closeMarkerPanel();
    toast('Click on the map to place');
  };
  const onCancel = () => {
    closeMarkerPanel();
    resetPlacing();
  };
  form.addEventListener('submit', onSubmit, { once: true });
  document.getElementById('cancelPlace').addEventListener('click', onCancel, { once: true });
  document.getElementById('closePanelBtn').addEventListener('click', onCancel, { once: true });
}

function closeMarkerPanel() {
  document.getElementById('markerPanel').classList.add('hidden');
}

function openZonePanel() {
  const panel = document.getElementById('zonePanel');
  panel.classList.remove('hidden');
  const form = document.getElementById('zoneForm');
  const nameEl = document.getElementById('zoneName');
  const descEl = document.getElementById('zoneDesc');
  const catEl = document.getElementById('zoneCat');
  nameEl.value = '';
  descEl.value = '';
  catEl.value = CATEGORY_LIST.includes('Custom') ? 'Custom' : CATEGORY_LIST[0];
  nameEl.focus();
  const onSubmit = ev => {
    ev.preventDefault();
    const name = nameEl.value || 'Unnamed';
    const desc = descEl.value || '';
    const cat = catEl.value;
    const color = COLOR_MAP[cat] || '#94a3b8';
    startZoneDrawing({ name, desc, cat, color });
    closeZonePanel();
  };
  const onCancel = () => closeZonePanel();
  form.addEventListener('submit', onSubmit, { once: true });
  document.getElementById('cancelZone').addEventListener('click', onCancel, { once: true });
  document.getElementById('closeZonePanelBtn').addEventListener('click', onCancel, { once: true });
}

function closeZonePanel() {
  document.getElementById('zonePanel').classList.add('hidden');
  if (isDrawingZone) resetZoneDrawing();
}

function saveUserData() {
  const data = { markers: [], areas: [], categories: CATEGORY_LIST.map(id => ({ id, color: COLOR_MAP[id] })) };
  markerLayer.eachLayer(m => data.markers.push(m.data));
  areaLayer.eachLayer(a => data.areas.push(a.data));
  localStorage.setItem('rdr2map_user', JSON.stringify(data));
}

function loadUserData() {
  loadRuntimeCategories();
  const visRaw = localStorage.getItem('rdr2map_visibility');
  if (visRaw) {
    try {
      CATEGORY_VISIBILITY = JSON.parse(visRaw);
    } catch {}
  }
  rebuildLegendAndSelect();
  const saved = localStorage.getItem('rdr2map_user');
  if (!saved) return;
  const data = JSON.parse(saved);
  if (data.categories) {
    CATEGORY_LIST = data.categories.map(c => c.id);
    COLOR_MAP = Object.fromEntries(data.categories.map(c => [c.id, c.color]));
    rebuildLegendAndSelect();
  }
  ;(data.markers || []).forEach(m => {
    const marker = L.marker([m.latlng[0], m.latlng[1]], { icon: getIcon(m.cat), draggable: true }).addTo(markerLayer);
    marker.data = m;
    marker.bindPopup(renderMarkerPopup(marker));
    marker.on('dragend', ev => {
      const ll = ev.target.getLatLng();
      marker.data.latlng = [ll.lat, ll.lng];
      saveUserData();
    });
  });
  ;(data.areas || []).forEach(a => {
    const color = COLOR_MAP[a.cat] || '#94a3b8';
    const poly = L.polygon(a.latlngs.map(([lat,lng]) => [lat,lng]), { color, fillOpacity: .25, weight: 2, renderer: canvasRenderer }).addTo(areaLayer);
    poly.data = a;
    poly.bindPopup(renderZonePopup(poly));
    poly.bindTooltip(renderZoneTooltip(a), { permanent: false, sticky: true });
    poly.on('mouseover', () => poly.openTooltip());
    poly.on('mouseout', () => poly.closeTooltip());
  });
  // Apply visibility after adding layers
  Object.entries(CATEGORY_VISIBILITY).forEach(([cat, visible]) => {
    if (!visible) toggleCategory(cat, false);
  });
}

function exportData() {
  const user = JSON.parse(localStorage.getItem('rdr2map_user') || '{"markers":[],"areas":[]}');
  const out = {
    categories: user.categories || CATEGORY_LIST.map(id => ({ id, color: COLOR_MAP[id] })),
    user: { markers: user.markers || [], areas: user.areas || [] }
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rdr2-user-data.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importData(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.user) {
        localStorage.setItem('rdr2map_user', JSON.stringify({
          markers: data.user.markers || [],
          areas: data.user.areas || [],
          categories: data.categories || []
        }));
      } else {
        localStorage.setItem('rdr2map_user', JSON.stringify(data));
      }
      location.reload();
    } catch {
      toast('Invalid JSON');
    }
  };
  reader.readAsText(file);
}

function clearUserData() {
  if (!confirm('Clear your markers and areas')) return;
  localStorage.removeItem('rdr2map_user');
  localStorage.removeItem('rdr2map_visibility');
  markerLayer.clearLayers();
  areaLayer.clearLayers();
  Object.keys(CATEGORY_VISIBILITY).forEach(cat => delete CATEGORY_VISIBILITY[cat]);
  toast('Cleared');
}

function openCategoryList(id) {
  const panel = document.getElementById('listPanel');
  document.getElementById('listTitle').textContent = id;
  document.getElementById('listSearch').value = '';
  panel.classList.remove('hidden');
  filterList('');
}

function filterList(q) {
  const body = document.getElementById('listBody');
  body.innerHTML = '';
  const cat = document.getElementById('listTitle').textContent;
  let hasItems = false;
  [...markerLayer.getLayers(), ...areaLayer.getLayers()].forEach(layer => {
    if (layer.data && layer.data.cat === cat && (!q || layer.data.name.toLowerCase().includes(q))) {
      hasItems = true;
      const div = document.createElement('div');
      div.className = 'entry';
      div.innerHTML = `
        <div>${escapeHtml(layer.data.name)}</div>
        <div class="entry-sub">${escapeHtml(layer.data.desc.substring(0,30))}${layer.data.desc.length > 30 ? '...' : ''}</div>
      `;
      body.appendChild(div);
    }
  });
  if (!hasItems) {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = '<i>No items yet</i>';
    body.appendChild(div);
  }
}

initMap();
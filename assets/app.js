/* Kurikulum Teknik Elektro UNTAN — logika halaman (vanilla JS).
 *
 * Alur: muat data/matkul.json -> normalisasi & validasi ringan -> render tab Daftar
 * -> graph (Cytoscape.js) dimuat malas saat tab Graph pertama kali dibuka.
 * Semua mata kuliah berasal dari JSON; tidak ada data yang di-hardcode di sini.
 *
 * Hash URL:  #daftar  #graph  #daftar/TKE-116  #graph/TKE-116
 */
(function () {
  'use strict';

  var DATA_URL = 'data/matkul.json'; // path relatif: aman untuk http.server maupun /kurikulum-elektro-untan/
  var CYTOSCAPE = {
    src: 'https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js',
    integrity: 'sha384-IWROdLKRsN1UuJywMlWl7/blXQ8GEooN2n7dzTxfEPd7ybYIKCUJ2Ol/1Gpf3YV4'
  };
  var REDUCED_MOTION = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.documentElement.classList.remove('no-js');

  /* ------------------------------------------------------------------ util */
  function $(sel, root) { return (root || document).querySelector(sel); }

  /** Pembuat elemen kecil; semua teks lewat textContent (aman dari injeksi HTML). */
  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'data') Object.keys(v).forEach(function (d) { e.dataset[d] = v[d]; });
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(e, arguments[i]);
    return e;
  }
  function append(e, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(e, x); }); return; }
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }

  function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function fmt(n) { return Number.isInteger(n) ? String(n) : String(n).replace('.', ','); }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'); }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      var ta = h('textarea', { readonly: true, style: 'position:fixed;opacity:0;top:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  /* ----------------------------------------------------------------- state */
  var state = {
    ready: false,
    data: [],
    byKode: new Map(),
    dependents: new Map(), // kode -> [kode yang membutuhkannya]
    semesters: [],
    tab: 'daftar',
    sem: 'all', q: '', jenis: 'all', konsentrasi: 'all',
    selected: null,
    hasEdges: false, hasEst: false, hasResmi: false,
    g: { cy: null, loading: false, from: 1, to: 8, hideP: false, showEst: true, q: '', hover: null,
         vis: null, matches: [], matchIdx: -1 }
  };

  /* ------------------------------------------------------------ data layer */
  function loadData() {
    return fetch(DATA_URL, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('Gagal memuat ' + DATA_URL + ' (HTTP ' + res.status + ').');
      return res.json().catch(function () { throw new Error(DATA_URL + ' bukan JSON yang valid.'); });
    }, function () {
      throw new Error('Tidak dapat mengambil ' + DATA_URL + '. Periksa koneksi, atau jika membuka berkas langsung (file://) jalankan lewat server lokal: python -m http.server');
    });
  }

  /** Validasi ringan + indeks. Entri/prasyarat bermasalah dilewati dan dicatat di console. */
  function normalize(raw) {
    if (!Array.isArray(raw)) throw new Error('Format data salah: ' + DATA_URL + ' harus berupa array.');
    var out = [], seen = new Set();
    raw.forEach(function (r, i) {
      var ok = r && typeof r.kode === 'string' && r.kode && typeof r.nama === 'string' &&
        typeof r.sks === 'number' && Number.isInteger(r.semester) && r.semester >= 1 && r.semester <= 8 &&
        (r.jenis === 'W' || r.jenis === 'P');
      if (!ok) { console.warn('[data] entri #' + i + ' dilewati (skema tidak valid):', r); return; }
      if (seen.has(r.kode)) { console.warn('[data] kode duplikat dilewati:', r.kode); return; }
      seen.add(r.kode);
      out.push({
        kode: r.kode, nama: r.nama, sks: r.sks, semester: r.semester, jenis: r.jenis,
        konsentrasi: typeof r.konsentrasi === 'string' ? r.konsentrasi : '',
        prasyarat: Array.isArray(r.prasyarat) ? r.prasyarat.slice() : [],
        status: r.prasyarat_status === 'resmi' ? 'resmi' : 'perkiraan'
      });
    });
    if (!out.length) throw new Error('Tidak ada mata kuliah valid di ' + DATA_URL + '.');

    state.data = out;
    state.byKode = new Map(out.map(function (m) { return [m.kode, m]; }));
    state.dependents = new Map(out.map(function (m) { return [m.kode, []]; }));
    out.forEach(function (m) {
      var valid = [];
      m.prasyarat.forEach(function (p) {
        if (p === m.kode) { console.warn('[data] ' + m.kode + ' merujuk dirinya sendiri; diabaikan.'); return; }
        if (!state.byKode.has(p)) { console.warn('[data] prasyarat "' + p + '" pada ' + m.kode + ' tidak ada; diabaikan.'); return; }
        if (valid.indexOf(p) !== -1) return;
        valid.push(p);
        state.dependents.get(p).push(m.kode);
      });
      m.prasyarat = valid;
      if (valid.length) {
        state.hasEdges = true;
        if (m.status === 'resmi') state.hasResmi = true; else state.hasEst = true;
      }
    });
    state.semesters = Array.from(new Set(out.map(function (m) { return m.semester; }))).sort(function (a, b) { return a - b; });
    state.g.from = state.semesters[0];
    state.g.to = state.semesters[state.semesters.length - 1];
  }

  /* ---------------------------------------------------------- small widgets */
  function badge(jenis) {
    var w = jenis === 'W';
    return h('span', { class: 'badge ' + (w ? 'badge-w' : 'badge-p') },
      h('span', { 'aria-hidden': 'true', text: w ? '■' : '◇' }), w ? 'Wajib' : 'Pilihan');
  }
  function statusTag(status) {
    return h('span', {
      class: 'tag tag-' + status,
      title: status === 'resmi' ? 'Prasyarat dari dokumen resmi' : 'Prasyarat perkiraan, belum dari dokumen resmi',
      text: status
    });
  }
  function courseBtn(kode, cls) {
    var m = state.byKode.get(kode);
    return h('button', { type: 'button', class: cls || 'pre-btn', data: { goto: kode },
      title: m.nama, 'aria-label': 'Buka detail ' + kode + ' ' + m.nama }, kode + ' ' + m.nama);
  }

  /* ------------------------------------------------------------ tab: daftar */
  function matches(m) {
    if (state.sem !== 'all' && m.semester !== state.sem) return false;
    if (state.jenis !== 'all' && m.jenis !== state.jenis) return false;
    if (state.konsentrasi !== 'all' && m.konsentrasi !== state.konsentrasi) return false;
    if (state.q) {
      var q = state.q.toLowerCase(), nq = norm(state.q);
      if (m.nama.toLowerCase().indexOf(q) === -1 && !(nq && norm(m.kode).indexOf(nq) !== -1)) return false;
    }
    return true;
  }

  function semTotals(sem) {
    var w = 0, p = 0;
    state.data.forEach(function (m) { if (m.semester === sem) { if (m.jenis === 'W') w += m.sks; else p += m.sks; } });
    return { w: w, p: p };
  }

  function renderList() {
    var root = $('#daftar-root');
    var list = state.data.filter(matches);
    var frag = document.createDocumentFragment();

    state.semesters.forEach(function (sem) {
      var rows = list.filter(function (m) { return m.semester === sem; });
      if (!rows.length) return;
      var t = semTotals(sem);
      var table = h('table', { class: 'mk', role: 'table' },
        h('caption', { class: 'visually-hidden', text: 'Mata kuliah semester ' + sem }),
        h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' },
          h('th', { scope: 'col', role: 'columnheader', text: 'Kode' }),
          h('th', { scope: 'col', role: 'columnheader', text: 'Mata kuliah' }),
          h('th', { scope: 'col', role: 'columnheader', class: 'num', text: 'SKS' }),
          h('th', { scope: 'col', role: 'columnheader', text: 'Jenis' }),
          h('th', { scope: 'col', role: 'columnheader', text: 'Prasyarat' }))),
        h('tbody', { role: 'rowgroup' }, rows.map(rowFor)));
      frag.append(h('section', { class: 'sem-group', 'aria-labelledby': 'sem-h-' + sem },
        h('div', { class: 'sem-head' },
          h('h3', { id: 'sem-h-' + sem, text: 'Semester ' + sem }),
          h('span', { class: 'sem-sks', text: 'Total SKS wajib: ' + fmt(t.w) + ' · Total SKS pilihan: ' + fmt(t.p) })),
        table));
    });

    if (!list.length) {
      frag.append(h('div', { class: 'empty' },
        h('p', { text: 'Tidak ada mata kuliah yang cocok dengan filter.' }),
        h('button', { type: 'button', class: 'btn', text: 'Hapus semua filter', onclick: resetListFilters })));
    }

    root.replaceChildren(frag);
    $('#list-controls').hidden = false;
    $('#result-count').textContent = 'Menampilkan ' + list.length + ' dari ' + state.data.length + ' mata kuliah';
    markSelectedRow();
  }

  function rowFor(m) {
    var pre;
    if (m.prasyarat.length) {
      pre = h('ul', { class: 'pre-list', 'aria-label': 'Prasyarat ' + m.nama },
        m.prasyarat.map(function (p) { return h('li', null, courseBtn(p)); }),
        h('li', null, statusTag(m.status)));
    } else {
      pre = h('span', { class: 'dash', text: '—', 'aria-label': 'Tidak ada prasyarat' });
    }
    return h('tr', { role: 'row', data: { kode: m.kode } },
      h('td', { role: 'cell', class: 'kode', data: { label: 'Kode' }, text: m.kode }),
      h('td', { role: 'cell', class: 'nama', data: { label: 'Mata kuliah' } },
        h('button', { type: 'button', class: 'name-btn', data: { kode: m.kode },
          'aria-label': 'Buka detail ' + m.nama, text: m.nama })),
      h('td', { role: 'cell', class: 'num', data: { label: 'SKS' }, text: fmt(m.sks) }),
      h('td', { role: 'cell', data: { label: 'Jenis' } }, badge(m.jenis)),
      h('td', { role: 'cell', data: { label: 'Prasyarat' } }, pre));
  }

  function markSelectedRow() {
    document.querySelectorAll('tr.is-selected').forEach(function (r) { r.classList.remove('is-selected'); });
    if (state.selected) {
      var r = $('tr[data-kode="' + cssEsc(state.selected) + '"]');
      if (r) r.classList.add('is-selected');
    }
  }

  function resetListFilters() {
    state.sem = 'all'; state.q = ''; state.jenis = 'all'; state.konsentrasi = 'all';
    $('#q').value = ''; $('#f-jenis').value = 'all'; $('#f-konsentrasi').value = 'all';
    syncChips();
    renderList();
  }

  function buildListControls() {
    var chips = $('#sem-chips');
    var opts = ['all'].concat(state.semesters);
    opts.forEach(function (s) {
      chips.append(h('button', { type: 'button', class: 'chip', data: { sem: s },
        'aria-pressed': 'false', 'aria-label': s === 'all' ? 'Semua semester' : 'Semester ' + s,
        text: s === 'all' ? 'Semua' : String(s) }));
    });
    chips.addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      state.sem = b.dataset.sem === 'all' ? 'all' : Number(b.dataset.sem);
      syncChips(); renderList();
    });
    syncChips();

    var timer;
    $('#q').addEventListener('input', function (e) {
      clearTimeout(timer);
      timer = setTimeout(function () { state.q = e.target.value.trim(); renderList(); }, 100);
    });
    $('#f-jenis').addEventListener('change', function (e) { state.jenis = e.target.value; renderList(); });

    var ks = Array.from(new Set(state.data.map(function (m) { return m.konsentrasi; }).filter(Boolean))).sort();
    if (ks.length) {
      ks.forEach(function (k) { $('#f-konsentrasi').append(h('option', { value: k, text: k })); });
      $('#f-konsentrasi-wrap').hidden = false;
      $('#f-konsentrasi').addEventListener('change', function (e) { state.konsentrasi = e.target.value; renderList(); });
    }

    $('#btn-copy').addEventListener('click', function () { copyLink(location.href); });
    $('#btn-print').addEventListener('click', function () { window.print(); });

    // Delegasi klik untuk seluruh daftar: tombol prasyarat, nama, dan baris.
    $('#daftar-root').addEventListener('click', function (e) {
      var g = e.target.closest('[data-goto]');
      if (g) { selectCourse(g.dataset.goto, { focus: true }); return; }
      var row = e.target.closest('tr[data-kode]');
      if (row) selectCourse(row.dataset.kode, { focus: true, fromList: row.dataset.kode });
    });
  }
  function syncChips() {
    document.querySelectorAll('#sem-chips .chip').forEach(function (c) {
      var v = c.dataset.sem === 'all' ? 'all' : Number(c.dataset.sem);
      c.setAttribute('aria-pressed', String(v === state.sem));
    });
  }

  function copyLink(url) {
    Promise.resolve(copyText(url)).then(function (ok) {
      toast(ok ? 'Tautan disalin' : 'Gagal menyalin. Salin dari bilah alamat.');
    });
  }

  /* ------------------------------------------------------------ panel detail */
  var lastFocusKode = null;

  function renderDetail(kode) {
    var m = state.byKode.get(kode);
    $('#detail-title').textContent = m.nama;
    var body = $('#detail-body');

    var dl = h('dl', null,
      h('dt', { text: 'Kode' }), h('dd', { text: m.kode }),
      h('dt', { text: 'SKS' }), h('dd', { text: fmt(m.sks) }),
      h('dt', { text: 'Semester' }), h('dd', { text: String(m.semester) }),
      h('dt', { text: 'Jenis' }), h('dd', null, badge(m.jenis)),
      m.konsentrasi ? [h('dt', { text: 'Konsentrasi' }), h('dd', { text: m.konsentrasi })] : null);

    var pre = m.prasyarat.length
      ? h('ul', { class: 'pre-list' }, m.prasyarat.map(function (p) { return h('li', null, courseBtn(p)); }))
      : h('p', { class: 'none', text: 'Tidak ada prasyarat.' });

    var deps = state.dependents.get(kode);
    var depEl = deps.length
      ? h('ul', { class: 'pre-list' }, deps.map(function (d) {
          return h('li', null, courseBtn(d), statusTag(state.byKode.get(d).status));
        }))
      : h('p', { class: 'none', text: 'Belum menjadi prasyarat mata kuliah lain.' });

    body.replaceChildren(dl,
      h('h3', null, 'Prasyarat ', m.prasyarat.length ? statusTag(m.status) : null), pre,
      h('h3', { text: 'Menjadi prasyarat bagi' }), depEl);
  }

  function openDetail(focus) {
    var d = $('#detail');
    d.hidden = false;
    document.body.classList.add('detail-open');
    if (focus) $('#detail-title').focus({ preventScroll: true });
  }

  function closeDetail() {
    if (state.selected == null && $('#detail').hidden) return;
    state.selected = null;
    $('#detail').hidden = true;
    document.body.classList.remove('detail-open');
    markSelectedRow();
    refreshHighlight();
    writeHash(true);
    // Kembalikan fokus ke pemicu terakhir
    var target = null;
    if (state.tab === 'daftar' && lastFocusKode) target = $('.name-btn[data-kode="' + cssEsc(lastFocusKode) + '"]');
    if (!target) target = state.tab === 'graph' ? $('#g-search') : $('#tab-daftar');
    if (target) target.focus({ preventScroll: true });
  }

  function selectCourse(kode, opts) {
    opts = opts || {};
    if (!state.byKode.has(kode)) return;
    if (opts.fromList) lastFocusKode = opts.fromList;
    state.selected = kode;
    renderDetail(kode);
    openDetail(opts.focus);
    markSelectedRow();
    if (state.g.cy) { focusGraphNode(kode, !opts.noCenter); }
    if (!opts.noHash) writeHash(true);
  }

  /* -------------------------------------------------------------- hash/tabs */
  function parseHash() {
    var raw = location.hash.slice(1);
    try { raw = decodeURIComponent(raw); } catch (e) { /* biarkan apa adanya */ }
    var i = raw.indexOf('/');
    var tab = i === -1 ? raw : raw.slice(0, i);
    var kode = i === -1 ? null : raw.slice(i + 1);
    return { tab: tab === 'graph' ? 'graph' : 'daftar', kode: kode || null };
  }
  function hashFor(tab, kode) { return '#' + tab + (kode ? '/' + encodeURIComponent(kode) : ''); }
  function writeHash(replace) {
    var h2 = hashFor(state.tab, state.selected);
    if (location.hash === h2) return;
    if (replace) history.replaceState(null, '', h2); else location.hash = h2;
  }

  function showTab(tab) {
    state.tab = tab;
    ['daftar', 'graph'].forEach(function (t) {
      var on = t === tab;
      var btn = $('#tab-' + t);
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      $('#panel-' + t).hidden = !on;
    });
    if (tab === 'graph' && state.ready) initGraph();
  }

  function applyHash() {
    var p = parseHash();
    showTab(p.tab);
    if (!state.ready) return;
    if (p.kode && state.byKode.has(p.kode)) selectCourse(p.kode, { noHash: true });
    else if (!p.kode && state.selected) closeDetailSilently();
  }
  function closeDetailSilently() {
    state.selected = null;
    $('#detail').hidden = true;
    document.body.classList.remove('detail-open');
    markSelectedRow();
    refreshHighlight();
  }

  function bindTabs() {
    var tabs = [$('#tab-daftar'), $('#tab-graph')];
    tabs.forEach(function (b, i) {
      b.addEventListener('click', function () {
        var t = i === 0 ? 'daftar' : 'graph';
        location.hash = hashFor(t, state.selected); // hashchange -> applyHash
      });
      b.addEventListener('keydown', function (e) {
        var n = null;
        if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = tabs.length - 1;
        if (n == null) return;
        e.preventDefault();
        tabs[n].focus();
        tabs[n].click();
      });
    });
    window.addEventListener('hashchange', applyHash);
  }

  /* ------------------------------------------------------------ tab: graph */
  var COL_W = 230, ROW_H = 84;

  function loadScript(cfg) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = cfg.src; s.integrity = cfg.integrity; s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Gagal memuat ' + cfg.src)); };
      document.head.appendChild(s);
    });
  }

  function showGraphMsg(text, isError) {
    var m = $('#graph-msg');
    m.textContent = text;
    m.hidden = !text;
    m.className = 'notice' + (isError ? ' status error' : '');
    if (isError) m.setAttribute('role', 'alert');
  }

  function initGraph() {
    var g = state.g;
    if (g.cy || g.loading) { if (g.cy) { g.cy.resize(); } return; }
    g.loading = true;

    buildGraphControls();
    if (!state.hasEdges) showGraphMsg('Data prasyarat belum diisi. Node ditampilkan per semester tanpa garis.');

    var ready = window.cytoscape ? Promise.resolve() : loadScript(CYTOSCAPE);
    ready.then(function () {
      g.loading = false;
      createCy();
    }, function (err) {
      g.loading = false;
      console.error(err);
      showGraphMsg('Pustaka graph tidak dapat dimuat (periksa koneksi internet). Prasyarat tetap tersedia dalam bentuk teks di tab Daftar Mata Kuliah dan pada panel detail.', true);
    });
  }

  function cyStyle() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (n) { return cs.getPropertyValue(n).trim(); };
    var font = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    return [
      { selector: 'node.course', style: {
        shape: 'round-rectangle', width: 170, height: 68, label: 'data(label)',
        'text-wrap': 'wrap', 'text-max-width': 158, 'font-size': 10, 'font-family': font, 'line-height': 1.25,
        'text-valign': 'center', 'text-halign': 'center',
        color: v('--w-fg'), 'background-color': v('--w-bg'), 'border-width': 2, 'border-color': v('--w-border'), 'border-style': 'solid' } },
      { selector: 'node.course[jenis="P"]', style: {
        shape: 'cut-rectangle', color: v('--p-fg'), 'background-color': v('--p-bg'),
        'border-color': v('--p-border'), 'border-style': 'dashed' } },
      { selector: 'node.semlabel', style: {
        shape: 'rectangle', width: 170, height: 26, label: 'data(label)', 'background-opacity': 0, 'border-width': 0,
        color: v('--text'), 'font-size': 14, 'font-weight': 700, 'font-family': font,
        'text-valign': 'center', 'text-halign': 'center', events: 'no' } },
      { selector: 'edge', style: {
        width: 1.5, 'line-color': v('--edge'), 'target-arrow-color': v('--edge'), 'target-arrow-shape': 'triangle',
        'arrow-scale': 1, 'curve-style': 'bezier', opacity: 0.75, 'line-style': 'solid' } },
      { selector: 'edge[status="perkiraan"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [6, 4] } },
      { selector: '.hide', style: { display: 'none' } },
      { selector: '.dim', style: { opacity: 0.12 } },
      { selector: 'edge.hl', style: { 'line-color': v('--edge-hl'), 'target-arrow-color': v('--edge-hl'), width: 2.5, opacity: 1, 'z-index': 10 } },
      { selector: 'node.hl', style: { 'border-width': 3, 'border-color': v('--edge-hl') } },
      { selector: 'node.focus', style: { 'border-width': 4, 'border-color': v('--focus') } },
      { selector: 'node.match', style: { 'border-width': 4, 'border-color': v('--focus'),
        'underlay-color': v('--focus'), 'underlay-opacity': 0.35, 'underlay-padding': 6 } }
    ];
  }

  function createCy() {
    var g = state.g;
    var elements = [];
    state.data.forEach(function (m) {
      elements.push({ group: 'nodes', classes: 'course', data: {
        id: m.kode, jenis: m.jenis, sem: m.semester,
        label: m.kode + '\n' + m.nama + '\n' + fmt(m.sks) + ' SKS · ' + (m.jenis === 'W' ? '■ Wajib' : '◇ Pilihan') } });
    });
    state.semesters.forEach(function (s) {
      elements.push({ group: 'nodes', classes: 'semlabel', data: { id: '__sem' + s, sem: s, label: 'Semester ' + s } });
    });
    state.data.forEach(function (m) {
      m.prasyarat.forEach(function (p) {
        elements.push({ group: 'edges', data: { id: p + '>' + m.kode, source: p, target: m.kode, status: m.status } });
      });
    });

    g.cy = window.cytoscape({
      container: $('#cy'),
      elements: elements,
      style: cyStyle(),
      layout: { name: 'null' },
      minZoom: 0.08, maxZoom: 2.5, wheelSensitivity: 0.3,
      autoungrabify: true, autounselectify: true, boxSelectionEnabled: false
    });
    var cy = g.cy;

    cy.on('mouseover', 'node.course', function (e) { g.hover = e.target.id(); refreshHighlight(); });
    cy.on('mouseout', 'node.course', function () { g.hover = null; refreshHighlight(); });
    cy.on('tap', 'node.course', function (e) { selectCourse(e.target.id(), { noCenter: true }); });
    cy.on('tap', function (e) { if (e.target === cy && state.selected) closeDetail(); });

    if (window.matchMedia) {
      var mq = matchMedia('(prefers-color-scheme: dark)');
      var restyle = function () { cy.style(cyStyle()); };
      if (mq.addEventListener) mq.addEventListener('change', restyle); else if (mq.addListener) mq.addListener(restyle);
    }

    applyGraphFilters(true);
    $('#g-hint').hidden = false;
    if (state.selected) focusGraphNode(state.selected, true);
  }

  /* Hitung himpunan simpul/garis yang terlihat menurut filter graph saat ini. */
  function computeVisible() {
    var g = state.g, nodes = new Set(), edges = [], preds = new Map(), succs = new Map();
    state.data.forEach(function (m) {
      if (m.semester < g.from || m.semester > g.to) return;
      if (g.hideP && m.jenis === 'P') return;
      nodes.add(m.kode); preds.set(m.kode, []); succs.set(m.kode, []);
    });
    state.data.forEach(function (m) {
      if (!nodes.has(m.kode)) return;
      m.prasyarat.forEach(function (p) {
        if (!nodes.has(p)) return;
        if (!g.showEst && m.status === 'perkiraan') return;
        edges.push({ id: p + '>' + m.kode, s: p, t: m.kode });
        preds.get(m.kode).push(p); succs.get(p).push(m.kode);
      });
    });
    g.vis = { nodes: nodes, edges: edges, edgeIds: new Set(edges.map(function (e) { return e.id; })), preds: preds, succs: succs };
  }

  /* Tata letak: satu kolom per semester (kiri ke kanan), urutan dalam kolom
   * diperhalus dengan heuristik barycenter agar garis tidak terlalu bersilangan. */
  function computeLayout() {
    var vis = state.g.vis;
    var bySem = new Map();
    state.data.forEach(function (m) {
      if (!vis.nodes.has(m.kode)) return;
      if (!bySem.has(m.semester)) bySem.set(m.semester, []);
      bySem.get(m.semester).push(m.kode);
    });
    var sems = Array.from(bySem.keys()).sort(function (a, b) { return a - b; });
    var idx = new Map(), y = new Map();
    state.data.forEach(function (m, i) { idx.set(m.kode, i); });
    function place(arr) {
      arr.forEach(function (k, i) { y.set(k, (i - (arr.length - 1) / 2) * ROW_H); });
    }
    sems.forEach(function (s) { place(bySem.get(s)); });
    for (var it = 0; it < 6; it++) {
      (it % 2 ? sems.slice().reverse() : sems).forEach(function (s) {
        var arr = bySem.get(s), bc = new Map();
        arr.forEach(function (k) {
          var ns = vis.preds.get(k).concat(vis.succs.get(k));
          bc.set(k, ns.length ? ns.reduce(function (a, n) { return a + y.get(n); }, 0) / ns.length : y.get(k));
        });
        arr.sort(function (a, b) { return (bc.get(a) - bc.get(b)) || (idx.get(a) - idx.get(b)); });
        place(arr);
      });
    }
    var pos = new Map(), minY = 0;
    sems.forEach(function (s, ci) {
      bySem.get(s).forEach(function (k) { pos.set(k, { x: ci * COL_W, y: y.get(k) }); minY = Math.min(minY, y.get(k)); });
    });
    var labels = new Map();
    sems.forEach(function (s, ci) { labels.set(s, { x: ci * COL_W, y: minY - ROW_H * 0.95 }); });
    return { pos: pos, labels: labels };
  }

  function applyGraphFilters(fit) {
    var g = state.g, cy = g.cy;
    if (!cy) return;
    computeVisible();
    var lay = computeLayout();
    cy.batch(function () {
      cy.nodes('.course').forEach(function (n) {
        var vis = g.vis.nodes.has(n.id());
        n.toggleClass('hide', !vis);
        if (vis) n.position(lay.pos.get(n.id()));
      });
      cy.nodes('.semlabel').forEach(function (n) {
        var p = lay.labels.get(n.data('sem'));
        n.toggleClass('hide', !p);
        if (p) n.position(p);
      });
      cy.edges().forEach(function (e) { e.toggleClass('hide', !g.vis.edgeIds.has(e.id())); });
    });
    $('#g-count').textContent = g.vis.nodes.size + ' mata kuliah, ' + g.vis.edges.length + ' garis prasyarat';
    updateGraphSearch(false);
    refreshHighlight();
    if (fit) fitGraph();
  }

  function fitGraph() {
    var cy = state.g.cy;
    if (!cy) return;
    var els = cy.elements().not('.hide');
    cy.resize();
    if (els.length) cy.fit(els, 30);
  }

  /* Penelusuran ke belakang (prasyarat) dan ke depan (turunan) pada graph terlihat. */
  function walk(start, map) {
    var seen = new Set(), stack = [start];
    while (stack.length) {
      (map.get(stack.pop()) || []).forEach(function (n) {
        if (!seen.has(n)) { seen.add(n); stack.push(n); }
      });
    }
    return seen;
  }

  function refreshHighlight() {
    var g = state.g, cy = g.cy;
    if (!cy || !g.vis) return;
    var k = g.hover || state.selected;
    cy.batch(function () {
      var all = cy.elements('.course, edge');
      all.removeClass('dim hl focus');
      if (!k || !g.vis.nodes.has(k)) return;
      var anc = walk(k, g.vis.preds), desc = walk(k, g.vis.succs);
      all.addClass('dim');
      var keep = cy.collection();
      var nodeSet = new Set([k]); anc.forEach(function (x) { nodeSet.add(x); }); desc.forEach(function (x) { nodeSet.add(x); });
      nodeSet.forEach(function (id) { keep = keep.union(cy.getElementById(id)); });
      g.vis.edges.forEach(function (e) {
        var back = (e.t === k || anc.has(e.t)) && (anc.has(e.s));
        var fwd = (e.s === k || desc.has(e.s)) && (desc.has(e.t));
        if (back || fwd) keep = keep.union(cy.getElementById(e.id));
      });
      keep.removeClass('dim');
      keep.nodes().addClass('hl');
      keep.edges().addClass('hl');
      cy.getElementById(k).addClass('focus');
    });
  }

  /* Pastikan node terlihat (longgarkan filter bila perlu), lalu pusatkan. */
  function focusGraphNode(kode, center) {
    var g = state.g, cy = g.cy;
    if (!cy) return;
    if (g.vis && !g.vis.nodes.has(kode)) {
      var m = state.byKode.get(kode);
      g.from = Math.min(g.from, m.semester); g.to = Math.max(g.to, m.semester);
      if (m.jenis === 'P') g.hideP = false;
      syncGraphControls();
      applyGraphFilters(false);
    }
    refreshHighlight();
    var n = cy.getElementById(kode);
    if (center && n.nonempty() && $('#panel-graph').hidden === false) {
      cy.zoom(Math.max(cy.zoom(), 0.7));
      cy.center(n);
    }
  }

  /* Pencarian node */
  function updateGraphSearch(jump) {
    var g = state.g, cy = g.cy;
    if (!cy) return;
    cy.nodes('.match').removeClass('match');
    g.matches = [];
    if (g.q) {
      var q = g.q.toLowerCase(), nq = norm(g.q);
      state.data.forEach(function (m) {
        if (!g.vis.nodes.has(m.kode)) return;
        if (m.nama.toLowerCase().indexOf(q) !== -1 || (nq && norm(m.kode).indexOf(nq) !== -1)) g.matches.push(m.kode);
      });
      g.matches.forEach(function (k) { cy.getElementById(k).addClass('match'); });
    }
    if (jump && g.matches.length) {
      g.matchIdx = (g.matchIdx + 1) % g.matches.length;
      selectCourse(g.matches[g.matchIdx], { noCenter: false });
    }
    var base = g.vis.nodes.size + ' mata kuliah, ' + g.vis.edges.length + ' garis prasyarat';
    $('#g-count').textContent = g.q ? (g.matches.length + ' cocok (tekan Enter untuk melompat) · ' + base) : base;
  }

  function buildGraphControls() {
    var g = state.g;
    var from = $('#g-from'), to = $('#g-to');
    state.semesters.forEach(function (s) {
      from.append(h('option', { value: s, text: 'Semester ' + s }));
      to.append(h('option', { value: s, text: 'Semester ' + s }));
    });
    syncGraphControls();

    from.addEventListener('change', function () {
      g.from = Number(from.value); if (g.to < g.from) g.to = g.from;
      syncGraphControls(); applyGraphFilters(true);
    });
    to.addEventListener('change', function () {
      g.to = Number(to.value); if (g.from > g.to) g.from = g.to;
      syncGraphControls(); applyGraphFilters(true);
    });
    $('#g-hide-p').addEventListener('change', function (e) { g.hideP = e.target.checked; applyGraphFilters(true); });
    $('#g-show-est').addEventListener('change', function (e) { g.showEst = e.target.checked; applyGraphFilters(false); });

    $('#g-zoom-in').addEventListener('click', function () { zoomBy(1.25); });
    $('#g-zoom-out').addEventListener('click', function () { zoomBy(0.8); });
    $('#g-fit').addEventListener('click', fitGraph);
    $('#g-reset').addEventListener('click', function () {
      g.from = state.semesters[0]; g.to = state.semesters[state.semesters.length - 1];
      g.hideP = false; g.showEst = true; g.q = ''; g.matchIdx = -1; g.hover = null;
      $('#g-search').value = '';
      syncGraphControls();
      if (state.selected) { closeDetailSilently(); writeHash(true); }
      applyGraphFilters(true);
    });
    $('#g-search').addEventListener('input', function (e) {
      g.q = e.target.value.trim(); g.matchIdx = -1; updateGraphSearch(false);
    });
    $('#g-search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); updateGraphSearch(true); }
    });

    // Keterangan garis perkiraan / resmi
    var note = $('#g-note');
    if (state.hasEst) {
      note.textContent = 'Garis putus-putus = prasyarat perkiraan, belum berasal dari dokumen resmi.';
    } else if (state.hasResmi) {
      note.textContent = 'Semua prasyarat berasal dari dokumen resmi.';
    }
    if (!state.hasEst) { $('#g-est-wrap').hidden = true; $('#legend-est').hidden = true; }
    if (!state.hasEdges) { $('#g-est-wrap').hidden = true; $('#legend-est').hidden = true; }
    $('#graph-controls').hidden = false;
  }

  function syncGraphControls() {
    var g = state.g;
    $('#g-from').value = String(g.from);
    $('#g-to').value = String(g.to);
    $('#g-hide-p').checked = g.hideP;
    $('#g-show-est').checked = g.showEst;
  }

  function zoomBy(f) {
    var cy = state.g.cy;
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * f, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }

  /* ------------------------------------------------------------------ init */
  function showError(err) {
    console.error(err);
    var s = $('#status');
    s.textContent = err.message || String(err);
    s.className = 'status error';
    s.setAttribute('role', 'alert');
  }

  function bindDetail() {
    $('#detail-close').addEventListener('click', closeDetail);
    $('#detail-copy').addEventListener('click', function () {
      var base = location.href.split('#')[0];
      copyLink(base + hashFor(state.tab, state.selected));
    });
    $('#detail-body').addEventListener('click', function (e) {
      var g = e.target.closest('[data-goto]');
      if (g) selectCourse(g.dataset.goto, { focus: true });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#detail').hidden) closeDetail();
    });
  }

  bindTabs();
  bindDetail();
  showTab(parseHash().tab);

  loadData().then(function (raw) {
    normalize(raw);
    state.ready = true;
    buildListControls();
    renderList();
    applyHash(); // pilih mata kuliah dari hash & mulai graph bila tab graph aktif
    if (state.tab === 'graph') initGraph();
  }).catch(showError);
})();

// Launch Radar's page logic. Reads window.RADAR_DATA (written beside the
// dashboard by the entry program) and renders the board, the filters and a
// per-protocol detail drawer with the model breakdown and the farm plan.
// Plain script, no imports, no network: every byte shown comes from data.js.

(function () {
  'use strict';
  var DATA = window.RADAR_DATA;
  if (!DATA) return;

  var rowsEl = document.getElementById('rows');
  var countEl = document.getElementById('count');
  var emptyEl = document.getElementById('empty');
  var drawer = document.getElementById('drawer');
  var scrim = document.getElementById('scrim');
  var q = document.getElementById('q');
  var categorySel = document.getElementById('category');
  var chainSel = document.getElementById('chain');
  var sortSel = document.getElementById('sort');
  var watchlistOnly = document.getElementById('watchlist-only');

  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }
  function moneyFull(n) {
    return '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function pct(v) {
    if (v === null || v === undefined) return '<span class="cat">n/a</span>';
    var cls = v >= 0 ? 'up' : 'down';
    return '<span class="' + cls + '">' + (v >= 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Header stats and the model strip.
  document.getElementById('stats').innerHTML =
    '<div class="stat"><b>' + DATA.scanned + '</b><span>protocols scanned</span></div>' +
    '<div class="stat"><b>' + DATA.pre_token + '</b><span>record no token</span></div>' +
    '<div class="stat"><b>' + DATA.rows.length + '</b><span>ranked on board</span></div>' +
    '<div class="stat"><b>' + DATA.as_of + '</b><span>snapshot date</span></div>';

  var chips = DATA.model.top_multiples.map(function (m) {
    return '<span class="chip">' + esc(m.category) + ' <b>' + m.multiple.toFixed(2) + 'x</b></span>';
  }).join('');
  document.getElementById('model').innerHTML =
    '<h2>The value model</h2>' +
    '<p><span class="formula">implied = TVL x category multiple x momentum x maturity</span></p>' +
    '<p>' + esc(DATA.model.summary) + '</p>' +
    '<div class="chips">' + chips +
    '<span class="chip">all-market median <b>' + DATA.model.global_multiple.toFixed(2) + 'x</b></span></div>';

  // Filter option lists, in the order the data presents them.
  function fillSelect(sel, values, allLabel) {
    sel.innerHTML = '<option value="">' + allLabel + '</option>' + values.map(function (v) {
      return '<option value="' + esc(v) + '">' + esc(v) + '</option>';
    }).join('');
  }
  var categories = [];
  var chains = [];
  DATA.rows.forEach(function (r) {
    var c = r.category || '(uncategorised)';
    if (categories.indexOf(c) < 0) categories.push(c);
    r.chains.forEach(function (ch) { if (chains.indexOf(ch) < 0) chains.push(ch); });
  });
  categories.sort();
  chains.sort();
  fillSelect(categorySel, categories, 'All categories');
  fillSelect(chainSel, chains, 'All chains');

  var bySlug = {};
  DATA.rows.forEach(function (r) { bySlug[r.slug] = r; });

  function currentRows() {
    var needle = q.value.trim().toLowerCase();
    var cat = categorySel.value;
    var chain = chainSel.value;
    var list = DATA.rows.filter(function (r) {
      if (watchlistOnly.checked && !r.watchlist) return false;
      if (cat && (r.category || '(uncategorised)') !== cat) return false;
      if (chain && r.chains.indexOf(chain) < 0) return false;
      if (needle && r.name.toLowerCase().indexOf(needle) < 0 && r.slug.indexOf(needle) < 0) return false;
      return true;
    });
    var key = sortSel.value;
    list.sort(function (a, b) {
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'change') return (b.change_7d || 0) - (a.change_7d || 0);
      if (key === 'age') return (b.age_days || 0) - (a.age_days || 0);
      if (key === 'multiple') return b.multiple - a.multiple;
      return a.rank - b.rank;
    });
    return list;
  }

  function render() {
    var list = currentRows();
    countEl.textContent = 'Showing ' + list.length + ' of ' + DATA.rows.length + ' ranked protocols';
    emptyEl.hidden = list.length > 0;
    rowsEl.innerHTML = list.map(function (r) {
      var ratio = r.tvl_usd > 0 ? (r.implied_value_usd / r.tvl_usd).toFixed(2) + 'x' : 'n/a';
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num rank">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + (r.watchlist ? '<span class="flag">watchlist</span>' : '') + '</span>' +
        '<span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || '(uncategorised)') + '</td>' +
        '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num implied">' + money(r.implied_value_usd) + '</td>' +
        '<td class="num ratio">' + ratio + '</td>' +
        '<td><button class="farm-btn" data-farm="' + esc(r.slug) + '">Farm plan</button></td>' +
        '</tr>';
    }).join('');
  }

  function buildLine(label, text) {
    return '<div class="bar-row"><span>' + label + '</span><span>' + text + '</span><span></span></div>';
  }

  function openDetail(slug) {
    var r = bySlug[slug];
    if (!r) return;
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    drawer.innerHTML =
      '<button class="close" id="drawer-close" aria-label="Close">x</button>' +
      '<h2>' + esc(r.name) + (r.watchlist ? '<span class="flag">watchlist</span>' : '') + '</h2>' +
      '<p class="sub">Rank #' + r.rank + ' of ' + DATA.rows.length + ' - ' + esc(r.category || '(uncategorised)') +
      ' - tracked since ' + (r.listed_at || 'an unreported date') + '</p>' +
      '<div class="kv">' +
      '<div><span>Implied value</span><b>' + moneyFull(r.implied_value_usd) + '</b></div>' +
      '<div><span>TVL</span><b>' + moneyFull(r.tvl_usd) + '</b></div>' +
      '<div><span>7d TVL change</span><b>' + (r.change_7d === null ? 'n/a' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</b></div>' +
      '<div><span>Days with no token</span><b>' + (r.age_days === null ? 'n/a' : r.age_days) + '</b></div>' +
      '</div>' +
      '<h3>How the value is built</h3>' +
      buildLine('TVL base', moneyFull(r.tvl_usd) + ' across ' + esc(r.chains.slice(0, 3).join(', '))) +
      buildLine('Category multiple', 'x' + r.multiple.toFixed(2) + ' (' + esc(r.multiple_source) + ')') +
      buildLine('Momentum', 'x' + r.momentum.toFixed(3) + ' from the 7-day TVL move') +
      buildLine('Maturity', 'x' + r.maturity.toFixed(3) + ' for the record with no token') +
      '<p class="sub">Chains: ' + esc(r.chains.join(', ')) + '. Tokenised peers set the multiple; this protocol records no token in the snapshot.</p>' +
      '<h3>Farm plan</h3><ol class="steps">' + steps + '</ol>';
    drawer.hidden = false;
    scrim.hidden = false;
    document.getElementById('drawer-close').addEventListener('click', closeDetail);
  }

  function closeDetail() {
    drawer.hidden = true;
    scrim.hidden = true;
  }

  rowsEl.addEventListener('click', function (e) {
    var t = e.target;
    var tr = t.closest ? t.closest('tr') : null;
    if (tr && tr.getAttribute('data-slug')) openDetail(tr.getAttribute('data-slug'));
  });
  scrim.addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });
  [q, categorySel, chainSel, sortSel, watchlistOnly].forEach(function (el) {
    el.addEventListener('input', render);
    el.addEventListener('change', render);
  });

  render();

  // A #slug in the address opens that protocol's detail directly.
  var hash = window.location.hash.replace(/^#/, '');
  if (hash && bySlug[hash]) openDetail(hash);
})();

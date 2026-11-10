/* 仕入れ・売価 アプリ本体 */
'use strict';

const VERSION = '1.0.0';
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } }
};
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = n => (n == null || n === '' || isNaN(n)) ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP');
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(Math.round(n)).toLocaleString('ja-JP');
const pct = x => (x == null || isNaN(x)) ? '—' : (x * 100).toFixed(1) + '%';
const numIn = s => { if (s == null) return null; const t = String(s).replace(/[,，¥円\s]/g, '').replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); if (t === '') return null; const n = Number(t); return isNaN(n) ? null : n; };
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s/g, '').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const SLOTS = [
  { k: 'nb', lab: '通常・玄米', cost: 'k', kind: 'N', genmai: true },
  { k: 'nw', lab: '通常・白米', cost: 'w', kind: 'N' },
  { k: 'bb', lab: '業務用・玄米', cost: 'k', kind: 'B', genmai: true },
  { k: 'bw', lab: '業務用・白米', cost: 'w', kind: 'B' }
];

/* ---------------- 状態 ---------------- */
const conf = Object.assign({ apiUrl: '' }, window.APP_CONFIG || {}, LS.get('shiire-conf', {}));
let D = LS.get('shiire-data', null);   // サーバーから受け取った全データ
let tab = 'calc';
let C = freshCalc();                   // 計算・入力タブの入力中の内容
let busy = false;
let histQuery = '', prodQuery = '', prodAll = false;

function freshCalc(keep) {
  const k = keep || {};
  return {
    mode: 'buy', editId: null, sendId: uid(),
    date: k.date || today(), code: '', q: '', sup: k.sup || '', tax: k.tax || '',
    unit: '', qty: '', note: '', prices: {}, tN: null, tB: null, showB: false
  };
}

/* ---------------- データの参照 ---------------- */
const cfg = () => (D && D.settings) || { rate: 0.08, factor: 60 / 53, defW: 30, tN: 0.35, bDiff: 0.1, round: 10, upDiff: 0.1 };
const prod = code => D && D.products.find(p => p.code === String(code));
const sup = id => D && D.suppliers.find(s => s.id === String(id));
const onSale = p => SLOTS.some(s => p[s.k] > 0);
const slotsOf = p => SLOTS.filter(s => !s.genmai || p.kubun === '玄米');
const cmpE = (a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : a.id - b.id;
function entriesOf(code) { return D.entries.filter(e => e.c === String(code) && e.b > 0).sort(cmpE); }
/** date 以前（同じ日も含む）の最新の仕入れ。exclude は除く入庫ID */
function prevEntry(code, date, exclude) {
  const list = entriesOf(code).filter(e => e.id !== exclude && (!date || e.d <= date));
  return list.length ? list[list.length - 1] : null;
}
function targets(p) {
  const c = cfg();
  const tN = C.code === p.code && C.tN != null ? C.tN : (p.tN != null ? p.tN : c.tN);
  const tB = C.code === p.code && C.tB != null ? C.tB : (p.tB != null ? p.tB : tN - c.bDiff);
  return { N: tN, B: tB };
}
function baseTargets(p) { const c = cfg(); const N = p.tN != null ? p.tN : c.tN; return { N, B: p.tB != null ? p.tB : N - c.bDiff }; }
function costOf(p, unit, tax) {
  const c = cfg();
  if (!(unit > 0)) return null;
  const b = tax === '税抜' ? unit * (1 + c.rate) : unit;
  const k = b / (p.weight || c.defW);
  const w = p.kubun === '玄米' ? k * c.factor : k;
  return { b, k, w };
}
const margin = (price, cost) => (price > 0 && cost > 0) ? (price - cost) / price : null;
function targetPrice(cost, t) { const r = cfg().round || 10; if (!(cost > 0) || t >= 1) return null; return Math.ceil(cost / (1 - t) / r - 1e-9) * r; }
function judge(m, t) {
  if (m == null) return '';
  if (m < t - 1e-9) return 'lo';
  const up = cfg().upDiff;
  if (up > 0 && m > t + up + 1e-9) return 'hi';
  return 'ok';
}
/** 見直し候補の判定（販売中の商品だけ） */
function reviewOf(p) {
  const list = entriesOf(p.code);
  if (!list.length) return null;
  const last = list[list.length - 1];
  let lastDecided = -1;
  list.forEach((e, i) => { if (e.dc === '見直し' || e.dc === '据え置き') lastDecided = i; });
  const after = list.slice(lastDecided + 1);
  const changed = after.filter(e => e.df != null && e.df !== 0);
  // 比べる相手：最後に確認した仕入れ。確認の記録がなければ、最後に値段が変わる直前の仕入れ
  const lastCh = changed.length ? list.indexOf(changed[changed.length - 1]) : -1;
  const base = lastDecided >= 0 ? list[lastDecided] : (lastCh > 0 ? list[lastCh - 1] : null);
  const t = baseTargets(p);
  const flags = [];
  if (changed.length) flags.push('change');
  let lo = false, hi = false;
  slotsOf(p).forEach(s => {
    const j = judge(margin(p[s.k], last[s.cost]), t[s.kind]);
    if (j === 'lo') lo = true; if (j === 'hi') hi = true;
  });
  if (lo) flags.push('lo');
  if (hi) flags.push('hi');
  return { last, base, flags, changedCount: changed.length };
}

/* ---------------- 通信 ---------------- */
async function api(action, payload) {
  if (!conf.apiUrl || !conf.pass) { openSettings(); throw new Error('設定画面でサーバーURLと合言葉を入れてください'); }
  setSync('通信中…');
  let res;
  try {
    const r = await fetch(conf.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ pass: conf.pass, action, by: conf.name || '' }, payload || {})) });
    res = await r.json();
  } catch (e) {
    setSync('未接続');
    throw new Error('サーバーにつながりません。電波を確認して、もう一度送ってください');
  }
  if (!res.ok) { setSync(''); if (res.auth) openSettings(); throw new Error(res.error || 'エラーが起きました'); }
  if (res.data) { D = res.data; LS.set('shiire-data', D); }
  setSync('最新 ' + (D && D.serverTime ? D.serverTime.slice(11) : ''));
  return res;
}
function setSync(t) { $('#syncState').textContent = t; }
function toast(msg, err) {
  const el = $('#toast'); el.textContent = msg; el.className = 'toast' + (err ? ' err' : ''); el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, err ? 5000 : 2500);
}
async function reload() {
  try { await api('load'); render(); } catch (e) { toast(e.message, true); }
}

/* ---------------- 画面の切り替え ---------------- */
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach(s => { s.hidden = s.id !== 'tab-' + t; });
  render();
  window.scrollTo(0, 0);
}
function render() {
  renderWarn();
  if (!D) { $('#tab-' + tab).innerHTML = '<div class="empty">データがありません。右上の ⚙ で設定してください</div>'; return; }
  const n = D.products.filter(p => onSale(p)).map(reviewOf).filter(r => r && r.flags.length).length;
  const b = $('#reviewCount'); b.textContent = n; b.hidden = !n;
  if (tab === 'calc') renderCalc();
  if (tab === 'review') renderReview();
  if (tab === 'history') renderHistory();
  if (tab === 'products') renderProducts();
}
function renderWarn() {
  const w = $('#warn');
  if (D && D.lastBackup) {
    const last = new Date(D.lastBackup.replace(' ', 'T'));
    if ((Date.now() - last) / 86400000 >= 3) { w.textContent = '⚠ バックアップが3日以上とれていません（最終 ' + D.lastBackup + '）'; w.hidden = false; return; }
  }
  w.hidden = true;
}

/* ---------------- 計算・入力タブ ---------------- */
function renderCalc() {
  const el = $('#tab-calc');
  const p = C.code ? prod(C.code) : null;
  const isBuy = C.mode === 'buy';
  let h = '';
  if (C.editId) {
    h += `<div class="card"><b>入庫ID ${C.editId} を修正中</b> <button class="linkbtn" data-act="cancelEdit">やめる</button></div>`;
  } else {
    h += `<div class="seg" style="margin-bottom:10px">
      <button data-mode="buy" class="${isBuy ? 'on' : ''}">仕入れを記録</button>
      <button data-mode="price" class="${!isBuy ? 'on' : ''}">売価だけ見直す</button></div>`;
  }
  h += '<div class="card">';
  if (isBuy) h += `<label class="f">仕入日</label><input class="t" type="date" id="cDate" value="${esc(C.date)}">`;
  h += '<label class="f">商品</label>';
  if (p) {
    h += `<div class="pick"><b>${esc(p.name)}</b><span class="muted">${esc(p.kubun)}${p.weight && p.weight !== 30 ? '・' + p.weight + 'kg' : ''}</span><button data-act="clearProd">変える</button></div>`;
  } else {
    h += `<input class="t" id="cQ" placeholder="商品名の一部（例：ひとめ）" value="${esc(C.q)}" autocomplete="off"><div id="cRes"></div>`;
  }
  if (isBuy) {
    const sups = supplierOptions(p);
    h += `<label class="f">仕入先</label><select class="t" id="cSup"><option value="">選んでください</option>${sups}<option value="__new">＋ 新しい仕入先を追加</option></select>
      <label class="f">請求書の表記</label>
      <div class="seg" id="cTax"><button data-tax="税込" class="${C.tax === '税込' ? 'on' : ''}">税込</button><button data-tax="税抜" class="${C.tax === '税抜' ? 'on' : ''}">税抜</button></div>
      <div class="row">
        <div><label class="f">1袋の単価</label><div class="yen"><input class="t num" id="cUnit" inputmode="decimal" value="${esc(C.unit)}" placeholder="0"></div></div>
        <div><label class="f">袋数</label><input class="t num" id="cQty" inputmode="decimal" value="${esc(C.qty)}" placeholder="計算だけなら空欄"></div>
      </div>
      <label class="f">備考</label><input class="t" id="cNote" value="${esc(C.note)}" placeholder="新米、一等 など">`;
  }
  h += '</div><div id="cOut"></div>';
  el.innerHTML = h;
  if (!p) renderSearch();
  renderCalcOut();
}

function supplierOptions(p) {
  if (!D) return '';
  const recent = p ? [...new Set(entriesOf(p.code).slice(-5).reverse().map(e => e.s))] : [];
  const all = D.suppliers.slice().sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  const opt = s => `<option value="${esc(s.id)}" ${C.sup === s.id ? 'selected' : ''}>${esc(s.name)}${s.tax ? '（' + s.tax + '）' : ''}</option>`;
  let h = '';
  if (recent.length) h += '<optgroup label="この商品の最近の仕入先">' + recent.map(id => sup(id)).filter(Boolean).map(opt).join('') + '</optgroup><optgroup label="すべて">';
  h += all.map(opt).join('');
  if (recent.length) h += '</optgroup>';
  return h;
}

function renderSearch() {
  const box = $('#cRes'); if (!box) return;
  const q = norm(C.q);
  let list = D.products.slice();
  const lastD = {}; D.entries.forEach(e => { if (!lastD[e.c] || lastD[e.c] < e.d) lastD[e.c] = e.d; });
  list.sort((a, b) => (onSale(b) - onSale(a)) || ((lastD[b.code] || '').localeCompare(lastD[a.code] || '')));
  if (q) list = list.filter(p => norm(p.name).includes(q) || p.code === q || norm(p.rakuichi) === q);
  else list = list.filter(p => onSale(p) || (lastD[p.code] || '') >= addDays(today(), -365));
  list = list.slice(0, q ? 30 : 40);
  box.innerHTML = list.length ? '<div class="results">' + list.map(p =>
    `<div data-code="${esc(p.code)}">${esc(p.name)}<small>${onSale(p) ? '販売中' : ''}${lastD[p.code] ? ' 最終 ' + lastD[p.code] : ''}</small></div>`).join('') + '</div>'
    : '<div class="muted" style="padding:8px">見つかりません。「商品」タブで追加できます</div>';
}
function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

function selectProduct(code) {
  const p = prod(code); if (!p) return;
  C.code = p.code; C.q = ''; C.prices = {}; C.tN = null; C.tB = null;
  C.showB = p.bb > 0 || p.bw > 0;
  if (C.mode === 'buy' && !C.editId) {
    const last = prevEntry(p.code);
    if (!C.sup) C.sup = (last && last.s) || p.mainSup || '';
    if (C.sup && !C.tax) { const s = sup(C.sup); C.tax = (s && s.tax) || (last && last.t) || '税込'; }
  }
  renderCalc();
}

function currentCost(p) {
  if (C.mode === 'buy') return costOf(p, numIn(C.unit), C.tax);
  const last = prevEntry(p.code);
  return last ? { b: last.b, k: last.k, w: last.w, from: last } : null;
}

function renderCalcOut() {
  const out = $('#cOut'); if (!out) return;
  const p = C.code ? prod(C.code) : null;
  if (!p) { out.innerHTML = ''; return; }
  const isBuy = C.mode === 'buy';
  const cost = currentCost(p);
  const prev = isBuy ? prevEntry(p.code, C.date, C.editId) : null;
  let h = '<div class="card">';
  if (isBuy) {
    h += prev ? `<div class="muted">前回の仕入れ：${esc(prev.d)}　${esc((sup(prev.s) || {}).name || '')}<br>1袋 ${yen(prev.b)}（税込）${prev.t === '税抜' ? '／請求書 ' + yen(prev.u) + '（税抜）' : ''}</div>`
      : '<div class="muted">この商品の過去の仕入れはありません</div>';
    if (cost && prev) {
      const unit = numIn(C.unit);
      const same = prev.t === C.tax && Math.abs(prev.u - unit) < 0.5;
      const d = same ? 0 : cost.b - prev.b;
      if (d === 0) h += `<div class="alert same">前回と同じ値段です</div>`;
      else h += `<div class="alert ${d > 0 ? 'up' : 'down'}">${d > 0 ? '⚠ 値上がり' : '⚠ 値下がり'}　1袋 <b>${signed(d)}円</b>（${d > 0 ? '+' : '−'}${Math.abs(d / prev.b * 100).toFixed(1)}%）<br>売価を見直すか確認してください</div>`;
    }
  } else if (cost) {
    h += `<div class="muted">原価は最新の仕入れ（${esc(cost.from.d)}　${esc((sup(cost.from.s) || {}).name || '')}）</div>`;
  } else {
    h += '<div class="muted">この商品の仕入れの記録がないため、原価が分かりません</div>';
  }
  if (cost) {
    h += `<div class="cost" style="margin-top:8px">
      <div><div class="muted">1袋（税込）</div><div class="big">${yen(cost.b)}</div></div>
      <div><div class="muted">${isBuy && numIn(C.qty) > 0 ? '合計（請求書）' : '&nbsp;'}</div><div class="big">${isBuy && numIn(C.qty) > 0 ? yen(numIn(C.unit) * numIn(C.qty)) : ''}</div></div>
      ${p.kubun === '玄米' ? `<div><div class="muted">玄米原価/kg</div><div class="big">${yen2(cost.k)}</div></div>` : ''}
      <div><div class="muted">${p.kubun === '玄米' ? '白米原価/kg' : '原価/kg'}</div><div class="big">${yen2(cost.w)}</div></div></div>`;
  }
  h += '</div>';
  if (cost && !C.editId) h += priceTable(p, cost);
  // ボタン
  h += '<div class="actions">';
  if (C.editId) {
    h += '<button class="btn danger" data-act="delete">削除</button><button class="btn" data-act="saveEdit">変更を保存</button>';
  } else if (isBuy) {
    h += '<button class="btn sub" data-act="clear">クリア</button><button class="btn" data-act="record">記録する</button>';
  } else {
    h += '<button class="btn sub" data-act="keep">据え置き（確認済み）</button><button class="btn" data-act="savePrice">売価を保存</button>';
  }
  h += '</div>';
  out.innerHTML = h;
}
const yen2 = n => (n == null || isNaN(n)) ? '—' : '¥' + n.toLocaleString('ja-JP', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function priceTable(p, cost) {
  const t = targets(p);
  const slots = slotsOf(p).filter(s => s.kind === 'N' || C.showB);
  let h = `<div class="card"><h2>売価と利益率</h2>
    <div class="row"><div><label class="f">目標利益率（通常）</label><div class="pct"><input class="t num" id="tN" inputmode="decimal" value="${(t.N * 100).toFixed(1).replace(/\.0$/, '')}"></div></div>
    ${C.showB ? `<div><label class="f">目標利益率（業務用）</label><div class="pct"><input class="t num" id="tB" inputmode="decimal" value="${(t.B * 100).toFixed(1).replace(/\.0$/, '')}"></div></div>` : '<div></div>'}</div>
    <table class="prices"><tr><th></th><th>今の売価</th><th>目標売価</th><th>新しい売価</th></tr>`;
  slots.forEach(s => {
    const c = cost[s.cost], tg = t[s.kind];
    const cur = p[s.k];
    const mCur = margin(cur, c), jCur = judge(mCur, tg);
    const tp = targetPrice(c, tg);
    const nv = C.prices[s.k];
    const mNew = margin(numIn(nv), c), jNew = judge(mNew, tg);
    h += `<tr><td>${s.lab}</td>
      <td>${cur > 0 ? yen(cur) + `<span class="m ${jCur}">${pct(mCur)}</span>` : '<span class="muted">なし</span>'}</td>
      <td>${tp ? `<button class="tp" data-tp="${s.k}" data-v="${tp}">${yen(tp)}</button>` : '—'}</td>
      <td><input data-price="${s.k}" inputmode="numeric" value="${esc(nv == null ? '' : nv)}" placeholder="—"><span class="m ${jNew}" id="m-${s.k}">${nv != null && nv !== '' ? pct(mNew) : ''}</span></td></tr>`;
  });
  h += '</table>';
  const up = cfg().upDiff;
  h += `<div class="muted" style="margin-top:6px">目標売価は ${cfg().round}円単位で切り上げ。タップで「新しい売価」に入ります。<span class="lo">赤</span>＝目標未満${up > 0 ? `、<span class="hi">青</span>＝目標を${Math.round(up * 100)}ポイント以上上回る` : ''}</div>`;
  if (!C.showB) h += '<button class="linkbtn" data-act="showB">業務用の売価も見る</button>';
  h += '</div>';
  return h;
}

// 入力のたびに全体を描き直すと、スマホでキーボードが閉じるので、必要な所だけ直す
document.addEventListener('input', ev => {
  const t = ev.target;
  if (tab !== 'calc') {
    if (t.id === 'hQ') { histQuery = t.value; renderHistoryList(); }
    if (t.id === 'pQ') { prodQuery = t.value; renderProductList(); }
    return;
  }
  if (t.id === 'cQ') { C.q = t.value; renderSearch(); return; }
  if (t.id === 'cUnit') { C.unit = t.value; refreshOut(); return; }
  if (t.id === 'cQty') { C.qty = t.value; refreshOut(); return; }
  if (t.id === 'cNote') { C.note = t.value; return; }
  if (t.id === 'tN' || t.id === 'tB') { const v = numIn(t.value); C[t.id] = v == null ? null : v / 100; refreshTable(); return; }
  if (t.dataset.price) {
    const k = t.dataset.price; if (t.value === '') delete C.prices[k]; else C.prices[k] = t.value;
    const p = prod(C.code), cost = currentCost(p), s = SLOTS.find(x => x.k === k);
    const m = margin(numIn(t.value), cost[s.cost]); const el = $('#m-' + k);
    el.textContent = t.value ? pct(m) : ''; el.className = 'm ' + judge(m, targets(p)[s.kind]);
  }
});
document.addEventListener('change', ev => {
  const t = ev.target;
  if (t.id === 'cDate') { C.date = t.value; refreshOut(); }
  if (t.id === 'cSup') {
    if (t.value === '__new') { t.value = C.sup; openNewSupplier(); return; }
    C.sup = t.value; const s = sup(C.sup); if (s && s.tax) C.tax = s.tax; renderCalc();
  }
});
// 入力欄にフォーカスがある間は、表の部分だけを描き直す
function refreshOut() {
  const a = document.activeElement, id = a && a.id, pos = a && a.selectionStart;
  renderCalcOut();
  if (id) { const n = document.getElementById(id); if (n && n !== a) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { } } }
}
function refreshTable() { refreshOut(); }

document.addEventListener('click', async ev => {
  const t = ev.target.closest('button, [data-code], [data-entry], [data-prod], [data-review]');
  if (!t) return;
  if (t.dataset.mode) { const keep = { date: C.date, sup: C.sup, tax: C.tax }; const code = C.code; C = freshCalc(keep); C.mode = t.dataset.mode; if (code) selectProduct(code); else renderCalc(); return; }
  if (t.dataset.code !== undefined && t.closest('#cRes')) { selectProduct(t.dataset.code); return; }
  if (t.dataset.tax) { C.tax = t.dataset.tax; t.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === t)); refreshOut(); return; }
  if (t.dataset.tp) { C.prices[t.dataset.tp] = t.dataset.v; refreshOut(); return; }
  if (t.dataset.entry) { startEdit(Number(t.dataset.entry)); return; }
  if (t.dataset.prod) { openProduct(t.dataset.prod); return; }
  if (t.dataset.review) { const keep = { date: C.date, sup: C.sup, tax: C.tax }; C = freshCalc(keep); C.mode = 'price'; showTab('calc'); selectProduct(t.dataset.review); return; }
  switch (t.dataset.act) {
    case 'clearProd': C.code = ''; C.prices = {}; renderCalc(); setTimeout(() => { const q = $('#cQ'); if (q) q.focus(); }, 0); break;
    case 'showB': C.showB = true; refreshOut(); break;
    case 'clear': C = freshCalc({ date: C.date, sup: C.sup, tax: C.tax }); renderCalc(); break;
    case 'cancelEdit': C = freshCalc(); renderCalc(); break;
    case 'record': confirmRecord(); break;
    case 'savePrice': confirmPrice(false); break;
    case 'keep': confirmPrice(true); break;
    case 'saveEdit': saveEdit(); break;
    case 'delete': deleteEntry(); break;
    case 'close': closeModal(); break;
    case 'newProduct': openProduct(''); break;
    case 'prodAll': prodAll = !prodAll; renderProducts(); break;
  }
});

/* ---- 記録の確認 ---- */
function changedPrices(p) {
  const out = {};
  Object.keys(C.prices).forEach(k => {
    const v = numIn(C.prices[k]);
    if (v != null && v !== (p[k] || 0)) out[k] = v;
  });
  return out;
}
function priceLines(p, ch) {
  return Object.keys(ch).map(k => { const s = SLOTS.find(x => x.k === k); return `${s.lab}：${p[k] > 0 ? yen(p[k]) : 'なし'} → <b>${ch[k] > 0 ? yen(ch[k]) : 'なし'}</b>`; }).join('<br>');
}
function confirmRecord() {
  const p = prod(C.code);
  const unit = numIn(C.unit), qty = numIn(C.qty);
  const err = !p ? '商品を選んでください' : !C.sup ? '仕入先を選んでください' : !C.tax ? '税込か税抜かを選んでください'
    : !(unit > 0) ? '1袋の単価を入れてください' : !(qty > 0) ? '袋数を入れてください（計算だけなら記録は不要です）' : !C.date ? '仕入日を入れてください' : '';
  if (err) { toast(err, true); return; }
  const cost = costOf(p, unit, C.tax), prev = prevEntry(p.code, C.date);
  const same = prev && prev.t === C.tax && Math.abs(prev.u - unit) < 0.5;
  const d = prev ? (same ? 0 : cost.b - prev.b) : null;
  const ch = changedPrices(p);
  let h = `<h2>この内容で記録しますか？</h2><table class="sum">
    <tr><td>仕入日</td><td>${esc(C.date)}</td></tr>
    <tr><td>商品</td><td><b>${esc(p.name)}</b></td></tr>
    <tr><td>仕入先</td><td>${esc(sup(C.sup).name)}${prev && prev.s !== C.sup ? `<br><span class="lo">前回は ${esc((sup(prev.s) || {}).name || '')}（違っていないか確認）</span>` : ''}</td></tr>
    <tr><td>数量・単価</td><td>${qty}袋 × ${yen(unit)}（${C.tax}）</td></tr>
    <tr><td>合計（請求書）</td><td>${yen(unit * qty)}</td></tr>
    <tr><td>1袋（税込）</td><td><b>${yen(cost.b)}</b>${d == null ? '' : d === 0 ? '　前回と同じ' : `　<span class="${d > 0 ? 'lo' : 'hi'}">前回比 ${signed(d)}円</span>`}</td></tr>
    ${C.note ? `<tr><td>備考</td><td>${esc(C.note)}</td></tr>` : ''}</table>`;
  if (Object.keys(ch).length) {
    h += `<div class="alert down" style="margin-top:12px">売価を変更します<br>${priceLines(p, ch)}</div>`;
  } else if (d) {
    h += `<div style="margin-top:12px"><b>値段が変わりました。売価はどうしますか？</b>
      <label class="radio"><input type="radio" name="dec" value="据え置き">売価は据え置く（確認済みにする）</label>
      <label class="radio"><input type="radio" name="dec" value="あとで" checked>あとで決める（「見直し」タブに残す）</label></div>`;
  }
  h += '<div class="actions"><button class="btn sub" data-act="close">戻る</button><button class="btn" id="okRecord">記録する</button></div>';
  openModal(h);
  $('#okRecord').onclick = async () => {
    const decEl = document.querySelector('input[name=dec]:checked');
    const body = { sendId: C.sendId, entry: { d: C.date, c: p.code, s: C.sup, q: qty, u: unit, t: C.tax, n: C.note },
      prices: Object.keys(ch).length ? ch : null, decision: decEl ? decEl.value : '' };
    await run(async () => {
      await api('addEntry', body);
      closeModal();
      toast('記録しました');
      C = freshCalc({ date: C.date, sup: C.sup, tax: C.tax });
      render();
      setTimeout(() => { const q = $('#cQ'); if (q) q.focus(); }, 50);
    });
  };
}
function confirmPrice(keep) {
  const p = prod(C.code); if (!p) { toast('商品を選んでください', true); return; }
  const last = prevEntry(p.code);
  const ch = changedPrices(p);
  if (!keep && !Object.keys(ch).length) { toast('「新しい売価」に、変える売価を入れてください', true); return; }
  let h = `<h2>${esc(p.name)}</h2>`;
  h += keep ? '<p>今の売価のまま据え置き、値段の変化を「確認済み」にします。</p>' : `<div class="alert down">売価を変更します<br>${priceLines(p, ch)}</div>`;
  h += '<div class="actions"><button class="btn sub" data-act="close">戻る</button><button class="btn" id="okPrice">保存する</button></div>';
  openModal(h);
  $('#okPrice').onclick = async () => {
    await run(async () => {
      await api('decide', { code: p.code, entryId: last ? last.id : null, decision: keep ? '据え置き' : '見直し', prices: keep ? null : ch });
      closeModal(); toast(keep ? '確認済みにしました' : '売価を保存しました');
      C = freshCalc({ date: C.date, sup: C.sup, tax: C.tax }); C.mode = 'price'; selectProduct(p.code);
    });
  };
}
async function run(fn) {
  if (busy) return; busy = true;
  document.querySelectorAll('.modal .btn').forEach(b => b.disabled = true);
  try { await fn(); } catch (e) { toast(e.message, true); } finally {
    busy = false; document.querySelectorAll('.modal .btn').forEach(b => b.disabled = false);
  }
}

/* ---- 修正・削除 ---- */
function startEdit(id) {
  const e = D.entries.find(x => x.id === id); if (!e) return;
  C = freshCalc(); C.editId = id; C.mode = 'buy';
  Object.assign(C, { date: e.d, code: e.c, sup: e.s, tax: e.t || '税込', unit: String(e.u == null ? '' : e.u), qty: String(e.q == null ? '' : e.q), note: e.n });
  showTab('calc');
}
async function saveEdit() {
  const unit = numIn(C.unit), qty = numIn(C.qty);
  if (!C.code || !C.sup || !(unit > 0) || !(qty > 0)) { toast('商品・仕入先・単価・袋数を入れてください', true); return; }
  const p = prod(C.code);
  openModal(`<h2>入庫ID ${C.editId} を変更しますか？</h2><p>${esc(C.date)}　${esc(p.name)}<br>${qty}袋 × ${yen(unit)}（${C.tax}）　${esc(sup(C.sup).name)}</p>
    <div class="actions"><button class="btn sub" data-act="close">戻る</button><button class="btn" id="okEdit">変更する</button></div>`);
  $('#okEdit').onclick = () => run(async () => {
    await api('editEntry', { id: C.editId, entry: { d: C.date, c: C.code, s: C.sup, q: qty, u: unit, t: C.tax, n: C.note } });
    closeModal(); toast('変更しました'); C = freshCalc(); showTab('history');
  });
}
function deleteEntry() {
  const e = D.entries.find(x => x.id === C.editId); const p = prod(e.c);
  openModal(`<h2>この仕入れを削除しますか？</h2><p>${esc(e.d)}　${esc(p ? p.name : e.c)}<br>${e.q}袋 × ${yen(e.u)}（${esc(e.t)}）</p><p class="muted">削除すると元に戻せません（毎日のバックアップには残ります）</p>
    <div class="actions"><button class="btn sub" data-act="close">戻る</button><button class="btn danger" id="okDel">削除する</button></div>`);
  $('#okDel').onclick = () => run(async () => {
    await api('deleteEntry', { id: C.editId }); closeModal(); toast('削除しました'); C = freshCalc(); showTab('history');
  });
}

/* ---------------- 見直しタブ ---------------- */
function renderReview() {
  const el = $('#tab-review');
  const rows = D.products.filter(onSale).map(p => ({ p, r: reviewOf(p) })).filter(x => x.r && x.r.flags.length);
  const rank = x => x.r.flags.includes('change') ? 0 : x.r.flags.includes('lo') ? 1 : 2;
  rows.sort((a, b) => rank(a) - rank(b) || b.r.last.d.localeCompare(a.r.last.d));
  let h = `<div class="muted" style="margin-bottom:8px">販売中の商品のうち、仕入れ値が変わってまだ確認していないもの・利益率が目標から外れているもの。タップして売価を見直します。</div>`;
  if (!rows.length) h += '<div class="empty">見直しが必要な商品はありません 👍</div>';
  rows.forEach(({ p, r }) => {
    const t = baseTargets(p);
    h += `<div class="card tap" data-review="${esc(p.code)}"><div class="row"><b class="grow">${esc(p.name)}</b></div><div>`;
    if (r.flags.includes('change')) h += '<span class="chip red">仕入れ値が変わった（未確認）</span>';
    if (r.flags.includes('lo')) h += '<span class="chip amber">利益率が目標未満</span>';
    if (r.flags.includes('hi')) h += '<span class="chip blue">値下げ検討</span>';
    h += '</div><div class="muted">';
    if (r.base && r.flags.includes('change')) h += `1袋 ${yen(r.base.b)}（${esc(r.base.d)}）→ <b>${yen(r.last.b)}</b>（${esc(r.last.d)}）　${signed(r.last.b - r.base.b)}円<br>`;
    else h += `最新の仕入れ 1袋 ${yen(r.last.b)}（${esc(r.last.d)}）<br>`;
    h += slotsOf(p).filter(s => p[s.k] > 0).map(s => {
      const m = margin(p[s.k], r.last[s.cost]); return `${s.lab} ${yen(p[s.k])} <span class="${judge(m, t[s.kind])}">${pct(m)}</span>`;
    }).join('　');
    h += '</div></div>';
  });
  el.innerHTML = h;
}

/* ---------------- 履歴タブ ---------------- */
function renderHistory() {
  $('#tab-history').innerHTML = `<div class="filters"><input class="t" id="hQ" placeholder="商品名・仕入先で絞り込み" value="${esc(histQuery)}"></div><div id="hList"></div>`;
  renderHistoryList();
}
function renderHistoryList() {
  const q = norm(histQuery);
  let list = D.entries.slice().sort((a, b) => -cmpE(a, b));
  if (q) list = list.filter(e => norm((prod(e.c) || {}).name).includes(q) || norm((sup(e.s) || {}).name).includes(q));
  list = list.slice(0, 120);
  $('#hList').innerHTML = list.length ? list.map(e => {
    const p = prod(e.c) || { name: '（商品 ' + e.c + '）' };
    const df = e.df == null ? '' : e.df === 0 ? '<span class="chip gray">前回と同じ</span>' : `<span class="chip ${e.df > 0 ? 'red' : 'blue'}">前回比 ${signed(e.df)}円</span>`;
    const dc = e.dc ? `<span class="chip green">${esc(e.dc)}</span>` : '';
    return `<div class="card tap hist" data-entry="${e.id}"><div class="top-line"><b>${esc(p.name)}</b><span class="muted">${esc(e.d)}</span></div>
      <div class="muted">${esc((sup(e.s) || {}).name || '')}　${e.q == null ? '' : e.q + '袋'} × ${yen(e.u)}（${esc(e.t)}）→ 1袋 ${yen(e.b)}</div>
      <div>${df}${dc}${e.n ? `<span class="chip gray">${esc(e.n)}</span>` : ''}</div></div>`;
  }).join('') : '<div class="empty">記録がありません</div>';
}

/* ---------------- 商品タブ ---------------- */
function renderProducts() {
  $('#tab-products').innerHTML = `<div class="filters"><input class="t" id="pQ" placeholder="商品名で絞り込み" value="${esc(prodQuery)}">
    <button class="btn sub small" data-act="prodAll">${prodAll ? 'すべて' : '販売中'}</button></div>
    <button class="btn" style="width:100%;margin-bottom:10px" data-act="newProduct">＋ 新しい商品を追加</button><div id="pList"></div>`;
  renderProductList();
}
function renderProductList() {
  const q = norm(prodQuery);
  let list = D.products.slice();
  if (!prodAll && !q) list = list.filter(onSale);
  if (q) list = list.filter(p => norm(p.name).includes(q));
  list.sort((a, b) => (onSale(b) - onSale(a)) || a.name.localeCompare(b.name, 'ja'));
  $('#pList').innerHTML = list.length ? list.map(p => {
    const last = prevEntry(p.code), t = baseTargets(p);
    const prices = slotsOf(p).filter(s => p[s.k] > 0).map(s => {
      const m = last ? margin(p[s.k], last[s.cost]) : null;
      return `${s.lab} ${yen(p[s.k])}${m == null ? '' : ` <span class="${judge(m, t[s.kind])}">${pct(m)}</span>`}`;
    }).join('　');
    return `<div class="card tap" data-prod="${esc(p.code)}"><div class="top-line row"><b class="grow">${esc(p.name)}</b><span class="muted">${esc(p.kubun)}${p.rakuichi ? '・楽一 ' + esc(p.rakuichi) : ''}</span></div>
      <div class="muted">${prices || '売価なし（販売していない）'}</div>
      <div class="muted">${last ? `最新の仕入れ ${esc(last.d)}　1袋 ${yen(last.b)}` : '仕入れの記録なし'}</div></div>`;
  }).join('') : '<div class="empty">該当する商品がありません。「販売中」を押すと、すべての商品を表示します</div>';
}
function openProduct(code) {
  const p = code ? prod(code) : { code: '', name: '', kubun: '玄米', weight: 30, active: true, mainSup: '', rakuichi: '', tN: null, tB: null, note: '' };
  const supOpts = D.suppliers.slice().sort((a, b) => (b.last || '').localeCompare(a.last || '')).map(s => `<option value="${esc(s.id)}" ${p.mainSup === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const f = (k, lab) => `<div><label class="f">${lab}</label><div class="yen"><input class="t num" id="p_${k}" inputmode="numeric" value="${p[k] > 0 ? p[k] : ''}"></div></div>`;
  const pc = (k, lab) => `<div><label class="f">${lab}</label><div class="pct"><input class="t num" id="p_${k}" inputmode="decimal" value="${p[k] != null ? +(p[k] * 100).toFixed(1) : ''}" placeholder="${k === 'tN' ? Math.round(cfg().tN * 100) : '通常−' + Math.round(cfg().bDiff * 100)}"></div></div>`;
  openModal(`<h2>${code ? '商品を編集' : '新しい商品'}</h2>
    <label class="f">商品名</label><input class="t" id="p_name" value="${esc(p.name)}">
    <div class="row"><div><label class="f">区分</label><select class="t" id="p_kubun">${['玄米', '白米', '雑穀'].map(k => `<option ${p.kubun === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div><label class="f">1袋の重さ（kg）</label><input class="t num" id="p_weight" inputmode="decimal" value="${p.weight || ''}"></div></div>
    <label class="f">主な仕入先</label><select class="t" id="p_mainSup"><option value="">なし</option>${supOpts}</select>
    <label class="f">楽一コード</label><input class="t" id="p_rakuichi" value="${esc(p.rakuichi)}">
    <h2 style="margin-top:16px">売価（販売していない米は空欄）</h2>
    ${p.kubun === '玄米' || !code ? `<div class="row">${f('nb', '通常 玄米')}${f('nw', '通常 白米')}</div><div class="row">${f('bb', '業務用 玄米')}${f('bw', '業務用 白米')}</div>`
      : `<div class="row">${f('nw', '通常 白米')}${f('bw', '業務用 白米')}</div>`}
    <h2 style="margin-top:16px">目標利益率（空欄なら共通の値）</h2>
    <div class="row">${pc('tN', '通常')}${pc('tB', '業務用')}</div>
    <label class="f">説明</label><input class="t" id="p_note" value="${esc(p.note)}">
    <label class="radio"><input type="checkbox" id="p_active" ${p.active ? 'checked' : ''}>取扱中</label>
    <div class="actions"><button class="btn sub" data-act="close">戻る</button><button class="btn" id="okProd">保存する</button></div>`);
  $('#okProd').onclick = () => {
    const g = id => $('#p_' + id);
    const x = { code: p.code, name: g('name').value.trim(), kubun: g('kubun').value, weight: numIn(g('weight').value), mainSup: g('mainSup').value,
      rakuichi: g('rakuichi').value.trim(), note: g('note').value, active: g('active').checked };
    ['nb', 'nw', 'bb', 'bw'].forEach(k => { if (g(k)) x[k] = numIn(g(k).value) || 0; });
    ['tN', 'tB'].forEach(k => { const v = numIn(g(k).value); x[k] = v == null ? null : v / 100; });
    if (!x.name) { toast('商品名を入れてください', true); return; }
    run(async () => { await api('saveProduct', { product: x }); closeModal(); toast('保存しました'); render(); });
  };
}
function openNewSupplier() {
  openModal(`<h2>新しい仕入先</h2><label class="f">仕入先名</label><input class="t" id="s_name">
    <label class="f">請求書の表記</label><select class="t" id="s_tax"><option>税込</option><option>税抜</option></select>
    <div class="actions"><button class="btn sub" data-act="close">戻る</button><button class="btn" id="okSup">追加する</button></div>`);
  $('#okSup').onclick = () => {
    const name = $('#s_name').value.trim(), tax = $('#s_tax').value;
    if (!name) { toast('仕入先名を入れてください', true); return; }
    run(async () => { const r = await api('addSupplier', { supplier: { name, tax } }); closeModal(); C.sup = String(r.id); C.tax = tax; renderCalc(); toast(r.dup ? '同じ名前の仕入先がありました' : '追加しました'); });
  };
}

/* ---------------- モーダル・設定 ---------------- */
function openModal(html) { $('#modalBody').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' && !busy) closeModal(); });
$('#btnSettings').addEventListener('click', openSettings);
function openSettings() {
  openModal(`<h2>設定</h2>
    <label class="f">サーバーURL（Apps Script のウェブアプリURL）</label><input class="t" id="st_url" value="${esc(conf.apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec">
    <label class="f">合言葉</label><input class="t" id="st_pass" value="${esc(conf.pass || '')}" inputmode="numeric">
    <label class="f">あなたの名前（記録に残ります）</label><input class="t" id="st_name" value="${esc(conf.name || '')}">
    <p class="muted">最終バックアップ：${esc((D && D.lastBackup) || 'まだありません')}<br>バージョン ${VERSION}</p>
    <div class="actions"><button class="btn sub" data-act="close">閉じる</button><button class="btn" id="okSet">保存して読み込む</button></div>`);
  $('#okSet').onclick = () => {
    conf.apiUrl = $('#st_url').value.trim(); conf.pass = $('#st_pass').value.trim(); conf.name = $('#st_name').value.trim();
    LS.set('shiire-conf', { apiUrl: conf.apiUrl, pass: conf.pass, name: conf.name });
    closeModal(); reload();
  };
}

/* ---------------- 起動 ---------------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
render();
if (conf.apiUrl && conf.pass) reload(); else openSettings();
document.addEventListener('visibilitychange', () => { if (!document.hidden && conf.apiUrl && conf.pass && !busy && $('#modal').hidden) api('load').then(() => { if (tab !== 'calc') render(); else renderWarn(); }).catch(() => { }); });

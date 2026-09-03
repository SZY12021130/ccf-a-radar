/* ===== CCF-A 论文雷达 SPA ===== */
(function(){
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------- datasets ---------- */
const DATASETS = {
  'a-conf':    { prefix:'data/',   kind:'conf',    rank:'A', label:'CCF A 会议', hero:'CCF-A 会议论文雷达', unit:'会议', span:'2023.01–2026.07' },
  'b-conf':    { prefix:'data/b/', kind:'conf',    rank:'B', label:'CCF B 会议', hero:'CCF-B 会议论文雷达', unit:'会议', span:'2023.01–2026.07' },
  'a-journal': { prefix:'data/j/', kind:'journal', rank:'A', label:'CCF A 期刊', hero:'CCF-A 期刊论文雷达', unit:'期刊', span:'2023.01–2026.08' },
  'b-journal': { prefix:'data/bj/', kind:'journal', rank:'B', label:'CCF B 期刊', hero:'CCF-B 期刊论文雷达', unit:'期刊', span:'2025.01–2026.08' },
};

const S = {
  ds: localStorage.getItem('ccf-ds') || 'a-conf',
  index: null,          // {prefix}index.json
  confByAbbr: {},
  papersCache: {},      // abbr -> papers array
  gindex: null,         // lazy global index
  gindexLoading: null,
  charts: {},
  radar: { conf:null, topic:null, year:'', q:'', author:'', sort:'year-desc', page:1, pagesize:40 },
  overview: { field:'', sort:'count' },
  ddl: { field:'' },
  topic: { id:null, q:'', sort:'year-desc', page:1, pagesize:40 },
  ret: { stack: [], restore: null }, // 返回导航：来源页栈与待恢复的滚动位置
};
if (!DATASETS[S.ds]) S.ds = 'a-conf';
const DS = () => DATASETS[S.ds];
const isJournal = () => DS().kind === 'journal';
const isWip = () => !DS().prefix;
const dataPath = p => DS().prefix + p;

function resetDatasetState(){
  Object.values(S.charts).forEach(c => c && c.dispose());
  S.charts = {};
  S.index = null; S.confByAbbr = {}; S.papersCache = {};
  S.gindex = null; S.gindexLoading = null;
  S.radar = { conf:null, topic:null, year:'', q:'', author:'', sort:'year-desc', page:1, pagesize:S.radar.pagesize||40 };
  S.topic = { id:null, q:'', sort:'year-desc', page:1, pagesize:S.topic.pagesize||40 };
  S.overview = { field:'', sort:'count' };
  S.ddl = { field:'' };
}

function switchDataset(ds){
  if (!DATASETS[ds]) return;
  localStorage.setItem('ccf-ds', ds);
  if (ds === S.ds){ route(); return; }
  S.ds = ds;
  resetDatasetState();
  S.ret.stack = []; S.ret.restore = null; // 换数据集后来源页不再对应，清空返回栈
  syncDSUI();
  location.hash = '#/';
  route();
}

function syncDSUI(){
  $$('#ds-tabs button').forEach(b => b.classList.toggle('on', b.dataset.ds === S.ds));
  const d = DS();
  const gi = $('#gsearch-input');
  if (isWip()){
    $('#ds-note').textContent = d.label + '数据建设中，敬请期待';
    if (gi){ gi.disabled = true; gi.placeholder = d.label + '数据建设中…'; }
  } else {
    $('#ds-note').textContent = '';
    if (gi) gi.disabled = false;
  }
  // unit-aware nav labels
  const navRadar = $('[data-nav=radar]');
  if (navRadar) navRadar.textContent = d.unit + '雷达';
  const navDdl = $('[data-nav=ddl]');
  if (navDdl) navDdl.style.display = (d.kind === 'journal') ? 'none' : '';
  const picker = $('#conf-picker-input');
  if (picker) picker.placeholder = `输入${d.unit}名模糊搜索，如 ${d.kind==='journal' ? 'TPAMI、TSE、TOG…' : 'SIGMOD、安全、CV…'}`;
  document.title = (isWip() ? d.label + ' · 建设中' : d.hero) + ' · ' + (d.span || '');
}

function setupDSTabs(){
  $$('#ds-tabs button').forEach(b => b.onclick = () => switchDataset(b.dataset.ds));
  $$('.wip-actions .btn').forEach(b => b.onclick = () => switchDataset(b.dataset.goto));
  syncDSUI();
}

/* ---------- data ---------- */
async function loadIndex(){
  if (S.index) return S.index;
  const r = await fetch(dataPath('index.json'));
  if (!r.ok) throw new Error('dataset unavailable: ' + r.status);
  S.index = await r.json();
  S.index.confs.forEach(c => S.confByAbbr[c.abbr] = c);
  return S.index;
}
function showDataError(){
  ['#hot-topics','#conf-grid','#paper-list','#topic-list','#ddl-list'].forEach(sel=>{
    const el = $(sel);
    if (el) el.innerHTML = '<div class="loading">⚠️ 数据集加载失败或尚未发布，请切换其他分类或稍后再试。</div>';
  });
}
async function loadPapers(abbr){
  if (S.papersCache[abbr]) return S.papersCache[abbr];
  const c = S.confByAbbr[abbr];
  const r = await fetch(dataPath('papers/') + encodeURIComponent(c.file) + '.json');
  const p = await r.json();
  S.papersCache[abbr] = p;
  return p;
}
async function loadGIndex(){
  if (S.gindex) return S.gindex;
  if (S.gindexLoading) return S.gindexLoading;
  S.gindexLoading = fetch(dataPath('global_index.json')).then(r=>r.json()).then(g=>{ S.gindex=g; return g; });
  return S.gindexLoading;
}

/* ---------- fuzzy matching ---------- */
function fuzzyScore(query, text){
  // returns -1 if no match; higher = better
  const q = query.toLowerCase().trim();
  const t = (text||'').toLowerCase();
  if (!q) return 0;
  const sub = t.indexOf(q);
  if (sub === 0) return 1000 - t.length*0.01;
  if (sub > 0) return 500 - sub - t.length*0.01;
  // subsequence
  let qi = 0, score = 0, streak = 0;
  for (let ti=0; ti<t.length && qi<q.length; ti++){
    if (t[ti] === q[qi]){ qi++; streak++; score += 10 + streak*2; }
    else streak = 0;
  }
  if (qi < q.length) return -1;
  return score - t.length*0.05;
}
function highlight(text, q){
  const t = esc(text);
  q = q.trim();
  if (!q) return t;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t;
  return esc(text.slice(0,i)) + '<mark>' + esc(text.slice(i, i+q.length)) + '</mark>' + esc(text.slice(i+q.length));
}

/* ---------- charts ---------- */
function chart(id){
  if (S.charts[id]) { S.charts[id].dispose(); }
  const el = document.getElementById(id);
  if (!el) return null;
  const c = echarts.init(el, null, {renderer:'canvas'});
  S.charts[id] = c;
  return c;
}
const FIELD_COLORS = ['#5b8cff','#38d9a9','#ffd166','#ff6b9d','#b197fc','#63e6be','#74c0fc','#ffa94d','#e599f7','#a9e34b'];
const fieldsOf = idx => { const f=[]; idx.confs.forEach(c=>{ if(!f.includes(c.field)) f.push(c.field); }); return f; };
function fieldColor(f){
  if (!S.index) return FIELD_COLORS[0];
  const i = fieldsOf(S.index).indexOf(f);
  return FIELD_COLORS[(i<0?0:i)%FIELD_COLORS.length];
}
function hexA(hex, a){
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}
function countUp(el, target, dur=900){
  if (!el) return;
  const t0 = performance.now();
  const step = t=>{
    const p = Math.min(1, (t-t0)/dur);
    const e = 1-Math.pow(1-p, 3);
    el.textContent = Math.round(target*e).toLocaleString();
    if (p<1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function topicName(id){
  const t = S.index.topics.find(t=>t.id===id);
  return t ? t.name : '主题 '+id;
}

/* ---------- router ---------- */
async function route(){
  const h = location.hash || '#/';
  // 无效路由直接重定向，不记入返回栈
  const valid = h === '#/' || h === '#' || /^#\/radar(\?.*)?$/.test(h) || /^#\/topic\/\d+$/.test(h) || h === '#/ddl' || isWip();
  if (!valid){ S.ret.skipPush = true; location.hash = '#/'; return; }
  // 返回导航：跳转前记录来源页与滚动位置
  if (!S.ret.skipPush && S.ret.cur != null && S.ret.cur !== h){
    S.ret.stack.push({ hash: S.ret.cur, y: window.scrollY });
    if (S.ret.stack.length > 30) S.ret.stack.shift();
  }
  S.ret.skipPush = false;
  S.ret.cur = h;
  $$('.view').forEach(v=>v.classList.add('hidden'));
  $$('.nav a').forEach(a=>a.classList.remove('on'));
  if (isWip()){
    $('#wip-title').textContent = DS().label + ' · 数据建设中';
    $('#view-wip').classList.remove('hidden');
    S.ret.restore = null;
    window.scrollTo({top:0});
    return;
  }
  let m;
  if (h === '#/' || h === '#') {
    $('#view-overview').classList.remove('hidden');
    $('[data-nav=overview]').classList.add('on');
    await renderOverview().catch(showDataError);
  } else if (m = h.match(/^#\/radar(?:\?(.*))?$/)) {
    $('#view-radar').classList.remove('hidden');
    $('[data-nav=radar]').classList.add('on');
    const params = new URLSearchParams(m[1] || '');
    await renderRadar(params.get('c'), params.get('q')).catch(showDataError);
  } else if (m = h.match(/^#\/topic\/(\d+)$/)) {
    $('#view-topic').classList.remove('hidden');
    await renderTopic(+m[1]).catch(showDataError);
  } else if (h === '#/ddl') {
    $('#view-ddl').classList.remove('hidden');
    $('[data-nav=ddl]').classList.add('on');
    await renderDDL().catch(showDataError);
  } else {
    location.hash = '#/';
  }
  // 返回导航时恢复来源页滚动位置，其余情况回到顶部
  const restore = S.ret.restore;
  S.ret.restore = null;
  if (restore != null) window.scrollTo({ top: restore, behavior: 'instant' });
  else window.scrollTo({ top: 0 });
  syncBackBtns();
}
window.addEventListener('hashchange', route);

/** 根据返回栈更新返回按钮文案（有来源显示“返回”，否则“返回总览”） */
function syncBackBtns(){
  const label = S.ret.stack.length ? '← 返回' : '← 返回总览';
  $$('.back-btn').forEach(b=>b.textContent = label);
}

/** 返回上一页（优先恢复来源页与其滚动位置，无来源时回总览顶部） */
function goBack(){
  const top = S.ret.stack.pop();
  const target = (top && top.hash) ? top.hash : '#/';
  S.ret.restore = top ? (top.y || 0) : null;
  S.ret.skipPush = true;
  if ((location.hash || '#/') === target) route();
  else location.hash = target;
}

/* ---------- overview ---------- */
async function renderOverview(){
  const idx = await loadIndex();
  const d = DS();
  const nConf = idx.confs.length;
  $('#hero-title').textContent = d.hero;
  $('#stat-confs').textContent = nConf;
  $('#stat-rank').textContent = d.rank;
  $('#stat-unit').textContent = d.unit;
  const u2 = $('#stat-unit2'); if (u2) u2.textContent = d.unit;
  const htn = $('#hot-topics-note'); if (htn) htn.textContent = `按 ${Object.keys(idx.yearTotals).join('–')} 论文总量排序 · 点击主题查看论文`;
  $('#stat-papers').textContent = idx.total.toLocaleString();
  $('#stat-span').textContent = d.span || '2023.01 – 2026.07';
  $('#conf-panel-title').textContent = `🏛️ ${nConf} 个 CCF-${d.rank} ${d.unit}`;
  const gi = $('#gsearch-input');
  if (gi) gi.placeholder = `全局模糊检索 ${idx.total.toLocaleString()} 篇论文…  ( / )`;
  // hero stats
  const yrs = idx.yearTotals;
  const years = Object.keys(yrs).sort();
  $('#hero-stats').innerHTML =
    statHtml(0, `CCF-${d.rank} ${d.unit}`) +
    statHtml(0, '收录论文') +
    statHtml(0, '研究主题') +
    statHtml(years[0].slice(2) + '–' + years[years.length-1].slice(2), '年份跨度');
  const statSpans = $$('#hero-stats .stat .v span');
  countUp(statSpans[0], nConf); countUp(statSpans[1], idx.total, 1300); countUp(statSpans[2], idx.topics.length);
  // hero chart: stacked by field
  const fields = fieldsOf(idx);
  const hc = chart('chart-global-trend');
  if (hc) hc.setOption({
    backgroundColor:'transparent',
    title:{text:'各年度论文总量（按领域）',textStyle:{color:'#93a0c4',fontSize:12},left:10,top:6},
    tooltip:{trigger:'axis',confine:true,backgroundColor:'#182244',borderColor:'#26325c',
      textStyle:{color:'#e8ecf8',fontSize:12},appendToBody:true,
      valueFormatter:v=>Number(v).toLocaleString()+' 篇'},
    grid:{left:52,right:16,top:42,bottom:52},
    xAxis:{type:'category',data:years,axisLine:{lineStyle:{color:'#3a4a7d'}},axisLabel:{color:'#93a0c4',fontWeight:600}},
    yAxis:{type:'value',splitLine:{lineStyle:{color:'#1d2749'}},axisLabel:{color:'#66739b',formatter:v=>(v/1000)+'k'}},
    series: fields.map((f,i)=>({
      name:f,type:'bar',stack:'a',barWidth:'42%',
      itemStyle:{color:FIELD_COLORS[i%10],borderRadius:i===fields.length-1?[3,3,0,0]:0},
      emphasis:{focus:'series'},
      data: years.map(y=>{
        let n=0; idx.confs.forEach(c=>{ if(c.field===f && c.years[y]) n+=c.years[y]; }); return n;
      })
    })).concat([{
      name:'年度总量',type:'line',data:years.map(y=>yrs[y]),z:10,
      symbol:'circle',symbolSize:7,lineStyle:{color:'#fff',width:2,type:'dashed'},
      itemStyle:{color:'#fff'},label:{show:true,position:'top',color:'#fff',fontWeight:700,fontSize:12,
        formatter:p=>Number(p.value).toLocaleString()}
    }]),
    legend:{type:'scroll',bottom:0,icon:'roundRect',itemWidth:10,itemHeight:10,
      textStyle:{color:'#93a0c4',fontSize:10.5},pageTextStyle:{color:'#93a0c4'}},
    animationDuration:800, animationEasing:'cubicOut'
  });

  // hot topics
  const maxC = Math.max(...idx.topics.map(t=>t.count));
  $('#hot-topics').innerHTML = idx.topics.filter(t=>t.id!==29).slice(0,12).map((t,i)=>`
    <div class="hot" onclick="location.hash='#/topic/${t.id}'">
      <div class="rk">${i+1}</div>
      <div class="inf">
        <div class="nm" title="${esc(t.name)}">${esc(t.name)}</div>
        <div class="bar"><i style="width:${(t.count/maxC*100).toFixed(1)}%"></i></div>
      </div>
      <div class="ct">${t.count.toLocaleString()}</div>
    </div>`).join('');

  // field chips
  const allFields = [''].concat(fields);
  $('#field-chips').innerHTML = allFields.map(f=>{
    const dot = f ? `<i class="dot" style="background:${fieldColor(f)}"></i>` : '';
    return `<span class="chip ${S.overview.field===f?'on':''}" data-f="${esc(f)}">${dot}${f||'全部领域'}</span>`;
  }).join('');
  $$('#field-chips .chip').forEach(ch=>ch.onclick=()=>{ S.overview.field=ch.dataset.f; renderConfGrid(); renderOverviewChipsOnly(); });
  $('#conf-sort').value = S.overview.sort;
  $('#conf-sort').onchange = e=>{ S.overview.sort=e.target.value; renderConfGrid(); };
  renderConfGrid();
}
function renderOverviewChipsOnly(){
  $$('#field-chips .chip').forEach(ch=>ch.classList.toggle('on', ch.dataset.f===S.overview.field));
}
function statHtml(v,k){ return `<div class="stat"><div class="v"><span>${v}</span></div><div class="k">${k}</div></div>`; }

function renderConfGrid(){
  const idx = S.index;
  let list = idx.confs.slice();
  if (S.overview.field) list = list.filter(c=>c.field===S.overview.field);
  if (S.overview.sort==='count') list.sort((a,b)=>b.count-a.count);
  else if (S.overview.sort==='name') list.sort((a,b)=>a.abbr.localeCompare(b.abbr));
  else list.sort((a,b)=>a.field.localeCompare(b.field)||b.count-a.count);
  const years = Object.keys(idx.yearTotals).sort();
  $('#conf-grid').innerHTML = list.map(c=>{
    const maxY = Math.max(...years.map(y=>c.years[y]||0), 1);
    const spark = years.map(y=>`<i style="height:${((c.years[y]||0)/maxY*100).toFixed(0)}%" title="${y}: ${c.years[y]||0}"></i>`).join('');
    const top3 = c.topics.filter(t=>t.id!==29).slice(0,3).map(t=>`<span class="ttag" title="${esc(topicName(t.id))}">${esc(topicName(t.id))}</span>`).join('');
    const fc = fieldColor(c.field);
    return `<div class="conf-card" style="--fc:${fc}" onclick="location.hash='#/radar?c=${encodeURIComponent(c.abbr)}'">
      <span class="ftag" style="color:${fc};background:${hexA(fc,.12)};border-color:${hexA(fc,.45)}">${esc(c.field.split('/')[0])}</span>
      <div class="abbr">${esc(c.abbr)}</div>
      <div class="fname">${esc(c.name)}</div>
      <div class="row">
        <div class="cnt"><b>${c.count.toLocaleString()}</b> 篇</div>
        <div class="spark">${spark}</div>
      </div>
      <div class="ttags">${top3}</div>
    </div>`;
  }).join('');
}

/* ---------- radar (conference detail) ---------- */
async function renderRadar(abbr, q){
  const idx = await loadIndex();
  setupConfPicker();
  if (!abbr) abbr = S.radar.conf || idx.confs.slice().sort((a,b)=>b.count-a.count)[0].abbr;
  if (!S.confByAbbr[abbr]) abbr = idx.confs[0].abbr;
  if (S.radar.conf !== abbr){
    S.radar = { conf:abbr, topic:null, year:'', q:'', author:'', sort:'year-desc', page:1, pagesize:S.radar.pagesize||40 };
    $('#paper-search').value=''; $('#paper-author').value=''; $('#paper-year').value=''; $('#paper-sort').value='year-desc';
  }
  if (q){ S.radar.q = q; S.radar.page = 1; $('#paper-search').value = q; }
  const c = S.confByAbbr[abbr];
  $('#conf-picker-input').value = c.abbr;
  $('#radar-conf-info').innerHTML = `
    <h1>${esc(c.abbr)} <span style="font-size:14px;color:var(--gold)">CCF-${DS().rank}</span>
      <a class="lnk" href="${esc(c.dblp)}" target="_blank" rel="noopener">DBLP ↗</a></h1>
    <div class="full">${esc(c.name)} · ${esc(c.field)}</div>`;
  setupPaperTools(c);
  await drawRadarCharts(c);
  renderDDLCrad(c);
  await renderPaperList();
}

function setupConfPicker(){
  const inp = $('#conf-picker-input'), drop = $('#conf-picker-drop');
  inp.onfocus = inp.oninput = ()=>{
    const q = inp.value.trim();
    const idx = S.index;
    let list;
    if (!q) list = idx.confs.slice(0, 60);
    else {
      list = idx.confs.map(c=>({c, s: Math.max(fuzzyScore(q,c.abbr), fuzzyScore(q,c.name), fuzzyScore(q,c.field))}))
        .filter(x=>x.s>=0).sort((a,b)=>b.s-a.s).slice(0,40).map(x=>x.c);
    }
    drop.innerHTML = list.map(c=>`<div class="cp-item" data-a="${esc(c.abbr)}">
      <b>${highlight(c.abbr,q)}</b><span>${esc(c.name)}</span></div>`).join('')
      || '<div class="gs-more">无匹配会议</div>';
    drop.classList.add('show');
    $$('.cp-item').forEach(it=>it.onmousedown=()=>{
      drop.classList.remove('show');
      location.hash = '#/radar?c=' + encodeURIComponent(it.dataset.a);
    });
  };
  inp.onblur = ()=> setTimeout(()=>drop.classList.remove('show'), 150);
}

async function drawRadarCharts(c){
  const papers = await loadPapers(c.abbr);
  // topic distribution (from papers, ensures consistency with filter)
  const dist = {};
  papers.forEach(p=>{ if(p.k!=null) dist[p.k]=(dist[p.k]||0)+1; });
  const OTHER_TOPIC = 29;
  const tops = Object.entries(dist).map(([id,n])=>({id:+id,n})).sort((a,b)=>b.n-a.n);
  const named = tops.filter(x=>x.id!==OTHER_TOPIC);
  const axes = named.slice(0,8);
  const top8ids = new Set(axes.map(a=>a.id));
  const otherN = tops.filter(x=>!top8ids.has(x.id)).reduce((s,x)=>s+x.n,0);
  if (otherN>0) axes.push({id:-1, n:otherN});
  const rc = chart('chart-radar');
  const maxN = Math.max(...axes.map(a=>a.n));
  if (rc){
    rc.setOption({
      backgroundColor:'transparent',
      tooltip:{backgroundColor:'#182244',borderColor:'#26325c',textStyle:{color:'#e8ecf8'}},
      radar:{
        indicator: axes.map(a=>({name: a.id===-1?'其余主题':topicName(a.id), max: Math.ceil(maxN*1.15)})),
        radius:'68%', center:['50%','52%'], splitNumber:4,
        axisName:{color:'#9db4ff',fontSize:12},
        splitLine:{lineStyle:{color:'#2a3866'}},
        splitArea:{areaStyle:{color:['#141d3855','#18224455']}},
        axisLine:{lineStyle:{color:'#2a3866'}},
      },
      series:[{
        type:'radar',
        data:[{value:axes.map(a=>a.n), name:'论文数',
          areaStyle:{color:'#5b8cff44'}, lineStyle:{color:'#5b8cff',width:2},
          itemStyle:{color:'#38d9a9'}, symbolSize:6}],
      }]
    });
    rc.off('click');
    rc.on('click', ev=>{
      // clicking near a vertex: use name
      if (ev.name){ /* series click */ }
    });
  }
  // topic chips
  $('#topic-chips').innerHTML =
    `<span class="chip ${S.radar.topic===null?'on':''}" data-t="">全部主题</span>` +
    axes.map(a=>`<span class="chip ${S.radar.topic===a.id?'on':''}" data-t="${a.id}" title="${a.n} 篇">${a.id===-1?'其余主题':esc(topicName(a.id))} · ${a.n}</span>`).join('');
  $$('#topic-chips .chip').forEach(ch=>ch.onclick=()=>{
    S.radar.topic = ch.dataset.t===''?null:+ch.dataset.t;
    S.radar.page = 1;
    $$('#topic-chips .chip').forEach(x=>x.classList.toggle('on', x===ch));
    renderPaperList();
  });

  // year trend
  const years = Object.keys(c.years).sort();
  const yc = chart('chart-year');
  if (yc) yc.setOption({
    backgroundColor:'transparent',
    tooltip:{trigger:'axis',backgroundColor:'#182244',borderColor:'#26325c',textStyle:{color:'#e8ecf8'}},
    grid:{left:44,right:16,top:26,bottom:24},
    xAxis:{type:'category',data:years,axisLabel:{color:'#93a0c4'},axisLine:{lineStyle:{color:'#3a4a7d'}}},
    yAxis:{type:'value',splitLine:{lineStyle:{color:'#1d2749'}},axisLabel:{color:'#66739b'}},
    series:[{type:'bar',data:years.map(y=>c.years[y]),barWidth:'50%',
      itemStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'#38d9a9'},{offset:1,color:'#1b7f66'}]},borderRadius:[4,4,0,0]},
      label:{show:true,position:'top',color:'#93a0c4',fontSize:11}}]
  });
}

function renderDDLCrad(c){
  const el = $('#ddl-card');
  const d = c.ddl;
  if (DS().kind === 'journal'){
    el.innerHTML = `<div class="panel-head"><h2>📖 出版信息</h2></div>
      <div class="ddl-t">${esc(c.abbr)}</div>
      <div class="ddl-row"><span>出版模式</span><b>滚动出版 · 无截稿时间</b></div>
      <div class="ddl-row"><span>收录区间</span><b>${esc(DS().span || '')}</b></div>
      <div style="margin-top:12px"><a href="${esc(c.dblp)}" target="_blank" rel="noopener">DBLP 期刊主页 ↗</a></div>`;
    return;
  }
  if (!d){ el.innerHTML = '<div class="panel-head"><h2>⏰ 截稿时间</h2></div><p class="dim">暂无数据</p>'; return; }
  const ddlDate = parseDDL(d.deadline, d.tz);
  const now = new Date();
  const days = ddlDate ? Math.ceil((ddlDate - now)/86400000) : null;
  let cd = '';
  if (days!==null){
    if (days < 0) cd = `<span class="countdown over">已截止 ${-days} 天</span>`;
    else if (days <= 30) cd = `<span class="countdown soon">⏳ 仅剩 ${days} 天</span>`;
    else cd = `<span class="countdown ok">还有 ${days} 天</span>`;
  }
  el.innerHTML = `
    <div class="panel-head"><h2>⏰ ${esc(c.abbr)} ${d.year} 截稿</h2></div>
    <div class="ddl-t">${esc(d.abbr_ddl||c.abbr)} ${d.year}</div>
    <div class="ddl-row"><span>截稿日期</span><b>${esc(fmtDDL(d.deadline))} ${esc(d.tz||'')}</b></div>
    <div class="ddl-row"><span>会议时间</span><b>${esc(d.date||'TBD')}</b></div>
    <div class="ddl-row"><span>会议地点</span><b>${esc(d.place||'TBD')}</b></div>
    ${cd}
    <div style="margin-top:12px"><a href="${esc(d.link)}" target="_blank" rel="noopener">官方页面 ↗</a>
      <a style="margin-left:12px" href="#/ddl">全部截稿日历 →</a></div>`;
}

function parseDDL(str, tz){
  if (!str) return null;
  const m = String(str).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  let off = -12;
  const tm = String(tz||'').match(/UTC([+-]?\d+)/i);
  if (tm) off = +tm[1];
  return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4]-off, +m[5]));
}
function fmtDDL(str){
  const m = String(str||'').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : (str||'');
}

/* ---------- paper browser (per conference) ---------- */
function setupPaperTools(c){
  // year options
  const years = Object.keys(c.years).sort().reverse();
  $('#paper-year').innerHTML = '<option value="">全部年份</option>' + years.map(y=>`<option value="${y}">${y}</option>`).join('');
  $('#paper-year').value = S.radar.year;
  let deb;
  $('#paper-search').oninput = e=>{
    clearTimeout(deb);
    deb = setTimeout(()=>{ S.radar.q = e.target.value; S.radar.page=1; renderPaperList(); }, 200);
  };
  $('#paper-author').oninput = e=>{
    clearTimeout(deb);
    deb = setTimeout(()=>{ S.radar.author = e.target.value; S.radar.page=1; renderPaperList(); }, 200);
  };
  $('#paper-year').onchange = e=>{ S.radar.year = e.target.value; S.radar.page=1; renderPaperList(); };
  $('#paper-sort').onchange = e=>{ S.radar.sort = e.target.value; S.radar.page=1; renderPaperList(); };
  $('#paper-pagesize').value = S.radar.pagesize;
  $('#paper-pagesize').onchange = e=>{ S.radar.pagesize = +e.target.value; S.radar.page=1; renderPaperList(); };
}

async function renderPaperList(){
  const c = S.confByAbbr[S.radar.conf];
  const papers = await loadPapers(c.abbr);
  let list = papers;
  if (S.radar.topic === -1){
    const dist2 = {};
    papers.forEach(p=>{ if(p.k!=null) dist2[p.k]=(dist2[p.k]||0)+1; });
    const top8 = new Set(Object.entries(dist2).map(([id,n])=>[+id,n]).filter(x=>x[0]!==29).sort((a,b)=>b[1]-a[1]).slice(0,8).map(x=>x[0]));
    list = list.filter(p=>!top8.has(p.k));
  } else if (S.radar.topic !== null){
    list = list.filter(p=>p.k === S.radar.topic);
  }
  if (S.radar.year) list = list.filter(p=>String(p.y)===S.radar.year);
  // 标题包含匹配（不命中即不显示）
  if (S.radar.q.trim()){
    const q = S.radar.q.trim().toLowerCase();
    list = list.filter(p=>p.t.toLowerCase().includes(q));
  }
  // 作者包含匹配（不命中即不显示）
  if (S.radar.author.trim()){
    const qa = S.radar.author.trim().toLowerCase();
    list = list.filter(p=>(p.a||[]).some(a=>a.toLowerCase().includes(qa)));
  }
  list = list.slice();
  if (S.radar.sort==='year-desc') list.sort((a,b)=>(b.y-a.y)||a.t.localeCompare(b.t));
  else if (S.radar.sort==='year-asc') list.sort((a,b)=>(a.y-b.y)||a.t.localeCompare(b.t));
  else list.sort((a,b)=>a.t.localeCompare(b.t));
  $('#paper-count').textContent = list.length.toLocaleString() + ' 篇';
  renderPaged(list, $('#paper-list'), $('#pager'), S.radar, (p,i)=>paperHtml(p,i));
}

function topTopicIds(c, n){
  return new Set(c.topics.slice(0,n).map(t=>t.id));
}

function paperHtml(p, i){
  const q = S.radar.q, qa = S.radar.author;
  let au = (p.a||[]).slice(0,6).join(', ') + ((p.a||[]).length>6 ? ' et al.' : '');
  if (qa) au = highlight(au, qa);
  else au = esc(au);
  const ti = q ? highlight(p.t, q) : esc(p.t);
  const link = p.u ? `<a href="${esc(p.u)}" target="_blank" rel="noopener">${ti} ↗</a>` : `<span class="no-link">${ti}</span>`;
  const tp = p.k!=null ? `<span class="tp" title="${esc(topicName(p.k))}">${esc(topicName(p.k))}</span>` : '';
  return `<div class="paper fade-in" style="animation-delay:${Math.min(i||0,20)*22}ms">
    <span class="yr">${p.y||'—'}</span>
    <div class="body"><div class="ti">${link}</div><div class="au">${au}</div></div>
    ${tp}
  </div>`;
}

function renderPaged(list, listEl, pagerEl, state, htmlFn){
  const per = state.pagesize || 40;
  const pages = Math.max(1, Math.ceil(list.length/per));
  if (state.page > pages) state.page = pages;
  const start = (state.page-1)*per;
  listEl.innerHTML = list.slice(start, start+per).map((it,i)=>htmlFn(it,i)).join('')
    || '<div class="loading">😕 没有符合条件的论文，请调整检索词或筛选条件</div>';
  if (pages <= 1){ pagerEl.innerHTML=''; return; }
  const cur = state.page;
  let btns = [];
  const push = p => btns.push(`<button data-p="${p}" class="${p===cur?'on':''}">${p}</button>`);
  push(1);
  let lo = Math.max(2, cur-2), hi = Math.min(pages-1, cur+2);
  if (lo > 2) btns.push('<button disabled>…</button>');
  for (let p=lo;p<=hi;p++) push(p);
  if (hi < pages-1) btns.push('<button disabled>…</button>');
  if (pages>1) push(pages);
  pagerEl.innerHTML = btns.join('');
  $$('#pager button[data-p]').forEach(b=>b.onclick=()=>{
    state.page = +b.dataset.p;
    if (state === S.radar) renderPaperList();
    else if (state === S.topic) renderTopicPapers();
    listEl.scrollIntoView({behavior:'smooth', block:'start'});
  });
}

/* ---------- global search ---------- */
function setupGlobalSearch(){
  const inp = $('#gsearch-input'), drop = $('#gsearch-drop');
  let deb;
  inp.addEventListener('focus', ()=>{ loadGIndex(); });
  inp.addEventListener('input', ()=>{
    clearTimeout(deb);
    deb = setTimeout(async ()=>{
      const q = inp.value.trim();
      if (q.length < 2){ drop.classList.remove('show'); return; }
      drop.innerHTML = '<div class="gs-more">检索中…（首次全局检索需加载索引）</div>';
      drop.classList.add('show');
      const g = await loadGIndex();
      const ql = q.toLowerCase();
      const scored = [];
      for (const it of g.p){
        const tl = it[0].toLowerCase();
        let s;
        if (tl.includes(ql)) s = 10000 + (tl.startsWith(ql)?500:0) - it[0].length*0.01;  // 包含匹配优先
        else { s = fuzzyScore(q, it[0]); if (s < 0) continue; }                          // 子序列模糊兜底
        scored.push([s, it]);
        if (scored.length > 6000) break;
      }
      scored.sort((a,b)=>b[0]-a[0]);
      // 按会议分组
      const groups = new Map();
      for (const [s, it] of scored){
        const conf = g.c[it[1]];
        if (!groups.has(conf)) groups.set(conf, []);
        groups.get(conf).push([s, it]);
      }
      const confKeys = [...groups.entries()].sort((a,b)=>b[1].length-a[1].length).slice(0,10).map(e=>e[0]);
      let html = '';
      for (const conf of confKeys){
        const items = groups.get(conf);
        html += `<div class="gs-group" data-c="${esc(conf)}" data-q="${esc(q)}">
          <span class="gs-gname">${esc(conf)}</span>
          <span class="gs-gcnt">${items.length.toLocaleString()} 条 · 进入该${DS().unit}检索 →</span>
        </div>`;
        for (const [s, it] of items.slice(0, 5)){
          html += `<div class="gs-item" data-u="${esc(it[4]||'')}" data-c="${esc(conf)}">
            <div class="t">${highlight(it[0], q)}</div>
            <div class="m"><b>${esc(conf)}</b> · ${it[2]} · ${esc(topicName(it[3]))}</div>
          </div>`;
        }
      }
      drop.innerHTML = (html || '<div class="gs-more">😕 无匹配论文</div>')
        + `<div class="gs-more">共 ${scored.length.toLocaleString()} 条匹配 · 命中 ${groups.size} 个${DS().unit} · 点条目访问原文，点分组进${DS().unit}检索</div>`;
      $$('.gs-item').forEach(el=>el.onmousedown=()=>{
        if (el.dataset.u) window.open(el.dataset.u, '_blank');
        else location.hash = '#/radar?c=' + encodeURIComponent(el.dataset.c);
      });
      $$('.gs-group').forEach(el=>el.onmousedown=()=>{
        location.hash = '#/radar?c=' + encodeURIComponent(el.dataset.c) + '&q=' + encodeURIComponent(el.dataset.q);
      });
    }, 250);
  });
  inp.addEventListener('blur', ()=> setTimeout(()=>drop.classList.remove('show'), 200));
  document.addEventListener('keydown', e=>{
    if (e.key === '/' && document.activeElement !== inp && !/input|textarea/i.test(document.activeElement.tagName)){
      e.preventDefault(); inp.focus();
    }
  });
}

/* ---------- topic view ---------- */
async function renderTopic(id){
  await loadIndex();
  S.topic.id = id; S.topic.page = 1; S.topic.q = '';
  $('#topic-title').textContent = topicName(id);
  const t = S.index.topics.find(t=>t.id===id);
  $('#topic-desc').innerHTML = t ? `共 <b style="color:var(--acc2)">${t.count.toLocaleString()}</b> 篇 · 关键词：${t.terms.map(esc).join(' / ')}` : '';
  // per-conference distribution bar
  const dist = [];
  S.index.confs.forEach(c=>{
    const f = c.topics.find(x=>x.id===id);
    if (f) dist.push([c.abbr, f.count]);
  });
  dist.sort((a,b)=>b[1]-a[1]);
  const tc = chart('chart-topic-conf');
  if (tc) tc.setOption({
    backgroundColor:'transparent',
    tooltip:{backgroundColor:'#182244',borderColor:'#26325c',textStyle:{color:'#e8ecf8'}},
    grid:{left:90,right:30,top:10,bottom:24},
    xAxis:{type:'value',splitLine:{lineStyle:{color:'#1d2749'}},axisLabel:{color:'#66739b'}},
    yAxis:{type:'category',data:dist.slice(0,15).map(d=>d[0]).reverse(),axisLabel:{color:'#9db4ff'}},
    series:[{type:'bar',data:dist.slice(0,15).map(d=>d[1]).reverse(),barWidth:'55%',
      itemStyle:{color:{type:'linear',x:0,y:0,x2:1,y2:0,colorStops:[{offset:0,color:'#3553b8'},{offset:1,color:'#5b8cff'}]},borderRadius:[0,4,4,0]}}]
  });
  let deb;
  $('#topic-search').oninput = e=>{ clearTimeout(deb); deb=setTimeout(()=>{ S.topic.q=e.target.value; S.topic.page=1; renderTopicPapers(); },200); };
  $('#topic-sort').onchange = e=>{ S.topic.sort=e.target.value; S.topic.page=1; renderTopicPapers(); };
  $('#topic-pagesize').value = S.topic.pagesize;
  $('#topic-pagesize').onchange = e=>{ S.topic.pagesize=+e.target.value; S.topic.page=1; renderTopicPapers(); };
  await renderTopicPapers();
}

async function renderTopicPapers(){
  const g = await loadGIndex();
  const id = S.topic.id;
  let list = g.p.filter(it=>it[3]===id);
  if (S.topic.q.trim()){
    const q = S.topic.q.trim().toLowerCase();
    list = list.filter(it=>it[0].toLowerCase().includes(q));
  }
  list = list.slice();
  if (S.topic.sort==='year-desc') list.sort((a,b)=>b[2]-a[2]||a[0].localeCompare(b[0]));
  else if (S.topic.sort==='year-asc') list.sort((a,b)=>a[2]-b[2]||a[0].localeCompare(b[0]));
  else list.sort((a,b)=>a[0].localeCompare(b[0]));
  $('#topic-count').textContent = list.length.toLocaleString() + ' 篇';
  renderPaged(list, $('#topic-list'), $('#topic-pager'), S.topic, (it,i)=>{
    const conf = g.c[it[1]];
    const ti = S.topic.q ? highlight(it[0], S.topic.q) : esc(it[0]);
    const link = it[4] ? `<a href="${esc(it[4])}" target="_blank" rel="noopener">${ti} ↗</a>` : `<span class="no-link">${ti}</span>`;
    return `<div class="paper fade-in" style="animation-delay:${Math.min(i||0,20)*22}ms">
      <span class="yr">${it[2]||'—'}</span>
      <div class="body"><div class="ti">${link}</div></div>
      <span class="tp" style="color:var(--acc);background:#5b8cff12;cursor:pointer"
        onclick="location.hash='#/radar?c=${encodeURIComponent(conf)}'">${esc(conf)}</span>
    </div>`;
  });
}

/* ---------- DDL calendar ---------- */
async function renderDDL(){
  const idx = await loadIndex();
  if (DS().kind === 'journal'){
    $('#ddl-title').textContent = `📖 CCF-${DS().rank} 期刊出版说明`;
    $('#ddl-field-chips').innerHTML = '';
    $('#ddl-list').innerHTML = '<div class="loading">期刊为滚动出版，无固定截稿时间。请切换到「会议」分类查看会议截稿日历。</div>';
    return;
  }
  $('#ddl-title').textContent = `⏰ CCF-${DS().rank} 会议截稿日历`;
  const fields = [''].concat(fieldsOf(idx));
  $('#ddl-field-chips').innerHTML = fields.map(f=>{
    const dot = f ? `<i class="dot" style="background:${fieldColor(f)}"></i>` : '';
    return `<span class="chip ${S.ddl.field===f?'on':''}" data-f="${esc(f)}">${dot}${f||'全部领域'}</span>`;
  }).join('');
  $$('#ddl-field-chips .chip').forEach(ch=>ch.onclick=()=>{
    S.ddl.field = ch.dataset.f;
    $$('#ddl-field-chips .chip').forEach(x=>x.classList.toggle('on', x===ch));
    drawDDLList();
  });
  drawDDLList();
}
function drawDDLList(){
  const now = new Date();
  let rows = [];
  S.index.confs.forEach(c=>{
    if (!c.ddl) return;
    if (S.ddl.field && c.field !== S.ddl.field) return;
    const dt = parseDDL(c.ddl.deadline, c.ddl.tz);
    rows.push({c, dt});
  });
  rows.sort((a,b)=>{
    const af = a.dt && a.dt >= now, bf = b.dt && b.dt >= now;
    if (af !== bf) return af ? -1 : 1;
    return (a.dt||0) - (b.dt||0);
  });
  $('#ddl-list').innerHTML = rows.map(({c, dt})=>{
    const d = c.ddl;
    const days = dt ? Math.ceil((dt-now)/86400000) : null;
    let cd;
    if (days===null) cd = '<span class="countdown over">TBD</span>';
    else if (days < 0) cd = `<span class="countdown over">已截止</span>`;
    else if (days <= 30) cd = `<span class="countdown soon">⏳ ${days} 天</span>`;
    else cd = `<span class="countdown ok">${days} 天</span>`;
    const fc = fieldColor(c.field);
    return `<div class="ddl-item" style="border-left:3px solid ${hexA(fc,.6)}">
      <div class="d-date">${esc(fmtDDL(d.deadline))}<small>${esc(d.tz||'')} · ${d.year} 届</small></div>
      <div class="d-conf">
        <b><a href="#/radar?c=${encodeURIComponent(c.abbr)}" style="color:#fff">${esc(c.abbr)}</a></b>
        <span>${esc(d.date||'TBD')} · ${esc(d.place||'')}</span>
        <div class="d-info">${esc(c.name)}</div>
      </div>
      <div class="d-act">${cd}<div style="margin-top:6px;font-size:12px"><a href="${esc(d.link)}" target="_blank" rel="noopener">官网 ↗</a></div></div>
    </div>`;
  }).join('') || '<div class="loading">暂无数据</div>';
}

/* ---------- boot ---------- */
(async function(){
  setupDSTabs();
  $$('.back-btn').forEach(b=>b.onclick = goBack);
  if (!isJournal()) await loadIndex();
  setupGlobalSearch();
  route();
  window.addEventListener('resize', ()=>Object.values(S.charts).forEach(c=>c&&c.resize()));
})();
})();

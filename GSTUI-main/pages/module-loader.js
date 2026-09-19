/* GSTUI modular page loader - stable, cache-safe asset loading. */
(function(){
'use strict';
const V='20260919-3';
const modules={dashboard:{html:'pages/dashboard/dashboard.html',css:'pages/dashboard/dashboard.css',js:'pages/dashboard/dashboard.js'},upload:{html:'pages/upload/upload.html',css:'pages/upload/upload.css',js:'pages/upload/upload.js'},reports:{html:'pages/report/report.html',css:'pages/report/report.css',js:'pages/report/report.js'},parties:{html:'pages/parties/parties.html',css:'pages/parties/parties.css',js:'pages/parties/parties.js'},settings:{html:'pages/settings/settings.html',css:'pages/settings/settings.css',js:'pages/settings/settings.js'}};
const reportSubpages={'pending-invoice':{html:'pages/report/pending-invoice.html',css:'pages/report/pending-invoice.css',js:'pages/report/pending-invoice.js'},'upload-invoice-report':{html:'pages/report/upload-invoice-report.html',css:'pages/report/upload-invoice.css',js:'pages/report/upload-invoice-report.js'},'ai-report':{html:'pages/report/ai-report.html',css:'pages/report/ai-report.css',js:'pages/report/ai-report.js'}};
const loaded=new Set();
const asset=u=>new URL(u,document.baseURI).href+'?v='+V;

function loadCss(u){
  const v=asset(u);
  const existing=document.querySelector('link[data-gstui-module-css][href="'+v+'"]');
  if(existing) return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const l=document.createElement('link');
    l.rel='stylesheet';
    l.href=v;
    l.dataset.gstuiModuleCss='1';
    l.onload=()=>resolve();
    l.onerror=()=>reject(new Error('Failed to load CSS: '+v));
    document.head.appendChild(l);
  });
}
function loadJs(u){
  return new Promise((resolve,reject)=>{
    const v=asset(u);
    if(document.querySelector('script[data-gstui-module-js="'+v+'"]')) return resolve();
    const s=document.createElement('script');
    s.src=v;
    s.dataset.gstuiModuleJs=v;
    s.onload=resolve;
    s.onerror=()=>reject(new Error('Failed to load JS: '+v));
    document.body.appendChild(s);
  });
}
async function loadInto(host,meta,key){
  if(!host||!meta||loaded.has(key)) return;
  host.style.visibility='hidden';
  await loadCss(meta.css);
  const r=await fetch(asset(meta.html),{cache:'no-store'});
  if(!r.ok) throw new Error('GSTUI module '+key+' failed to load ('+r.status+')');
  host.innerHTML=await r.text();
  await loadJs(meta.js);
  loaded.add(key);
  host.dispatchEvent(new CustomEvent('gstui:module-mounted',{detail:{name:key},bubbles:true}));
  requestAnimationFrame(()=>{host.style.visibility='visible'});
}
async function mountReportSubpages(){
  const report=document.querySelector('.page-module-host[data-page-module="reports"]');
  if(!report) return;
  for(const id of Object.keys(reportSubpages)){
    const host=report.querySelector('[data-report-subpage-host="'+id+'"]');
    try{await loadInto(host,reportSubpages[id],'report:'+id)}catch(e){console.error('[GSTUI report-module]',e)}
  }
}
async function mount(name){
  const meta=modules[name],host=document.querySelector('.page-module-host[data-page-module="'+name+'"]');
  if(!meta||!host||loaded.has(name)) return;
  await loadInto(host,meta,name);
  if(name==='reports') await mountReportSubpages();
}
async function mountAll(){
  for(const name of Object.keys(modules)){
    try{await mount(name)}catch(e){console.error('[GSTUI module-loader]',e)}
  }
  document.documentElement.dataset.gstuiModulesReady='1';
  document.dispatchEvent(new CustomEvent('gstui:modules-ready'));
  if(typeof window.showSection==='function') window.showSection(window.location.hash.replace(/^#/,'')||'dashboard');
}
window.GSTUIModule={mount,mountAll,modules};
window.GSTUIPageLoader=window.GSTUIModule;
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mountAll,{once:true});
else mountAll();
})();
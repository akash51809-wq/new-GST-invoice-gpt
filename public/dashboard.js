/* Dashboard page controller. */
(function(){
  'use strict';
  window.GSTUIPageModules = window.GSTUIPageModules || {};

  function applyChartMode(root, mode){
    root=root || document;
    const chart=root.querySelector ? root.querySelector('#invoiceChart') : document.getElementById('invoiceChart');
    const filter=root.querySelector ? root.querySelector('#invoiceChartMode') : document.getElementById('invoiceChartMode');
    if(!chart) return;
    const value=mode || (filter && filter.value) || 'both';
    chart.dataset.mode=value;
    chart.querySelectorAll('.candle-group').forEach(group=>{
      group.classList.toggle('hide-buy',value==='sale');
      group.classList.toggle('hide-sale',value==='buy');
    });
  }

  window.setInvoiceChartMode=function(value){
    const chart=document.getElementById('invoiceChart');
    if(!chart) return;
    chart.dataset.mode=value;
    chart.querySelectorAll('.candle-group').forEach(group=>{
      group.classList.toggle('hide-buy',value==='sale');
      group.classList.toggle('hide-sale',value==='buy');
    });
  };

  window.launchDashboardShortcut=function(target,button){
    if(button){
      document.querySelectorAll('.hub-shortcut.launching').forEach(b=>b.classList.remove('launching'));
      button.classList.add('launching');
      button.animate(
        [{transform:'scale(1)'},{transform:'scale(1.18) translateY(-3px)'},{transform:'scale(.94)'},{transform:'scale(1.08)'}],
        {duration:360,easing:'cubic-bezier(.2,.8,.2,1)'}
      );
    }
    setTimeout(function(){
      if(typeof window.showSection==='function') window.showSection(target);
      requestAnimationFrame(function(){
        const id=['pending-invoice','upload-invoice-report','ai-report'].includes(target)?'reports':target;
        const page=document.getElementById(id);
        if(page){
          page.classList.remove('shortcut-launch');
          void page.offsetWidth;
          page.classList.add('shortcut-launch');
          setTimeout(()=>page.classList.remove('shortcut-launch'),450);
        }
      });
    },220);
  };

  window.GSTUIPageModules.dashboard={
    mount(root){
      if(root){
        root.dataset.moduleMounted='1';
        applyChartMode(root);
      }
    },
    unmount(root){
      if(root) delete root.dataset.moduleMounted;
    }
  };

  document.addEventListener('gstui:module-mounted',event=>{
    if(event.detail && event.detail.name==='dashboard') applyChartMode(event.target);
  });

  document.addEventListener('change',event=>{
    const filter=event.target.closest('#invoiceChartMode');
    if(filter) window.setInvoiceChartMode(filter.value);
  });
})();

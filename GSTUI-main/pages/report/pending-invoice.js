/* Pending Invoice module controller. */
(function(){
  'use strict';
  window.GSTUIReportModules = window.GSTUIReportModules || {};
  window.GSTUIReportModules.pendingInvoice = {
    mount(root){
      if(!root) return;
      const rows=[
        {fy:'2026-27',month:'April',inv:'ERS/26-27/0018',party:'ABC Traders',gstin:'09ABCDE1234F1Z5',type:'Buy',amount:'₹ 48,500',status:'Pending'},
        {fy:'2026-27',month:'April',inv:'ERS/26-27/0020',party:'XYZ Enterprises',gstin:'09XYZDE5678K1Z2',type:'Sell',amount:'₹ 72,800',status:'Pending'},
        {fy:'2026-27',month:'May',inv:'ERS/26-27/0031',party:'Shree Suppliers',gstin:'09SHREE1234P1Z8',type:'Buy',amount:'₹ 35,600',status:'Pending'},
        {fy:'2026-27',month:'May',inv:'ERS/26-27/0036',party:'Maa Enterprises',gstin:'09MAAEN9876Q1Z4',type:'Sell',amount:'₹ 91,250',status:'Pending'},
        {fy:'2026-27',month:'June',inv:'ERS/26-27/0045',party:'Om Distributors',gstin:'09OMDIS3456R1Z7',type:'Buy',amount:'₹ 64,900',status:'Pending'},
        {fy:'2025-26',month:'March',inv:'ERS/25-26/0204',party:'R K Communications',gstin:'09RKCOM7654T1Z3',type:'Buy',amount:'₹ 27,350',status:'Pending'}
      ];
      const body=root.querySelector('#pendingTableBody'),fin=root.querySelector('#pendingFinYear'),month=root.querySelector('#pendingMonth'),type=root.querySelector('#pendingType'),party=root.querySelector('#pendingParty'),search=root.querySelector('#pendingSearchBtn'),reset=root.querySelector('#pendingResetBtn'),count=root.querySelector('#pendingRowCount'),filterCount=root.querySelector('#pendingFilterCount');
      let filtered=rows.slice();
      function render(data){
        filtered=data;
        body.innerHTML=data.length?data.map((r,i)=>'<tr><td class="sl-cell">'+(i+1)+'</td><td>'+r.fy+'</td><td>'+r.month+'</td><td><strong>'+r.inv+'</strong></td><td class="party-cell"><strong>'+r.party+'</strong><small>'+r.gstin+'</small></td><td><span class="type-pill '+(r.type==='Buy'?'type-buy':'type-sell')+'">'+(r.type==='Buy'?'↙ BUY':'↗ SELL')+'</span></td><td class="amount-cell">'+r.amount+'</td><td><span class="pending-status-pill">'+r.status+'</span></td><td><div class="action-group"><button class="report-action action-view" title="View" type="button" data-action="view" data-index="'+i+'">◉</button><button class="report-action action-download" title="Download" type="button" data-action="download" data-index="'+i+'">↓</button></div></td></tr>').join(''):'<tr><td colspan="9"><div class="report-empty">No pending invoice record found. Change the filters and search again.</div></td></tr>';
        count.textContent=data.length+' record'+(data.length===1?'':'s');
        filterCount.textContent='Showing '+data.length+' of '+rows.length+' pending invoice records';
      }
      function apply(){const f=fin.value,m=month.value,t=type.value,q=party.value.trim().toLowerCase();render(rows.filter(r=>(f==='all'||r.fy===f)&&(m==='all'||r.month===m)&&(t==='all'||r.type===t)&&(!q||r.party.toLowerCase().includes(q))))}
      search?.addEventListener('click',()=>{search.classList.remove('report-search-bump');void search.offsetWidth;search.classList.add('report-search-bump');apply()});
      reset?.addEventListener('click',()=>{fin.value='all';month.value='all';type.value='all';party.value='';apply()});
      party?.addEventListener('keydown',e=>{if(e.key==='Enter')apply()});
      body?.addEventListener('click',e=>{const btn=e.target.closest('.report-action');if(!btn)return;const row=filtered[Number(btn.dataset.index)];if(!row)return;alert(btn.dataset.action==='view'?'Invoice: '+row.inv+'\nParty: '+row.party+'\nType: '+row.type+'\nAmount: '+row.amount:'Download action is ready to connect with the backend file link.')});
      render(rows);
      root.dataset.moduleMounted='1';
    }
  };
})();
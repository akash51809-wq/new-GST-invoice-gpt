/* Party List page controller. */
(function(){
  'use strict';
  window.GSTUIPageModules = window.GSTUIPageModules || {};
  window.GSTUIPageModules.parties = {
    mount(root){
      if(!root) return;
      root.dataset.moduleMounted='1';
      const input=root.querySelector('#partySearchInput');
      const body=root.querySelector('#partyTableBody');
      if(!input || !body) return;
      const rows=Array.from(body.querySelectorAll('tr'));
      input.addEventListener('input',function(){
        const q=this.value.trim().toLowerCase();
        let visible=0;
        rows.forEach(row=>{
          const name=row.cells[0]?.innerText.toLowerCase() || '';
          const show=!q || name.includes(q);
          row.style.display=show?'':'none';
          if(show) visible++;
        });
        let empty=body.querySelector('.party-empty-row');
        if(!visible){
          if(!empty){
            empty=document.createElement('tr');
            empty.className='party-empty-row';
            empty.innerHTML='<td colspan="6" class="party-empty">No parties found.</td>';
            body.appendChild(empty);
          }
        }else if(empty) empty.remove();
      });
    },
    unmount(root){ if(root) delete root.dataset.moduleMounted; }
  };
})();
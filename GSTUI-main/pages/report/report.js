/* Report module registry.
 * This file intentionally does not alter the existing report UI yet.
 * It provides a stable page-level contract for the final shell integration.
 */
(function(){
  'use strict';
  window.GSTUIReportModules = window.GSTUIReportModules || {};
  window.GSTUIReportPage = {
    modules: {
      'pending-invoice':'pendingInvoice',
      'upload-invoice-report':'uploadInvoiceReport',
      'ai-report':'aiReport'
    },
    mount(id, root){
      const key=this.modules[id];
      if(key && window.GSTUIReportModules[key]){
        window.GSTUIReportModules[key].mount(root);
      }
    }
  };
})();

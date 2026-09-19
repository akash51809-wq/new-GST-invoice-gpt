/* Report > Upload Invoice page controller.
 * Common navigation stays in app.js; page behavior belongs here.
 */
(function(){
  'use strict';
  window.GSTUIReportModules = window.GSTUIReportModules || {};
  window.GSTUIReportModules.uploadInvoiceReport = {
    mount(root){
      if(!root) return;
      root.dataset.moduleMounted='1';
    },
    unmount(root){
      if(root) delete root.dataset.moduleMounted;
    }
  };
})();

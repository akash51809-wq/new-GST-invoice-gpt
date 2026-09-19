/* Settings page controller. */
(function(){
  'use strict';

  window.GSTUIPageModules = window.GSTUIPageModules || {};

  function saveCompanySettings(){
    try{
      localStorage.setItem('gstui_company_name', document.getElementById('company-name-input')?.value || '');
      localStorage.setItem('gstui_auto_email', document.getElementById('auto-email-toggle')?.checked ? '1' : '0');
    }catch(e){}
  }

  function loadCompanySettings(){
    try{
      const name = localStorage.getItem('gstui_company_name');
      const auto = localStorage.getItem('gstui_auto_email');
      const input = document.getElementById('company-name-input');
      const toggle = document.getElementById('auto-email-toggle');
      if(input && name) input.value = name;
      if(toggle) toggle.checked = auto === '1';

      const logo = localStorage.getItem('gstui_company_logo');
      const preview = document.getElementById('company-logo-preview');
      if(logo && preview) preview.innerHTML = '<img src="' + logo + '" alt="Company Logo">';
      const logoName = document.getElementById('company-logo-name');
      const savedLogoName = localStorage.getItem('gstui_company_logo_name');
      if(logoName) logoName.textContent = savedLogoName || (logo ? 'Saved logo' : 'No logo selected');
    }catch(e){}
  }

  window.showSettingsPanel = function(name, button){
    document.querySelectorAll('.settings-panel').forEach(function(panel){
      panel.classList.toggle('active', panel.id === name + '-panel');
    });
    document.querySelectorAll('.settings-shortcut').forEach(function(btn){
      const active = btn === button;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  };


  function saveEmailTemplate(){
    try{
      const subject=document.getElementById('email-template-subject')?.value || '';
      const code=document.getElementById('email-template-code')?.value || '';
      localStorage.setItem('gstui_email_template_subject',subject);
      localStorage.setItem('gstui_email_template_code',code);
      const status=document.getElementById('email-template-status');
      if(status){
        status.classList.add('saved');
        status.innerHTML='<span class="email-status-dot"></span><span>Email Template successfully saved.</span>';
      }
    }catch(e){}
  }

  function loadEmailTemplate(){
    try{
      const subject=localStorage.getItem('gstui_email_template_subject');
      const code=localStorage.getItem('gstui_email_template_code');
      const subjectInput=document.getElementById('email-template-subject');
      const codeInput=document.getElementById('email-template-code');
      if(subjectInput && subject !== null) subjectInput.value=subject;
      if(codeInput && code !== null) codeInput.value=code;
      if(subject !== null || code !== null){
        const status=document.getElementById('email-template-status');
        if(status){
          status.classList.add('saved');
          status.innerHTML='<span class="email-status-dot"></span><span>Saved Email Template loaded.</span>';
        }
      }
    }catch(e){}
  }

  function insertEmailVariable(variable){
    const field=document.getElementById('email-template-code');
    if(!field) return;
    const start=field.selectionStart || 0;
    const end=field.selectionEnd || 0;
    field.value=field.value.slice(0,start)+variable+field.value.slice(end);
    field.focus();
    field.selectionStart=field.selectionEnd=start+variable.length;
  }

  function saveWhatsAppSettings(root){
    try{
      const requestType=root.querySelector('#whatsapp-request-type')?.value || 'POST';
      const apiUrl=root.querySelector('#whatsapp-api-url')?.value || '';
      localStorage.setItem('gstui_whatsapp_request_type',requestType);
      localStorage.setItem('gstui_whatsapp_api_url',apiUrl);
      const status=root.querySelector('#whatsapp-status');
      if(status){
        status.classList.add('saved');
        status.innerHTML='<span class="whatsapp-status-dot"></span><span>WhatsApp API settings successfully saved.</span>';
      }
    }catch(e){}
  }

  function loadWhatsAppSettings(root){
    try{
      const requestType=localStorage.getItem('gstui_whatsapp_request_type');
      const apiUrl=localStorage.getItem('gstui_whatsapp_api_url');
      const type=root.querySelector('#whatsapp-request-type');
      const url=root.querySelector('#whatsapp-api-url');
      if(type && requestType) type.value=requestType;
      if(url && apiUrl !== null) url.value=apiUrl;
      if(requestType || apiUrl !== null){
        const status=root.querySelector('#whatsapp-status');
        if(status){
          status.classList.add('saved');
          status.innerHTML='<span class="whatsapp-status-dot"></span><span>Saved WhatsApp API settings loaded.</span>';
        }
      }
    }catch(e){}
  }

  function resetWhatsAppSettings(root){
    try{
      localStorage.removeItem('gstui_whatsapp_request_type');
      localStorage.removeItem('gstui_whatsapp_api_url');
    }catch(e){}
    const type=root.querySelector('#whatsapp-request-type');
    const url=root.querySelector('#whatsapp-api-url');
    if(type) type.value='POST';
    if(url) url.value='';
    const status=root.querySelector('#whatsapp-status');
    if(status){
      status.classList.remove('saved');
      status.innerHTML='<span class="whatsapp-status-dot"></span><span>WhatsApp API settings are not saved.</span>';
    }
  }

  window.GSTUIPageModules.settings = {
    mount(root){
      if(!root) return;
      root.dataset.moduleMounted='1';

      const input = root.querySelector('#company-name-input');
      const toggle = root.querySelector('#auto-email-toggle');
      const logoInput = root.querySelector('#company-logo-input');
      const preview = root.querySelector('#company-logo-preview');

      if(input) input.addEventListener('input', saveCompanySettings);
      if(toggle) toggle.addEventListener('change', saveCompanySettings);

      if(logoInput) logoInput.addEventListener('change', function(){
        const file = this.files && this.files[0];
        if(!file || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = function(e){
          try{
            localStorage.setItem('gstui_company_logo', e.target.result);
            localStorage.setItem('gstui_company_logo_name', file.name);
            if(preview) preview.innerHTML = '<img src="' + e.target.result + '" alt="Company Logo">';
            const logoName = document.getElementById('company-logo-name');
            if(logoName) logoName.textContent = file.name;
          }catch(err){}
        };
        reader.readAsDataURL(file);
      });

      loadCompanySettings();

      const emailSubject=root.querySelector('#email-template-subject');
      const emailCode=root.querySelector('#email-template-code');
      const emailSave=root.querySelector('#email-template-save-btn');
      root.querySelectorAll('#template-panel .email-variable-chip').forEach(function(btn){
        btn.addEventListener('click',function(){ insertEmailVariable(btn.dataset.variable || ''); });
      });
      if(emailSave) emailSave.addEventListener('click',saveEmailTemplate);
      if(emailSubject) emailSubject.addEventListener('input',function(){
        const status=root.querySelector('#email-template-status'); if(status){status.classList.remove('saved');status.innerHTML='<span class="email-status-dot"></span><span>Unsaved changes.</span>';}
      });
      const gmailInput=root.querySelector('#gmail-sender-email');
      const gmailConnect=root.querySelector('#gmail-connect-btn');
      if(gmailInput){
        try{ gmailInput.value=localStorage.getItem('gstui_gmail_sender') || ''; }catch(e){}
        gmailInput.addEventListener('input',function(){
          try{ localStorage.setItem('gstui_gmail_sender', gmailInput.value); }catch(e){}
        });
      }
      if(gmailConnect){
        gmailConnect.addEventListener('click',function(){
          const note=root.querySelector('.gmail-note');
          if(note) note.textContent='Gmail OAuth connection backend के लिए ready है।';
        });
      }

      if(emailCode) emailCode.addEventListener('input',function(){
        const status=root.querySelector('#email-template-status'); if(status){status.classList.remove('saved');status.innerHTML='<span class="email-status-dot"></span><span>Unsaved changes.</span>';}
      });

      const whatsappSubmit=root.querySelector('#whatsapp-submit-btn');
      const whatsappReset=root.querySelector('#whatsapp-reset-btn');
      const whatsappType=root.querySelector('#whatsapp-request-type');
      const whatsappUrl=root.querySelector('#whatsapp-api-url');

      loadWhatsAppSettings(root);

      if(whatsappSubmit) whatsappSubmit.addEventListener('click',function(){ saveWhatsAppSettings(root); });
      if(whatsappReset) whatsappReset.addEventListener('click',function(){ resetWhatsAppSettings(root); });
      root.querySelectorAll('#whatsapp-panel .whatsapp-variable-chip').forEach(function(btn){
        btn.addEventListener('click',function(){
          const variable=btn.dataset.variable || '';
          const url=root.querySelector('#whatsapp-api-url');
          if(url){
            const start=url.selectionStart || url.value.length;
            const end=url.selectionEnd || start;
            url.value=url.value.slice(0,start)+variable+url.value.slice(end);
            url.focus();
            url.selectionStart=url.selectionEnd=start+variable.length;
          }
        });
      });

      [whatsappType,whatsappUrl].forEach(function(field){
        if(field) field.addEventListener('input',function(){
          const status=root.querySelector('#whatsapp-status');
          if(status){
            status.classList.remove('saved');
            status.innerHTML='<span class="whatsapp-status-dot"></span><span>Unsaved changes.</span>';
          }
        });
      });

      loadEmailTemplate();
    },
    unmount(root){ if(root) delete root.dataset.moduleMounted; }
  };
})();
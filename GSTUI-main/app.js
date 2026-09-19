function showSection(id){
  document.querySelectorAll('.page-section').forEach(section => section.classList.add('hidden'));

  const reportIds = ['pending-invoice', 'upload-invoice-report', 'ai-report'];
  const isReportSubpage = reportIds.includes(id);
  const targetId = isReportSubpage ? 'reports' : id;
  const target = document.getElementById(targetId);

  if(target) target.classList.remove('hidden');

  document.body.classList.toggle('upload-active', targetId === 'upload');
  document.body.classList.toggle('party-active', targetId === 'parties');
  document.body.classList.toggle('settings-active', targetId === 'settings');

  const titles = {
    dashboard: 'Dashboard',
    upload: 'Upload Invoice',
    reports: 'Report',
    parties: 'Party List',
    settings: 'Settings'
  };
  const reportTitles = {
    'pending-invoice': 'Pending Invoice',
    'upload-invoice-report': 'Upload Invoice',
    'ai-report': 'AI Report'
  };

  const title = reportTitles[id] || titles[targetId] || 'Dashboard';
  const pageTitle = document.getElementById('pageTitle');
  const crumb = document.getElementById('crumbTitle');
  if(pageTitle) pageTitle.textContent = title;
  if(crumb) crumb.textContent = title;

  document.querySelectorAll('.sidebar-nav > a').forEach(link => link.classList.remove('active'));
  document.querySelectorAll('.nav-parent').forEach(link => link.classList.remove('active'));
  document.querySelectorAll('.submenu a').forEach(link => link.classList.remove('active'));

  const reportParent = document.querySelector('.nav-parent');
  const reportSubmenu = document.getElementById('reportSubmenu');

  if(isReportSubpage){
    reportParent?.classList.add('active');
    reportSubmenu?.classList.add('open');

    const subLink = document.querySelector('.submenu a[href="#' + id + '"]');
    subLink?.classList.add('active');

    if(typeof window.showReportSubpage === 'function'){
      window.showReportSubpage(id, subLink);
    }
  }else{
    // Report submenu stays closed on every normal page, including Dashboard.
    reportSubmenu?.classList.remove('open');

    const link = document.querySelector('.sidebar-nav > a[href="#' + targetId + '"]');
    link?.classList.add('active');
  }

  window.location.hash = id;
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function toggleSubmenu(id){
  const submenu = document.getElementById(id);
  if(!submenu) return;

  const willOpen = !submenu.classList.contains('open');
  submenu.classList.toggle('open', willOpen);
  document.querySelector('.nav-parent')?.classList.toggle('active', willOpen);
}

window.showReportSubpage = function(id, button){
  document.querySelectorAll('.report-subpage').forEach(item => item.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');

  document.querySelectorAll('.report-tab').forEach(item => item.classList.remove('active'));
  button?.classList.add('active');
};

function logout(){
  if(window.confirm('Are you sure you want to logout?')){
    window.location.href = 'index.html';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.sidebar-nav > a').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      showSection(link.getAttribute('href').slice(1));
    });
  });

  document.querySelectorAll('.submenu a').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      showSection(link.getAttribute('href').slice(1));
    });
  });

  const requestedId = location.hash.replace('#', '');
  const initialId = requestedId || 'dashboard';
  showSection(document.getElementById(initialId) ? initialId : 'dashboard');
});
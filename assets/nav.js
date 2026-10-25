// Shared app navigation. Every page loads this right after <body>; it injects one
// consistent top bar so all pages are reachable from anywhere, in the same order.
(() => {
  const PAGES = [
    { group: 'Audit results', href: 'brain.html', label: 'Brain', desc: 'Verified requirements as a 3D graph',
      icon: '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3"/>' },
    { group: 'Audit results', href: 'brd.html', label: 'BRD viewer', desc: 'BRDs with the proven parts highlighted',
      icon: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>' },
    { group: 'System', href: 'system.html', label: 'System map', desc: 'Screens, builder, architecture, data, roles',
      icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
    { group: 'System', href: 'flow.html', label: 'Order flow', desc: 'Login → order → rework → reorder, step by step',
      icon: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 12h10M14 9l3 3-3 3"/>' },
    { group: 'System', href: 'features.html', label: 'Functional reference', desc: 'Every feature, page by page: picker, builder, cart, orders',
      icon: '<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 21V5M8 7h7M8 11h7"/>' },
    { group: 'New BRDs', href: 'analysis.html', label: 'Analysis requests', desc: 'Submit a new BRD and track its analysis',
      icon: '<path d="M4 4h16v12H8l-4 4z"/><path d="M8 9h8M8 12h5"/>' },
  ];

  const here = (location.pathname.split('/').pop() || 'analysis.html').toLowerCase();
  const svg = (body) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const link = (p) => `<a href="${p.href}" title="${p.desc}"${p.href === here ? ' aria-current="page"' : ''}>${svg(p.icon)}<span class="an-label">${p.label}</span><span class="an-desc">${p.desc}</span></a>`;

  const groups = [...new Set(PAGES.map((p) => p.group))];
  const css = `
  :root { --appnav-h: 48px; }
  .appnav { position: sticky; top: 0; z-index: 1000; height: var(--appnav-h); display: flex; align-items: center; gap: 18px;
    padding: 0 20px; background: rgba(5,7,13,.92); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid rgba(120,160,255,.16); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e6ecff; }
  .appnav * { box-sizing: border-box; }
  .appnav .an-brand { display: flex; align-items: center; gap: 8px; color: #e6ecff; text-decoration: none; font-weight: 650; white-space: nowrap; }
  .appnav .an-brand i { width: 10px; height: 10px; border-radius: 50%; background: linear-gradient(135deg, #7cc4ff, #4fe3a0); box-shadow: 0 0 10px rgba(79,227,160,.5); }
  .appnav .an-links { position: static; margin: 0; padding: 0; display: flex; align-items: center; gap: 2px; }
  .appnav .an-group { display: flex; align-items: center; gap: 2px; }
  .appnav .an-group + .an-group { margin-left: 8px; padding-left: 10px; border-left: 1px solid rgba(120,160,255,.16); }
  .appnav .an-gname { display: none; }
  .appnav a:not(.an-brand) { display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; border-radius: 8px; color: #8b97b8;
    text-decoration: none; font-size: 13px; white-space: nowrap; transition: color .12s, background .12s; }
  .appnav a:not(.an-brand):hover { color: #e6ecff; background: rgba(255,255,255,.05); }
  .appnav a[aria-current=page] { color: #e6ecff; background: rgba(124,196,255,.14); box-shadow: inset 0 0 0 1px rgba(124,196,255,.35); }
  .appnav a[aria-current=page] svg { color: #7cc4ff; }
  .appnav a:focus-visible, .appnav button:focus-visible { outline: 2px solid #7cc4ff; outline-offset: 2px; }
  .appnav .an-desc { display: none; }
  .appnav .an-toggle { display: none; margin-left: auto; align-items: center; gap: 6px; font: inherit; font-size: 13px; color: #e6ecff;
    background: rgba(255,255,255,.04); border: 1px solid rgba(120,160,255,.16); border-radius: 8px; padding: 6px 10px; cursor: pointer; }
  .appnav .an-current { color: #8b97b8; font-size: 13px; }
  @media (max-width: 880px) {
    .appnav { gap: 10px; padding: 0 16px; }
    .appnav .an-toggle { display: inline-flex; }
    .appnav .an-links { display: none; position: absolute; top: var(--appnav-h); left: 0; right: 0; flex-direction: column; align-items: stretch;
      gap: 10px; padding: 12px 16px 16px; background: rgba(8,11,20,.98); border-bottom: 1px solid rgba(120,160,255,.16);
      box-shadow: 0 20px 40px rgba(0,0,0,.5); max-height: calc(100vh - var(--appnav-h)); overflow: auto; }
    .appnav.open .an-links { display: flex; }
    .appnav .an-group { flex-direction: column; align-items: stretch; }
    .appnav .an-group + .an-group { margin-left: 0; padding-left: 0; border-left: 0; padding-top: 10px; border-top: 1px solid rgba(120,160,255,.12); }
    .appnav .an-gname { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #8b97b8; margin: 0 0 4px 10px; }
    .appnav a:not(.an-brand) { display: grid; grid-template-columns: 16px 1fr; column-gap: 10px; padding: 8px 10px; font-size: 14px; white-space: normal; }
    .appnav .an-label { color: #e6ecff; }
    .appnav .an-desc { display: block; grid-column: 2; font-size: 12px; color: #8b97b8; }
  }`;

  const current = PAGES.find((p) => p.href === here);
  const nav = document.createElement('header');
  nav.className = 'appnav';
  nav.innerHTML = `<style>${css}</style>
    <a class="an-brand" href="brain.html" title="Master-BRD home"><i></i>Master-BRD</a>
    <button class="an-toggle" type="button" aria-expanded="false" aria-controls="appnavLinks">
      ${svg('<path d="M4 7h16M4 12h16M4 17h16"/>')}<span>${current ? current.label : 'Menu'}</span></button>
    <nav class="an-links" id="appnavLinks" aria-label="Main">
      ${groups.map((g) => `<div class="an-group" role="group" aria-label="${g}"><span class="an-gname">${g}</span>${PAGES.filter((p) => p.group === g).map(link).join('')}</div>`).join('')}
    </nav>`;
  document.body.insertAdjacentElement('afterbegin', nav);

  // Mobile menu: toggle, close on outside click, Escape, or picking a link.
  const toggle = nav.querySelector('.an-toggle');
  const setOpen = (open) => { nav.classList.toggle('open', open); toggle.setAttribute('aria-expanded', open); };
  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
  document.addEventListener('click', (e) => { if (!nav.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('open')) { setOpen(false); toggle.focus(); }
  });
  nav.querySelectorAll('.an-links a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
})();

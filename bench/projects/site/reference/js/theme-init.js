// Runs before the stylesheet applies, so the page never flashes the wrong theme.
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem('northwind.theme');
  } catch (e) {
    // Storage blocked: follow the system.
  }
  var dark =
    stored === 'dark' ||
    (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();

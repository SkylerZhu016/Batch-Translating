(function () {
  try {
    var scheme = localStorage.getItem('kimi-web.color-scheme');
    var dayTheme = localStorage.getItem('batch-translating.day-theme');
    var nightTheme = localStorage.getItem('batch-translating.night-theme');
    var uiFont = localStorage.getItem('batch-translating.ui-font');

    document.documentElement.dataset.colorScheme =
      scheme === 'light' || scheme === 'dark' || scheme === 'system' ? scheme : 'system';
    document.documentElement.dataset.dayTheme =
      dayTheme === 'pure-white' || dayTheme === 'maple' ? dayTheme : 'maple';
    document.documentElement.dataset.nightTheme =
      nightTheme === 'ink-black' || nightTheme === 'ink-blue' ? nightTheme : 'ink-blue';
    document.documentElement.dataset.uiFont =
      uiFont === 'wenkai' || uiFont === 'system' ? uiFont : 'wenkai';
  } catch {
    document.documentElement.dataset.colorScheme = 'system';
    document.documentElement.dataset.dayTheme = 'maple';
    document.documentElement.dataset.nightTheme = 'ink-blue';
    document.documentElement.dataset.uiFont = 'wenkai';
  }
})();

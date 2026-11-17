// Page vitrine de Nino : apparence (Auto, Clair, Sombre) et lien direct vers le dernier installateur publié.
(function () {
  var root = document.documentElement;
  var order = ['auto', 'light', 'dark'];
  var names = { auto: 'Auto', light: 'Clair', dark: 'Sombre' };
  var button = document.getElementById('theme');
  var label = document.getElementById('theme-label');

  function apply(theme) {
    root.dataset.theme = theme;
    label.textContent = names[theme];
    button.setAttribute('aria-label', 'Apparence : ' + names[theme] + '. Changer d’apparence');
  }
  apply(order.indexOf(root.dataset.theme) >= 0 ? root.dataset.theme : 'auto');
  button.addEventListener('click', function () {
    var next = order[(order.indexOf(root.dataset.theme) + 1) % order.length];
    apply(next);
    try {
      if (next === 'auto') localStorage.removeItem('nino-site-theme');
      else localStorage.setItem('nino-site-theme', next);
    } catch (e) {}
  });

  // Sans réponse de GitHub, le bouton garde son lien vers la page des versions.
  var link = document.getElementById('download');
  var linkLabel = document.getElementById('download-label');
  var meta = document.getElementById('download-meta');
  if (!window.fetch) return;
  fetch('https://api.github.com/repos/antoinequarroz/nino-studio/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (res) {
      if (res.status === 404) {
        linkLabel.textContent = 'Voir les versions';
        meta.textContent = 'La première version publique arrive bientôt. Windows 11 x64.';
        return null;
      }
      return res.ok ? res.json() : null;
    })
    .then(function (release) {
      if (!release || !release.assets) return;
      var exe = release.assets.filter(function (a) { return /-windows-x64\.exe$/.test(a.name); })[0];
      if (!exe) return;
      var version = String(release.tag_name || '').replace(/^v/, '');
      var size = Math.round(exe.size / 1048576);
      link.href = exe.browser_download_url;
      linkLabel.textContent = 'Télécharger Nino ' + version;
      meta.textContent = 'Windows 11 x64 · ' + size + ' Mo · empreinte SHA-256 publiée avec la version';
    })
    .catch(function () {});
})();

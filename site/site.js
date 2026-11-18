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

  // Sur un Mac, le bouton macOS passe en premier plan.
  var isMac = /Mac/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent || '');
  if (isMac) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-os]'), function (el) {
      el.classList.toggle('btn-primary', el.getAttribute('data-os') === 'mac');
    });
  }

  // Sans réponse de GitHub, les boutons gardent leur lien vers la dernière version.
  var link = document.getElementById('download');
  var linkLabel = document.getElementById('download-label');
  var meta = document.getElementById('download-meta');
  var macLink = document.getElementById('download-mac');
  var macLabel = document.getElementById('download-mac-label');
  var macMeta = document.getElementById('download-mac-meta');
  if (!window.fetch) return;
  fetch('https://api.github.com/repos/antoinequarroz/nino-studio/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (res) {
      if (res.status === 404) {
        linkLabel.textContent = 'Voir les versions';
        meta.textContent = 'La première version publique arrive bientôt.';
        return null;
      }
      return res.ok ? res.json() : null;
    })
    .then(function (release) {
      if (!release || !release.assets) return;
      var version = String(release.tag_name || '').replace(/^v/, '');
      var find = function (pattern) { return release.assets.filter(function (a) { return pattern.test(a.name); })[0]; };
      var exe = find(/-windows-x64\.exe$/);
      if (exe) {
        link.href = exe.browser_download_url;
        linkLabel.textContent = 'Windows · Nino ' + version;
        meta.textContent = 'Windows 11 x64 · ' + Math.round(exe.size / 1048576) + ' Mo · empreinte SHA-256 publiée avec la version';
      }
      var dmg = find(/-macos-arm64\.dmg$/);
      if (dmg) {
        macLink.href = dmg.browser_download_url;
        macLabel.textContent = 'macOS · Nino ' + version;
        macMeta.textContent = 'macOS 13.5 ou plus récent, Mac Apple Silicon · ' + Math.round(dmg.size / 1048576) + ' Mo · empreinte SHA-256 publiée avec la version';
      }
    })
    .catch(function () {});
})();

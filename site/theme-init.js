// Apparence choisie par le visiteur, gardée sur cet appareil (Auto par défaut).
try { var t = localStorage.getItem('nino-site-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}

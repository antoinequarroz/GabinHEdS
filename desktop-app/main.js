const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindows() {
  // Fenêtre unique, plein écran (kiosk) sans barre de titre
  const dashboardWin = new BrowserWindow({
    width: 1920,
    height: 1080,
    kiosk: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  // EN PRODUCTION, charger le build Vue statique
  if (app.isPackaged) {
    const vueIndexPath = path.join(__dirname, 'dist', 'index.html');
    console.log('[ELECTRON] Chargement du fichier Vue :', vueIndexPath);
    const fs = require('fs');
    if (fs.existsSync(vueIndexPath)) {
      console.log('[ELECTRON] Fichier index.html trouvé, chargement...');
      dashboardWin.loadFile(vueIndexPath);
    } else {
      console.error('[ELECTRON] Fichier index.html introuvable dans dist/ !');
      dashboardWin.loadURL('data:text/html,<h1>Erreur : index.html non trouvé dans dist/</h1>');
    }
  } else {
    dashboardWin.loadURL('http://localhost:3001/');
  }
}

app.whenReady().then(createWindows);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindows();
});

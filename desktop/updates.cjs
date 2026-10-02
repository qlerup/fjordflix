// Native dialogs only: the remote web page cannot choose a feed or executable.
function createUpdates({app, updater, dialog, window, playing}) {
  let busy = false, available = null, downloaded = false;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.on('update-available', info => { available = info; });
  updater.on('download-progress', info => {
    if (!window.isDestroyed()) window.setProgressBar(info.percent / 100);
  });
  // Errors are also returned by the awaited check/download; avoid duplicate dialogs.
  updater.on('error', () => {});
  async function check() {
    if (busy) return;
    busy = true;
    const message = options => dialog.showMessageBox(window, {title:'FjordFlix · Opdatering', ...options});
    try {
      if (!app.isPackaged) {
        await message({message:'Opdateringer er tilgængelige i den installerede Windows-app.'}); return;
      }
      if (!downloaded) {
        available = null;
        window.setProgressBar(2);
        await updater.checkForUpdates();
        window.setProgressBar(-1);
        if (!available) {
          await message({message:'Du har den nyeste version.',detail:`Installeret: ${app.getVersion()}`}); return;
        }
        const choice = await message({message:`FjordFlix ${available.version} er klar.`,
          detail:`Din version: ${app.getVersion()}\nHent opdateringen fra GitHub?`,
          buttons:['Hent opdatering','Senere'],defaultId:0,cancelId:1});
        if (choice.response !== 0) return;
        await updater.downloadUpdate();
        downloaded = true;
      }
      window.setProgressBar(-1);
      if (playing()) {
        await message({message:'Opdateringen er hentet.',detail:'Luk filmen, og vælg Søg efter opdateringer igen for at installere.'}); return;
      }
      const choice = await message({message:'Opdateringen er klar til installation.',
        detail:'FjordFlix lukker og åbner igen. Din serveradresse og dit login bevares.',
        buttons:['Installer og genstart','Senere'],defaultId:0,cancelId:1});
      if (choice.response === 0 && !playing()) updater.quitAndInstall(false,true);
    } catch (error) {
      await message({type:'error',message:'Opdateringen kunne ikke gennemføres.',detail:'Kontrollér internetforbindelsen og prøv igen.\n'+String(error.message || error).slice(0,400)});
    } finally { busy = false; if (!window.isDestroyed()) window.setProgressBar(-1); }
  }
  return {check};
}
module.exports = {createUpdates};

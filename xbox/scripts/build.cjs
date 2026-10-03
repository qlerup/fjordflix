const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist/app');
fs.mkdirSync(out, {recursive:true});
for (const [folder, files] of Object.entries({
  app:['AppxManifest.xml','server-url.js','logo.svg'],
  tv:['index.html','tv.css','navigation.js','capabilities.js','xbox-platform.js','local-phone-server.js','phone-login.js','tv.js']
})) {
  for (const file of files) {
    const source = path.join(root, folder, file);
    if (file.endsWith('.js')) acorn.parse(fs.readFileSync(source, 'utf8'), {ecmaVersion:5});
    fs.copyFileSync(source, path.join(out, file));
  }
}
fs.cpSync(path.join(root, 'app/Assets'), path.join(out, 'Assets'), {recursive:true});
const qrSource=fs.readFileSync(require.resolve('qrcode-generator'),'utf8');
acorn.parse(qrSource,{ecmaVersion:5});
fs.writeFileSync(path.join(out,'qrcode.js'),qrSource);
fs.copyFileSync(path.join(root,'tv/QR-LICENSE.txt'),path.join(out,'QR-LICENSE.txt'));
fs.writeFileSync(path.join(out,'phone-page.js'),'window.FjordPhonePage = '+JSON.stringify(fs.readFileSync(path.join(root,'tv/phone-setup.html'),'utf8'))+';');
console.log('Built standalone Xbox UWP app; all scripts pass ES5 parsing.');

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const root = path.resolve(__dirname, '..');
// In the main repository, take shared UI directly from Xbox's TV source.
// Standalone copies retain a snapshot for packaging without the server checkout.
const shared = path.resolve(root, '../xbox/tv');
const common = new Set(['tv.js','tv.css','next-episode.js','wishes.js']);
const out = path.join(root, 'dist/app');
fs.mkdirSync(out, {recursive:true});
for (const [folder, files] of Object.entries({app:['appinfo.json','server-url.js','webOSTV.js','webOSTV-LICENSE.txt','icon.png','largeIcon.png','logo.svg'], tv:['index.html','tv.css','navigation.js','capabilities.js','phone-login.js','next-episode.js','wishes.js','tv.js']})) {
  for (const file of files) {
    const source = common.has(file) && fs.existsSync(path.join(shared,file)) ? path.join(shared,file) : path.join(root, folder, file);
    if (file.endsWith('.js')) acorn.parse(fs.readFileSync(source, 'utf8'), {ecmaVersion:5});
    fs.copyFileSync(source, path.join(out, file));
  }
}
console.log('Built standalone webOS app; every shipped script parses as ES5.');

fs.writeFileSync(path.join(out,'client-info.js'), 'window.FjordTVClient = ' + JSON.stringify({platform:'LG',version:require('../package.json').version}) + ';\n');

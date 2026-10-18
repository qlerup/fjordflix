const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const root = path.resolve(__dirname, '..');
const out = path.resolve(root, 'dist/app');
// Only the generated app directory may be replaced, never sources or settings.
if (out !== path.join(root, 'dist', 'app') || !out.startsWith(root + path.sep)) throw new Error('Unsafe build path');
fs.rmSync(out, {recursive:true, force:true});
fs.mkdirSync(out, {recursive:true});
const shared = path.resolve(root, '../xbox/tv');
const common = new Set(['tv.js','tv.css','next-episode.js','wishes.js']);
for (const [folder, files] of Object.entries({
  app:['config.xml','server-url.js','icon.png','logo.svg'],
  tv:['index.html','tv.css','navigation.js','capabilities.js','phone-login.js','next-episode.js','wishes.js','tv.js','samsung-platform.js','samsung-player.js','samsung.css']
})) {
  for (const file of files) {
    const source = common.has(file) && fs.existsSync(path.join(shared,file)) ? path.join(shared,file) : path.join(root,folder,file);
    if (file.endsWith('.js')) acorn.parse(fs.readFileSync(source,'utf8'),{ecmaVersion:5});
    fs.copyFileSync(source,path.join(out,file));
  }
}
const pkg = require('../package.json');
const manifest = fs.readFileSync(path.join(out,'config.xml'),'utf8');
if (!manifest.includes('version="'+pkg.version+'"') || !manifest.includes('required_version="4.0"')) throw new Error('Tizen manifest/version mismatch');
fs.writeFileSync(path.join(out,'client-info.js'),'window.FjordTVClient = '+JSON.stringify({platform:'Samsung',version:pkg.version})+';\n');
console.log('Samsung Tizen 4.0+ (2018+) app built; all shipped scripts parse as ES5.');

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {zipSync} = require('fflate');
const root = path.resolve(__dirname,'..'), version = require('../package.json').version;
const entries = {};
for (const name of fs.readdirSync(path.join(root,'dist/app')).sort()) {
  const file = path.join(root,'dist/app',name);
  if (!fs.statSync(file).isFile()) throw new Error('Unexpected nested file in app');
  entries[name] = fs.readFileSync(file);
}
const widget = 'FjordFlix-Samsung_'+version+'_UNSIGNED.wgt';
fs.writeFileSync(path.join(root,'dist',widget),zipSync(entries,{level:9}));
const source = {};
for (const [name,data] of Object.entries(entries)) source['FjordFlix-Samsung/'+name] = data;
for (const name of ['README.md','TEST-PAA-SAMSUNG-TV.md']) source[name] = fs.readFileSync(path.join(root,name));
const project = 'FjordFlix-Samsung_'+version+'_TV-project.zip';
fs.writeFileSync(path.join(root,'dist',project),zipSync(source,{level:9}));
fs.writeFileSync(path.join(root,'dist','SHA256SUMS.txt'),[widget,project].map(name=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'dist',name))).digest('hex')+'  '+name).join('\n')+'\n');
console.log('Created unsigned WGT and TV project. A Samsung certificate with your TV DUID is required for installation.');

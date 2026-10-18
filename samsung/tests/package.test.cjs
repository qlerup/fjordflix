const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),acorn=require('acorn');
const root=path.resolve(__dirname,'..');
test('manifest targets Tizen 4.0+, uses a ten-character package ID and public TV APIs',()=>{
  const xml=fs.readFileSync(path.join(root,'app/config.xml'),'utf8');
  assert.match(xml,/required_version="4\.0"/);assert.match(xml,/package="[A-Za-z0-9]{10}"/);
  assert.match(xml,/id="FjordFlix1\.FjordFlix"/);assert.match(xml,/tv-samsung/);assert.match(xml,/tv\.inputdevice/);
  assert.doesNotMatch(xml,/background-support="enable"|privilege[^>]*partner/);
});
test('all Samsung runtime scripts parse as ES5; Return handles the 2018 keycode',()=>{
  for(const folder of ['app','tv'])for(const name of fs.readdirSync(path.join(root,folder))){
    if(name.endsWith('.js'))acorn.parse(fs.readFileSync(path.join(root,folder,name),'utf8'),{ecmaVersion:5});
  }
  assert.match(fs.readFileSync(path.join(root,'tv/navigation.js'),'utf8'),/10009/);
});

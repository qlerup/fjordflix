const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const server=fs.existsSync(path.resolve(root,'../app/main.py'))?path.resolve(root,'..'):path.resolve(root,'../fjordflix');
for(const script of [path.join(root,'tests/local-phone-browser.cjs'),path.join(root,'tests/phone-login-browser.cjs'),path.join(server,'tests/browser_tv_login.cjs')]){
  const result=spawnSync(process.execPath,[script],{cwd:root,stdio:'inherit'});
  if(result.status!==0)process.exit(result.status||1);
}

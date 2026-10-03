/* Actual TCP + phone browser. WinRT socket objects are adapted to Node TCP;
 * binding/firewall behavior on physical Xbox remains a device check. */
const net=require('node:net'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{chromium}=require('playwright'),jsQR=require('jsqr');
const root=path.resolve(__dirname,'..'),listeners=[],credentials={name:'Søren QA',password:'Temporary-test-only-73!'};
const token='t'.repeat(43),calls=[];
class Listener {
  constructor(){this.information={};}
  bindEndpointAsync(host,port){this.host=host;this.server=net.createServer(socket=>this.onconnectionreceived({socket:{inputStream:socket,outputStream:socket,close:()=>socket.end()}}));listeners.push(this);return new Promise(resolve=>this.server.listen(0,'127.0.0.1',()=>{this.information.localPort=String(this.server.address().port);resolve();}));}
  close(){this.server.close();}
}
class Reader {
  constructor(socket){this.socket=socket;this.buffer=[];this.ended=false;this.pending=null;socket.on('data',data=>{this.buffer.push(...data);this.ready();});socket.on('end',()=>{this.ended=true;this.ready();});socket.on('error',()=>{this.ended=true;this.ready();});}
  ready(){if(this.pending&&(this.buffer.length||this.ended)){const {size,resolve}=this.pending;this.pending=null;resolve(Math.min(size,this.buffer.length));}}
  loadAsync(size){return new Promise(resolve=>{this.pending={size,resolve};this.ready();});}
  readBytes(target){target.set(this.buffer.splice(0,target.length));}
  close(){this.ended=true;this.ready();}
}
class Writer {
  constructor(socket){this.socket=socket;}
  writeBytes(bytes){this.bytes=bytes;}
  storeAsync(){return new Promise((resolve,reject)=>this.socket.write(Buffer.from(this.bytes),error=>error?reject(error):resolve(this.bytes.length)));}
  close(){}
}
class XHR {
  open(method,url){this.method=method;this.url=url;this.headers={};}
  setRequestHeader(name,value){this.headers[name]=value;}
  send(body){fetch(this.url,{method:this.method,headers:this.headers,body,signal:AbortSignal.timeout(this.timeout||12000)}).then(async response=>{this.status=response.status;this.responseText=await response.text();this.onload();},()=>this.onerror());}
}
function element(){return {hidden:false,textContent:'',src:'',focus(){},removeAttribute(name){delete this[name];}};}
async function main(){
  const backend=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const data=JSON.parse(body||'{}');calls.push({path:req.url,data});res.setHeader('Content-Type','application/json');if(req.url==='/tv-api/login'&&data.name===credentials.name&&data.password===credentials.password)res.end(JSON.stringify({token}));else{res.statusCode=401;res.end(JSON.stringify({detail:'Forkert brugernavn eller adgangskode.'}));}});});
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
  const server=`http://127.0.0.1:${backend.address().port}`,nodes={},accepted=[],expiry=[];
  const sandbox={Promise,Uint8Array,Date,setTimeout:(fn,ms)=>{if(ms===300000)expiry.push(fn);return setTimeout(fn,ms);},clearTimeout,setInterval,clearInterval,crypto:require('node:crypto').webcrypto,btoa,XMLHttpRequest:XHR,
    qrcode:require('qrcode-generator'),FjordServerURL:require('../app/server-url.js'),FjordPhonePage:fs.readFileSync(path.join(root,'tv/phone-setup.html'),'utf8'),
    document:{getElementById:id=>nodes[id]||(nodes[id]=element()),body:{classList:{toggle(){}}}},
    Windows:{Networking:{HostName:function(ip){this.ip=ip;},Sockets:{StreamSocketListener:Listener},Connectivity:{NetworkInformation:{getInternetConnectionProfile:()=>null,getHostNames:()=>[{canonicalName:'192.168.1.20',ipInformation:{networkAdapter:{networkAdapterId:'LAN'}}}]}}},Storage:{Streams:{DataReader:Reader,DataWriter:Writer,InputStreamOptions:{partial:1}}}}};
  sandbox.window=sandbox;vm.createContext(sandbox);
  for(const name of ['local-phone-server.js','phone-login.js'])vm.runInContext(fs.readFileSync(path.join(root,'tv',name),'utf8'),sandbox);
  let browser;
  try{
    sandbox.TVPhoneLogin.setup((value,address)=>accepted.push({value,address}));
    await sandbox.TVPhoneLogin.start();
    const address=nodes['phone-address'].textContent;
    assert.match(address,/^http:\/\/192\.168\.1\.20:\d+\/[A-Za-z0-9_-]{43}\/$/);
    assert.equal(calls.length,0,'a QR is generated without a configured FjordFlix address');
    browser=await chromium.launch({headless:true});const phone=await browser.newPage({viewport:{width:390,height:844}});
    await phone.setContent(`<img id="qr" src="${nodes['phone-qr'].src}">`);
    const decoded=await phone.locator('#qr').evaluate(async img=>{await img.decode();const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);return {width:canvas.width,height:canvas.height,bytes:Array.from(ctx.getImageData(0,0,canvas.width,canvas.height).data)};});
    assert.equal(jsQR(Uint8ClampedArray.from(decoded.bytes),decoded.width,decoded.height).data,address);
    const port=new URL(address).port;
    await phone.route(new URL(address).origin+'/**',async route=>{const url=new URL(route.request().url());const response=await route.fetch({url:`http://127.0.0.1:${port}${url.pathname}`,headers:{...route.request().headers(),host:`192.168.1.20:${port}`}});await route.fulfill({response});});
    await phone.goto(address);
    assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await phone.locator('#server').fill(server);await phone.locator('#name').fill(credentials.name);await phone.locator('#password').fill('wrong');await phone.locator('#submit').click();
    await phone.waitForFunction(()=>document.getElementById('status').textContent.includes('Forkert'));
    assert.equal(await phone.locator('#password').inputValue(),'');
    await phone.locator('#password').fill(credentials.password);await phone.locator('#submit').click();
    await phone.waitForFunction(()=>document.getElementById('status').textContent.includes('Du er logget ind'));
    assert.deepEqual(accepted,[{value:token,address:server}]);assert.equal(sandbox.TVPhoneLogin.active(),false);
    assert.equal(await phone.locator('#password').inputValue(),'');
    await new Promise(resolve=>setTimeout(resolve,20));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`),'temporary listener closes after login');
    console.log('PASS local setup: no Xbox server entry, decoded local QR, actual TCP HTTP, mobile layout, wrong/correct login, listener closes after success');
    await sandbox.TVPhoneLogin.start();const cancelPort=new URL(nodes['phone-address'].textContent).port;await sandbox.TVPhoneLogin.cancel();
    await assert.rejects(fetch(`http://127.0.0.1:${cancelPort}/`));console.log('PASS local cancellation closes the TCP listener');
    await sandbox.TVPhoneLogin.start();const expiredPort=new URL(nodes['phone-address'].textContent).port;expiry.at(-1)();
    await assert.rejects(fetch(`http://127.0.0.1:${expiredPort}/`));assert.equal(nodes['phone-retry'].hidden,false);
    console.log('PASS expiry closes the listener and offers a new QR');
    const opening=sandbox.TVPhoneLogin.start();await sandbox.TVPhoneLogin.cancel();await opening;
    await assert.rejects(fetch(`http://127.0.0.1:${listeners.at(-1).information.localPort}/`));
    console.log('PASS cancellation while binding closes a late listener');
    const xbox=await browser.newPage();await xbox.goto(require('node:url').pathToFileURL(path.join(root,'dist/app/index.html')).href);
    await xbox.evaluate(()=>{
      window.Windows={Networking:{Sockets:{}}};window.localStarts=0;window.localCloses=0;
      window.FjordLocalPhoneServer.start=()=>{localStarts++;return Promise.resolve({url:'http://192.168.1.20:43000/'+'x'.repeat(43)+'/',expires:Date.now()+300000,close:()=>localCloses++});};
    });
    assert.equal(await xbox.locator('#server-address').inputValue(),'');await xbox.locator('#phone-login').click();
    await xbox.waitForFunction(()=>document.getElementById('phone-qr').getAttribute('src')?.startsWith('data:image/gif'));
    assert.equal(await xbox.evaluate(()=>localStarts),1);assert.equal(await xbox.locator('#server-address').inputValue(),'');
    await xbox.locator('#phone-cancel').click();assert.equal(await xbox.evaluate(()=>localCloses),1);
    console.log('PASS packaged Xbox UI starts local phone setup with a blank server field');await xbox.close();
  }finally{await sandbox.TVPhoneLogin.cancel();if(browser)await browser.close();await new Promise(resolve=>backend.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

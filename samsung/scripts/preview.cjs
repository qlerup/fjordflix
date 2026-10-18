const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname,'../dist/app'), port = Number(process.env.PORT || 8128);
const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
http.createServer((req,res)=>{
  let name;
  try { name=decodeURIComponent(new URL(req.url,'http://localhost').pathname); } catch { res.writeHead(400).end();return; }
  if (name==='/') name='/index.html';
  const file = path.resolve(root,'.'+name);
  if (!file.startsWith(root+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);
}).listen(port,'127.0.0.1',()=>console.log('PC preview: http://127.0.0.1:'+port+' (not a Samsung hardware test)'));

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {collectDroppedFiles,createUploadQueue,createChunkUploader,uploadPath}=require('../app/static/uploads.js');

function fileEntry(name) {
  return {name,isFile:true,file:resolve=>queueMicrotask(()=>resolve(new File(['video'],name,{lastModified:1})))};
}
function folder(name,batches) {
  return {name,isDirectory:true,createReader:()=>{
    let i=0;return {readEntries:resolve=>queueMicrotask(()=>resolve(batches[i++] || []))};
  }};
}
function transfer(entries) {
  return {items:entries.map(entry=>({kind:'file',webkitGetAsEntry:()=>entry,getAsFile:()=>null}))};
}

test('dropped folders include every entry batch, nested paths and same-named episodes',async()=>{
  const first=Array.from({length:100},(_,i)=>fileEntry(`E${i+1}.mkv`));
  const files=await collectDroppedFiles(transfer([folder('Show',[
    [folder('Season 1',[first,[fileEntry('E101.mkv')]]),folder('Season 2',[[fileEntry('E1.mkv')]])]
  ])]));
  assert.equal(files.length,102);
  assert.equal(uploadPath(files[100]),'Show/Season 1/E101.mkv');
  assert.equal(uploadPath(files[101]),'Show/Season 2/E1.mkv');
  const queue=createUploadQueue(async()=>({}));
  queue.add(files);queue.add(files);
  assert.equal(queue.items.length,102);
});

test('plain drops still work and directory read errors reach the UI',async()=>{
  const file=new File(['x'],'Movie.mp4');
  assert.deepEqual(await collectDroppedFiles({files:[file]}),[file]);
  const broken={isDirectory:true,name:'Broken',createReader:()=>({readEntries:(_,reject)=>reject(new Error('Permission denied'))})};
  await assert.rejects(collectDroppedFiles(transfer([broken])),/Permission denied/);
});

test('folder picker paths are sent with the existing chunk upload and unsupported files never upload',async()=>{
  const file=new File(['video'],'E01.mkv');
  Object.defineProperty(file,'webkitRelativePath',{value:'Show/Season 1/E01.mkv'});
  const posts=[];
  const send=createChunkUploader(async(method,url,body)=>{
    if(url==='/api/uploads'){posts.push(body);return {id:'fixture',offset:0};}
    if(method==='PUT')return {offset:file.size};
    return {status:'done'};
  });
  const queue=createUploadQueue(send);
  queue.add([file,new File(['poster'],'cover.jpg')]);
  await queue.run();
  assert.equal(posts.length,1);
  assert.equal(posts[0].relative_path,'Show/Season 1/E01.mkv');
  assert.equal(posts[0].filename,'E01.mkv');
  assert.deepEqual(queue.items.map(item=>item.status),['done','skipped']);
});

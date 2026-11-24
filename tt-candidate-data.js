/* Candidate-only transactional persistence. No production activation. */
(function(){
'use strict';
const LOCK='tt-mobile:db:write-v2', KEY='suachua_db', PREFIX='tt_v2img_', DRAFT='tt_v2draft_', DRAFT_IMG='tt_v2draft_image_';
const LOCAL_SCHEMA_VERSION=3, CLIENT_PROTOCOL_VERSION=2, BUILD_ID='20261124-pwa-2040';
const slots=['before_images','after_images','condition_images','repair_images'];
let held=false;
const RECOVERY='tt_v2_recovery_status',BACKUP='tt_v2_good_snapshot';
const clone=v=>JSON.parse(JSON.stringify(v));
const parse=(x,def)=>{if(typeof x!=='string'||!x.trim())return def;try{const value=JSON.parse(x);return value===null?def:value}catch(e){return def}};

const IDB_NAME='TT_MOBILE_SERIAL_V1', IDB_STORE='canonical';
let activeRecord=null,activeStage=null,activePuts=null,activeDeletes=null,dbPromise=null;
let canonicalCache=null,canonicalFromIdb=false,ready=false,bootstrapStatus='LOADING',bootstrapError=null,bootstrapPromise=null;
let projectionStale=false,lastProjectionError=null,canonicalEpoch=0,currentLineageId=null,currentActiveBinding=null,pendingActiveBinding=null,versionChangeBlocked=false;
const idbAssetCache=new Map(),idbDraftCache=new Map(),hydrateListeners=new Set();

function notifyHydrate(snapshot,meta){
 for(const fn of hydrateListeners){try{fn(clone(snapshot),meta)}catch(e){console.warn('[hydrate listener]',e)}}
 if(typeof window!=='undefined'&&typeof window.dispatchEvent==='function'){
  try{window.dispatchEvent(new CustomEvent('tt-canonical-hydrated',{detail:{epoch:canonicalEpoch,fromIdb:canonicalFromIdb,projectionStale}}))}catch(_){}
 }
}
function notifyProjectionStale(err){
 if(typeof window!=='undefined'&&typeof window.dispatchEvent==='function'){
  try{window.dispatchEvent(new CustomEvent('tt-projection-stale',{detail:{message:err?.message||String(err),epoch:canonicalEpoch}}))}catch(_){}
 }
}
function fail(text,code='STORAGE'){const e=new Error(text);e.code=code;throw e}
function strictArray(raw,label){
 let value;try{value=JSON.parse(raw)}catch(e){fail('Kho '+label+' không đọc được; chặn ghi để phục hồi.','CORRUPT_ASSET')}
 if(!Array.isArray(value))fail('Kho '+label+' sai cấu trúc; chặn ghi.','CORRUPT_ASSET');
 return value;
}
function resolveAssetArray(pointer,overlay){
 const key=PREFIX+pointer;
 if(overlay&&overlay.has(key))return clone(overlay.get(key));
 if(idbAssetCache.has(key))return clone(idbAssetCache.get(key));
 const raw=localStorage.getItem(key);
 if(raw===null)return null;
 return strictArray(raw,'ảnh '+pointer);
}
function assertRefs(t,overlay){
 if(t===null||typeof t!=='object'||Array.isArray(t)||t.id===null||
    t.id===undefined||!['string','number'].includes(typeof t.id))
   fail('Phiếu có định danh không hợp lệ.','CANONICAL_CORRUPT');
 if(t.__imageRefs!==undefined){
  if(!t.__imageRefs||typeof t.__imageRefs!=='object'||Array.isArray(t.__imageRefs))
   fail('Image sidecar manifest không hợp lệ.','CORRUPT_ASSET');
  for(const [attr,pointer] of Object.entries(t.__imageRefs)){
   if(!slots.includes(attr)||typeof pointer!=='string'||!pointer||
      !/^[a-zA-Z0-9_-]+$/.test(pointer))fail('Image sidecar pointer không hợp lệ.','CORRUPT_ASSET');
   const images=resolveAssetArray(pointer,overlay);
   if(images===null)fail('Image sidecar bị thiếu; chặn ghi và ACK.','CORRUPT_ASSET');
   if(!Array.isArray(images)||images.some(x=>!x||typeof x!=='object'||typeof x.data!=='string'||
      !/^data:image\/(png|jpeg|webp);base64,/.test(x.data)))
    fail('Image sidecar chứa dữ liệu không hợp lệ.','CORRUPT_ASSET');
  }
 }
 for(const attr of slots){
  if(t[attr]!==undefined){
   if(typeof t[attr]!=='string')fail('Danh sách URL ảnh sai cấu trúc.','CORRUPT_ASSET');
   const arr=strictArray(t[attr],attr);
   if(arr.some(x=>!x||typeof x!=='object'||
      !(typeof x.url==='string'||typeof x.data==='string')))
    fail('Danh sách ảnh có item hỏng.','CORRUPT_ASSET');
  }
  const legacy='img_'+t.id+'_'+attr,raw=localStorage.getItem(legacy);
  if(raw!==null)strictArray(raw,legacy);
 }
}
function parseCanonical(raw,overlay){
 if(raw===null)return {schemaVersion:LOCAL_SCHEMA_VERSION,nextId:1,tickets:[],tombstones:[],outbox:[],ackedDeletes:[]};
 if(typeof raw!=='string'||!raw.trim())fail('Canonical không hợp lệ.','CANONICAL_CORRUPT');
 let d;try{d=JSON.parse(raw)}catch(e){fail('Canonical JSON bị hỏng; dữ liệu cũ được giữ nguyên.','CANONICAL_CORRUPT')}
 if(!d||typeof d!=='object'||Array.isArray(d)||!Array.isArray(d.tickets)||
    (d.tombstones!==undefined&&!Array.isArray(d.tombstones))||
    (d.outbox!==undefined&&!Array.isArray(d.outbox))||
    (d.ackedDeletes!==undefined&&!Array.isArray(d.ackedDeletes)))
   fail('Canonical sai schema; không thể ghi đè.','CANONICAL_CORRUPT');
 const ids=new Set();
 for(const t of d.tickets){assertRefs(t,overlay);const id=String(t.id);
  if(ids.has(id))fail('Phiếu trùng ID trong canonical.','CANONICAL_CORRUPT');ids.add(id)}
 for(const op of d.outbox||[]){
  if(!op||typeof op!=='object'||typeof op.operationId!=='string'||!op.operationId||
     op.ticketId===undefined||!Number.isSafeInteger(Number(op.revision)))
    fail('Outbox sai schema.','CANONICAL_CORRUPT');
  if(op.row&&typeof op.row==='object')assertRefs(op.row,overlay);
 }
 for(const tomb of d.tombstones||[])
  if(!tomb||typeof tomb!=='object'||!tomb.operationId||
     tomb.ticketId===undefined)fail('Tombstone sai schema.','CANONICAL_CORRUPT');
 for(const marker of d.ackedDeletes||[])
  if(!marker||typeof marker!=='object'||marker.ticketId===undefined||
     !Number.isSafeInteger(Number(marker.revision))||Number(marker.revision)<0||
     typeof marker.datasetId!=='string'||typeof marker.endpoint!=='string')
    fail('ACK delete watermark hỏng.','CANONICAL_CORRUPT');
 return {schemaVersion:d.schemaVersion||LOCAL_SCHEMA_VERSION,nextId:d.nextId||1,tickets:d.tickets,tombstones:d.tombstones||[],outbox:d.outbox||[],ackedDeletes:d.ackedDeletes||[]};
}
function getRecoveryStatus(){
 if(bootstrapStatus==='LOADING'&&!ready&&!bootstrapError){
  return {status:'LOADING',ticketCount:0,hasBackup:localStorage.getItem(BACKUP)!==null,canonicalBytesPreserved:true};
 }
 if(bootstrapError||bootstrapStatus==='BLOCKED'){
  return {status:'BLOCKED',code:bootstrapError?.code||'CANONICAL_CORRUPT',
   message:bootstrapError?.message||'Kho canonical lỗi; chặn ghi để phục hồi.',
   hasBackup:localStorage.getItem(BACKUP)!==null,
   recoveryKey:RECOVERY,canonicalBytesPreserved:true};
 }
 if(ready&&canonicalCache!==null){
  return {status:bootstrapStatus==='EMPTY'&&canonicalCache.tickets.length===0?'EMPTY':'VALID',
   ticketCount:canonicalCache.tickets.length,
   hasBackup:localStorage.getItem(BACKUP)!==null,
   projectionStale,canonicalEpoch,fromIdb:canonicalFromIdb};
 }
 const raw=localStorage.getItem(KEY);
 try{const db=parseCanonical(raw);return {status:raw===null?'EMPTY':'VALID',ticketCount:db.tickets.length,
   hasBackup:localStorage.getItem(BACKUP)!==null}}
 catch(e){return {status:'BLOCKED',code:e.code||'CANONICAL_CORRUPT',
   message:e.message,hasBackup:localStorage.getItem(BACKUP)!==null,
   recoveryKey:RECOVERY,canonicalBytesPreserved:true}}
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const uid=()=>crypto.randomUUID();
function idbOpen(){
 if(versionChangeBlocked)return Promise.reject(Object.assign(Error('Cơ sở dữ liệu vừa nâng cấp phiên bản ở tab khác; vui lòng tải lại ứng dụng.'),{code:'IDB_VERSION_CHANGED'}));
 if(dbPromise)return dbPromise;
 dbPromise=new Promise((resolve,reject)=>{
  if(typeof window==='undefined'||!window.indexedDB)return reject(Object.assign(Error('IndexedDB unavailable'),{code:'IDB_UNAVAILABLE'}));
  let req;
  try{req=indexedDB.open(IDB_NAME,1);}catch(e){return reject(Object.assign(Error(e?.message||'IDB open failed'),{code:'IDB_UNAVAILABLE'}))}
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(IDB_STORE))req.result.createObjectStore(IDB_STORE)};
  req.onblocked=()=>reject(Object.assign(Error('IDB version blocked'),{code:'IDB_BLOCKED'}));
  req.onerror=()=>reject(Object.assign(req.error||Error('IDB open failed'),{code:req.error?.name||'IDB_ERROR'}));
  req.onsuccess=()=>{const db=req.result;db.onversionchange=()=>{
   try{db.close();}catch(_){}
   dbPromise=null;versionChangeBlocked=true;
   const err=Object.assign(Error('Cơ sở dữ liệu vừa nâng cấp phiên bản ở tab khác; vui lòng tải lại ứng dụng.'),{code:'IDB_VERSION_CHANGED'});
   bootstrapStatus='BLOCKED';bootstrapError=err;ready=false;
   if(typeof window!=='undefined'&&typeof window.dispatchEvent==='function'){
    try{window.dispatchEvent(new CustomEvent('tt-idb-versionchange',{detail:{name:IDB_NAME,at:Date.now()}}))}catch(_){}
   }
  };resolve(db)};
 }).catch(e=>{dbPromise=null;throw e});
 return dbPromise;
}
function checkFencing(meta){
 if(meta===null||meta===undefined)return;
 if(typeof meta!=='object'||Array.isArray(meta))
  fail('Metadata schema không hợp lệ.','SCHEMA_META_INVALID');
 if(meta.minClient!==undefined){
  if(typeof meta.minClient!=='number'||!Number.isSafeInteger(meta.minClient)||meta.minClient<1)
   fail('Metadata minClient không hợp lệ.','SCHEMA_META_INVALID');
  if(meta.minClient>CLIENT_PROTOCOL_VERSION)
   fail('Phiên bản tab cũ không tương thích; vui lòng tải lại ứng dụng.','OLD_TAB_FENCED');
 }
}
async function loadDraftsFromIdb(){
 try{
  const db=await idbOpen();
  return await new Promise(resolve=>{
   let settled=false;
   const finish=ok=>{if(!settled){settled=true;resolve(ok)}};
   let tx,store;
   try{tx=db.transaction(IDB_STORE,'readonly');store=tx.objectStore(IDB_STORE);}catch(_){finish(false);return}
   const found=new Map();
   tx.onabort=()=>finish(false);
   tx.onerror=()=>finish(false);
   tx.oncomplete=()=>{try{for(const [k,v] of found)idbDraftCache.set(k,clone(v));finish(true)}catch(_){finish(false)}};
   if(typeof store.openCursor!=='function'){finish(false);return}
   const curReq=store.openCursor();
   curReq.onsuccess=ev=>{
    const cur=ev.target.result;if(!cur)return;
    const k=String(cur.key),v=cur.value;
    if(k.startsWith('draft:')||k.startsWith('draft_img:'))found.set(k,v&&v.value!==undefined?v.value:v);
    cur.continue();
   };
   curReq.onerror=()=>{try{tx.abort()}catch(_){};finish(false)};
  });
 }catch(_){return false}
}
async function readIdbState(updateCache=true){
 let db;
 try{db=await idbOpen();}
 catch(e){
  const err=e instanceof Error?e:Object.assign(Error(String(e)),{code:'IDB_UNAVAILABLE'});
  if(!err.code)err.code='IDB_UNAVAILABLE';
  if(updateCache){bootstrapStatus='BLOCKED';bootstrapError=err;ready=false;canonicalCache=null;}
  throw err;
 }
 return new Promise((resolve,reject)=>{
  let tx,store,ticketsRec,metaRec,settled=false;
  const assets=new Map();
  const failOnce=e=>{
   if(settled)return;settled=true;
   const err=e instanceof Error?e:Object.assign(Error(String(e)),{code:'IDB_ERROR'});
   if(updateCache){bootstrapStatus='BLOCKED';bootstrapError=err;ready=false;canonicalCache=null;}
   reject(err);
  };
  try{tx=db.transaction(IDB_STORE,'readonly');store=tx.objectStore(IDB_STORE);}catch(e){failOnce(e);return}
  tx.onabort=()=>failOnce(tx.error||Object.assign(Error('IDB_READ_ABORT'),{code:'IDB_ABORT'}));
  tx.onerror=()=>failOnce(tx.error||Object.assign(Error('IDB_READ_ERROR'),{code:'IDB_ERROR'}));
  const metaReq=store.get('meta:schema');
  const ticketsReq=store.get('tickets');
  metaReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(metaReq.error||Error('IDB_META_READ_ERROR'))};
  ticketsReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(ticketsReq.error||Error('IDB_TICKETS_READ_ERROR'))};
  const collectRefs=rows=>{
   if(!Array.isArray(rows))return;
   for(const t of rows){
    if(!t||!t.__imageRefs||typeof t.__imageRefs!=='object')continue;
    for(const pointer of Object.values(t.__imageRefs)){
     if(typeof pointer!=='string'||!pointer||seenPtrs.has(pointer))continue;
     seenPtrs.add(pointer);
     const areq=store.get('img:'+pointer);
     areq.onsuccess=()=>{if(areq.result!==undefined)assets.set(PREFIX+pointer,areq.result&&areq.result.value!==undefined?areq.result.value:areq.result)};
     areq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(areq.error||Error('IDB_ASSET_READ_ERROR'))};
    }
   }
  };
  const seenPtrs=new Set();
  ticketsReq.onsuccess=()=>{
   const rec=ticketsReq.result;
   collectRefs(rec?.value?.tickets);
   if(Array.isArray(rec?.value?.outbox))collectRefs(rec.value.outbox.map(op=>op&&op.row).filter(Boolean));
  };
  tx.oncomplete=async()=>{
   if(settled)return;
   try{
    metaRec=metaReq.result;
    ticketsRec=ticketsReq.result;
    const metaVal=metaRec?.value||metaRec;
    checkFencing(metaVal);
    if(metaVal&&typeof metaVal.lineageId==='string')currentLineageId=metaVal.lineageId;
    if(metaVal&&metaVal.activeBinding&&typeof metaVal.activeBinding.datasetId==='string')currentActiveBinding=metaVal.activeBinding;
    if(ticketsRec!==undefined){
     const validated=parseCanonical(JSON.stringify(ticketsRec.value),assets);
     await loadDraftsFromIdb();
     if(updateCache){
      for(const [k,v] of assets)idbAssetCache.set(k,clone(v));
      canonicalCache=clone(validated);
      canonicalFromIdb=true;
      canonicalEpoch=Number(ticketsRec.epoch)||0;
      ready=true;bootstrapStatus='VALID';bootstrapError=null;
      const mirror=localStorage.getItem(KEY);
      projectionStale=mirror!==JSON.stringify(canonicalCache);
      if(typeof window!=='undefined'&&window.DB){
       const demos=Array.isArray(window.DB.tickets)?window.DB.tickets.filter(t=>t&&t.__demo):[];
       window.DB.tickets=[...clone(canonicalCache.tickets),...demos];
       window.DB.nextId=canonicalCache.nextId;
      }
      notifyHydrate(canonicalCache,{epoch:canonicalEpoch,fromIdb:true,projectionStale});
     }
     settled=true;resolve({snapshot:validated,fromIdb:true,epoch:Number(ticketsRec.epoch)||0,lineageId:currentLineageId});
     return;
    }
    const rawLs=localStorage.getItem(KEY);
    const validated=parseCanonical(rawLs,assets);
    await loadDraftsFromIdb();
    if(updateCache){
     for(const [k,v] of assets)idbAssetCache.set(k,clone(v));
     canonicalCache=clone(validated);
     canonicalFromIdb=false;
     canonicalEpoch=0;
     ready=true;bootstrapStatus=rawLs===null?'EMPTY':'VALID';bootstrapError=null;
     projectionStale=false;
     if(typeof window!=='undefined'&&window.DB){
      const demos=Array.isArray(window.DB.tickets)?window.DB.tickets.filter(t=>t&&t.__demo):[];
      window.DB.tickets=[...clone(canonicalCache.tickets),...demos];
      window.DB.nextId=canonicalCache.nextId;
     }
     notifyHydrate(canonicalCache,{epoch:0,fromIdb:false,projectionStale:false});
    }
    settled=true;resolve({snapshot:validated,fromIdb:false,epoch:0,lineageId:currentLineageId});
   }catch(e){failOnce(e)}
  };
 });
}
async function bootstrap(){
 if(ready&&!bootstrapError&&canonicalFromIdb)return getRecoveryStatus();
 if(bootstrapPromise)return bootstrapPromise;
 bootstrapStatus='LOADING';
 bootstrapPromise=readIdbState(true)
  .then(()=>getRecoveryStatus())
  .catch(()=>getRecoveryStatus())
  .finally(()=>{bootstrapPromise=null});
 return bootstrapPromise;
}
async function hydrate(){
 bootstrapPromise=readIdbState(true)
  .then(()=>getRecoveryStatus())
  .catch(()=>getRecoveryStatus())
  .finally(()=>{bootstrapPromise=null});
 return bootstrapPromise;
}
async function getRecoveryStatusAsync(){
 await hydrate();
 return getRecoveryStatus();
}

async function atomicTransaction(key,legacy,validate,work,projection){
 const db=await idbOpen();
 return new Promise((resolve,reject)=>{
  let tx,store,result,changed=false,next,prior,settled=false,nextEpoch=0,puts=[],deletes=[],nextMeta=null;
  try{tx=db.transaction(IDB_STORE,'readwrite');store=tx.objectStore(IDB_STORE)}catch(e){reject(e);return}
  const failOnce=e=>{pendingActiveBinding=null;if(!settled){settled=true;reject(e||Error('IDB_ABORT'))}};
  tx.onabort=()=>failOnce(tx.error||Error('IDB_ABORT'));
  tx.onerror=()=>failOnce(tx.error||Error('IDB_ERROR'));
  tx.oncomplete=()=>{
   if(settled)return;
   try{
    if(key==='tickets'&&changed){
     for(const item of puts){
      if(item.key.startsWith('img:'))idbAssetCache.set(PREFIX+item.key.slice(4),clone(item.value));
     }
     for(const dk of deletes)idbDraftCache.delete(dk);
     if(nextMeta&&typeof nextMeta.lineageId==='string')currentLineageId=nextMeta.lineageId;
     if(nextMeta&&nextMeta.activeBinding)currentActiveBinding=nextMeta.activeBinding;
     pendingActiveBinding=null;
     canonicalCache=clone(next);
     canonicalFromIdb=true;
     canonicalEpoch=nextEpoch;
     ready=true;bootstrapStatus='VALID';bootstrapError=null;
     if(typeof window!=='undefined'&&window.DB){
      const demos=Array.isArray(window.DB.tickets)?window.DB.tickets.filter(t=>t&&t.__demo):[];
      window.DB.tickets=[...clone(next.tickets),...demos];
      window.DB.nextId=next.nextId;
     }
     notifyHydrate(next,{epoch:nextEpoch,fromIdb:true,projectionStale});
    }
    if(changed&&projection){
     try{
      projection(next,prior);
      if(key==='tickets'){projectionStale=false;lastProjectionError=null;}
     }catch(e){
      if(key==='tickets'){projectionStale=true;lastProjectionError=e;notifyProjectionStale(e);}
      console.error('Projection failed after durable transaction',e);
     }
    }
    settled=true;
    resolve(result);
   }catch(e){failOnce(e)}
  };
  const metaReq=store.get('meta:schema');
  const req=store.get(key);
  metaReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(metaReq.error||Error('IDB_META_ERROR'))};
  req.onerror=()=>{try{tx.abort()}catch(_){};failOnce(req.error)};
  req.onsuccess=()=>{
   try{
    checkFencing(metaReq.result?.value||metaReq.result);
    prior=req.result;
    const current=prior===undefined?legacy():prior.value;
    validate(current);
    const stage=value=>{
     const ov=new Map();
     for(const item of puts)if(item&&typeof item.key==='string'&&item.key.startsWith('img:'))ov.set(PREFIX+item.key.slice(4),item.value);
     validate(value,ov);next=clone(value);changed=true;
     nextEpoch=(Number(prior?.epoch)||0)+1;
     for(const item of puts){store.put({value:clone(item.value),at:Date.now()},item.key)}
     for(const dk of deletes){store.delete(dk)}
     if(key==='tickets'){
      const prevMeta=metaReq.result?.value||metaReq.result||null;
      const boundMeta=pendingActiveBinding||(prevMeta&&prevMeta.activeBinding)||currentActiveBinding||null;
      nextMeta=prevMeta?{...prevMeta,protocolVersion:CLIENT_PROTOCOL_VERSION,schemaVersion:LOCAL_SCHEMA_VERSION,lineageId:prevMeta.lineageId||uid(),activeBinding:boundMeta,updatedAt:Date.now()}:
       {protocolVersion:CLIENT_PROTOCOL_VERSION,minClient:CLIENT_PROTOCOL_VERSION,schemaVersion:LOCAL_SCHEMA_VERSION,lineageId:uid(),activeBinding:boundMeta,updatedAt:Date.now()};
      store.put(nextMeta,'meta:schema');
     }
     store.put({value:next,previous:prior?.value??null,epoch:nextEpoch,at:Date.now()},key);
    };
    activePuts=puts;activeDeletes=deletes;
    try{result=work(clone(current),stage);}
    finally{activePuts=null;activeDeletes=null;}
    if(result&&typeof result.then==='function')throw Error('IDB_TRANSACTION_CALLBACK_ASYNC');
    if(prior===undefined&&!changed)stage(current);
   }catch(e){try{tx.abort()}catch(_){};failOnce(e)}
  };
 });
}
function read(){
 if(activeRecord!==null)return clone(activeRecord);
 if(bootstrapError||bootstrapStatus==='BLOCKED')throw (bootstrapError||fail('Kho canonical đang bị khóa phục hồi.','CANONICAL_CORRUPT'));
 if(ready&&canonicalCache!==null)return clone(canonicalCache);
 throw fail('Kho canonical chưa nạp xong.','NOT_READY');
}
function isReady(){return ready&&!bootstrapError&&bootstrapStatus!=='BLOCKED'}
function isBlocked(){return !!(bootstrapError||bootstrapStatus==='BLOCKED')}
function getView(){
 if(bootstrapError||bootstrapStatus==='BLOCKED')throw (bootstrapError||fail('Kho canonical đang bị khóa phục hồi.','CANONICAL_CORRUPT'));
 if(!ready||canonicalCache===null)throw fail('Kho canonical chưa sẵn sàng.','NOT_READY');
 return clone(canonicalCache);
}
function getBootstrapState(){
 return {status:bootstrapStatus,ready,fromIdb:canonicalFromIdb,epoch:canonicalEpoch,lineageId:currentLineageId,buildId:BUILD_ID,projectionStale,lastProjectionError:lastProjectionError?.message||null,error:bootstrapError?{code:bootstrapError.code,message:bootstrapError.message}:null};
}
async function readCanonical(){
 const res=await readIdbState(true);
 return clone(res.snapshot);
}
window.TTAtomicStore={
 transact:atomicTransaction,
 stageSideEffects:(puts,deletes)=>{
  if(activePuts&&Array.isArray(puts)){
   for(const p of puts){
    if(Array.isArray(p))activePuts.push({key:p[0],value:p[1]&&p[1].value!==undefined?p[1].value:p[1]});
    else if(p&&typeof p==='object'&&p.key)activePuts.push(p);
   }
  }
  if(activeDeletes&&Array.isArray(deletes))activeDeletes.push(...deletes);
 },
 read:async(key,legacy,validate)=>{
  const db=await idbOpen();
  return new Promise((resolve,reject)=>{
   let tx,store,settled=false;
   const failOnce=e=>{if(!settled){settled=true;reject(e||Error('IDB_READ_ERROR'))}};
   try{tx=db.transaction(IDB_STORE,'readonly');store=tx.objectStore(IDB_STORE);}catch(e){failOnce(e);return}
   tx.onabort=()=>failOnce(tx.error||Error('IDB_READ_ABORT'));
   tx.onerror=()=>failOnce(tx.error||Error('IDB_READ_ERROR'));
   const metaReq=store.get('meta:schema');
   const req=store.get(key);
   metaReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(metaReq.error||Error('IDB_META_READ_ERROR'))};
   req.onerror=()=>{try{tx.abort()}catch(_){};failOnce(req.error||Error('IDB_READ_ERROR'))};
   tx.oncomplete=()=>{
    if(settled)return;
    try{
     checkFencing(metaReq.result?.value||metaReq.result);
     const val=req.result===undefined?legacy():req.result.value;
     validate(val);
     const out=clone(val);
     settled=true;
     resolve(out);
    }catch(e){failOnce(e)}
   };
  });
 },
 putRaw:async(entries)=>{
  const db=await idbOpen();
  return new Promise((resolve,reject)=>{
   let tx,store,settled=false;
   const failOnce=e=>{if(!settled){settled=true;reject(e||Error('IDB_PUT_ERROR'))}};
   try{tx=db.transaction(IDB_STORE,'readwrite');store=tx.objectStore(IDB_STORE);}catch(e){failOnce(e);return}
   tx.oncomplete=()=>{if(!settled){settled=true;resolve(true)}};
   tx.onabort=()=>failOnce(tx.error||Error('IDB_ABORT'));
   tx.onerror=()=>failOnce(tx.error||Error('IDB_ERROR'));
   try{for(const [k,v] of entries)store.put(v,k);}catch(e){try{tx.abort()}catch(_){};failOnce(e)}
  });
 },
 deleteRaw:async(keys)=>{
  const db=await idbOpen();
  return new Promise((resolve,reject)=>{
   let tx,store,settled=false;
   const failOnce=e=>{if(!settled){settled=true;reject(e||Error('IDB_DELETE_ERROR'))}};
   try{tx=db.transaction(IDB_STORE,'readwrite');store=tx.objectStore(IDB_STORE);}catch(e){failOnce(e);return}
   tx.oncomplete=()=>{if(!settled){settled=true;resolve(true)}};
   tx.onabort=()=>failOnce(tx.error||Error('IDB_ABORT'));
   tx.onerror=()=>failOnce(tx.error||Error('IDB_ERROR'));
   try{for(const k of keys)store.delete(k);}catch(e){try{tx.abort()}catch(_){};failOnce(e)}
  });
 },
 getRaw:async(key)=>{
  const db=await idbOpen();
  return new Promise((resolve,reject)=>{
   let settled=false;
   const failOnce=e=>{if(!settled){settled=true;reject(e||Error('IDB_GET_ERROR'))}};
   let tx,req;
   try{tx=db.transaction(IDB_STORE,'readonly');req=tx.objectStore(IDB_STORE).get(key);}catch(e){failOnce(e);return}
   tx.onabort=()=>failOnce(tx.error||Error('IDB_ABORT'));
   tx.onerror=()=>failOnce(tx.error||Error('IDB_ERROR'));
   req.onsuccess=()=>{if(!settled){settled=true;resolve(req.result)}};
   req.onerror=()=>failOnce(req.error||Error('IDB_GET_ERROR'));
  });
 }
};
function available(){return !!(navigator.locks&&navigator.locks.request)}
async function lock(callback){
 if(!available())fail('Thiếu Web Locks; chặn ghi để tránh mất dữ liệu giữa hai tab.','NO_LOCK');
 return navigator.locks.request(LOCK,{mode:'exclusive'},async()=>{
  held=true;
  try{
   const preAssets=new Map();
   const db=await idbOpen();
   await new Promise((resolve)=>{
    let settled=false;
    const done=()=>{if(!settled){settled=true;resolve()}};
    let tx,store;
    try{tx=db.transaction(IDB_STORE,'readonly');store=tx.objectStore(IDB_STORE);}catch(_){done();return}
    tx.oncomplete=()=>{try{for(const [k,v] of preAssets)idbAssetCache.set(k,clone(v));}catch(_){}done()};
    tx.onabort=()=>done();
    tx.onerror=()=>done();
    if(typeof store.openCursor==='function'){
     const req=store.openCursor();
     req.onsuccess=ev=>{const cur=ev.target.result;if(!cur)return;const k=String(cur.key);if(k.startsWith('img:'))preAssets.set(PREFIX+k.slice(4),cur.value?.value??cur.value);cur.continue()};
     req.onerror=()=>{try{tx.abort()}catch(_){};done()};
    }else done();
   });
   return await atomicTransaction('tickets',
    ()=>parseCanonical(localStorage.getItem(KEY)),
    (v,ov)=>parseCanonical(JSON.stringify(v),ov),
    (value,persist)=>{
     activeRecord=value;activeStage=persist;
     try{return callback()}finally{activeRecord=null;activeStage=null}
    },
    value=>{
     const bytes=JSON.stringify(value);
     for(const t of value.tickets){
      if(t.__imageRefs){
       for(const pointer of Object.values(t.__imageRefs)){
        const rawArr=idbAssetCache.get(PREFIX+pointer);
        if(rawArr&&localStorage.getItem(PREFIX+pointer)===null){
         localStorage.setItem(PREFIX+pointer,JSON.stringify(rawArr));
        }
       }
      }
     }
     localStorage.setItem(KEY,bytes);
     if(localStorage.getItem(KEY)!==bytes)throw Error('COMPAT_PROJECTION_FAILED');
    });
  }finally{held=false}
 });
}
function images(t,attr){
 assertRefs(t);
 const urls=t[attr]===undefined?[]:strictArray(t[attr],attr);
 const pointer=t.__imageRefs&&t.__imageRefs[attr];
 if(pointer){
  const arr=resolveAssetArray(pointer);
  return [...urls,...(arr||[])];
 }
 const stored=localStorage.getItem('img_'+t.id+'_'+attr);
 const raw=stored===null?[]:strictArray(stored,attr+' sidecar');
 return [...urls,...raw];
}
function stage(db,changed){
 if(!held)fail('Web Lock bắt buộc trước khi ghi DB.','NO_LOCK');
 const stageOverlay=new Map();
 const pendingPuts=[];
 const snapshot={schemaVersion:LOCAL_SCHEMA_VERSION,nextId:db.nextId,tombstones:Array.isArray(db.tombstones)?db.tombstones:[],outbox:Array.isArray(db.outbox)?db.outbox:[],ackedDeletes:Array.isArray(db.ackedDeletes)?db.ackedDeletes:[],tickets:db.tickets.filter(t=>!t.__demo).map(t=>{
  const row={...t};for(const attr of slots){
   delete row[attr+'_raw'];delete row[attr+'_urls'];
   if(!(changed[String(t.id)]||[]).includes(attr))continue;
   const all=parse(row[attr]||'[]',null);
   if(!Array.isArray(all))fail('Danh sách ảnh không hợp lệ');
   const raw=all.filter(x=>x&&x.data&&!x.url);
   const urls=all.filter(x=>x&&x.url).map(x=>({url:x.url,imageId:x.imageId||'',sha256:x.sha256||''}));
   const refs={...(row.__imageRefs||{})};
   if(raw.length){
    const token=uid();
    stageOverlay.set(PREFIX+token,raw);
    pendingPuts.push({key:'img:'+token,value:raw});
    refs[attr]=token;
   }else delete refs[attr];
   row.__imageRefs=refs;row[attr]=JSON.stringify(urls);
  }return row;
 })};
 for(const t of snapshot.tickets){
   if(!t.needs_sync||!t.pending_operation_id)continue;
   if(snapshot.outbox.some(op=>op.operationId===t.pending_operation_id))continue;
   snapshot.outbox=snapshot.outbox.filter(op=>
     String(op.ticketId)!==String(t.id)||op.attempted===true);
   const previous=snapshot.outbox.filter(op=>String(op.ticketId)===String(t.id));
   const last=previous.length?previous[previous.length-1]:null;
   snapshot.outbox.push({attempted:false,ticketId:t.id,operationId:t.pending_operation_id,
     revision:Number(t.local_revision)||1,
     expectedRevision:last?last.revision:(Number(t.server_revision)||0),
     row:clone(t),createdAt:Date.now(),action:'upsert'});
 }
 if(!activeStage)fail('Không có transaction canonical IDB.','IDB_NO_TRANSACTION');
 if(activePuts)for(const item of pendingPuts)activePuts.push(item);
 activeStage(snapshot);
 return snapshot;
}
function idFor(db){
 for(let n=0;n<40;n++){
  const bytes=new Uint8Array(6);crypto.getRandomValues(bytes);
  const id=bytes.reduce((v,b)=>v*256+b,0);
  if(id>1000000&&!db.tickets.some(t=>String(t.id)===String(id)))return id;
 }fail('Không tạo được ID phiếu.','ID_COLLISION');
}
function fields(base,edited){
 const omit=new Set([...slots,...slots.map(x=>x+'_raw'),...slots.map(x=>x+'_urls'),
  'needs_sync','pending_operation_id','local_revision','local_updated_at']);
 const out={};for(const [k,v] of Object.entries(edited))
  if(!omit.has(k)&&(!base||!same(base[k],v)))out[k]=v;
 return out;
}
async function commitTicket({id,base,edited,imageStore,imageBase,actor,operationId}){
 return lock(()=>{
  const db=read();const idx=id==null?-1:db.tickets.findIndex(t=>String(t.id)===String(id));
  if(id!=null&&idx<0)fail('Phiếu đã bị xóa hoặc chưa lưu.','MISSING');
  const old=idx<0?null:db.tickets[idx],changed=fields(base,edited);
  const beforeRev=Number(base&&base.local_revision)||0,nowRev=Number(old&&old.local_revision)||0;
  if(old&&nowRev!==beforeRev){
   const conflicts=Object.keys(changed).filter(k=>!same(old[k],base&&base[k])&&!same(old[k],changed[k]));
   if(conflicts.length)fail('Phiếu bị sửa ở tab khác: '+conflicts.join(', ')+'. Cần nạp lại.','CONFLICT');
  }
  const ticketId=old?old.id:idFor(db);
  const t=old?{...old,...changed}:{id:ticketId,date_received:new Date().toLocaleDateString('vi-VN'),created_by:actor,...edited};
  const modified=[];
  for(const attr of slots){
   const next=(imageStore&&imageStore[attr])||[];
   const baseline=(imageBase&&imageBase[attr])||[];
   if(!old||!same(next,baseline)){
    const current=old?images(old,attr):[];
    const dropped=new Set(baseline.filter(x=>!next.some(y=>same(x,y))).map(x=>x.imageId||x.data||x.url));
    const combined=current.filter(x=>!dropped.has(x.imageId||x.data||x.url));
    const ids=new Set(combined.map(x=>x.imageId||x.data||x.url));
    for(const x of next){const k=x.imageId||x.data||x.url;if(!ids.has(k)){combined.push(x);ids.add(k)}}
    t[attr]=JSON.stringify(combined);modified.push(attr);
   }
  }
  t.local_revision=nowRev+1;t.local_updated_at=Date.now();t.needs_sync=true;t.pending_operation_id=operationId||uid();
  if(old)db.tickets[idx]=t;else db.tickets.unshift(t);
  db.nextId=Math.max(Number(db.nextId)||1,Number(ticketId)+1);
  const committed=stage(db,{[String(ticketId)]:modified});
  return committed.tickets.find(x=>String(x.id)===String(ticketId));
 });
}
async function commitImage(ticketId,attr,photo,options){
 if(!slots.includes(attr))fail('Slot ảnh không hợp lệ');
 return lock(()=>{
  const db=read(),t=db.tickets.find(x=>String(x.id)===String(ticketId));
  if(!t)fail('Không tìm thấy phiếu nhận ảnh.','MISSING');
  const all=images(t,attr);
  if(!all.some(x=>(x.imageId||x.data)===(photo.imageId||photo.data)))all.push(photo);
  t[attr]=JSON.stringify(all);t.local_revision=(Number(t.local_revision)||0)+1;
  t.local_updated_at=Date.now();t.needs_sync=true;t.pending_operation_id=(options&&options.operationId)||uid();
  stage(db,{[String(ticketId)]:[attr]});
  return true;
 });
}
async function draft(draftId,attr,photo){
 if(!draftId||!slots.includes(attr))fail('Thiếu định danh nháp.');
 if(!photo||typeof photo.data!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(photo.data))
  fail('Dữ liệu ảnh nháp không hợp lệ.','CORRUPT_ASSET');
 if(!available())fail('Thiếu Web Locks; không thể lưu nháp bền vững.','NO_LOCK');
 if(bootstrapError||bootstrapStatus==='BLOCKED')throw (bootstrapError||fail('Kho canonical đang bị khóa.','BLOCKED'));
 const key=DRAFT+draftId,idbKey='draft:'+draftId,draftLock='tt-mobile:draft:'+draftId;
 return navigator.locks.request(draftLock,{mode:'exclusive'},async()=>{
  const db=await idbOpen();
  const committed=await new Promise((resolve,reject)=>{
   let tx,store,settled=false,nextManifest,itemId;
   const failOnce=e=>{if(!settled){settled=true;reject(e||Error('DRAFT_STORAGE_FAILED'))}};
   try{tx=db.transaction(IDB_STORE,'readwrite');store=tx.objectStore(IDB_STORE);}catch(e){failOnce(e);return}
   tx.onabort=()=>failOnce(tx.error||Object.assign(Error('DRAFT_TX_ABORTED'),{code:tx.error?.name||'DRAFT_TX_ABORTED'}));
   tx.onerror=()=>failOnce(tx.error||Object.assign(Error('DRAFT_TX_ERROR'),{code:tx.error?.name||'DRAFT_TX_ERROR'}));
   tx.oncomplete=()=>{
    if(settled)return;
    try{
     idbDraftCache.set('draft_img:'+itemId,clone(photo));
     idbDraftCache.set(idbKey,clone(nextManifest));
     let projOk=true;
     try{
      localStorage.setItem(DRAFT_IMG+itemId,JSON.stringify(photo));
      localStorage.setItem(key,JSON.stringify(nextManifest));
     }catch(e){projOk=false;projectionStale=true;lastProjectionError=e;}
     if(typeof window!=='undefined'&&typeof window.dispatchEvent==='function'){
      try{window.dispatchEvent(new CustomEvent('tt-draft-committed',{detail:{draftId,itemId,attr,durable:true,projectionStale:!projOk}}))}catch(_){}
     }
     settled=true;
     resolve({ok:true,durable:true,storage:'idb',draftId,itemId,projectionStale:!projOk});
    }catch(e){failOnce(e)}
   };
   const metaReq=store.get('meta:schema');
   const prevReq=store.get(idbKey);
   metaReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(metaReq.error||Error('DRAFT_META_ERROR'))};
   prevReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(prevReq.error)};
   prevReq.onsuccess=()=>{
    try{
     checkFencing(metaReq.result?.value||metaReq.result);
     const rawPrev=prevReq.result?.value??prevReq.result;
     const prev=(rawPrev&&typeof rawPrev==='object'&&rawPrev.slots&&typeof rawPrev.slots==='object')
       ?clone(rawPrev)
       :(idbDraftCache.has(idbKey)?clone(idbDraftCache.get(idbKey)):{slots:{},createdAt:Date.now()});
     itemId=uid();
     nextManifest={...prev,slots:{...prev.slots,[attr]:[...(Array.isArray(prev.slots[attr])?prev.slots[attr]:[]),itemId]}};
     store.put({value:clone(photo),at:Date.now()},'draft_img:'+itemId);
     store.put({value:clone(nextManifest),at:Date.now()},idbKey);
    }catch(e){try{tx.abort()}catch(_){};failOnce(e)}
   };
  });
  return committed;
 });
}
function listDrafts(){
 const byId=new Map();
 for(const [k,v] of idbDraftCache.entries()){
  if(!k.startsWith('draft:'))continue;
  if(v&&v.slots&&typeof v.slots==='object')byId.set(k.slice(6),clone(v));
 }
 for(let i=0;i<localStorage.length;i++){
   const k=localStorage.key(i);
   if(!k||!k.startsWith(DRAFT)||k.startsWith(DRAFT_IMG))continue;
   const id=k.slice(DRAFT.length);
   if(byId.has(id))continue;
   const manifest=parse(localStorage.getItem(k),null);
   if(!manifest||!manifest.slots||typeof manifest.slots!=='object')continue;
   byId.set(id,manifest);
 }
 return Array.from(byId.entries()).map(([id,manifest])=>({id,manifest}));
}
async function listDraftsAsync(){
 await loadDraftsFromIdb();
 return listDrafts();
}
function getDraftImages(draftId){
 const manifest=listDrafts().find(x=>x.id===draftId)?.manifest;
 if(!manifest)fail('Không tìm thấy ảnh nháp bền vững.','MISSING_DRAFT');
 const restored={};
 for(const attr of slots){
   restored[attr]=[];
   for(const ref of (manifest.slots[attr]||[])){
     if(typeof ref!=='string')continue;
     const value=idbDraftCache.has('draft_img:'+ref)?clone(idbDraftCache.get('draft_img:'+ref)):parse(localStorage.getItem(DRAFT_IMG+ref),null);
     if(value&&typeof value.data==='string'&&value.data.startsWith('data:image/'))
       restored[attr].push(value);
   }
 }
 return restored;
}
async function clearDraft(draftId){
 if(!draftId)return false;
 if(!available())fail('Thiếu Web Locks; chặn xóa nháp.','NO_LOCK');
 if(bootstrapError||bootstrapStatus==='BLOCKED')throw (bootstrapError||fail('Kho canonical đang bị khóa.','BLOCKED'));
 const draftLock='tt-mobile:draft:'+draftId;
 return navigator.locks.request(draftLock,{mode:'exclusive'},async()=>{
  const db=await idbOpen();
  return new Promise((resolve,reject)=>{
   let tx,store,settled=false,delRefs=[];
   const failOnce=e=>{if(!settled){settled=true;reject(e||Error('DRAFT_CLEAR_FAILED'))}};
   try{tx=db.transaction(IDB_STORE,'readwrite');store=tx.objectStore(IDB_STORE);}catch(e){failOnce(e);return}
   tx.onabort=()=>failOnce(tx.error||Object.assign(Error('DRAFT_CLEAR_ABORTED'),{code:tx.error?.name||'DRAFT_CLEAR_ABORTED'}));
   tx.onerror=()=>failOnce(tx.error||Object.assign(Error('DRAFT_CLEAR_ERROR'),{code:tx.error?.name||'DRAFT_CLEAR_ERROR'}));
   tx.oncomplete=()=>{
    if(settled)return;
    try{
     idbDraftCache.delete('draft:'+draftId);
     try{localStorage.removeItem(DRAFT+draftId);}catch(_){}
     for(const ref of delRefs){
      idbDraftCache.delete('draft_img:'+ref);
      try{localStorage.removeItem(DRAFT_IMG+ref);}catch(_){}
     }
     settled=true;
     resolve(delRefs.length>0||hadManifest);
    }catch(e){failOnce(e)}
   };
   let hadManifest=false;
   const metaReq=store.get('meta:schema');
   const mReq=store.get('draft:'+draftId);
   metaReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(metaReq.error||Error('DRAFT_CLEAR_META_ERROR'))};
   mReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(mReq.error)};
   mReq.onsuccess=()=>{
    try{
     checkFencing(metaReq.result?.value||metaReq.result);
     const idbManifest=mReq.result?.value??mReq.result;
     const memManifest=idbDraftCache.get('draft:'+draftId)||parse(localStorage.getItem(DRAFT+draftId),null);
     const manifest=(idbManifest&&idbManifest.slots)?idbManifest:memManifest;
     if(!manifest||!manifest.slots)return;
     hadManifest=true;
     store.delete('draft:'+draftId);
     for(const arr of Object.values(manifest.slots)){
      if(!Array.isArray(arr))continue;
      for(const ref of arr)if(typeof ref==='string'){delRefs.push(ref);store.delete('draft_img:'+ref);}
     }
    }catch(e){try{tx.abort()}catch(_){};failOnce(e)}
   };
  });
 });
}
async function commitDelete(ids,binding){
 if(!binding||binding.appId!=='tt-mobile'||binding.protocolVersion!==2||
    !/^[A-Za-z0-9_-]{8,}$/.test(String(binding.datasetId||''))||
    typeof binding.url!=='string')fail('Chưa có binding dataset/backend v2 đã xác minh: chặn xóa.','NO_DATASET');
 return lock(()=>{
  const db=read();db.tombstones=Array.isArray(db.tombstones)?db.tombstones:[];
  const accepted=[];
  for(const id of ids){
   const t=db.tickets.find(x=>String(x.id)===String(id));
   if(!t)continue;
   const existing=db.tombstones.find(x=>String(x.ticketId)===String(id));
   if(existing)fail('Đã có tombstone cho phiếu này.','DELETE_PENDING');
   db.tombstones.push({ticketId:id,operationId:uid(),
     revision:(Number(t.local_revision)||0)+1,expectedRevision:(db.outbox||[]).filter(op=>String(op.ticketId)===String(id)).slice(-1)[0]?.revision||(Number(t.server_revision)||0),
     datasetId:binding.datasetId,endpoint:binding.url,appId:'tt-mobile',
     protocolVersion:2,action:'delete',createdAt:Date.now()});
   accepted.push(id);
  }
  db.tickets=db.tickets.filter(t=>!accepted.some(id=>String(t.id)===String(id)));
  if(!accepted.length)return [];
  const saved=stage(db,{});
  return saved.tombstones.filter(t=>accepted.some(id=>String(t.ticketId)===String(id)));
 });
}
async function reconcileImages(id,operationId,revision,approved){
 return lock(()=>{
  const db=read(),t=db.tickets.find(x=>String(x.id)===String(id));
  if(!t||t.pending_operation_id!==operationId||Number(t.local_revision)!==Number(revision))
    return {stale:true,accepted:0,remaining:0};
  const modified=[];let accepted=0,remaining=0;
  for(const attr of slots){
    const existing=images(t,attr);let touched=false;
    const revised=existing.map(x=>{
      if(!x||!x.data||x.url)return x;
      const duplicateLegacy=existing.filter(y=>y&&y.data===x.data&&!y.imageId).length>1;
      const proof=approved.find(p=>p.attr===attr&&p.data===x.data&&p.sha256&&p.imageId&&p.url&&
        (x.imageId ? p.imageId===x.imageId : !duplicateLegacy));
      if(!proof)return x;
      touched=true;accepted++;
      return {imageId:proof.imageId,sha256:proof.sha256,url:proof.url};
    });
    remaining+=revised.filter(x=>x&&x.data&&!x.url).length;
    if(touched){t[attr]=JSON.stringify(revised);modified.push(attr);}
  }
  if(modified.length){
    stage(db,{[String(id)]:modified});
  }
  return {stale:false,accepted,remaining};
 });
}
async function markOperationAttempted(operationId){
 return lock(()=>{
  const db=read(),op=(db.outbox||[]).find(x=>x.operationId===operationId);
  if(!op)return false;
  if(op.attempted===true)return true;
  op.attempted=true;
  stage(db,{});
  return true;
 });
}
async function acknowledgeTicket(id,operationId,revision){
 return lock(()=>{
  const db=read(),queue=Array.isArray(db.outbox)?db.outbox:[],
    idx=queue.findIndex(x=>String(x.ticketId)===String(id)&&x.operationId===operationId&&Number(x.revision)===Number(revision));
  if(idx<0)return false;
  const t=db.tickets.find(x=>String(x.id)===String(id));
  db.outbox=queue.filter((_,n)=>n!==idx);
  if(t){
    t.server_revision=Math.max(Number(t.server_revision)||0,Number(revision));
    if(!db.outbox.some(x=>String(x.ticketId)===String(id))&&t.pending_operation_id===operationId){
      delete t.needs_sync;delete t.pending_operation_id;
    }
  }
  stage(db,{});
  return true;
 });
}
async function markAllForSync(){
 return lock(()=>{
   const db=read();let changed=0;
   for(const t of db.tickets){
     if(t.needs_sync)continue;
     t.needs_sync=true;t.local_revision=(Number(t.local_revision)||0)+1;
     t.local_updated_at=Date.now();t.pending_operation_id=uid();changed++;
   }
   if(!changed)return {count:0};
   stage(db,{});
   return {count:changed};
 });
}
async function ensureOutbox(){
 return lock(()=>{
  const db=read(),all=db.tickets.filter(t=>t.needs_sync&&t.pending_operation_id);
  if(all.every(t=>(db.outbox||[]).some(o=>o.operationId===t.pending_operation_id)))return true;
  stage(db,{});
  return true;
 });
}
function ttPersistRemoteDeleteWatermark(db, marker){
 const existing=Array.isArray(db.ackedDeletes)?db.ackedDeletes:[];
 const related=existing.filter(x=>String(x.ticketId)===String(marker.ticketId)&&
   x.datasetId===marker.datasetId&&x.endpoint===marker.endpoint);
 const highest=related.reduce((n,x)=>Math.max(n,Number(x.revision)),-1);
 const winner=highest>Number(marker.revision)?
   related.find(x=>Number(x.revision)===highest):
   highest===Number(marker.revision)?
    related.find(x=>Number(x.revision)===highest):marker;
 const revised=[...existing.filter(x=>String(x.ticketId)!==String(marker.ticketId)||
    x.datasetId!==marker.datasetId||x.endpoint!==marker.endpoint),winner];
 if(JSON.stringify(existing)===JSON.stringify(revised))return false;
 db.ackedDeletes=revised;
 return true;
}
async function applyServerSnapshot(rows,binding){
 if(!binding||binding.appId!=='tt-mobile'||binding.protocolVersion!==2||
    !/^[A-Za-z0-9_-]{8,}$/.test(String(binding.datasetId||''))||
    typeof binding.url!=='string'||!binding.url||!Array.isArray(rows))
   fail('Snapshot thiếu binding đã xác minh.','SNAPSHOT_INVALID');
 return lock(()=>{
  const db=read(),pending=new Map(),deleted=new Map(),
    updates=[],removals=[],graveUpdates=[],conflicts=[],skipped=[],seen=new Set();
  const register=(map,id,revision,kind,source)=>{
   const key=String(id),previous=map.get(key);
   if(!previous||Number(previous.revision)<Number(revision))
     map.set(key,{revision:Number(revision),kind,source});
  };
  for(const op of [...(db.outbox||[]),...(db.tombstones||[])]){
   const id=String(op.ticketId),dataset=op.datasetId,endpoint=op.endpoint;
   if((dataset&&dataset!==binding.datasetId)||
      (endpoint&&endpoint!==binding.url))
     register(pending,id,op.revision,'binding_mismatch',op);
   else register(pending,id,op.revision,op.action==='delete'?'delete':'upsert',op);
  }
  for(const t of db.tickets){
   if(t.needs_sync||t.pending_operation_id)
     register(pending,t.id,t.local_revision,'upsert',t);
  }
  for(const tomb of db.tombstones||[])
    register(deleted,tomb.ticketId,tomb.revision,'pending_delete',tomb);
  for(const acked of db.ackedDeletes||[]){
   if(acked.datasetId!==binding.datasetId||acked.endpoint!==binding.url)
     register(pending,acked.ticketId,acked.revision,'binding_mismatch',acked);
   else register(deleted,acked.ticketId,acked.revision,'acked_delete',acked);
  }
  for(const entry of rows){
   if(!entry||entry.ticketId===null||entry.ticketId===undefined||
      typeof entry.owner!=='string'||!Number.isSafeInteger(Number(entry.revision))||
      Number(entry.revision)<0||typeof entry.deleted!=='boolean')
     fail('Snapshot chứa row không hợp lệ.','SNAPSHOT_INVALID');
   const id=String(entry.ticketId),rev=Number(entry.revision);
   if(seen.has(id))fail('Snapshot trùng ID phiếu.','SNAPSHOT_DUPLICATE');
   seen.add(id);
   const old=db.tickets.find(t=>String(t.id)===id);
   const queued=pending.get(id),grave=deleted.get(id);
   if(queued?.kind==='binding_mismatch'){
     conflicts.push(id+':DATASET_OR_ENDPOINT');continue;
   }
   if(queued||grave){
    const watermark=Math.max(Number(queued?.revision)||0,Number(grave?.revision)||0);
    if(rev>=watermark&&queued){
      conflicts.push(id+':REMOTE_CONFLICT_PENDING');continue;
    }
    if(rev>watermark&&grave){
      if(!queued&&entry.deleted===true){
       if(entry.row!==null&&entry.row!==undefined){
        conflicts.push(id+':TOMBSTONE_WITH_ROW');continue;
       }
       if(old&&rev<=Number(old.server_revision||0)){
        skipped.push({ticketId:id,reason:'STALE_DELETE_VS_LOCAL_ACK',
          serverRevision:rev});continue;
       }
       graveUpdates.push({id,revision:rev});
       if(old)removals.push({id,revision:rev});
       continue;
      }
      conflicts.push(id+':REMOTE_NEWER_THAN_DELETE');continue;
    }
    skipped.push({ticketId:id,reason:'LOCAL_OPERATION_OR_DELETE_WATERMARK',
      serverRevision:rev,localRevision:watermark});continue;
   }
   const known=Number(old?.server_revision)||0;
   if(old&&rev<known){
    skipped.push({ticketId:id,reason:'STALE_REMOTE_REVISION',
      serverRevision:rev,localRevision:known});continue;
   }
   if(entry.deleted===true){
    if(entry.row!==null&&entry.row!==undefined){
      conflicts.push(id+':TOMBSTONE_WITH_ROW');continue;
    }
    if(old&&rev===known){
      conflicts.push(id+':EQUAL_REVISION_DELETE_MISMATCH');continue;
    }
    graveUpdates.push({id,revision:rev});
    if(old)removals.push({id,revision:rev});
    continue;
   }
   if(!entry.row||typeof entry.row!=='object'||Array.isArray(entry.row)){
     conflicts.push(id+':ROW_INVALID');continue;
   }
   if(String(entry.row.id??id)!==id){
     conflicts.push(id+':ROW_ID_MISMATCH');continue;
   }
   const clean={...entry.row,id:entry.ticketId,server_revision:rev,
     local_revision:Math.max(Number(entry.row.local_revision)||0,rev)};
   delete clean.__imageRefs;delete clean.pending_operation_id;delete clean.needs_sync;
   assertRefs(clean);
   if(old&&rev===known){
    const ignored=new Set(['id','local_revision','server_revision',
      'local_updated_at','pending_operation_id','needs_sync','__imageRefs','_lastOperationId']);
    const sameField=(k,a,b)=>{
     if(same(a,b))return true;
     if(k==='updated_by'&&a===undefined)return true;
     if(slots.includes(k)){
      try{
       const norm=v=>strictArray(v,k).map(x=>x&&typeof x==='object'&&!Array.isArray(x)
        ?{imageId:x.imageId??null,sha256:x.sha256??null,url:x.url??null,data:x.data??null,name:x.name??null}:x);
       return same(norm(a),norm(b));
      }catch(_){return false;}
     }
     return false;
    };
    if(Object.keys(entry.row).some(k=>!ignored.has(k)&&
       !sameField(k,old[k],entry.row[k]))){
      conflicts.push(id+':EQUAL_REVISION_CONTENT_MISMATCH');continue;
    }
    skipped.push({ticketId:id,reason:'ALREADY_ACKNOWLEDGED',
      serverRevision:rev});continue;
   }
   updates.push(clean);
  }
  if(conflicts.length)
    fail('Snapshot xung đột. Không thay đổi bất kỳ phiếu nào: '+conflicts.join(','),
      'SNAPSHOT_CONFLICT');
  if(!updates.length&&!removals.length&&!graveUpdates.length)
    return {applied:0,deleted:0,skipped:skipped.length,outbox:db.outbox.length,
      tombstones:db.tombstones.length};
  for(const r of graveUpdates)
   ttPersistRemoteDeleteWatermark(db,{ticketId:r.id,revision:r.revision,
     datasetId:binding.datasetId,endpoint:binding.url,source:'snapshot'});
  for(const r of removals)
   db.tickets=db.tickets.filter(t=>String(t.id)!==r.id);
  for(const row of updates){
   const idx=db.tickets.findIndex(t=>String(t.id)===String(row.id));
   if(idx>=0)db.tickets[idx]=row;else db.tickets.push(row);
   const numeric=Number(row.id);
   if(Number.isSafeInteger(numeric)&&numeric>=0)
     db.nextId=Math.max(Number(db.nextId)||1,numeric+1);
  }
  pendingActiveBinding={datasetId:binding.datasetId,endpoint:binding.url};
  const saved=stage(db,{});
  return {applied:updates.length,deleted:removals.length,skipped:skipped.length,
    outbox:saved.outbox.length,tombstones:saved.tombstones.length};
 });
}
async function acknowledgeDelete(ack,op){
 return lock(()=>{
  const db=read(),all=Array.isArray(db.tombstones)?db.tombstones:[];
  const found=all.find(x=>x.operationId===op.operationId&&x.datasetId===op.datasetId&&x.revision===op.revision);
  if(!found)return false;
  const receipt=ack?.ack||ack;
  if(!receipt||receipt.accepted!==true||receipt.operationComplete!==true||
     receipt.datasetId!==found.datasetId||receipt.appId!==found.appId||
     Number(receipt.protocolVersion)!==2||receipt.action!=='delete'||
     String(receipt.ticketId)!==String(found.ticketId)||
     receipt.operationId!==found.operationId||
     Number(receipt.acceptedRevision)!==Number(found.revision))
    fail('ACK delete không khớp đầy đủ.','DELETE_ACK_PROOF_INVALID');
  ttPersistRemoteDeleteWatermark(db,{ticketId:found.ticketId,
    revision:Number(found.revision),datasetId:found.datasetId,
    endpoint:found.endpoint,source:'delete_ack'});
  db.tombstones=all.filter(x=>x!==found);
  stage(db,{});
  return true;
 });
}
async function sha256Hex(text){
 const bytes=new TextEncoder().encode(text);
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
}
async function sha256Base64DataUrl(dataUrl){
 if(typeof dataUrl!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl))
  fail('Dữ liệu ảnh base64 không hợp lệ trong recovery package.','CORRUPT_ASSET');
 const raw=atob(dataUrl.split(',')[1]);
 const bytes=new Uint8Array(raw.length);
 for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
}
function inferActiveBinding(snap,metaRec){
 const candidates=[];
 for(const list of [snap?.outbox,snap?.tombstones,snap?.ackedDeletes]){
  for(const x of (list||[])){
   if(x&&typeof x.datasetId==='string'&&x.datasetId&&(x.endpoint||x.url))
    candidates.push({datasetId:x.datasetId,endpoint:x.endpoint||x.url});
  }
 }
 const metaB=metaRec?.activeBinding||metaRec?.value?.activeBinding;
 if(metaB&&typeof metaB.datasetId==='string'&&metaB.datasetId&&(metaB.endpoint||metaB.url))
  candidates.push({datasetId:metaB.datasetId,endpoint:metaB.endpoint||metaB.url});
 if(typeof window!=='undefined'){
  const s=window.TTBackendSession||window.ttBackendV2;
  if(s&&s.datasetId&&s.url)candidates.push({datasetId:s.datasetId,endpoint:s.url});
  try{
   const b=JSON.parse(localStorage.getItem('tt_v2_backend_binding')||'null');
   if(b&&b.datasetId&&b.url)candidates.push({datasetId:b.datasetId,endpoint:b.url});
  }catch(_){}
 }
 return candidates[0]||null;
}
function validateTicketRevisionStrict(t,label){
 if(!t||typeof t!=='object'||typeof t.local_revision!=='number'||!Number.isSafeInteger(t.local_revision)||t.local_revision<0)
  fail('Thiếu hoặc sai kiểu local_revision ('+label+').','RECOVERY_REVISION_INVALID');
 if(t.server_revision!==undefined&&(typeof t.server_revision!=='number'||!Number.isSafeInteger(t.server_revision)||t.server_revision<0))
  fail('Sai kiểu server_revision ('+label+').','RECOVERY_REVISION_INVALID');
}
async function inspectCanonicalClosure(canon,assetResolver,strictRevisions){
 const reachablePointers=new Set();
 const imageIndex=new Map();
 const assetDigests={};
 const rowsToCheck=[];
 for(const t of (canon.tickets||[])){
  if(strictRevisions)validateTicketRevisionStrict(t,'ticket:'+t?.id);
  rowsToCheck.push({row:t,source:'ticket:'+t?.id});
 }
 for(const op of (canon.outbox||[])){
  if(!op||typeof op!=='object'||typeof op.operationId!=='string'||!op.operationId||
     typeof op.revision!=='number'||!Number.isSafeInteger(op.revision)||op.revision<0)
   fail('Outbox operation sai schema trong recovery.','RECOVERY_PACKAGE_INVALID');
  if(op.row&&typeof op.row==='object'){
   if(strictRevisions)validateTicketRevisionStrict(op.row,'outbox:'+op.operationId);
   rowsToCheck.push({row:op.row,source:'outbox:'+op.operationId});
  }
 }
 for(const {row,source} of rowsToCheck){
  const tid=String(row.id);
  if(row.__imageRefs&&typeof row.__imageRefs==='object'){
   for(const [attr,pointer] of Object.entries(row.__imageRefs)){
    if(!slots.includes(attr)||typeof pointer!=='string'||!/^[a-zA-Z0-9_-]+$/.test(pointer))
     fail('Pointer sidecar không hợp lệ ('+source+').','CORRUPT_ASSET');
    reachablePointers.add(pointer);
    const items=assetResolver(pointer);
    if(items===null||!Array.isArray(items))fail('Thiếu asset sidecar '+pointer+' cho '+source,'CORRUPT_ASSET');
    const digests=[];
    for(const item of items){
     if(!item||typeof item!=='object'||typeof item.data!=='string')fail('Asset sidecar hỏng ('+pointer+').','CORRUPT_ASSET');
     const sha=await sha256Base64DataUrl(item.data);
     if(item.imageId!==undefined){
      if(typeof item.imageId!=='string'||!item.imageId)fail('imageId không hợp lệ ('+pointer+').','CORRUPT_ASSET');
      const prev=imageIndex.get(item.imageId);
      if(prev&&(prev.ticketId!==tid||prev.slot!==attr||prev.sha!==sha))
       fail('Xung đột duplicate/cross-resource imageId: '+item.imageId,'RECOVERY_IMAGE_ID_CONFLICT');
      imageIndex.set(item.imageId,{ticketId:tid,slot:attr,sha});
     }
     digests.push({imageId:item.imageId||'',sha256:sha,slot:attr,ticketId:tid,name:item.name||''});
    }
    assetDigests[pointer]=digests;
   }
  }
  for(const attr of slots){
   if(row[attr]!==undefined){
    const arr=strictArray(row[attr],attr);
    for(const item of arr){
     if(item.imageId){
      const sha=item.sha256?String(item.sha256).toUpperCase():(item.data?await sha256Base64DataUrl(item.data):null);
      const prev=imageIndex.get(item.imageId);
      if(prev&&(prev.ticketId!==tid||prev.slot!==attr||(sha&&prev.sha&&prev.sha!==sha)))
       fail('Xung đột imageId giữa slot/receipt/raw: '+item.imageId,'RECOVERY_IMAGE_ID_CONFLICT');
      if(sha)imageIndex.set(item.imageId,{ticketId:tid,slot:attr,sha});
     }
    }
   }
  }
 }
 return {reachablePointers,assetDigests};
}
function parseNotesNamespaceKey(nk){
 const prefix='notes:tt:notes:v3:';
 if(typeof nk!=='string'||!nk.startsWith(prefix))
  fail('Namespace ghi chú không hợp lệ: '+String(nk),'NOTES_NAMESPACE_INVALID');
 const rest=nk.slice(prefix.length);
 const parts=rest.split(':');
 if(parts.length!==2||!parts[0]||!parts[1])
  fail('Namespace ghi chú sai cấu trúc dataset/owner: '+nk,'NOTES_NAMESPACE_INVALID');
 return {dataset:parts[0],username:parts[1],owner:parts[1],namespaceKey:nk};
}
function validNotesId(id){
 return (typeof id==='string'&&id.length>0)||(typeof id==='number'&&Number.isFinite(id));
}
function validNotesServerWatermark(value,minimum=0){
 return typeof value==='number'&&Number.isFinite(value)&&Number.isSafeInteger(value)&&value>=0&&value>=minimum;
}
function verifyNotesSuccessorChain(ctx,anchor,head,outbox){
 if(!anchor||!head||!Array.isArray(outbox)||
    typeof anchor.operationId!=='string'||!anchor.operationId||
    !validNotesId(anchor.recordId)||
    anchor.datasetId!==ctx.dataset||anchor.owner!==ctx.username||
    !Number.isSafeInteger(anchor.revision)||anchor.revision<1||
    !Number.isSafeInteger(anchor.expectedRevision)||
    anchor.expectedRevision<0||anchor.expectedRevision>=anchor.revision||
    !Number.isSafeInteger(head.revision)||head.revision<anchor.revision||
    String(head.id)!==String(anchor.recordId))
  fail('Chuỗi kế thừa ACK/WAL ghi chú không hợp lệ.','NOTES_ACK_CHAIN_INVALID');
 const perRecord=outbox.filter(o=>String(o.recordId)===String(anchor.recordId));
 const original=perRecord.find(o=>o.operationId===anchor.operationId);
 if(original&&(
    original.revision!==anchor.revision||
    original.expectedRevision!==anchor.expectedRevision||
    original.owner!==anchor.owner||original.datasetId!==anchor.datasetId||
    original.action!=='notes_write'||
    (original.deleted===true)!==(anchor.deleted===true)))
  fail('Anchor ACK không khớp outbox gốc.','NOTES_ACK_CHAIN_ANCHOR_MISMATCH');
 if(perRecord.some(o=>o.revision<=anchor.revision&&o.operationId!==anchor.operationId))
  fail('Outbox còn operation cũ hơn anchor ACK.','NOTES_ACK_CHAIN_OLD_PENDING');
 const successors=perRecord.filter(o=>o.revision>anchor.revision).sort((a,b)=>a.revision-b.revision);
 let rev=anchor.revision,tail=original||anchor;
 for(const next of successors){
  if(next.action!=='notes_write'||next.owner!==ctx.username||
     next.datasetId!==ctx.dataset||
     String(next.recordId)!==String(anchor.recordId)||
     typeof next.operationId!=='string'||!next.operationId||
     next.operationId===tail.operationId||
     !Number.isSafeInteger(next.revision)||
     !Number.isSafeInteger(next.expectedRevision)||
     next.expectedRevision!==rev||next.revision!==rev+1||
     typeof next.record!=='object'||!next.record||Array.isArray(next.record))
   fail('Operation kế thừa WAL ghi chú không hợp lệ.','NOTES_ACK_CHAIN_SUCCESSOR_INVALID');
  rev=next.revision;tail=next;
 }
 if(head.revision!==rev||(head.deleted===true)!==(tail.deleted===true))
  fail('Head ghi chú không khớp đỉnh chuỗi WAL.','NOTES_ACK_CHAIN_HEAD_MISMATCH');
 if(successors.length){
  if(head.text!==tail.record.text||!!head.pinned!==!!tail.record.pinned||head.ts!==tail.record.ts)
   fail('Payload head ghi chú lệch operation kế thừa cuối.','NOTES_ACK_CHAIN_PAYLOAD_MISMATCH');
 }
 return {acceptedRevision:anchor.revision,headRevision:rev,successorIds:successors.map(o=>o.operationId),headDeleted:head.deleted===true};
}
function validateNotesCanonicalPayload(ctx,value,opts){
 if(!ctx||typeof ctx.username!=='string'||!ctx.username||typeof ctx.dataset!=='string'||!ctx.dataset)
  fail('Context ghi chú không hợp lệ.','NOTES_CONTEXT_INVALID');
 if(!value||typeof value!=='object'||Array.isArray(value)||
    !Array.isArray(value.rows)||!Array.isArray(value.outbox)||!Array.isArray(value.ack))
  fail('Cấu trúc Notes canonical hỏng.','NOTES_CANONICAL_CORRUPT');
 const rowsById=new Map(),outboxByOp=new Map(),ackOps=new Set();
 for(const n of value.rows){
  if(!n||typeof n!=='object'||Array.isArray(n)||!validNotesId(n.id)||
     typeof n.text!=='string'||
     typeof n.revision!=='number'||!Number.isSafeInteger(n.revision)||n.revision<0||
     (n.deleted!==undefined&&typeof n.deleted!=='boolean')||
     (n.pinned!==undefined&&typeof n.pinned!=='boolean')||
     (n.serverRevision!==undefined&&!validNotesServerWatermark(n.serverRevision))||
     rowsById.has(String(n.id)))
   fail('Bản ghi ghi chú không hợp lệ.','NOTES_CANONICAL_ROW_INVALID');
  rowsById.set(String(n.id),n);
 }
 for(const o of value.outbox){
  if(!o||typeof o!=='object'||Array.isArray(o)||
     typeof o.operationId!=='string'||!o.operationId||
     outboxByOp.has(o.operationId)||
     !validNotesId(o.recordId)||
     o.owner!==ctx.username||o.datasetId!==ctx.dataset||
     o.action!=='notes_write'||
     typeof o.revision!=='number'||!Number.isSafeInteger(o.revision)||o.revision<1||
     typeof o.expectedRevision!=='number'||!Number.isSafeInteger(o.expectedRevision)||
     o.expectedRevision<0||o.expectedRevision>=o.revision||
     (o.deleted!==undefined&&typeof o.deleted!=='boolean')||
     !o.record||typeof o.record!=='object'||Array.isArray(o.record)||
     typeof o.record.text!=='string')
   fail('Outbox ghi chú không hợp lệ.','NOTES_CANONICAL_OUTBOX_INVALID');
  outboxByOp.set(o.operationId,o);
 }
 for(const marker of value.ack){
  if(!marker||typeof marker!=='object'||Array.isArray(marker)||
     typeof marker.operationId!=='string'||!marker.operationId||
     ackOps.has(marker.operationId)||
     !validNotesId(marker.recordId)||
     marker.accepted!==true||
     marker.owner!==ctx.username||marker.datasetId!==ctx.dataset||
     typeof marker.revision!=='number'||!Number.isSafeInteger(marker.revision)||marker.revision<1||
     typeof marker.expectedRevision!=='number'||!Number.isSafeInteger(marker.expectedRevision)||
     marker.expectedRevision<0||marker.expectedRevision>=marker.revision||
     (marker.deleted!==undefined&&typeof marker.deleted!=='boolean'))
   fail('ACK WAL ghi chú không hợp lệ.','NOTES_CANONICAL_ACK_INVALID');
  ackOps.add(marker.operationId);
  const pending=outboxByOp.get(marker.operationId);
  if(pending&&(
     String(pending.recordId)!==String(marker.recordId)||
     pending.revision!==marker.revision||
     pending.expectedRevision!==marker.expectedRevision||
     pending.owner!==marker.owner||pending.datasetId!==marker.datasetId||
     pending.action!=='notes_write'||
     (pending.deleted===true)!==(marker.deleted===true)))
   fail('ACK WAL lệch binding outbox ghi chú.','NOTES_CANONICAL_ACK_BINDING_MISMATCH');
  const row=rowsById.get(String(marker.recordId));
  verifyNotesSuccessorChain(ctx,marker,row,value.outbox);
  if(opts&&opts.strictRetiredWatermark&&!pending&&!validNotesServerWatermark(row.serverRevision,marker.revision))
   fail('Marker ACK thiếu serverRevision watermark hợp lệ.','NOTES_ACK_JOURNAL_RECOVERY_REQUIRED');
 }
}
async function readFullIdbSnapshotInLock(){
 const db=await idbOpen();
 return new Promise((resolve,reject)=>{
  let tx,store,metaRec,ticketsRec,settled=false;
  const imgRecords=new Map(),noteRecords=new Map();
  const failOnce=e=>{if(!settled){settled=true;reject(e||Error('IDB_SNAPSHOT_READ_FAILED'))}};
  try{tx=db.transaction(IDB_STORE,'readonly');store=tx.objectStore(IDB_STORE);}catch(e){failOnce(e);return}
  tx.onabort=()=>failOnce(tx.error||Error('IDB_ABORT'));
  tx.onerror=()=>failOnce(tx.error||Error('IDB_ERROR'));
  const metaReq=store.get('meta:schema');
  const tReq=store.get('tickets');
  metaReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(metaReq.error||Error('IDB_META_READ_ERROR'))};
  tReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(tReq.error||Error('IDB_TICKETS_READ_ERROR'))};
  if(typeof store.openCursor==='function'){
   const cur=store.openCursor();
   cur.onsuccess=ev=>{
    const c=ev.target.result;if(!c)return;
    const k=String(c.key),v=c.value;
    if(k.startsWith('img:'))imgRecords.set(k.slice(4),v&&v.value!==undefined?v.value:v);
    else if(k.startsWith('notes:'))noteRecords.set(k,v);
    c.continue();
   };
   cur.onerror=ev=>{try{tx.abort()}catch(_){};failOnce(ev?.target?.error||cur.error||Error('IDB_CURSOR_ERROR'))};
  }
  tx.oncomplete=()=>{
   if(settled)return;
   try{
    metaRec=metaReq.result&&metaReq.result.value!==undefined?metaReq.result.value:(metaReq.result??null);
    ticketsRec=tReq.result;
    checkFencing(metaRec);
    settled=true;
    resolve({metaRec,ticketsRec,imgRecords,noteRecords});
   }catch(e){failOnce(e)}
  };
 });
}
async function exportRecoveryPackage(){
 if(!available())fail('Thiếu Web Locks; chặn export gói phục hồi.','NO_LOCK');
 if(bootstrapError||bootstrapStatus==='BLOCKED')throw (bootstrapError||fail('Kho canonical đang bị khóa.','BLOCKED'));
 return navigator.locks.request(LOCK,{mode:'exclusive'},async()=>{
  const {metaRec,ticketsRec,imgRecords,noteRecords}=await readFullIdbSnapshotInLock();
  const fromIdb=ticketsRec!==undefined;
  const snap=fromIdb
    ?clone(ticketsRec.value)
    :parseCanonical(localStorage.getItem(KEY));
  const resolver=pointer=>{
   if(imgRecords.has(pointer))return clone(imgRecords.get(pointer));
   if(!fromIdb){
    const raw=localStorage.getItem(PREFIX+pointer);
    return raw===null?null:strictArray(raw,'ảnh '+pointer);
   }
   return null;
  };
  parseCanonical(JSON.stringify(snap),new Map(Array.from(imgRecords.entries()).map(([k,v])=>[PREFIX+k,v])));
  const {reachablePointers,assetDigests}=await inspectCanonicalClosure(snap,resolver,false);
  const assets={};
  for(const ptr of reachablePointers){
   assets[ptr]=resolver(ptr);
  }
  const notes={};
  for(const [nk,rec] of noteRecords.entries()){
   const ctx=parseNotesNamespaceKey(nk);
   const val=clone(rec&&rec.value!==undefined?rec.value:rec);
   validateNotesCanonicalPayload(ctx,val,{strictRetiredWatermark:true});
   notes[nk]=val;
  }
  const epoch=fromIdb?(Number(ticketsRec.epoch)||0):0;
  const lineageId=(metaRec&&metaRec.lineageId)||currentLineageId||null;
  const binding=inferActiveBinding(snap,metaRec);
  const payload={
   packageVersion:2,
   packageId:uid(),
   exportedAt:new Date().toISOString(),
   protocolVersion:CLIENT_PROTOCOL_VERSION,
   schemaVersion:LOCAL_SCHEMA_VERSION,
   lineageId,
   binding,
   epoch,
   scope:{tickets:true,outbox:true,tombstones:true,ackedDeletes:true,outboxAssets:true,notes:true,draftsIncluded:false},
   canonical:snap,
   notes,
   assets,
   assetDigests
  };
  const sha256=await sha256Hex(JSON.stringify(payload));
  return {...payload,sha256};
 });
}
function checkRollbackSafety(pkg,validated,assetMap,currentMeta,currentTicketsRec,curNotesRaw,expectedBinding){
 const current=currentTicketsRec!==undefined?parseCanonical(JSON.stringify(currentTicketsRec.value)):parseCanonical(localStorage.getItem(KEY));
 const curNotesClean={};
 for(const [nk,rec] of curNotesRaw.entries())curNotesClean[nk]=rec&&rec.value!==undefined?rec.value:rec;
 const pkgNotes=pkg.notes&&typeof pkg.notes==='object'?pkg.notes:{};
 const curHasNotes=Object.values(curNotesClean).some(n=>n&&((n.rows&&n.rows.length)||(n.outbox&&n.outbox.length)||(n.ack&&n.ack.length)));
 const lsRawEmpty=localStorage.getItem(KEY)===null;
 const isClean=(currentTicketsRec===undefined&&lsRawEmpty&&!curHasNotes)||
   (current.tickets.length===0&&current.outbox.length===0&&current.tombstones.length===0&&(current.ackedDeletes||[]).length===0&&!curHasNotes);

 if(expectedBinding){
  const expUrl=expectedBinding.url||expectedBinding.endpoint||'';
  if(expectedBinding.datasetId&&(!pkg.binding||pkg.binding.datasetId!==expectedBinding.datasetId||(expUrl&&pkg.binding.endpoint&&pkg.binding.endpoint!==expUrl)))
   fail('Gói khôi phục không khớp binding dataset/endpoint.','RECOVERY_BINDING_MISMATCH');
  const checkB=b=>{
   if(!b)return;
   if((expectedBinding.datasetId&&b.datasetId&&b.datasetId!==expectedBinding.datasetId)||
      (expUrl&&b.endpoint&&b.endpoint!==expUrl))
    fail('Gói khôi phục không khớp binding dataset/endpoint.','RECOVERY_BINDING_MISMATCH');
  };
  checkB(pkg.binding);
  for(const op of [...(validated.outbox||[]),...(validated.tombstones||[]),...(validated.ackedDeletes||[])]){
   if(op&&op.datasetId)checkB({datasetId:op.datasetId,endpoint:op.endpoint||op.url});
  }
 }
 if(!isClean){
  const curBinding=inferActiveBinding(current,currentMeta);
  if(pkg.binding&&curBinding&&(pkg.binding.datasetId!==curBinding.datasetId||(pkg.binding.endpoint&&curBinding.endpoint&&pkg.binding.endpoint!==curBinding.endpoint)))
   fail('Gói khôi phục thuộc dataset/endpoint khác với kho hiện tại.','RECOVERY_BINDING_MISMATCH');
  const normCan=c=>({schemaVersion:c.schemaVersion||3,nextId:c.nextId||1,tickets:c.tickets||[],tombstones:c.tombstones||[],outbox:c.outbox||[],ackedDeletes:c.ackedDeletes||[]});
  const identicalState=same(normCan(current),normCan(validated))&&same(curNotesClean,pkgNotes);
  const curLineage=currentMeta&&typeof currentMeta.lineageId==='string'?currentMeta.lineageId:null;
  if(curLineage&&pkg.lineageId!==curLineage)
   fail('Từ chối khôi phục chéo lineage lên kho đang có dữ liệu.','RECOVERY_CROSS_LINEAGE');
  if(identicalState)return {isClean,identical:true};
  if((current.outbox||[]).length>0||(current.tombstones||[]).length>0)
   fail('Không cho phép rollback khi kho hiện tại còn outbox hoặc tombstone chưa đồng bộ.','ROLLBACK_POST_MIGRATION_EDITS');
  const pkgAckMap=new Map((validated.ackedDeletes||[]).map(m=>[String(m.ticketId)+'|'+m.datasetId+'|'+m.endpoint,Number(m.revision)||0]));
  for(const m of (current.ackedDeletes||[])){
   const key=String(m.ticketId)+'|'+m.datasetId+'|'+m.endpoint;
   if(!pkgAckMap.has(key)||Number(m.revision)>pkgAckMap.get(key))
    fail('Kho hiện tại có delete watermark mới hơn gói khôi phục.','ROLLBACK_POST_MIGRATION_EDITS');
  }
  const curById=new Map(current.tickets.map(t=>[String(t.id),t]));
  const pkgById=new Map(validated.tickets.map(t=>[String(t.id),t]));
  for(const pt of validated.tickets){
   validateTicketRevisionStrict(pt,'pkg:'+pt?.id);
   if(!curById.has(String(pt.id)))
    fail('Phiếu '+pt.id+' đã bị xóa sau thời điểm gói khôi phục; chặn hồi sinh ngoài quy trình.','ROLLBACK_POST_MIGRATION_EDITS');
  }
  for(const ct of current.tickets){
   validateTicketRevisionStrict(ct,'current:'+ct?.id);
   const pt=pkgById.get(String(ct.id));
   if(!pt)fail('Kho hiện tại có phiếu mới #'+ct.id+' chưa có trong gói khôi phục.','ROLLBACK_POST_MIGRATION_EDITS');
   if(ct.local_revision>pt.local_revision||(Number(ct.server_revision)||0)>(Number(pt.server_revision)||0))
    fail('Phiếu #'+ct.id+' trên máy mới hơn gói khôi phục ('+ct.local_revision+' > '+pt.local_revision+').','ROLLBACK_POST_MIGRATION_EDITS');
   if(ct.local_revision===pt.local_revision&&!same(ct,pt))
    fail('Phiếu #'+ct.id+' cùng revision nhưng dữ liệu khác với gói khôi phục.','ROLLBACK_POST_MIGRATION_EDITS');
  }
  for(const [nk,cn] of Object.entries(curNotesClean)){
   if(!cn)continue;
   if((cn.outbox||[]).length>0||(cn.ack||[]).length>0)
    fail('Ghi chú hiện tại còn outbox/WAL chờ; chặn rollback.','ROLLBACK_POST_MIGRATION_EDITS');
   const pn=pkgNotes[nk];
   if(!pn){
    if((cn.rows||[]).length>0)fail('Kho hiện tại có namespace ghi chú mới sau gói khôi phục.','ROLLBACK_POST_MIGRATION_EDITS');
    continue;
   }
   const pNotesMap=new Map((pn.rows||[]).map(n=>[String(n.id),n]));
   const cNotesMap=new Map((cn.rows||[]).map(n=>[String(n.id),n]));
   for(const pid of pNotesMap.keys())if(!cNotesMap.has(pid))fail('Ghi chú đã thay đổi/xóa sau gói khôi phục.','ROLLBACK_POST_MIGRATION_EDITS');
   for(const [cid,cNote] of cNotesMap.entries()){
    if(typeof cNote.revision!=='number'||!Number.isSafeInteger(cNote.revision)||cNote.revision<0)
     fail('Revision ghi chú hiện tại không hợp lệ.','RECOVERY_REVISION_INVALID');
    const pNote=pNotesMap.get(cid);
    if(!pNote)fail('Kho hiện tại có ghi chú mới chưa có trong gói.','ROLLBACK_POST_MIGRATION_EDITS');
    if(cNote.revision>pNote.revision||(Number(cNote.serverRevision)||0)>(Number(pNote.serverRevision)||0))
     fail('Ghi chú hiện tại có revision mới hơn gói khôi phục.','ROLLBACK_POST_MIGRATION_EDITS');
    if(cNote.revision===pNote.revision&&!same(cNote,pNote))
     fail('Ghi chú hiện tại cùng revision nhưng khác nội dung.','ROLLBACK_POST_MIGRATION_EDITS');
   }
  }
 }
 return {isClean,identical:false};
}
async function verifyAndPrepareRestorePackage(pkg,opts){
 if(!pkg||typeof pkg!=='object'||!pkg.canonical||typeof pkg.sha256!=='string')
  fail('Gói khôi phục không hợp lệ.','RECOVERY_PACKAGE_INVALID');
 const {sha256,...body}=pkg;
 const computed=await sha256Hex(JSON.stringify(body));
 if(computed!==sha256)fail('Checksum gói khôi phục không khớp.','RECOVERY_CHECKSUM_MISMATCH');
 if(pkg.protocolVersion!==undefined&&Number(pkg.protocolVersion)>CLIENT_PROTOCOL_VERSION)
  fail('Gói khôi phục dành cho phiên bản client mới hơn.','OLD_TAB_FENCED');
 if(pkg.schemaVersion!==undefined&&Number(pkg.schemaVersion)!==LOCAL_SCHEMA_VERSION)
  fail('Gói khôi phục sai schemaVersion.','RECOVERY_PACKAGE_INVALID');
 if(!pkg.assets||typeof pkg.assets!=='object'||Array.isArray(pkg.assets))
  fail('Gói khôi phục thiếu trường assets.','RECOVERY_PACKAGE_INVALID');
 const validatedNotes=new Map();
 if(pkg.notes!==undefined){
  if(!pkg.notes||typeof pkg.notes!=='object'||Array.isArray(pkg.notes))
   fail('Trường notes trong gói khôi phục không hợp lệ.','NOTES_CANONICAL_CORRUPT');
  const expB=opts&&opts.expectedBinding?opts.expectedBinding:null;
  for(const [nk,nv] of Object.entries(pkg.notes)){
   const ctx=parseNotesNamespaceKey(nk);
   if(expB){
    if(expB.datasetId&&ctx.dataset!==expB.datasetId)
     fail('Namespace ghi chú không khớp dataset binding ('+nk+').','RECOVERY_BINDING_MISMATCH');
    if(expB.owner&&ctx.username!==expB.owner)
     fail('Namespace ghi chú không khớp owner binding ('+nk+').','RECOVERY_BINDING_MISMATCH');
   }
   validateNotesCanonicalPayload(ctx,nv,{strictRetiredWatermark:true});
   validatedNotes.set(nk,clone(nv));
  }
 }
 const assetMap=new Map(Object.entries(pkg.assets).map(([k,v])=>[PREFIX+k,v]));
 const validated=parseCanonical(JSON.stringify(pkg.canonical),assetMap);
 const resolver=pointer=>Object.prototype.hasOwnProperty.call(pkg.assets,pointer)?pkg.assets[pointer]:null;
 const {reachablePointers,assetDigests}=await inspectCanonicalClosure(validated,resolver,true);
 if(pkg.assetDigests&&typeof pkg.assetDigests==='object'){
  for(const ptr of reachablePointers){
   const exp=pkg.assetDigests[ptr],got=assetDigests[ptr];
   if(!Array.isArray(exp)||!same(exp.map(x=>({imageId:x.imageId||'',sha256:x.sha256})),got.map(x=>({imageId:x.imageId||'',sha256:x.sha256}))))
    fail('Checksum raw asset bị thay đổi ('+ptr+').','RECOVERY_ASSET_TAMPERED');
  }
 }
 return {validated,assetMap,reachablePointers,assetDigests,validatedNotes};
}
async function executeRestoreTransaction(pkg,validated,assetMap,mode,options){
 if(!available())fail('Thiếu Web Locks; chặn khôi phục.','NO_LOCK');
 if(bootstrapError||bootstrapStatus==='BLOCKED')throw (bootstrapError||fail('Kho canonical đang bị khóa.','BLOCKED'));
 return navigator.locks.request(LOCK,{mode:'exclusive'},async()=>{
  const db=await idbOpen();
  return new Promise((resolve,reject)=>{
   let tx,store,settled=false,nextEpoch=0,nextMeta=null,resultMeta={};
   const curNotesRaw=new Map(),curImgs=new Map();
   const failOnce=e=>{if(!settled){settled=true;reject(e||Error('IDB_RESTORE_ABORT'))}};
   try{tx=db.transaction(IDB_STORE,'readwrite');store=tx.objectStore(IDB_STORE);}catch(e){failOnce(e);return}
   tx.onabort=()=>failOnce(tx.error||Object.assign(Error('IDB_RESTORE_ABORT'),{code:tx.error?.name||'IDB_ABORT'}));
   tx.onerror=()=>failOnce(tx.error||Object.assign(Error('IDB_RESTORE_ERROR'),{code:tx.error?.name||'IDB_ERROR'}));
   tx.oncomplete=()=>{
    if(settled)return;
    try{
     if(nextMeta&&typeof nextMeta.lineageId==='string')currentLineageId=nextMeta.lineageId;
     if(nextMeta&&nextMeta.activeBinding)currentActiveBinding=nextMeta.activeBinding;
     for(const [k,v] of assetMap)idbAssetCache.set(k,clone(v));
     canonicalCache=clone(validated);
     canonicalFromIdb=true;
     canonicalEpoch=nextEpoch;
     ready=true;bootstrapStatus='VALID';bootstrapError=null;
     if(typeof window!=='undefined'&&window.DB){
      const demos=Array.isArray(window.DB.tickets)?window.DB.tickets.filter(t=>t&&t.__demo):[];
      window.DB.tickets=[...clone(validated.tickets),...demos];
      window.DB.nextId=validated.nextId;
     }
     try{
      for(const [k,v] of Object.entries(pkg.assets||{}))localStorage.setItem(PREFIX+k,JSON.stringify(v));
      const bytes=JSON.stringify(validated);
      localStorage.setItem(KEY,bytes);
      projectionStale=false;lastProjectionError=null;
     }catch(e){projectionStale=true;lastProjectionError=e;notifyProjectionStale(e);}
     notifyHydrate(validated,{epoch:nextEpoch,fromIdb:true,projectionStale});
     settled=true;
     resolve({restored:true,tickets:validated.tickets.length,...resultMeta});
    }catch(e){failOnce(e)}
   };
   const performWrite=()=>{
    try{
     const curMeta=metaReq.result?.value||metaReq.result||null;
     checkFencing(curMeta);
     const ticketsRec=tReq.result;
     if(mode==='admin'){
      const backupKey='recovery_backup:'+Date.now();
      store.put({
       exportedAt:new Date().toISOString(),
       reason:options.confirmReason,
       operator:options.operator||'admin',
       previousMeta:curMeta,
       previousTickets:ticketsRec?.value??null,
       previousAssets:Object.fromEntries(curImgs.entries()),
       previousNotes:Object.fromEntries(Array.from(curNotesRaw.entries()).map(([k,v])=>[k,v?.value??v]))
      },backupKey);
      store.put({
       at:Date.now(),action:'ADMIN_FORCE_RESTORE',operator:options.operator||'admin',
       reason:options.confirmReason,backupKey,packageId:pkg.packageId||null
      },'recovery_audit:'+Date.now());
      resultMeta={forced:true,backupKey};
     }else{
      const decision=checkRollbackSafety(pkg,validated,assetMap,curMeta,ticketsRec,curNotesRaw,options.expectedBinding);
      resultMeta={cleanRestore:decision.isClean,identical:decision.identical};
     }
     for(const [k,v] of Object.entries(pkg.assets||{})){
      store.put({value:clone(v),at:Date.now()},'img:'+k);
     }
     nextEpoch=(Number(ticketsRec?.epoch)||0)+1;
     const targetLineage=(mode==='default'&&resultMeta.cleanRestore)?(pkg.lineageId||curMeta?.lineageId||uid()):(curMeta?.lineageId||pkg.lineageId||uid());
     nextMeta={
      protocolVersion:CLIENT_PROTOCOL_VERSION,
      minClient:curMeta?.minClient??CLIENT_PROTOCOL_VERSION,
      schemaVersion:LOCAL_SCHEMA_VERSION,
      lineageId:targetLineage,
      activeBinding:pkg.binding||curMeta?.activeBinding||currentActiveBinding||null,
      updatedAt:Date.now()
     };
     store.put(nextMeta,'meta:schema');
     store.put({value:clone(validated),previous:ticketsRec?.value??null,epoch:nextEpoch,at:Date.now()},'tickets');
     if(options.validatedNotes&&options.validatedNotes.size>0){
      for(const [nk,nv] of options.validatedNotes.entries()){
       const prevN=curNotesRaw.get(nk);
       store.put({value:clone(nv),previous:prevN?.value??null,epoch:(Number(prevN?.epoch)||0)+1,at:Date.now()},nk);
      }
     }
    }catch(e){try{tx.abort()}catch(_){};failOnce(e)}
   };
   const metaReq=store.get('meta:schema');
   const tReq=store.get('tickets');
   metaReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(metaReq.error)};
   tReq.onerror=()=>{try{tx.abort()}catch(_){};failOnce(tReq.error)};
   tReq.onsuccess=()=>{
    if(typeof store.openCursor==='function'){
     const cur=store.openCursor();
     cur.onsuccess=ev=>{
      const c=ev.target.result;
      if(!c){performWrite();return}
      const k=String(c.key);
      if(k.startsWith('notes:'))curNotesRaw.set(k,c.value);
      else if(k.startsWith('img:'))curImgs.set(k.slice(4),c.value?.value??c.value);
      c.continue();
     };
     cur.onerror=()=>{try{tx.abort()}catch(_){};failOnce(cur.error)};
    }else{
     performWrite();
    }
   };
  });
 });
}
async function restoreRecoveryPackage(pkg,opts={}){
 const {validated,assetMap,validatedNotes}=await verifyAndPrepareRestorePackage(pkg,opts);
 return executeRestoreTransaction(pkg,validated,assetMap,'default',{expectedBinding:opts?.expectedBinding||null,validatedNotes});
}
async function adminForceRestoreRecoveryPackage(pkg,adminOpts){
 if(!adminOpts||typeof adminOpts.confirmReason!=='string'||adminOpts.confirmReason.trim().length<4)
  fail('Yêu cầu lý do xác nhận hợp lệ cho khôi phục cưỡng bức quản trị.','ADMIN_CONFIRM_REQUIRED');
 const {validated,assetMap,validatedNotes}=await verifyAndPrepareRestorePackage(pkg,adminOpts);
 return executeRestoreTransaction(pkg,validated,assetMap,'admin',{...adminOpts,validatedNotes});
}
async function setSchemaFencing(minClient){
 if(!Number.isSafeInteger(minClient)||minClient<1)fail('minClient không hợp lệ');
 const prev=await window.TTAtomicStore.getRaw('meta:schema');
 const prevVal=prev?.value||prev||{};
 await window.TTAtomicStore.putRaw([['meta:schema',{protocolVersion:CLIENT_PROTOCOL_VERSION,minClient,schemaVersion:LOCAL_SCHEMA_VERSION,lineageId:prevVal.lineageId||currentLineageId||uid(),activeBinding:prevVal.activeBinding||currentActiveBinding||null,updatedAt:Date.now()}]]);
 return hydrate();
}
function onHydrate(fn){if(typeof fn==='function')hydrateListeners.add(fn);return ()=>hydrateListeners.delete(fn)}
function isHeld(){return held}

if(typeof window!=='undefined'){
 window.TTNotesValidator={
  parseNotesNamespaceKey,
  validServerWatermark:validNotesServerWatermark,
  verifySuccessorChain:verifyNotesSuccessorChain,
  validateNotesCanonicalPayload
 };
}

// Start eager canonical bootstrap immediately.
if(typeof window!=='undefined'){
 window.__TT_HELPER_BUILD_ID=BUILD_ID;
 void bootstrap();
 if(typeof window.addEventListener==='function'){
  window.addEventListener('storage',ev=>{
   if(ev&&ev.key===KEY)void hydrate();
  });
 }
}

window.TTCandidateData={
 BUILD_ID,read,readCanonical,bootstrap,hydrate,isReady,isBlocked,getView,getBootstrapState,getRecoveryStatus,getRecoveryStatusAsync,
 onHydrate,images,commitTicket,commitImage,commitDelete,reconcileImages,acknowledgeTicket,acknowledgeDelete,markAllForSync,ensureOutbox,markOperationAttempted,
 draft,listDrafts,listDraftsAsync,getDraftImages,clearDraft,isHeld,stage,available,applyServerSnapshot,
 exportRecoveryPackage,restoreRecoveryPackage,adminForceRestoreRecoveryPackage,setSchemaFencing,CLIENT_PROTOCOL_VERSION
};
})();

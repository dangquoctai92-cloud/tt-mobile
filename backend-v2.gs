/*
T&T Mobile — backend v2 REVIEW CANDIDATE ONLY.
NOT DEPLOYED. Requires owner migration, server auth and Apps Script integration review.
Never paste production passwords, IDs, private keys or customer data into this source.
Configure ScriptProperties in the Apps Script editor:
 TT_SPREADSHEET_ID, TT_DRIVE_FOLDER_ID, TT_DATASET_ID (8+ alnum/_/-).
Create sheets UsersV2, TicketsV2, OperationsV2, ImagesV2, NotesV2, ChatV2.
DO NOT make login accessible until PBKDF2 benchmark/rate limiting & migration audited.
*/
const TT2_APP='tt-mobile',TT2_PROTOCOL=2,TT2_PBKDF2_ITER=150000,TT2_SESSION_TTL_MS=30*24*60*60*1000,TT2_SESSION_RENEW_THRESHOLD_MS=20*24*60*60*1000;
const TT2_SHEETS={
 UsersV2:['username','saltB64','hashB64','iterations','role','enabled'],
 TicketsV2:['ticketId','datasetId','revision','deleted','owner','json','updatedAt'],
 OperationsV2:['operationId','datasetId','action','ticketId','revision','payloadSha256','state','ackJson','principal','expectedRevision','intentJson','globalRevision'],
 ImagesV2:['imageId','datasetId','sha256','fileId','url','operationId'],
 NotesV2:['recordId','datasetId','revision','deleted','owner','json'],
 ChatV2:['recordId','datasetId','revision','deleted','owner','json']
};
let __tt2Ctx = null;
function tt2NewCtx() {
 return {
  props: null,
  propVals: {},
  ss: null,
  sheets: {},
  rows: {},
  lastWrittenLine: {},
  folder: null,
  verifiedDriveFiles: {},
  timing: { authMs: 0, lockWaitMs: 0, readMs: 0, writeMs: 0, verifyMs: 0, flushMs: 0, totalMs: 0, sheetReads: 0, sheetWrites: 0, openCount: 0 }
 };
}
function tt2Props(){
 if(__tt2Ctx&&__tt2Ctx.props)return __tt2Ctx.props;
 const p=PropertiesService.getScriptProperties();
 if(__tt2Ctx)__tt2Ctx.props=p;
 return p;
}
function tt2Prop(key){
 if(__tt2Ctx&&Object.prototype.hasOwnProperty.call(__tt2Ctx.propVals,key))return __tt2Ctx.propVals[key];
 const v=tt2Props().getProperty(key);
 if(__tt2Ctx)__tt2Ctx.propVals[key]=v;
 return v;
}
function tt2Dataset(){
 const id=tt2Prop('TT_DATASET_ID')||'';
 if(!/^[A-Za-z0-9_-]{8,}$/.test(id))throw Error('BACKEND_NOT_CONFIGURED');
 return id;
}
function tt2DriveFolder(){
 if(__tt2Ctx&&__tt2Ctx.folder)return __tt2Ctx.folder;
 const folderId=tt2Prop('TT_DRIVE_FOLDER_ID');
 if(!folderId)throw Error('IMAGE_FOLDER_NOT_CONFIGURED');
 const f=DriveApp.getFolderById(folderId);
 if(__tt2Ctx)__tt2Ctx.folder=f;
 return f;
}
function tt2Spreadsheet(){
 const id=tt2Prop('TT_SPREADSHEET_ID');
 if(!id)throw Error('BACKEND_NOT_CONFIGURED');
 if(__tt2Ctx&&__tt2Ctx.ss)return __tt2Ctx.ss;
 const t0=Date.now();
 const ss=SpreadsheetApp.openById(id);
 if(__tt2Ctx){
  __tt2Ctx.ss=ss;
  __tt2Ctx.timing.openCount++;
  __tt2Ctx.timing.readMs+=Date.now()-t0;
 }
 return ss;
}
function tt2Sheet(name){
 if(!TT2_SHEETS[name])throw Error('BACKEND_NOT_CONFIGURED');
 if(__tt2Ctx&&__tt2Ctx.sheets[name])return __tt2Ctx.sheets[name];
 const t0=Date.now();
 const sheet=tt2Spreadsheet().getSheetByName(name);
 if(!sheet)throw Error('MIGRATION_REQUIRED_'+name);
 if(__tt2Ctx){
  __tt2Ctx.sheets[name]=sheet;
  __tt2Ctx.timing.readMs+=Date.now()-t0;
 }
 return sheet;
}
function tt2Rows(name,bypassCache){
 if(__tt2Ctx&&!bypassCache&&__tt2Ctx.rows[name])return __tt2Ctx.rows[name];
 const t0=Date.now();
 const sh=tt2Sheet(name);
 const lastRow=sh.getLastRow();
 const out=lastRow<2?[]:sh.getRange(2,1,lastRow-1,TT2_SHEETS[name].length).getValues();
 if(__tt2Ctx){
  __tt2Ctx.rows[name]=out;
  __tt2Ctx.timing.sheetReads++;
  __tt2Ctx.timing.readMs+=Date.now()-t0;
 }
 return out;
}
function tt2Find(name,column,value,bypassCache){
 const rows=tt2Rows(name,bypassCache),i=rows.findIndex(row=>String(row[column])===String(value));
 return i<0?null:{row:rows[i],line:i+2};
}
function tt2FindFreshRow(name,column,value,hintLine){
 if(hintLine&&hintLine>=2&&TT2_SHEETS[name]){
  const t0=Date.now();
  const sh=tt2Sheet(name);
  const row=sh.getRange(hintLine,1,1,TT2_SHEETS[name].length).getValues()[0];
  if(__tt2Ctx){
   __tt2Ctx.timing.sheetReads++;
   __tt2Ctx.timing.verifyMs+=Date.now()-t0;
  }
  if(row&&String(row[column])===String(value)){
   if(__tt2Ctx&&__tt2Ctx.rows[name])__tt2Ctx.rows[name][hintLine-2]=row;
   return {row,line:hintLine};
  }
 }
 return tt2Find(name,column,value,true);
}
function tt2Put(name,columns,line){
 const t0=Date.now();
 const sh=tt2Sheet(name),at=line||sh.getLastRow()+1;
 sh.getRange(at,1,1,columns.length).setValues([columns]);
 if(__tt2Ctx){
  __tt2Ctx.timing.sheetWrites++;
  __tt2Ctx.timing.writeMs+=Date.now()-t0;
  __tt2Ctx.lastWrittenLine[name]=at;
  if(__tt2Ctx.rows[name]){
   const arr=__tt2Ctx.rows[name];
   const idx=at-2;
   if(idx>=0&&idx<arr.length)arr[idx]=columns.slice();
   else if(idx===arr.length)arr.push(columns.slice());
   else delete __tt2Ctx.rows[name];
  }
 }
 return at;
}
function tt2B64(bytes){return Utilities.base64Encode(bytes)}
function tt2Hex(bytes){return bytes.map(v=>(v&255).toString(16).padStart(2,'0')).join('')}
function tt2Sha(value){
 return tt2Hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value));
}
function tt2ShaBytes(bytes){
 return tt2Hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes));
}
function tt2ConstantTime(a,b){
 const x=String(a),y=String(b);let mismatch=x.length^y.length;
 for(let i=0;i<Math.max(x.length,y.length);i++)mismatch|=(x.charCodeAt(i)||0)^(y.charCodeAt(i)||0);
 return mismatch===0;
}
const TT2_SHA256_K=new Int32Array([
 0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
 0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
 0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
 0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
 0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
 0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
 0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
 0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
const TT2_SHA256_IV=[0x6a09e667|0,0xbb67ae85|0,0x3c6ef372|0,0xa54ff53a|0,0x510e527f|0,0x9b05688c|0,0x1f83d9ab|0,0x5be0cd19|0];
function tt2Sha256Compress(st,blk,w){
 const K=TT2_SHA256_K;
 for(let i=0;i<16;i++)w[i]=blk[i];
 for(let i=16;i<64;i++){
  const x=w[i-15],y=w[i-2];
  const s0=((x>>>7)|(x<<25))^((x>>>18)|(x<<14))^(x>>>3);
  const s1=((y>>>17)|(y<<15))^((y>>>19)|(y<<13))^(y>>>10);
  w[i]=(w[i-16]+s0+w[i-7]+s1)|0;
 }
 let a=st[0],b=st[1],c=st[2],d=st[3],e=st[4],f=st[5],g=st[6],h=st[7];
 for(let i=0;i<64;i++){
  const S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
  const t1=(h+S1+((e&f)^(~e&g))+K[i]+w[i])|0;
  const S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
  const t2=(S0+((a&b)^(a&c)^(b&c)))|0;
  h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
 }
 st[0]=(st[0]+a)|0;st[1]=(st[1]+b)|0;st[2]=(st[2]+c)|0;st[3]=(st[3]+d)|0;
 st[4]=(st[4]+e)|0;st[5]=(st[5]+f)|0;st[6]=(st[6]+g)|0;st[7]=(st[7]+h)|0;
}
function tt2Sha256FromState(initSt,dataBytes,prefixLen){
 const st=new Int32Array(initSt),w=new Int32Array(64),blk=new Int32Array(16);
 const len=dataBytes.length,totalBytes=prefixLen+len,paddedLen=Math.ceil((len+9)/64)*64;
 const buf=new Uint8Array(paddedLen);
 for(let i=0;i<len;i++)buf[i]=dataBytes[i]&255;
 buf[len]=0x80;
 const totalBitsHi=Math.floor((totalBytes*8)/0x100000000),totalBitsLo=(totalBytes*8)>>>0;
 buf[paddedLen-8]=(totalBitsHi>>>24)&255;buf[paddedLen-7]=(totalBitsHi>>>16)&255;
 buf[paddedLen-6]=(totalBitsHi>>>8)&255;buf[paddedLen-5]=totalBitsHi&255;
 buf[paddedLen-4]=(totalBitsLo>>>24)&255;buf[paddedLen-3]=(totalBitsLo>>>16)&255;
 buf[paddedLen-2]=(totalBitsLo>>>8)&255;buf[paddedLen-1]=totalBitsLo&255;
 for(let off=0;off<paddedLen;off+=64){
  for(let j=0;j<16;j++){
   const p=off+j*4;
   blk[j]=(buf[p]<<24)|(buf[p+1]<<16)|(buf[p+2]<<8)|buf[p+3];
  }
  tt2Sha256Compress(st,blk,w);
 }
 return st;
}
// Pure V8 SHA-256 + precomputed ipad/opad state matches PBKDF2-HMAC-SHA256 bit-for-bit across all 150,000 rounds
// while avoiding 150,000 Apps Script Java-bridge RPC calls (~72s -> <0.5s).
function tt2Pbkdf2(password,saltB64,iterations){
 if(typeof password!=='string'||password.length<1||password.length>1024 ||
    !Number.isSafeInteger(iterations)||iterations<100000)throw Error('INVALID_PASSWORD_METADATA');
 const key=Utilities.newBlob(password).getBytes(),salt=Utilities.base64Decode(saltB64);
 const kArr=new Uint8Array(64);
 if(key.length>64){
  const kd=tt2Sha256FromState(TT2_SHA256_IV,key,0);
  for(let j=0;j<8;j++){
   kArr[j*4]=(kd[j]>>>24)&255;kArr[j*4+1]=(kd[j]>>>16)&255;
   kArr[j*4+2]=(kd[j]>>>8)&255;kArr[j*4+3]=kd[j]&255;
  }
 }else{
  for(let i=0;i<key.length;i++)kArr[i]=key[i]&255;
 }
 const ipadBlk=new Int32Array(16),opadBlk=new Int32Array(16),w=new Int32Array(64);
 for(let j=0;j<16;j++){
  const word=(kArr[j*4]<<24)|(kArr[j*4+1]<<16)|(kArr[j*4+2]<<8)|kArr[j*4+3];
  ipadBlk[j]=word^0x36363636;opadBlk[j]=word^0x5c5c5c5c;
 }
 const iSt=new Int32Array(TT2_SHA256_IV),oSt=new Int32Array(TT2_SHA256_IV);
 tt2Sha256Compress(iSt,ipadBlk,w);tt2Sha256Compress(oSt,opadBlk,w);
 const sLen=salt.length,s1=new Uint8Array(sLen+4);
 for(let i=0;i<sLen;i++)s1[i]=salt[i]&255;
 s1[sLen]=0;s1[sLen+1]=0;s1[sLen+2]=0;s1[sLen+3]=1;
 const uInit=tt2Sha256FromState(iSt,s1,64),blk=new Int32Array(16);
 blk[8]=0x80000000|0;blk[15]=768;
 for(let j=0;j<8;j++)blk[j]=uInit[j];
 const st=new Int32Array(oSt);
 tt2Sha256Compress(st,blk,w);
 let u0=st[0],u1=st[1],u2=st[2],u3=st[3],u4=st[4],u5=st[5],u6=st[6],u7=st[7];
 let out0=u0,out1=u1,out2=u2,out3=u3,out4=u4,out5=u5,out6=u6,out7=u7;
 const ih0=iSt[0],ih1=iSt[1],ih2=iSt[2],ih3=iSt[3],ih4=iSt[4],ih5=iSt[5],ih6=iSt[6],ih7=iSt[7];
 const oh0=oSt[0],oh1=oSt[1],oh2=oSt[2],oh3=oSt[3],oh4=oSt[4],oh5=oSt[5],oh6=oSt[6],oh7=oSt[7];
 for(let iter=1;iter<iterations;iter++){
  st[0]=ih0;st[1]=ih1;st[2]=ih2;st[3]=ih3;st[4]=ih4;st[5]=ih5;st[6]=ih6;st[7]=ih7;
  blk[0]=u0;blk[1]=u1;blk[2]=u2;blk[3]=u3;blk[4]=u4;blk[5]=u5;blk[6]=u6;blk[7]=u7;
  tt2Sha256Compress(st,blk,w);
  blk[0]=st[0];blk[1]=st[1];blk[2]=st[2];blk[3]=st[3];blk[4]=st[4];blk[5]=st[5];blk[6]=st[6];blk[7]=st[7];
  st[0]=oh0;st[1]=oh1;st[2]=oh2;st[3]=oh3;st[4]=oh4;st[5]=oh5;st[6]=oh6;st[7]=oh7;
  tt2Sha256Compress(st,blk,w);
  u0=st[0];u1=st[1];u2=st[2];u3=st[3];u4=st[4];u5=st[5];u6=st[6];u7=st[7];
  out0^=u0;out1^=u1;out2^=u2;out3^=u3;out4^=u4;out5^=u5;out6^=u6;out7^=u7;
 }
 const words=[out0,out1,out2,out3,out4,out5,out6,out7],outBytes=[];
 for(let j=0;j<8;j++){
  const wd=words[j];
  const b0=(wd>>>24)&255,b1=(wd>>>16)&255,b2=(wd>>>8)&255,b3=wd&255;
  outBytes.push(b0>127?b0-256:b0,b1>127?b1-256:b1,b2>127?b2-256:b2,b3>127?b3-256:b3);
 }
 return tt2B64(outBytes);
}
function tt2Lock(fn){
 const lock=LockService.getScriptLock();
 const tw=Date.now();
 lock.waitLock(30000);
 if(__tt2Ctx){
  __tt2Ctx.timing.lockWaitMs+=Date.now()-tw;
  __tt2Ctx.rows={};
 }
 try{
  const result=fn();
  const tf=Date.now();
  SpreadsheetApp.flush();
  if(__tt2Ctx)__tt2Ctx.timing.flushMs+=Date.now()-tf;
  return result;
 } finally{lock.releaseLock()}
}
// Owner-only editor setup. NEVER expose as an HTTP action.
function tt2BootstrapOwnerFromEditor(username,password){
 if(!/^[a-zA-Z0-9._-]{3,40}$/.test(username)||password.length<16)throw Error('INVALID_OWNER_SETUP');
 return tt2Lock(()=>{
  if(tt2Rows('UsersV2').length)throw Error('OWNER_ALREADY_EXISTS');
  const salt=tt2B64(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid()+Utilities.getUuid()+new Date().toISOString()));
  tt2Put('UsersV2',[username,salt,tt2Pbkdf2(password,salt,TT2_PBKDF2_ITER),
    TT2_PBKDF2_ITER,'admin',true]);
  return {configured:true};
 });
}
function tt2RateKey(username){return 'rate_'+tt2Sha(String(username).toLowerCase()).slice(0,28)}
function tt2Login(req){
 const username=String(req.username||'').trim();
 const cache=CacheService.getScriptCache(),key=tt2RateKey(username);
 const count=Number(cache.get(key)||0);
 if(count>=5)throw Error('AUTH_RATE_LIMIT');
 const user=tt2Find('UsersV2',0,username),row=user&&user.row;
 // Generic error, no username enumeration.
 if(!row||row[5]!==true||!tt2ConstantTime(tt2Pbkdf2(String(req.password||''),row[1],Number(row[3])),row[2])){
  cache.put(key,String(count+1),600);throw Error('AUTH_FAILED');
 }
 cache.remove(key);
 const token=Utilities.getUuid()+'-'+Utilities.getUuid()+'-'+Utilities.getUuid();
 const digest=tt2Sha(token),session={
  username:row[0],role:row[4],datasetId:tt2Dataset(),
  expiresAt:Date.now()+TT2_SESSION_TTL_MS
 };
 tt2Props().setProperty('TT2_SESSION_'+digest,JSON.stringify(session));
 return {ok:true,action:'login',appId:TT2_APP,protocolVersion:2,
  datasetId:session.datasetId,sessionToken:token,expiresAt:session.expiresAt,
  actor:{username:session.username,role:session.role}};
}
function tt2Session(req){
 const token=req&&req.sessionToken;
 if(typeof token!=='string'||token.length<80)throw Error('AUTH_REQUIRED');
 const properties=tt2Props(),key='TT2_SESSION_'+tt2Sha(token);
 const value=properties.getProperty(key),session=value&&JSON.parse(value);
 const now=Date.now();
 if(!session||session.expiresAt<now||session.datasetId!==tt2Dataset())
  throw Error('AUTH_REQUIRED');
 // Re-read server principal on EVERY request: role changes, disabled users and
 // deleted accounts must revoke cached sessions before replay/ACK.
 const found=tt2Find('UsersV2',0,session.username),u=found&&found.row;
 if(!u||u[5]!==true||!['admin','manager','viewer'].includes(String(u[4])))
  throw Error('AUTH_REVOKED');
 if(session.expiresAt-now<TT2_SESSION_RENEW_THRESHOLD_MS){
  session.expiresAt=now+TT2_SESSION_TTL_MS;
  try{properties.setProperty(key,JSON.stringify(session));}catch(_){}
 }
 return {username:String(u[0]),role:String(u[4]),datasetId:session.datasetId,
   expiresAt:session.expiresAt};
}
function tt2Can(session,action,owner){
 if(!session)throw Error('AUTH_REQUIRED');
 if(session.role==='admin')return true;
 if(action==='snapshot'||action==='chat_read'||action==='notes_read'||action==='image_get')return true;
 if(action==='drive_storage'&&session.role==='manager')return true;
 if(session.role!=='manager')throw Error('PERMISSION_DENIED');
 if(['upsert','delete','notes_write','chat_write'].includes(action)&&owner===session.username)return true;
 throw Error('PERMISSION_DENIED');
}

function tt2CheckRequest(req,action){
 if(!req||req.appId!==TT2_APP||Number(req.protocolVersion)!==TT2_PROTOCOL||
    req.datasetId!==tt2Dataset()||req.action!==action)throw Error('PROTOCOL_OR_DATASET_MISMATCH');
 if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(String(req.operationId||'')))throw Error('INVALID_OPERATION_ID');
 const expected=Number(req.expectedRevision),revision=Number(req.revision);
 // local_revision may skip server revisions after multiple offline edits.
 // Must nevertheless advance monotonically beyond the acknowledged server revision.
 if(!Number.isSafeInteger(expected)||expected<0||!Number.isSafeInteger(revision)||
    revision<=expected)throw Error('REVISION_ROLLBACK');
}
function tt2Ack(req,images,complete=true){
 return {ok:true,action:req.action,appId:TT2_APP,protocolVersion:TT2_PROTOCOL,datasetId:tt2Dataset(),
  ack:{accepted:true,operationComplete:!!complete,appId:TT2_APP,protocolVersion:TT2_PROTOCOL,
    datasetId:tt2Dataset(),action:req.action,ticketId:req.id||req.row&&req.row.id||req.recordId,
    operationId:req.operationId,acceptedRevision:Number(req.revision)},
  images:images||[]};
}
function tt2OperationDigest(req){
 const copy={...req};
 delete copy.sessionToken;delete copy.requestUser;delete copy.username;
 delete copy.role;delete copy.authRequired;
 return tt2Sha(JSON.stringify(copy));
}
function tt2Fault(stage){
 // Emulator injects a crash AFTER durable step. Production source has no testing hook.
 if(typeof TT2_TEST_HOOK==='function')TT2_TEST_HOOK(stage);
}
function tt2Reservation(){
 const ops=tt2Rows('OperationsV2'),prop=Number(tt2Props().getProperty('TT2_GLOBAL_REV')||0);
 return Math.max(prop,...ops.map(r=>Number(r[11])||0),0)+1;
}
function tt2BumpGlobalRevision(reserved){
 const p=tt2Props(),now=Number(p.getProperty('TT2_GLOBAL_REV')||0);
 p.setProperty('TT2_GLOBAL_REV',String(Math.max(now,Number(reserved)||0)));
 tt2Fault('global_revision');
}
function tt2OpValues(j){
 const metadata={owner:j.owner,resourceKind:j.resourceKind||
   (j.action==='chat_write'?'chat':j.action==='notes_write'?'notes':'ticket'),
   imageManifest:j.imageManifest||[],
   recordDeleted:j.recordDeleted===true,
   hasPreflightManifest:!!j.hasPreflightManifest,
   recovery:j.recovery||null,createdAt:j.createdAt||null};
 return [j.id,j.datasetId,j.action,j.ticketId,j.revision,j.digest,j.state,
   j.ackJson||'',j.principal,j.expectedRevision,JSON.stringify(metadata),j.globalRevision];
}
function tt2JournalFromFound(found){
 if(!found)return null;
 const r=found.row,metadata=JSON.parse(r[10]||'{}');
 return {id:String(r[0]),datasetId:String(r[1]),action:String(r[2]),
  ticketId:String(r[3]),revision:Number(r[4]),digest:String(r[5]),state:String(r[6]),
  ackJson:String(r[7]||''),principal:String(r[8]),expectedRevision:Number(r[9]),
  owner:String(metadata.owner||''),globalRevision:Number(r[11]),line:found.line,
  recordDeleted:metadata.recordDeleted===true,
  resourceKind:metadata.resourceKind||(String(r[2])==='chat_write'?'chat':
    String(r[2])==='notes_write'?'notes':'ticket'),
  imageManifest:metadata.imageManifest||[],hasPreflightManifest:!!metadata.hasPreflightManifest,
  createdAt:metadata.createdAt||null,recovery:metadata.recovery||null};
}
function tt2JournalWrite(j,state,ack){
 j.state=state;
 if(ack)j.ackJson=JSON.stringify(ack);
 j.line=tt2Put('OperationsV2',tt2OpValues(j),j.line);
 return j;
}
function tt2GetOrStart(req,session,ticketId,owner,serverRevision){
 const digest=tt2OperationDigest(req);
 let j=tt2JournalFromFound(tt2Find('OperationsV2',0,req.operationId));
 tt2Can(session,req.action,owner||j&&j.owner||session.username);
 if(j){
  if(j.datasetId!==tt2Dataset()||j.action!==req.action||
    j.ticketId!==String(ticketId)||j.revision!==Number(req.revision)||
    j.expectedRevision!==Number(req.expectedRevision)||j.digest!==digest)
    throw Error('OPERATION_ID_REUSE');
  if(j.principal!==session.username)throw Error('OPERATION_PRINCIPAL_MISMATCH');
  if(owner&&j.owner!==owner)throw Error('OPERATION_OWNER_MISMATCH');
  if(['aborted','quarantined','rejected'].includes(j.state))
    throw Error('OPERATION_TERMINAL');
  return j;
 }
 if(Number(req.expectedRevision)!==Number(serverRevision))throw Error('REVISION_CONFLICT');
 // Validate every image in every slot before writing the first durable journal row.
 const manifest=(req.action==='upsert'||req.action==='chat_write'&&req.row)?
   tt2ValidateImageBatch(req,owner):[];
 // Recover fully committed operations and auto-abort only provably empty
 // intents from revoked users. Unknown effects still require admin review.
 tt2AutoRecoverOnGate();
 const unresolved=tt2Rows('OperationsV2').some(r=>r[1]===tt2Dataset()&&
   !['complete','aborted','quarantined','rejected'].includes(String(r[6])));
 if(unresolved)throw Error('OLDER_OPERATION_PENDING_RECOVERY');
 j={id:req.operationId,datasetId:tt2Dataset(),action:req.action,
  ticketId:String(ticketId),revision:Number(req.revision),expectedRevision:Number(req.expectedRevision),
  principal:session.username,owner:owner||session.username,digest,state:'intent',
  recordDeleted:req.deleted===true,
  resourceKind:req.action==='chat_write'?'chat':req.action==='notes_write'?'notes':'ticket',
  imageManifest:manifest,hasPreflightManifest:true,
  createdAt:Date.now(),globalRevision:tt2Reservation(),ackJson:'',line:null};
 tt2JournalWrite(j,'intent');
 tt2Fault('intent');
 return j;
}


function tt2ExistingImageClaim(imageId){
 // The journal is the durable imageId reservation, written under the script
 // lock BEFORE Drive creation. It is deliberately independent from SHA.
 for(const r of tt2Rows('OperationsV2')){
  const j=tt2JournalFromFound({row:r,line:0});
  if(j.datasetId!==tt2Dataset())continue;
  if((j.imageManifest||[]).some(x=>x.imageId===imageId))return j;
 }
 return null;
}
function tt2RegisteredImage(imageId,sha,providedUrl,context,attr){
 if(!/^[A-Za-z0-9._:-]{1,160}$/.test(String(imageId||''))||
    !/^[0-9a-f]{64}$/.test(String(sha||'')))
   throw Error('IMAGE_REFERENCE_INVALID');
 const found=tt2Find('ImagesV2',0,imageId),r=found&&found.row;
 if(!r)throw Error('IMAGE_REFERENCE_NOT_FOUND');
 const dataset=tt2Dataset();
 if(String(r[1])!==dataset||String(r[2])!==sha)throw Error('IMAGE_REFERENCE_MISMATCH');
 const source=tt2JournalFromFound(tt2Find('OperationsV2',0,r[5]));
 if(!source||source.datasetId!==dataset||source.ticketId!==String(context.ticketId)||
    source.owner!==context.owner||
    source.resourceKind!==(context.resourceKind||
      (context.action==='chat_write'?'chat':'ticket')))
   throw Error('IMAGE_ID_CROSS_RESOURCE');
 if(['aborted','quarantined','rejected'].includes(source.state))
   throw Error('IMAGE_ID_QUARANTINED');
 if(source.id!==context.id&&source.state!=='complete')
   throw Error('IMAGE_SOURCE_NOT_COMMITTED');
 if(!(source.imageManifest||[]).some(x=>x.imageId===imageId&&x.sha256===sha))
   throw Error('IMAGE_SOURCE_MANIFEST_MISMATCH');
 const fileId=String(r[3]||''),canonical='https://drive.google.com/file/d/'+fileId+'/view';
 if(!/^[A-Za-z0-9_-]+$/.test(fileId)||r[4]!==canonical||
   (providedUrl!==undefined&&providedUrl!==null&&providedUrl!==canonical))
   throw Error('IMAGE_REFERENCE_URL_MISMATCH');
 const driveCacheKey=imageId+':'+sha+':'+fileId;
 if(!(__tt2Ctx&&__tt2Ctx.verifiedDriveFiles[driveCacheKey])){
  const folder=tt2DriveFolder();
  const filename='TT2_'+dataset+'_'+imageId+'_'+sha,files=folder.getFilesByName(filename);
  let foundFile=false;
  while(files.hasNext()){
   const file=files.next();
   if(String(file.getId())===fileId){foundFile=true;break}
  }
  if(!foundFile)throw Error('IMAGE_FILE_BINDING_MISMATCH');
  if(__tt2Ctx)__tt2Ctx.verifiedDriveFiles[driveCacheKey]=true;
 }
 return {ok:true,imageId,sha256:sha,url:canonical,fileId,
   sourceOperationId:source.id};
}
function tt2VerifyStoredImageRef(ref,context,attr){
 // Stored proof MUST include an explicit canonical URL. The optional
 // providedUrl lookup of tt2RegisteredImage is reserved for raw uploads.
 if(!ref||typeof ref!=='object'||Array.isArray(ref)||
    typeof ref.imageId!=='string'||
    typeof ref.sha256!=='string'||!/^[0-9a-f]{64}$/.test(ref.sha256)||
    typeof ref.url!=='string'||!ref.url)
   throw Error('STORED_IMAGE_REFERENCE_INCOMPLETE');
 return tt2RegisteredImage(ref.imageId,ref.sha256,ref.url,context,attr);
}
function tt2ValidateStoredRefs(record,context){
 if(!record||typeof record!=='object'||Array.isArray(record))
   throw Error('BAD_STORED_TICKET');
 for(const attr of ['before_images','after_images','condition_images','repair_images']){
  if(typeof record[attr]!=='string')throw Error('BAD_STORED_IMAGE_RECORD');
  let refs;
  try{refs=JSON.parse(record[attr])}catch(e){throw Error('BAD_STORED_IMAGE_RECORD')}
  if(!Array.isArray(refs))throw Error('BAD_STORED_IMAGE_RECORD');
  for(const ref of refs)tt2VerifyStoredImageRef(ref,context,attr);
 }
}

function tt2ValidateImageBatch(req,owner) {
 // All deterministic errors must be rejected BEFORE the first intent write.
 // Registry and manifest claims are checked within tt2Lock for consistency.
 const row=req&&req.row;if(!row||typeof row!=='object')throw Error('BAD_TICKET');
 const context={id:req.operationId,ticketId:String(row.id),owner,datasetId:tt2Dataset()};
 const manifest=[],seen={};let total=0;
 for(const attr of ['before_images','after_images','condition_images','repair_images']){
  let refs;
  try{refs=JSON.parse(row[attr]===undefined?'[]':row[attr])}
  catch(e){throw Error('BAD_IMAGE_RECORD')}
  if(!Array.isArray(refs)||refs.length>60)throw Error('BAD_IMAGE_RECORD');
  for(const ref of refs){
   // URL-only legacy records are not proof of an asset: they need explicit
   // migration/revalidation, never an implicit successful sync.
   if(!ref||typeof ref!=='object'||typeof ref.imageId!=='string'||
      typeof ref.sha256!=='string'||typeof ref.url!=='string')
     throw Error('BAD_IMAGE_REFERENCE');
   tt2RegisteredImage(ref.imageId,ref.sha256,ref.url,context,attr);
  }
  const list=row[attr+'_raw']===undefined?[]:row[attr+'_raw'];
  if(!Array.isArray(list)||list.length>60)throw Error('BAD_IMAGE_PAYLOAD');
  for(const im of list){
   total++;if(total>100)throw Error('TOO_MANY_IMAGES');
   if(!im||!/^[A-Za-z0-9._:-]{1,160}$/.test(String(im.imageId||''))||
      typeof im.data!=='string')throw Error('BAD_IMAGE_PAYLOAD');
   const match=im.data.match(/^data:(image\/(?:png|jpeg|webp)|application\/(?:pdf|octet-stream)|text\/plain);base64,([A-Za-z0-9+/]+={0,2})$/i);
   if(!match||im.data.length>12*1024*1024||match[2].length%4!==0)
     throw Error('BAD_IMAGE_PAYLOAD');
   const bytes=Utilities.base64Decode(match[2]);
   if(!bytes.length||bytes.length>8*1024*1024)throw Error('IMAGE_SIZE_LIMIT');
   const b=bytes.map(x=>x&255),mime=match[1].toLowerCase();
   const isPNG=b.length>8&&[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v);
   const isJPEG=b.length>4&&b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217;
   const isWEBP=b.length>12&&String.fromCharCode(...b.slice(0,4))==='RIFF'&&
     String.fromCharCode(...b.slice(8,12))==='WEBP';
   const isPDF=b.length>4&&String.fromCharCode(...b.slice(0,5))==='%PDF-';
   const isText=mime==='text/plain'&&b.every(v=>v===9||v===10||v===13||v>=32);
   const isBinary=mime==='application/octet-stream';
   if(!(mime==='image/png'&&isPNG||mime==='image/jpeg'&&isJPEG||
      mime==='image/webp'&&isWEBP||
      req.action==='chat_write'&&(mime==='application/pdf'&&isPDF||isText||isBinary)))
     throw Error('IMAGE_MIME_MISMATCH');
   // Immutable request digest must use canonical lowercase SHA from the start.
   // Reject uppercase/mixed-case BEFORE intent, images or Drive side effects.
   if(typeof im.sha256!=='string'||!/^[0-9a-f]{64}$/.test(im.sha256))
     throw Error('IMAGE_CHECKSUM_NONCANONICAL');
   const sha=tt2ShaBytes(bytes);
   if(!tt2ConstantTime(sha,im.sha256))
     throw Error('IMAGE_CHECKSUM_MISMATCH');
   const previous=seen[im.imageId];
   if(previous)throw Error(previous===sha?'IMAGE_ID_DUPLICATE':'IMAGE_ID_COLLISION');
   seen[im.imageId]=sha;
   const claimed=tt2ExistingImageClaim(im.imageId);
   if(claimed){
    // Preserve the existing cross-resource error contract before the
    // quarantine-specific code. Both paths deny the imageId reservation.
    if(claimed.ticketId!==String(row.id)||claimed.owner!==owner||
       claimed.resourceKind!==(req.action==='chat_write'?'chat':'ticket'))
      throw Error('IMAGE_ID_CROSS_RESOURCE');
    // ImageID remains reserved after abort/quarantine, even if ImagesV2
    // was never written (crash just after Drive file creation).
    if(['aborted','quarantined','rejected'].includes(claimed.state))
      throw Error('IMAGE_ID_QUARANTINED');
    if(!(claimed.imageManifest||[]).some(x=>x.imageId===im.imageId&&x.sha256===sha))
      throw Error('IMAGE_ID_RESERVED');
    // A new operation can reuse only a committed and registered image.
    if(claimed.state!=='complete')throw Error('IMAGE_ID_RESERVED');
    tt2RegisteredImage(im.imageId,sha,null,context,attr);
   }else if(tt2Find('ImagesV2',0,im.imageId)){
    // Pre-v2 registry without a valid source intent cannot silently grant
    // ownership of the imageId.
    throw Error('IMAGE_ID_UNMIGRATED');
   }else{
    const folderId=tt2Props().getProperty('TT_DRIVE_FOLDER_ID');
    if(folderId&&DriveApp.getFolderById(folderId)
       .getFilesByName('TT2_'+tt2Dataset()+'_'+im.imageId+'_'+sha).hasNext())
      throw Error('IMAGE_ORPHAN_COLLISION');
   }
   manifest.push({attr,imageId:im.imageId,sha256:sha});
  }
 }
 return manifest;
}
function tt2JournalOwnerActive(j) {
 const found=tt2Find('UsersV2',0,j.principal),u=found&&found.row;
 if(!u||u[5]!==true)return false;
 try{
  tt2Can({username:String(u[0]),role:String(u[4])},j.action,j.owner);
  return true;
 }catch(e){return false}
}
function tt2JournalEvidence(j) {
 const tv0=Date.now();
 const sheet=j.action==='upsert'||j.action==='delete'?'TicketsV2':
    j.action==='notes_write'?'NotesV2':'ChatV2';
 const hintLine=j._writtenLine||(__tt2Ctx&&__tt2Ctx.lastWrittenLine[sheet])||null;
 const found=tt2FindFreshRow(sheet,0,j.ticketId,hintLine),stored=found&&found.row;
 let last=null;
 try{last=stored?JSON.parse(String(stored[5]||'{}')):null}catch(e){}
 const canonicalBinding=!!(stored&&
   String(stored[0])===String(j.ticketId)&&
   stored[1]===j.datasetId&&stored[4]===j.owner&&
   typeof stored[2]==='number'&&Number.isSafeInteger(stored[2])&&
   stored[2]>=0&&stored[2]===j.revision);
 const correctDeletedState=(j.action==='upsert'?stored&&stored[3]===false:
   j.action==='delete'?stored&&stored[3]===true:
   (j.action==='notes_write'||j.action==='chat_write')?
    stored&&stored[3]===j.recordDeleted:true);
 const committed=!!(canonicalBinding&&correctDeletedState&&last&&
   typeof last==='object'&&!Array.isArray(last)&&
   last._lastOperationId===j.id);
 const manifest=Array.isArray(j.imageManifest)?j.imageManifest:[];
 let fileCount=0,imageRows=0,verifiedReceipts=[],completeRefs=true;
 for(const im of manifest){
  const r=tt2Find('ImagesV2',0,im.imageId);
  const ownRow=!!(r&&r.row[1]===j.datasetId&&r.row[5]===j.id);
  if(ownRow)imageRows++;
  // Only count a Drive file as a side effect of THIS operation when the
  // registry has not already attributed it to another completed journal.
  if(!r||ownRow){
   const folderId=tt2Prop('TT_DRIVE_FOLDER_ID');
   if(folderId&&tt2DriveFolder()
      .getFilesByName('TT2_'+j.datasetId+'_'+im.imageId+'_'+im.sha256).hasNext())
     fileCount++;
  }
  let receipt=null;
  try{
   receipt=tt2RegisteredImage(im.imageId,im.sha256,null,j,im.attr);
  }catch(e){completeRefs=false}
  if(receipt){
   verifiedReceipts.push({ok:true,imageId:im.imageId,
     sha256:im.sha256,url:receipt.url});
   if(committed&&j.action==='upsert'){
    let refs=[];try{refs=JSON.parse(last[im.attr]||'[]')}catch(e){}
    if(!Array.isArray(refs)||!refs.some(x=>x&&x.imageId===im.imageId&&
      x.sha256===im.sha256&&x.url===receipt.url))completeRefs=false;
   }
  }
 }
 if(verifiedReceipts.length!==manifest.length)completeRefs=false;
 if(committed&&j.action==='upsert'){
  try{tt2ValidateStoredRefs(last,j)}catch(e){completeRefs=false}
 }
 if(committed&&j.action==='chat_write'){
  try{tt2VerifyChatAttachmentRecord(last,j)}catch(e){completeRefs=false}
 }
 const safeNoEffects=!!j.hasPreflightManifest&&!committed&&imageRows===0&&fileCount===0;
 return {committed,completeRefs,safeNoEffects,imageRows,fileCount,
  verifiedReceipts,manifestCount:manifest.length};
}
function tt2JournalRecoverFinalize(j,by,evidence) {
 if(!evidence.committed||!evidence.completeRefs||
    evidence.verifiedReceipts.length!==evidence.manifestCount)
  throw Error('RECOVERY_RECEIPT_PROOF_INCOMPLETE');
 j.recovery={kind:'finalized_after_commit',by,at:Date.now(),
   files:evidence.fileCount,imageRows:evidence.imageRows,
   receipts:evidence.verifiedReceipts.length};
 tt2JournalWrite(j,'ticket_committed');
 tt2BumpGlobalRevision(j.globalRevision);
 const ack=tt2Ack({action:j.action,id:j.ticketId,operationId:j.id,
   revision:j.revision},evidence.verifiedReceipts,true);
 tt2JournalWrite(j,'complete',ack);
 return {state:'complete',ticketId:j.ticketId,operationId:j.id};
}
function tt2JournalTerminal(j,state,by,reason,evidence) {
 if(!['aborted','quarantined'].includes(state))throw Error('BAD_RECOVERY_STATE');
 if(evidence.committed)throw Error('RECOVERY_MUST_FINALIZE_COMMITTED');
 if(state==='aborted'&&!evidence.safeNoEffects)
  throw Error('RECOVERY_SIDE_EFFECTS_REQUIRE_QUARANTINE');
 j.recovery={kind:state,by,reason,at:Date.now(),
   files:evidence.fileCount,imageRows:evidence.imageRows};
 tt2JournalWrite(j,state);
 // No ticket commit means no global revision advancement. Keep journal forever
 // as an immutable audit/ID collision barrier; do not remove image/files.
 return {state,ticketId:j.ticketId,operationId:j.id};
}
function tt2AutoRecoverOnGate(){
 for(const found of tt2Rows('OperationsV2').map((r,i)=>({row:r,line:i+2}))){
  const j=tt2JournalFromFound(found);
  if(j.datasetId!==tt2Dataset()||['complete','aborted','quarantined','rejected'].includes(j.state))
   continue;
  // Do NOT auto-skip unknown older journal formats. Admin must review.
  if(!j.hasPreflightManifest)continue;
  const evidence=tt2JournalEvidence(j);
  if(evidence.committed&&evidence.completeRefs){
   tt2JournalRecoverFinalize(j,'system:verified_commit',evidence);
   continue;
  }
  if(!tt2JournalOwnerActive(j)&&evidence.safeNoEffects)
   tt2JournalTerminal(j,'aborted','system:principal_revoked',
     'No ticket/Drive/ImagesV2 effects verified',evidence);
 }
}
function tt2AdminRecover(req,session){
 if(session.role!=='admin')throw Error('PERMISSION_DENIED');
 if(req.appId!==TT2_APP||Number(req.protocolVersion)!==TT2_PROTOCOL||
   req.datasetId!==tt2Dataset()||!/^[a-zA-Z0-9._:-]{8,128}$/.test(String(req.operationId||'')))
  throw Error('PROTOCOL_OR_DATASET_MISMATCH');
 return tt2Lock(()=>{
  const j=tt2JournalFromFound(tt2Find('OperationsV2',0,req.operationId));
  if(!j||j.datasetId!==tt2Dataset())throw Error('OPERATION_NOT_FOUND');
  const e=tt2JournalEvidence(j);
  const details={state:j.state,ticketId:j.ticketId,operationId:j.id,
    principal:j.principal,owner:j.owner,committed:e.committed,
    files:e.fileCount,imageRows:e.imageRows,safeNoEffects:e.safeNoEffects};
  if(req.decision==='inspect')return {ok:true,action:'recover_operation',details};
  if(['complete','aborted','quarantined','rejected'].includes(j.state))
   throw Error('OPERATION_TERMINAL');
  if(e.committed){
   const r=tt2JournalRecoverFinalize(j,session.username,e);
   return {ok:true,action:'recover_operation',details:{...details,...r}};
  }
  if(req.decision==='abort'&&e.safeNoEffects){
   const r=tt2JournalTerminal(j,'aborted',session.username,
     String(req.reason||'Authorized no-effects recovery'),e);
   return {ok:true,action:'recover_operation',details:{...details,...r}};
  }
  if(req.decision==='quarantine'&&req.reviewed===true&&
    typeof req.reason==='string'&&req.reason.length>=16&&req.reason.length<=1000){
   const r=tt2JournalTerminal(j,'quarantined',session.username,req.reason,e);
   return {ok:true,action:'recover_operation',details:{...details,...r}};
  }
  throw Error('RECOVERY_REVIEW_REQUIRED');
 });
}

function tt2RecheckCommitted(hit,j){
 if(!hit)return false;
 const row=hit.row;
 const saved=JSON.parse(String(row[5]||'{}'));
 if(Number(row[2])===j.revision&&saved._lastOperationId===j.id)return true;
 if(Number(row[2])!==j.expectedRevision)
  throw Error('REVISION_CONFLICT');
 return false;
}
function tt2FileName(img,sha){
 return 'TT2_'+tt2Dataset()+'_'+img.imageId+'_'+sha;
}
function tt2ImageReceipts(req,j){
 let rawTotal=0;
 for(const attr of ['before_images','after_images','condition_images','repair_images']){
  rawTotal+=(req.row[attr+'_raw']||[]).length;
 }
 if(rawTotal===0)return {receipts:[],pending:0};
 const folder=tt2DriveFolder(),receipts=[];
 let pending=0;
 for(const attr of ['before_images','after_images','condition_images','repair_images']){
  for(const img of req.row[attr+'_raw']||[]){
   if(!img||!/^[A-Za-z0-9._:-]{1,160}$/.test(String(img.imageId||''))||
      !/^data:(?:image\/(?:jpeg|png|webp)|application\/(?:pdf|octet-stream)|text\/plain);base64,/i.test(img.data||''))
     throw Error('BAD_IMAGE_PAYLOAD');
   const bytes=Utilities.base64Decode(img.data.slice(img.data.indexOf(',')+1));
   const sha=tt2ShaBytes(bytes);
   if(!tt2ConstantTime(sha,String(img.sha256||'').toLowerCase()))
     throw Error('IMAGE_CHECKSUM_MISMATCH');
   const existing=tt2Find('ImagesV2',0,img.imageId);
   if(existing){
    const proof=tt2RegisteredImage(img.imageId,sha,null,j,attr);
    receipts.push({ok:true,imageId:img.imageId,sha256:sha,url:proof.url});
    continue;
   }
   // Even when the ImageV2 row is absent, a durable intent with imageId
   // reservation must exist for THIS operation before creating a file.
   const claim=tt2ExistingImageClaim(img.imageId);
   if(!claim||claim.id!==j.id||
      !(claim.imageManifest||[]).some(x=>x.imageId===img.imageId&&x.sha256===sha))
     throw Error('IMAGE_ID_RESERVED');
   try{
    const filename=tt2FileName(img,sha),files=folder.getFilesByName(filename);
    const mime=img.data.match(/^data:([^;]+);/i)[1];
    const file=files.hasNext()?files.next():folder.createFile(Utilities.newBlob(bytes,mime,filename));
    tt2Fault('file');
    const url='https://drive.google.com/file/d/'+file.getId()+'/view';
    tt2Put('ImagesV2',[img.imageId,tt2Dataset(),sha,file.getId(),url,req.operationId]);
    tt2Fault('ImagesV2');
    receipts.push({ok:true,imageId:img.imageId,sha256:sha,url});
   }catch(e){
    if(String(e.message)==='IMAGE_TEMPORARY_UNAVAILABLE'){pending++;continue}
    throw e;
   }
  }
 }
 return {receipts,pending};
}
function tt2ImageReferences(row,receipts,j){
 const clean={...row};
 for(const attr of ['before_images','after_images','condition_images','repair_images']){
  const verified=[];
  let refs=[];
  try{refs=JSON.parse(row[attr]===undefined?'[]':row[attr])}
  catch(e){throw Error('BAD_IMAGE_RECORD')}
  if(!Array.isArray(refs))throw Error('BAD_IMAGE_RECORD');
  for(const ref of refs){
   // Re-resolve at commit, not merely on first preflight.
   const proof=tt2VerifyStoredImageRef(ref,j,attr);
   if(!verified.some(x=>x.imageId===ref.imageId))
    verified.push({imageId:proof.imageId,sha256:proof.sha256,url:proof.url});
  }
  for(const img of row[attr+'_raw']||[]){
   const receipt=receipts.find(x=>x&&x.ok===true&&
     x.imageId===img.imageId&&x.sha256===img.sha256);
   if(!receipt)throw Error('IMAGE_RECEIPT_INCOMPLETE');
   const proof=tt2RegisteredImage(img.imageId,img.sha256,receipt.url,j,attr);
   const existing=verified.findIndex(x=>x.imageId===proof.imageId);
   const saved={imageId:proof.imageId,sha256:proof.sha256,url:proof.url};
   if(existing>=0)verified[existing]=saved;else verified.push(saved);
  }
  clean[attr]=JSON.stringify(verified);
  delete clean[attr+'_raw'];delete clean[attr+'_urls'];
 }
 return clean;
}
function tt2CompletedTicketReplay(j,found){
 // Called under tt2Lock AFTER authentication, ACL and operation digest check.
 // A historical complete ACK is immutable, but it is not proof that a
 // missing/rolled-back/corrupt canonical ticket was superseded.
 if(!found)throw Error('CANONICAL_TICKET_MISSING');
 const row=found.row;
 if(String(row[0])!==j.ticketId||row[1]!==j.datasetId||
    row[4]!==j.owner)throw Error('CANONICAL_RESOURCE_MISMATCH');
 if(typeof row[2]!=='number'||!Number.isSafeInteger(row[2])||row[2]<0)
   throw Error('CANONICAL_REVISION_INVALID');
 if(row[2]<j.revision)throw Error('CANONICAL_REVISION_ROLLBACK');
 if(row[2]===j.revision){
   const evidence=tt2JournalEvidence(j);
   if(!evidence.committed||!evidence.completeRefs||
      evidence.verifiedReceipts.length!==evidence.manifestCount)
     // Preserve the pre-existing direct/completed-retry error contract;
     // safety remains fail-closed and no ACK or journal is mutated.
     throw Error('STORED_IMAGE_PROOF_INCOMPLETE');
   return JSON.parse(j.ackJson);
 }
 // Higher revision requires a REAL committed replacement operation matching
 // this exact ticket, owner, dataset, revision, action, marker and deleted flag.
 // A bare higher number is not sufficient to release local pending/raw.
 let saved;
 try{saved=JSON.parse(String(row[5]||''))}catch(e){throw Error('CANONICAL_NEWER_MARKER_INVALID')}
 if(!saved||typeof saved!=='object'||Array.isArray(saved)||
    typeof saved._lastOperationId!=='string')
   throw Error('CANONICAL_NEWER_MARKER_INVALID');
 const newer=tt2JournalFromFound(tt2Find('OperationsV2',0,saved._lastOperationId));
 if(!newer||newer.id===j.id||newer.datasetId!==j.datasetId||
    newer.ticketId!==j.ticketId||newer.owner!==j.owner||
    newer.revision!==row[2]||newer.revision<=j.revision||
    !Number.isSafeInteger(newer.expectedRevision)||
    newer.expectedRevision<j.revision||
    newer.expectedRevision>=newer.revision||
    !['upsert','delete'].includes(newer.action))
   throw Error('CANONICAL_NEWER_OPERATION_INVALID');
 if(newer.state!=='complete')throw Error('CANONICAL_NEWER_PENDING_RECOVERY');
 if(row[3] !== (newer.action==='delete'))
   throw Error('CANONICAL_NEWER_DELETED_MISMATCH');
 const evidence=tt2JournalEvidence(newer);
 if(!evidence.committed||!evidence.completeRefs||
    evidence.verifiedReceipts.length!==evidence.manifestCount)
   throw Error('CANONICAL_NEWER_PROOF_INCOMPLETE');
 return JSON.parse(j.ackJson);
}

function tt2Upsert(req,session){
 tt2CheckRequest(req,'upsert');
 if(!req.row||req.row.id===undefined||req.row.id===null)throw Error('BAD_TICKET');
 const id=String(req.row.id);
 return tt2Lock(()=>{
  const existing=tt2Find('TicketsV2',0,id),current=existing&&existing.row,
    priorOp=tt2JournalFromFound(tt2Find('OperationsV2',0,req.operationId));
  const owner=current?String(current[4]):priorOp&&priorOp.owner||session.username;
  tt2Can(session,'upsert',owner);
  const j=tt2GetOrStart(req,session,id,owner,current?Number(current[2]):0);
  if(j.state==='complete')return tt2CompletedTicketReplay(j,existing);
  const already=tt2RecheckCommitted(existing,j);
  // Read image receipts by imageId: file and ImagesV2 are individually idempotent.
  const {receipts,pending}=tt2ImageReceipts(req,j);
  const total=['before_images','after_images','condition_images','repair_images']
   .reduce((n,a)=>n+(req.row[a+'_raw']||[]).length,0);
  if(pending||receipts.length!==total){
    const partial=tt2Ack(req,receipts,false);
    tt2JournalWrite(j,'images_partial',partial);
    return partial;
  }
  if(!already){
    const safe=tt2ImageReferences(req.row,receipts,j);
    safe.created_by=j.owner;safe.updated_by=session.username;safe._lastOperationId=j.id;
    tt2Put('TicketsV2',[id,tt2Dataset(),j.revision,false,
      j.owner,JSON.stringify(safe),Date.now()],existing&&existing.line);
    tt2Fault('TicketsV2');
  }
  // Validate the actually persisted record before changing journal state
  // or emitting ACK complete. This covers direct retry where already=true
  // after TicketsV2 write/crash, as well as the fresh commit path.
  const committedProof=tt2JournalEvidence(j);
  if(!committedProof.committed||!committedProof.completeRefs||
     committedProof.verifiedReceipts.length!==committedProof.manifestCount)
    throw Error('STORED_IMAGE_PROOF_INCOMPLETE');
  if(receipts.length!==committedProof.verifiedReceipts.length||
     receipts.some(r=>!committedProof.verifiedReceipts.some(p=>
       p.imageId===r.imageId&&p.sha256===r.sha256&&p.url===r.url)))
    throw Error('STORED_IMAGE_RECEIPT_MISMATCH');
  tt2JournalWrite(j,'ticket_committed');
  tt2BumpGlobalRevision(j.globalRevision);
  const ack=tt2Ack(req,committedProof.verifiedReceipts,true);
  tt2JournalWrite(j,'complete',ack);
  tt2Fault('operation_complete');
  return ack;
 });
}
function tt2Delete(req,session){
 tt2CheckRequest(req,'delete');
 const id=String(req.id||'');
 if(!id)throw Error('BAD_TICKET');
 return tt2Lock(()=>{
  const found=tt2Find('TicketsV2',0,id),prior=found&&found.row,
    prevOp=tt2JournalFromFound(tt2Find('OperationsV2',0,req.operationId));
  const owner=prior?String(prior[4]):prevOp&&prevOp.owner||session.username;
  tt2Can(session,'delete',owner);
  const j=tt2GetOrStart(req,session,id,owner,prior?Number(prior[2]):0);
  if(j.state==='complete')return tt2CompletedTicketReplay(j,found);
  if(!tt2RecheckCommitted(found,j)){
    const original=prior?JSON.parse(String(prior[5]||'{}')):{};
    const safe={...original,_lastOperationId:j.id};
    tt2Put('TicketsV2',[id,tt2Dataset(),j.revision,true,j.owner,
      JSON.stringify(safe),Date.now()],found&&found.line);
    tt2Fault('TicketsV2');
  }
  tt2JournalWrite(j,'ticket_committed');
  tt2BumpGlobalRevision(j.globalRevision);
  const ack=tt2Ack(req,[],true);
  tt2JournalWrite(j,'complete',ack);
  tt2Fault('operation_complete');
  return ack;
 });
}
function tt2Snapshot(req,session){
 tt2Can(session,'snapshot',null);
 const cursor=Number(req.pageToken||0);
 if(!Number.isSafeInteger(cursor)||cursor<0)throw Error('BAD_CURSOR');
 const revision=Number(tt2Props().getProperty('TT2_GLOBAL_REV')||0);
 if(req.snapshotRevision!==undefined&&Number(req.snapshotRevision)!==revision)
   throw Error('SNAPSHOT_CHANGED');
 const rows=tt2Rows('TicketsV2').filter(r=>r[1]===tt2Dataset())
   .sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 const slice=rows.slice(cursor,cursor+100).map(r=>({
  ticketId:r[0],revision:Number(r[2]),deleted:r[3]===true,
  owner:r[4],row:r[3]===true?null:JSON.parse(String(r[5]||'{}'))
 }));
 return {ok:true,action:'snapshot',appId:TT2_APP,protocolVersion:2,
  datasetId:tt2Dataset(),revision,snapshotRevision:revision,
  rows:slice,tombstones:slice.filter(x=>x.deleted).map(x=>({ticketId:x.ticketId,revision:x.revision})),
  complete:cursor+100>=rows.length,
  nextPageToken:cursor+100<rows.length?String(cursor+100):null};
}
function tt2VerifyChatAttachmentRecord(record,j){
 if(!record||typeof record!=='object'||Array.isArray(record)||
    !Array.isArray(record.attachments))
   throw Error('CHAT_CANONICAL_ATTACHMENTS_MISSING');
 const manifest=Array.isArray(j.imageManifest)?j.imageManifest:[];
 const attachments=record.attachments,ids=new Set(),expected=new Set();
 if(attachments.length!==manifest.length)
   throw Error('CHAT_CANONICAL_ATTACHMENT_COUNT_MISMATCH');
 for(const m of manifest){
  if(!m||typeof m.attr!=='string'||!['before_images','after_images',
      'condition_images','repair_images'].includes(m.attr)||
     typeof m.imageId!=='string'||!/^[0-9a-f]{64}$/.test(m.sha256))
    throw Error('CHAT_MANIFEST_INVALID');
  if(expected.has(m.imageId))throw Error('CHAT_MANIFEST_DUPLICATE');
  expected.add(m.imageId);
  const match=attachments.find(a=>a&&a.imageId===m.imageId);
  if(!match)throw Error('CHAT_CANONICAL_ATTACHMENT_MISSING');
  if(ids.has(match.imageId))throw Error('CHAT_CANONICAL_ATTACHMENT_DUPLICATE');
  ids.add(match.imageId);
  if(!/^[0-9a-f]{64}$/.test(match.sha256)||match.sha256!==m.sha256||
     typeof match.url!=='string')
    throw Error('CHAT_CANONICAL_ATTACHMENT_HASH_INVALID');
  const proof=tt2VerifyStoredImageRef(match,j,m.attr);
  if(proof.imageId!==m.imageId||proof.sha256!==m.sha256||proof.url!==match.url)
    throw Error('CHAT_CANONICAL_ATTACHMENT_PROOF_INVALID');
 }
 for(const a of attachments)
  if(!a||typeof a.imageId!=='string'||!expected.has(a.imageId))
    throw Error('CHAT_CANONICAL_ATTACHMENT_UNCLAIMED');
 return true;
}
function tt2VerifiedHistoricalRecordAck(j,evidence){
 if(!j.ackJson||!evidence.completeRefs||
    evidence.verifiedReceipts.length!==evidence.manifestCount)
   throw Error('CHAT_HISTORICAL_RECEIPT_PROOF_INCOMPLETE');
 let ack;try{ack=JSON.parse(j.ackJson)}catch(e){throw Error('CHAT_HISTORICAL_ACK_INVALID')}
 if(!ack||ack.ok!==true||ack.action!==j.action||
    ack.datasetId!==j.datasetId||ack.appId!==TT2_APP||
    Number(ack.protocolVersion)!==TT2_PROTOCOL||
    !ack.ack||ack.ack.accepted!==true||
    ack.ack.operationComplete!==true||
    ack.ack.operationId!==j.id||
    ack.ack.datasetId!==j.datasetId||
    ack.ack.action!==j.action||
    String(ack.ack.ticketId)!==j.ticketId||
    Number(ack.ack.acceptedRevision)!==j.revision||
    !Array.isArray(ack.images)||ack.images.length!==evidence.verifiedReceipts.length)
    throw Error('CHAT_HISTORICAL_ACK_INVALID');
 for(const p of evidence.verifiedReceipts)
  if(!ack.images.some(x=>x&&x.ok===true&&x.imageId===p.imageId&&
    x.sha256===p.sha256&&x.url===p.url))
   throw Error('CHAT_HISTORICAL_ACK_MISMATCH');
 return ack;
}

function tt2ChatAttachmentMetadata(req,receipt){
 const slots=['before_images','after_images','condition_images','repair_images'];
 let raw=null;
 for(const attr of slots)
  for(const item of req.row?.[attr+'_raw']||[])
   if(item.imageId===receipt.imageId){raw=item;break}
 if(!raw||raw.sha256!==receipt.sha256)
  throw Error('CHAT_ATTACHMENT_RAW_NOT_BOUND');
 const match=String(raw.data||'').match(/^data:([^;]+);base64,/i);
 if(!match)throw Error('CHAT_ATTACHMENT_MIME_MISSING');
 const mime=match[1].toLowerCase();
 const user=req.record?.attachment;
 if(user){
  if(user.imageId!==receipt.imageId||user.sha256!==receipt.sha256||
     user.mime!==mime||typeof user.name!=='string'||user.name.length>128||
     !['image','file'].includes(user.kind)||
     user.kind!==(mime.startsWith('image/')?'image':'file'))
   throw Error('CHAT_ATTACHMENT_METADATA_MISMATCH');
 }
 const name=String(user?.name||raw.name||'attachment').slice(0,128);
 return {kind:mime.startsWith('image/')?'image':'file',
  mime,name,imageId:receipt.imageId,sha256:receipt.sha256,url:receipt.url};
}

function tt2CompletedRecordReplay(j,found,sheet){
 if(!found)throw Error('CANONICAL_RECORD_MISSING');
 const row=found.row;
 if(String(row[0])!==j.ticketId||row[1]!==j.datasetId||row[4]!==j.owner)
   throw Error('CANONICAL_RECORD_BINDING');
 if(typeof row[2]!=='number'||!Number.isSafeInteger(row[2])||row[2]<0)
   throw Error('CANONICAL_RECORD_REVISION_INVALID');
 if(row[2]<j.revision)throw Error('CANONICAL_RECORD_ROLLBACK');
 let saved;try{saved=JSON.parse(String(row[5]||''))}catch(e){throw Error('CANONICAL_RECORD_MARKER')}
 if(!saved||typeof saved!=='object'||Array.isArray(saved)||
    typeof saved._lastOperationId!=='string')throw Error('CANONICAL_RECORD_MARKER');
 const isChat=j.action==='chat_write';
 // Historical ACK alone is NOT proof: manifest, SHA, registry, file and
 // journal source must still be valid before any replay succeeds.
 const original=tt2JournalEvidence(j);
 const historical=isChat?tt2VerifiedHistoricalRecordAck(j,original):null;
 if(row[2]===j.revision){
  if(saved._lastOperationId!==j.id||row[3]!==j.recordDeleted)
   throw Error('CANONICAL_RECORD_PROOF_INCOMPLETE');
  if(isChat&&(!original.committed||!original.completeRefs||
     !tt2VerifyChatAttachmentRecord(saved,j)))
    throw Error('CANONICAL_CHAT_PROOF_INCOMPLETE');
  return historical||JSON.parse(j.ackJson);
 }
 const newer=tt2JournalFromFound(tt2Find('OperationsV2',0,saved._lastOperationId));
 if(!newer||newer.id===j.id||newer.datasetId!==j.datasetId||
    newer.ticketId!==j.ticketId||newer.owner!==j.owner||
    newer.revision!==row[2]||newer.revision<=j.revision||
    newer.expectedRevision<j.revision||newer.expectedRevision>=newer.revision||
    newer.action!==j.action||newer.state!=='complete'||
    row[3]!==newer.recordDeleted)
    throw Error('CANONICAL_RECORD_NEWER_PROOF_INCOMPLETE');
 const current=tt2JournalEvidence(newer);
 if(!current.committed||!current.completeRefs||
    current.verifiedReceipts.length!==current.manifestCount)
   throw Error('CANONICAL_RECORD_NEWER_PROOF_INCOMPLETE');
 if(isChat&&(!tt2VerifyChatAttachmentRecord(saved,newer)||
    !tt2VerifiedHistoricalRecordAck(newer,current)))
   throw Error('CANONICAL_CHAT_NEWER_PROOF_INCOMPLETE');
 return historical||JSON.parse(j.ackJson);
}

function tt2Record(req,session,kind){
 const spec=kind==='notes'?{sheet:'NotesV2',write:'notes_write'}:{sheet:'ChatV2',write:'chat_write'};
 tt2CheckRequest(req,spec.write);
 const id=String(req.recordId||'');
 if(!/^[A-Za-z0-9._:-]{1,128}$/.test(id))throw Error('INVALID_RECORD');
 if(kind==='chat'&&(!req.record||typeof req.record!=='object'||req.record.imageData||req.record.fileData))
   throw Error('CHAT_UNSAFE_PAYLOAD');
 return tt2Lock(()=>{
  const found=tt2Find(spec.sheet,0,id),old=found&&found.row,
    prevOp=tt2JournalFromFound(tt2Find('OperationsV2',0,req.operationId));
  const owner=old?String(old[4]):prevOp&&prevOp.owner||session.username;
  tt2Can(session,spec.write,owner);
  const j=tt2GetOrStart(req,session,id,owner,old?Number(old[2]):0);
  if(j.state==='complete')return tt2CompletedRecordReplay(j,found,spec.sheet);
  let receipts=[],pending=0;
  if(kind==='chat'&&req.row){
   if(String(req.row.id)!==id)throw Error('CHAT_ATTACHMENT_RESOURCE_MISMATCH');
   ({receipts,pending}=tt2ImageReceipts(req,j));
   const count=['before_images','after_images','condition_images','repair_images']
     .reduce((n,k)=>n+(req.row[k+'_raw']||[]).length,0);
   if(pending||receipts.length!==count){
    const partial=tt2Ack({...req,id,action:spec.write},receipts,false);
    tt2JournalWrite(j,'images_partial',partial);return partial;
   }
  }
  const stored=old?JSON.parse(String(old[5]||'{}')):null;
  const already=old&&Number(old[2])===j.revision&&stored._lastOperationId===j.id;
  if(!already){
    if(old&&Number(old[2])!==j.expectedRevision)throw Error('REVISION_CONFLICT');
    const safe={...(req.record||{}),_lastOperationId:j.id};
    if(kind==='chat'){
     safe.attachments=[];
     for(const receipt of receipts){
      const proof=tt2RegisteredImage(receipt.imageId,receipt.sha256,receipt.url,j,'before_images');
      const detail=tt2ChatAttachmentMetadata(req,proof);
      safe.attachments.push(detail);
     }
    }
    tt2Put(spec.sheet,[id,tt2Dataset(),j.revision,req.deleted===true,
      j.owner,JSON.stringify(safe)],found&&found.line);
    tt2Fault('record_commit');
  }
  const evidence=tt2JournalEvidence(j);
  if(!evidence.committed||!evidence.completeRefs||
     evidence.verifiedReceipts.length!==evidence.manifestCount)
    throw Error('CANONICAL_RECORD_PROOF_INCOMPLETE');
  tt2JournalWrite(j,'ticket_committed');
  tt2BumpGlobalRevision(j.globalRevision);
  const ack=tt2Ack({...req,id,action:spec.write},evidence.verifiedReceipts,true);
  tt2JournalWrite(j,'complete',ack);
  tt2Fault('operation_complete');
  return ack;
 });
}

function tt2ChatReadVerifiedRecord(r){
 const record=r[3]===true?null:JSON.parse(String(r[5]||'{}'));
 if(!record)return null;
 const j=tt2JournalFromFound(tt2Find('OperationsV2',0,record._lastOperationId));
 if(!j||j.id!==record._lastOperationId||j.ticketId!==String(r[0])||
    j.datasetId!==r[1]||j.owner!==String(r[4])||
    j.revision!==Number(r[2])||j.recordDeleted!==false||
    j.state!=='complete'||j.action!=='chat_write')
   throw Error('CHAT_READ_CANONICAL_JOURNAL_MISMATCH');
 const proof=tt2JournalEvidence(j);
 if(!proof.committed||!proof.completeRefs||
    proof.verifiedReceipts.length!==proof.manifestCount)
   throw Error('CHAT_READ_ATTACHMENT_PROOF_INCOMPLETE');
 tt2VerifyChatAttachmentRecord(record,j);
 return record;
}
function tt2ReadRecords(req,session,kind){
 const sheet=kind==='notes'?'NotesV2':'ChatV2';
 const action=kind==='notes'?'notes_read':'chat_read';
 tt2Can(session,action,null);
 const cursor=Number(req.pageToken||0);
 if(!Number.isSafeInteger(cursor)||cursor<0)throw Error('BAD_CURSOR');
 const revision=Number(tt2Props().getProperty('TT2_GLOBAL_REV')||0);
 if(req.snapshotRevision!==undefined&&Number(req.snapshotRevision)!==revision)
   throw Error('SNAPSHOT_CHANGED');
 // Never return a corrupt attachment record, but do not allow one bad
 // row to starve unrelated authenticated chat messages forever.
 let quarantineCount=0;
 const rows=tt2Rows(sheet).filter(r=>r[1]===tt2Dataset()&&
   (kind!=='notes'||r[4]===session.username||
      (session.role==='admin'&&req.owner===r[4])))
   .filter(r=>{
     if(kind!=='chat'||r[3]===true)return true;
     try{tt2ChatReadVerifiedRecord(r);return true}
     catch(e){quarantineCount++;return false}
   })
   .sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 const slice=rows.slice(cursor,cursor+100).map(r=>({
  recordId:String(r[0]),revision:Number(r[2]),deleted:r[3]===true,
  owner:String(r[4]),record:r[3]===true?null:JSON.parse(String(r[5]||'{}'))
 }));
 return {ok:true,action,appId:TT2_APP,protocolVersion:TT2_PROTOCOL,
  datasetId:tt2Dataset(),snapshotRevision:revision,revision,
  rows:slice,quarantinedCount:quarantineCount,integrityWarning:quarantineCount>0,
  complete:cursor+100>=rows.length,
  nextPageToken:cursor+100<rows.length?String(cursor+100):null};
}

function tt2ScanDriveFolder(folder,depth){
 let bytes=0,count=0;
 if(!folder||depth>20)return {bytes,count};
 try{
  if(typeof folder.getFiles==='function'){
   const files=folder.getFiles();
   while(files.hasNext()){
    const f=files.next();
    try{bytes+=Number(f.getSize()||0)||0;}catch(_){}
    count++;
   }
  }
  if(typeof folder.getFolders==='function'){
   const subs=folder.getFolders();
   while(subs.hasNext()){
    const sub=tt2ScanDriveFolder(subs.next(),depth+1);
    bytes+=sub.bytes;count+=sub.count;
   }
  }
 }catch(_){}
 return {bytes,count};
}
function tt2DriveStorage(session){
 tt2Can(session,'drive_storage',null);
 const datasetId=tt2Dataset();
 let usedBytes=0,limitBytes=0,usageInDrive=0,usageInPhotos=0,usageGmailOther=0;
 let folderUsedBytes=0,fileCount=0,userEmail='',quotaSource='driveapp_v2';
 try{if(typeof DriveApp!=='undefined'&&typeof DriveApp.getStorageUsed==='function')usedBytes=Number(DriveApp.getStorageUsed()||0)||0;}catch(_){}
 try{if(typeof DriveApp!=='undefined'&&typeof DriveApp.getStorageLimit==='function')limitBytes=Number(DriveApp.getStorageLimit()||0)||0;}catch(_){}
 usageInDrive=usedBytes;
 try{
  if(typeof UrlFetchApp!=='undefined'&&typeof ScriptApp!=='undefined'&&typeof ScriptApp.getOAuthToken==='function'){
   const tok=ScriptApp.getOAuthToken();
   if(tok){
    const r=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota,user',{
     method:'get',headers:{Authorization:'Bearer '+tok},muteHttpExceptions:true
    });
    if(r&&r.getResponseCode&&r.getResponseCode()===200){
     const about=JSON.parse(r.getContentText()||'{}');
     const sq=about.storageQuota||{};
     const apiUsed=Number(sq.usage||0)||0,apiLim=Number(sq.limit||0)||0;
     const apiDrive=Number(sq.usageInDrive||0)||0,apiPhotos=Number(sq.usageInPhotos||0)||0;
     if(apiUsed>0)usedBytes=apiUsed;
     if(apiLim>0)limitBytes=apiLim;
     if(apiDrive>0||apiUsed>0){
      usageInDrive=apiDrive;usageInPhotos=apiPhotos;
      usageGmailOther=Math.max(0,usedBytes-apiDrive-apiPhotos);
      quotaSource='about_v3';
     }
     if(about.user&&about.user.emailAddress)userEmail=String(about.user.emailAddress);
    }
   }
  }
 }catch(_){}
 const folderId=tt2Props().getProperty('TT_DRIVE_FOLDER_ID')||'';
 if(folderId&&typeof DriveApp!=='undefined'&&typeof DriveApp.getFolderById==='function'){
  try{
   const folder=DriveApp.getFolderById(folderId);
   if(folder&&typeof folder.getFiles==='function'){
    const st=tt2ScanDriveFolder(folder,0);
    folderUsedBytes=st.bytes;fileCount=st.count;
   }else{
    fileCount=tt2Rows('ImagesV2').filter(r=>r[1]===datasetId).length;
   }
  }catch(_){}
 }
 if(!usedBytes&&folderUsedBytes>0){usedBytes=folderUsedBytes;usageInDrive=folderUsedBytes;}
 return {
  ok:true,action:'drive_storage',appId:TT2_APP,protocolVersion:TT2_PROTOCOL,datasetId,
  actor:session.username,usedBytes,limitBytes,usageInDrive,usageInPhotos,usageGmailOther,
  quotaSource,folderUsedBytes,fileCount,scannedAt:Date.now(),userEmail
 };
}

function tt2ImageGet(req,session){
 tt2Can(session,'image_get');
 const fileId=String(req&&req.fileId||'').trim();
 if(!/^[A-Za-z0-9_-]{10,120}$/.test(fileId))throw Error('INVALID_IMAGE_ID');
 const datasetId=tt2Dataset();
 const registered=tt2Rows('ImagesV2').some(r=>String(r[1]||'')===datasetId&&String(r[3]||'')===fileId);
 const file=DriveApp.getFileById(fileId);
 if(!registered){
  const folderId=tt2DriveFolder().getId();
  let inFolder=false;
  const parents=file.getParents();
  while(parents.hasNext()){if(parents.next().getId()===folderId){inFolder=true;break;}}
  if(!inFolder)throw Error('IMAGE_NOT_AUTHORIZED');
 }
 const blob=file.getBlob();
 const mimeType=String(blob.getContentType()||'image/jpeg').split(';')[0].trim().toLowerCase();
 if(!/^image\/(?:jpeg|jpg|png|webp|gif|heic|heif)$/i.test(mimeType))throw Error('UNSUPPORTED_IMAGE_MIME');
 const bytes=blob.getBytes();
 if(!bytes||bytes.length>12*1024*1024)throw Error('IMAGE_TOO_LARGE');
 return {ok:true,action:'image_get',appId:TT2_APP,protocolVersion:2,datasetId,
   fileId,mimeType,dataUrl:'data:'+mimeType+';base64,'+Utilities.base64Encode(bytes)};
}

function tt2Handle(req){
 const tReq0=Date.now();
 __tt2Ctx=tt2NewCtx();
 try{
  const action=String(req.action||'');
  if(action==='capabilities')return {ok:true,action:'capabilities',appId:TT2_APP,protocolVersion:2,
    schemaVersion:2,datasetId:tt2Dataset(),revisionAck:true,imageAck:true,
    idempotency:true,authRequired:true};
  if(action==='login')return tt2Login(req);
  const ta0=Date.now();
  const session=tt2Session(req);
  if(__tt2Ctx)__tt2Ctx.timing.authMs=Date.now()-ta0;
  if(action==='whoami')return {ok:true,action:'whoami',appId:TT2_APP,protocolVersion:2,
    datasetId:tt2Dataset(),expiresAt:session.expiresAt,actor:{username:session.username,role:session.role}};
  if(action==='drive_storage')return tt2DriveStorage(session);
  if(action==='image_get')return tt2ImageGet(req,session);
  if(action==='logout'){
   tt2Props().deleteProperty('TT2_SESSION_'+tt2Sha(req.sessionToken));
   return {ok:true,action:'logout'};
  }
  if(action==='recover_operation')return tt2AdminRecover(req,session);
  if(action==='snapshot')return tt2Snapshot(req,session);
  if(action==='notes_read')return tt2ReadRecords(req,session,'notes');
  if(action==='chat_read')return tt2ReadRecords(req,session,'chat');
  if(action==='upsert'){
   const res=tt2Upsert(req,session);
   if(__tt2Ctx){__tt2Ctx.timing.totalMs=Date.now()-tReq0;return {...res,timing:{...__tt2Ctx.timing}};}
   return res;
  }
  if(action==='delete'){
   const res=tt2Delete(req,session);
   if(__tt2Ctx){__tt2Ctx.timing.totalMs=Date.now()-tReq0;return {...res,timing:{...__tt2Ctx.timing}};}
   return res;
  }
  if(action==='notes_write')return tt2Record(req,session,'notes');
  if(action==='chat_write')return tt2Record(req,session,'chat');
  // chat_clear: never allow legacy clear without per-message tombstones and admin authorization.
  if(['chat_clear','getAll','getUsers','saveUsers','saveNotes'].includes(action))
   throw Error('LEGACY_ACTION_BLOCKED');
  throw Error('UNKNOWN_ACTION');
 }finally{__tt2Ctx=null;}
}
function doPost(e){
 try{
  const data=JSON.parse((e&&e.postData&&e.postData.contents)||'{}');
  return ContentService.createTextOutput(JSON.stringify(tt2Handle(data))).setMimeType(ContentService.MimeType.JSON);
 }catch(err){
  const code=String(err&&err.message||'FAILED').replace(/[^A-Z_]/g,'').slice(0,40)||'FAILED';
  return ContentService.createTextOutput(JSON.stringify({ok:false,errorCode:code}))
   .setMimeType(ContentService.MimeType.JSON);
 }
}
function doGet(){return ContentService.createTextOutput(JSON.stringify({ok:false,errorCode:'GET_DISABLED'}))
 .setMimeType(ContentService.MimeType.JSON);}

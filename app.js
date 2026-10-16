import {initializeApp} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import {getAuth,GoogleAuthProvider,signInWithPopup,signOut,onAuthStateChanged,setPersistence,indexedDBLocalPersistence,browserSessionPersistence,inMemoryPersistence} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import {getFirestore,collection,doc,getDoc,getDocs,onSnapshot,query,where,orderBy,setDoc,writeBatch,runTransaction,serverTimestamp} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';

// FirebaseのWeb設定は公開用識別情報。データの保護は必ず firestore.rules で実施します。
const firebaseConfig={apiKey:'AIzaSyAPYQt1vLtcjwn6JKyeP-YGviwUGQi9Glc',authDomain:'yorimichi-lifelog.firebaseapp.com',projectId:'yorimichi-lifelog',storageBucket:'yorimichi-lifelog.firebasestorage.app',messagingSenderId:'756920621415',appId:'1:756920621415:web:7e486f5e3a31abd25037c2'};
const OWNER_EMAIL='webrich60@gmail.com';
const app=initializeApp(firebaseConfig),auth=getAuth(app),db=getFirestore(app);
const provider=new GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});
const $=id=>document.getElementById(id);
const today=()=>{const d=new Date();const j=new Date(d.getTime()-d.getTimezoneOffset()*60000);return j.toISOString().slice(0,10)};
const dateText=v=>v?String(v).slice(0,10).replace(/-/g,'.'):'';
const now=()=>new Date().toISOString();
const uniqueId=()=>globalThis.crypto?.randomUUID?.()||('id_'+Date.now()+'_'+Math.random().toString(36).slice(2));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const validCoord=(lat,lng)=>lat!==null&&lng!==null&&lat!==''&&lng!==''&&Number.isFinite(Number(lat))&&Number.isFinite(Number(lng))&&Math.abs(Number(lat))<=90&&Math.abs(Number(lng))<=180;
const mapsUrl=place=>`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place||'日本')}`;
const defaultCats={'観光・旅行':['観光スポット','自然・絶景','寺社・歴史','道の駅','旅館・ホテル','温泉'],'外食・グルメ':['カフェ・喫茶','和食','洋食','海鮮','ラーメン・麺類','スイーツ','中華'],'遊び・体験':['レジャー','イベント','文化体験','ドライブ'],'日常・暮らし':['買い物','家族','散歩','その他'],'宿泊':['ホテル','旅館','温泉宿']};
const state={user:null,logs:[],wishes:[],categories:structuredClone(defaultCats),media:null,tab:'home',unsubs:[],map:null,leafletPromise:null,pendingMapPoint:null,headerImg:null,headerX:0,headerY:0,headerZoom:1,headerBaseScale:1,photoCache:new Map(),headerPhotoIndex:null,visitSeq:0,toastTimer:null,loaded:{logs:false,wishes:false}};
const alertMsg=(message,bad=false)=>{let el=$('toast');el.textContent=message;el.style.background=bad?'#963d40':'#193d58';el.classList.remove('hidden');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.add('hidden'),4200)};
const syncInfo=s=>{$('syncState').textContent=s};
const friendlyErr=e=>{const c=e?.code||'',m=e?.message||String(e);if(c.includes('permission-denied'))return '保存権限がありません。FirestoreルールとGoogleアカウントを確認してください。';if(c.includes('offline')||c.includes('unavailable'))return '通信に接続できません。ネットワークを確認してください。';if(c.includes('popup'))return 'Googleログインが開けません。Chromeで開いて、ポップアップの許可を確認してください。';return m.slice(0,180)};
const dateSort=(arr,which='date',dir='new')=>[...arr].sort((a,b)=>dir==='new'?String(b[which]||b.createdAt||'').localeCompare(String(a[which]||a.createdAt||'')):String(a[which]||a.createdAt||'').localeCompare(String(b[which]||b.createdAt||'')));
const categoriesWithHistory=()=>{const cats=structuredClone(state.categories);for(const item of [...state.logs,...state.wishes]){const maj=item.major||'その他',min=item.minor||'';if(!cats[maj])cats[maj]=[];if(min&&!cats[maj].includes(min))cats[maj].push(min)}return cats};
function optionList(select,items,first=''){const current=select.value;select.replaceChildren();if(first){select.add(new Option(first,''))}items.forEach(x=>select.add(new Option(x,x)));if([...select.options].some(x=>x.value===current))select.value=current}
function resetLogin(){state.user=null;state.logs=[];state.wishes=[];state.photoCache.clear();cardThumbnailCache.clear();state.headerPhotoIndex=null;state.visitSeq++;state.loaded={logs:false,wishes:false};for(const un of state.unsubs)try{un()}catch(_){}state.unsubs=[];$('loginPage').classList.remove('hidden');$('appPage').classList.add('hidden');$('bottomNav').classList.add('hidden');$('account').classList.add('hidden')}
// Firebase Auth の localStorage 容量超過に備える。既存の他アプリの端末データは削除しない。
// 第1候補: IndexedDB（ブラウザ終了後もログイン状態を保持）
// 第2候補: sessionStorage（タブを閉じるまで保持）
// 第3候補: メモリ（一時的なログイン）
const isAuthStorageError=e=>/setItem|quota|storage|indexeddb|exceeded|persist|保存容量/i.test([e?.message,e?.code].join(' '));
const authPersistenceCandidates=[
  {name:'IndexedDB',value:indexedDBLocalPersistence},
  {name:'sessionStorage',value:browserSessionPersistence},
  {name:'一時メモリ',value:inMemoryPersistence}
];
$('login').addEventListener('click',async()=>{
  const btn=$('login');
  if(btn.disabled)return;
  btn.disabled=true;
  $('loginError').textContent='Googleログインを準備しています…';
  let lastError;
  try{
    for(let i=0;i<authPersistenceCandidates.length;i++){
      const candidate=authPersistenceCandidates[i];
      try{
        await setPersistence(auth,candidate.value);
        $('loginError').textContent='Googleアカウントに接続しています…';
        await signInWithPopup(auth,provider);
        if(i>0)alertMsg('ログインできました。端末の保存容量の関係で、次回は再ログインが必要な場合があります。');
        return;
      }catch(e){
        lastError=e;
        // ストレージ関係以外（ログインの取り消し等）の場合は再試行しない。
        if(!isAuthStorageError(e))break;
        $('loginError').textContent='ブラウザの保存方法を切り替えています…';
      }
    }
    $('loginError').textContent=isAuthStorageError(lastError)
      ?'ブラウザにログイン情報を保存できませんでした。端末の空き容量やサイトデータの使用状況を確認してください。'
      :friendlyErr(lastError);
  }finally{
    btn.disabled=false;
  }
});
$('logout').addEventListener('click',()=>signOut(auth).catch(e=>alertMsg(friendlyErr(e),true)));
onAuthStateChanged(auth,user=>{if(!user){resetLogin();return}if(user.email?.toLowerCase()!==OWNER_EMAIL){$('loginError').textContent='このGoogleアカウントは許可されていません。元のライフログ用アカウントを選んでください。';signOut(auth).catch(()=>{});return}state.user=user;$('loginPage').classList.add('hidden');$('appPage').classList.remove('hidden');$('bottomNav').classList.remove('hidden');$('account').classList.remove('hidden');$('emailBadge').textContent=user.email;connectData()});
function connectData(){for(const unsub of state.unsubs)unsub();state.unsubs=[];state.loaded={logs:false,wishes:false};syncInfo('Firestore接続中…');state.unsubs.push(onSnapshot(collection(db,'logs'),snap=>{state.logs=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>!x.deleted);state.loaded.logs=true;dataUpdated()},err=>syncInfo('思い出取得エラー: '+friendlyErr(err))));state.unsubs.push(onSnapshot(collection(db,'wishes'),snap=>{state.wishes=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>!x.deleted);state.loaded.wishes=true;dataUpdated()},err=>syncInfo('行きたい場所取得エラー: '+friendlyErr(err))));state.unsubs.push(onSnapshot(doc(db,'settings','categories'),snap=>{if(snap.exists()&&snap.data().majors)state.categories=snap.data().majors;refreshCategoryUi();render()},err=>syncInfo('カテゴリ取得エラー: '+friendlyErr(err))));state.unsubs.push(onSnapshot(doc(db,'media','header'),snap=>{state.media=snap.exists()?snap.data().dataUrl||null:null;applyHeader();},err=>alertMsg('ヘッダー画像: '+friendlyErr(err),true)))}
function dataUpdated(){syncInfo(state.loaded.logs&&state.loaded.wishes?'● 本番接続済み・自動保存有効':'データを同期しています…');refreshCategoryUi();render()}
const navButtons=[...document.querySelectorAll('[data-tab]')];function showTab(tab){state.tab=tab;document.querySelectorAll('.view').forEach(el=>el.classList.toggle('hidden',el.id!==tab));document.querySelectorAll('.bottom-nav button').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===tab));render();if(tab==='map')loadMap().catch(e=>{$('mapHint').textContent='地図読み込みに失敗しました: '+friendlyErr(e)})}
navButtons.forEach(b=>b.addEventListener('click',()=>showTab(b.dataset.tab)));
function render(){if(!state.user)return;const logs=state.logs,wishes=state.wishes;$('statLogs').textContent=logs.length;$('statWishes').textContent=wishes.filter(x=>x.status!=='visited').length;$('statStamps').textContent=wishes.filter(x=>x.status==='visited').length;$('statPins').textContent=[...logs,...wishes].filter(x=>validCoord(x.lat,x.lng)).length;renderHome();if(state.tab==='logs')renderLogs();if(state.tab==='wishes')renderWishes();if(state.tab==='settings')renderCategories();if(state.tab==='map'&&state.map)renderMapPins()}
// 写真付き思い出カード：写真がない記録は中立的なアイコンを表示する。
// ※ 見た目の改善のみ。写真・記録・ピンの内容は更新しない。
function thumbButton(x,compact=false){
  const title=esc(x.title||'思い出');
  return `<button type="button" class="${compact?'visit-mini-thumb':'entry-cover'}" data-photo-log="${esc(x.id)}" data-view="${esc(x.id)}" aria-label="${title}の思い出を見る"><span class="photo-empty-icon" aria-hidden="true">📷</span><span class="photo-empty-text">写真を確認中</span></button>`;
}
function cardLog(x){
  return `<article class="entry card entry-photo-card">
    ${thumbButton(x)}
    <div class="entry-main">
      <div class="entry-meta">${esc(dateText(x.date))}${x.date?' ・ ':''}${esc(x.major||'思い出')}${x.minor?' / '+esc(x.minor):''}</div>
      <div class="entry-title">${esc(x.title)}</div>
      ${x.place?`<a href="${mapsUrl(x.place)}" target="_blank" rel="noopener noreferrer" class="entry-meta entry-address">📍 ${esc(x.place)} ↗</a>`:''}
      <div class="entry-actions"><button class="primary slim record-open" data-view="${esc(x.id)}">記録を見る <span aria-hidden="true">›</span></button><button class="ghost slim" data-edit-log="${esc(x.id)}">編集する</button></div>
    </div>
  </article>`;
}
function cardGroupedVisit(x){
  return `<div class="visit-inner visit-photo-row">
    ${thumbButton(x,true)}
    <div class="visit-detail">
      <div class="entry-meta">${esc(dateText(x.date))} / ${esc(x.minor||x.major||'思い出')}</div>
      <strong class="visit-title">${esc(x.title)}</strong>
      ${x.note?`<p class="entry-note visit-excerpt">${esc(x.note)}</p>`:''}
      <div class="entry-actions"><button class="ghost slim" data-view="${esc(x.id)}">記録を見る ›</button><button class="ghost slim" data-edit-log="${esc(x.id)}">編集する</button></div>
    </div>
  </div>`;
}
// Firestoreの写真ID参照を用いて、表示領域に入ったカードの1枚目のみ遅延取得。
// 写真が未登録の記録もあるため、カードごとに「写真なし」を明示する。
const cardThumbnailCache=new Map();
async function firstPhotoForCard(log){
  const key=String(log.updatedAt||'')+'|'+JSON.stringify(log.photos||[]);
  const cached=cardThumbnailCache.get(log.id);
  if(cached?.key===key)return cached.promise;
  const promise=(async()=>{
    const direct=(Array.isArray(log.photos)?log.photos:[]).filter(p=>p?.type==='firestore');
    for(const photo of direct){try{const uri=await getPhoto(photo);if(uri)return uri}catch(_){/* 別の参照も試す */}}
    // 古いGASから移したログのように photos が空でも、ownerId から参照を取得する。
    const refs=await photoRefsForVisit(log);
    for(const photo of refs.filter(p=>p?.type==='firestore')){
      try{const uri=await getPhoto(photo);if(uri)return uri}catch(_){/* ほかの写真を確認 */}
    }
    return null;
  })().catch(e=>{cardThumbnailCache.delete(log.id);throw e});
  cardThumbnailCache.set(log.id,{key,promise});
  return promise;
}
async function fillThumbnail(el){
  const id=el.dataset.photoLog;
  const log=state.logs.find(x=>x.id===id);
  if(!log||!el.isConnected)return;
  try{
    const uri=await firstPhotoForCard(log);
    if(!el.isConnected||el.dataset.photoLog!==id)return;
    if(uri){
      const img=document.createElement('img');
      img.src=uri;img.alt='';img.loading='lazy';img.decoding='async';img.className='record-cover-img';
      const label=document.createElement('span');label.className='record-cover-label';label.textContent='写真を見る';
      el.replaceChildren(img,label);el.classList.add('has-photo');
    }else{
      el.replaceChildren();
      const icon=document.createElement('span');icon.className='photo-empty-icon';icon.textContent='📖';icon.setAttribute('aria-hidden','true');
      const txt=document.createElement('span');txt.className='photo-empty-text';txt.textContent='写真なし';
      el.append(icon,txt);
    }
  }catch(_){
    if(!el.isConnected)return;
    el.replaceChildren();
    const icon=document.createElement('span');icon.className='photo-empty-icon';icon.textContent='📷';icon.setAttribute('aria-hidden','true');
    const txt=document.createElement('span');txt.className='photo-empty-text';txt.textContent='再確認';
    el.append(icon,txt);
  }
}
const cardPhotoObserver=typeof IntersectionObserver!=='undefined'?new IntersectionObserver(entries=>{
  for(const item of entries){if(!item.isIntersecting)continue;cardPhotoObserver.unobserve(item.target);void fillThumbnail(item.target)}
},{rootMargin:'180px 0px'}):null;
function scheduleCardThumbnails(container){
  for(const el of container.querySelectorAll('[data-photo-log]')){
    if(cardPhotoObserver)cardPhotoObserver.observe(el);
    else void fillThumbnail(el);
  }
}
function cardWish(x){return `<article class="entry card"><div><div class="entry-meta">${esc(x.major||'行きたい')} ${x.minor?' / '+esc(x.minor):''}</div><div class="entry-title">${esc(x.title)}</div><span class="pill ${x.status==='visited'?'visited':'wish'}">${x.status==='visited'?'✓ 行った！':x.status==='planning'?'計画中':'行きたい'}</span>${x.place?`<a href="${mapsUrl(x.place)}" target="_blank" rel="noopener noreferrer" class="entry-meta">📍 ${esc(x.place)} ↗</a>`:''}<div class="entry-actions">${x.status!=='visited'?`<button class="primary slim" data-stamp="${esc(x.id)}">✓ 行った！</button>`:''}<button class="ghost slim" data-edit-wish="${esc(x.id)}">編集</button><button class="ghost slim" data-delete-wish="${esc(x.id)}">削除</button></div></div></article>`}
const empty=t=>`<div class="card" style="padding:24px;text-align:center;color:#668292">${esc(t)}</div>`;
function renderHome(){$('homeRecent').innerHTML=dateSort(state.logs).slice(0,3).map(cardLog).join('')||empty('思い出がまだありません。初めての1件を残してみよう。');scheduleCardThumbnails($('homeRecent'));$('homeWishes').innerHTML=dateSort(state.wishes.filter(x=>x.status!=='visited'),'createdAt').slice(0,2).map(cardWish).join('')||empty('行きたい場所をひとつ登録してみよう。')}
function filtered(list,search,major){const text=search.trim().toLocaleLowerCase('ja');return list.filter(x=>(!major||x.major===major)&&(!text||[x.title,x.place,x.note,x.reason,x.groupName,x.major,x.minor].some(s=>String(s||'').toLocaleLowerCase('ja').includes(text))))}
function groupKey(x){return String(x.groupName||((x.place||'').length>17?x.place:x.title)||x.id).trim().toLocaleLowerCase('ja')}
function renderLogs(){
  const a=dateSort(filtered(state.logs,$('logSearch').value,$('logCategory').value),'date',$('logSort').value);
  const area=$('logsList');
  if($('logView').value==='visit'){
    area.innerHTML=a.map(cardLog).join('')||empty('条件に一致する記録がありません');
    scheduleCardThumbnails(area);
    return;
  }
  const groups=new Map();
  for(const x of a){const k=groupKey(x);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x)}
  area.innerHTML=[...groups.values()].map((visits,i)=>{
    const name=visits[0].groupName||visits[0].title;
    return `<details class="group card" ${i===0?'open':''}><summary class="group-summary"><span>📍 ${esc(name)}</span><small>${visits.length}回訪問 ▼</small></summary>${visits.map(cardGroupedVisit).join('')}</details>`;
  }).join('')||empty('条件に一致する記録がありません');
  scheduleCardThumbnails(area);
}
function renderWishes(){const a=dateSort(filtered(state.wishes,$('wishSearch').value,$('wishCategory').value).filter(x=>!$('wishStatus').value||x.status===$('wishStatus').value),'createdAt',$('wishSort').value);$('wishesList').innerHTML=a.map(cardWish).join('')||empty('行きたい場所がまだありません')}
for(const id of ['logSearch','logSort','logView','logCategory'])$(id).addEventListener(id==='logSearch'?'input':'change',renderLogs);
for(const id of ['wishSearch','wishSort','wishCategory','wishStatus'])$(id).addEventListener(id==='wishSearch'?'input':'change',renderWishes);
function refreshCategoryUi(){const majors=Object.keys(categoriesWithHistory());for(const id of ['logCategory','wishCategory'])optionList($(id),majors,'すべてのカテゴリ');const prev=$('fieldMajor').value;optionList($('fieldMajor'),majors);if(prev)$('fieldMajor').value=prev;updateMinor()}
function updateMinor(){const arr=categoriesWithHistory()[$('fieldMajor').value]||[];optionList($('fieldMinor'),arr,'選択なし')}
$('fieldMajor').addEventListener('change',updateMinor);
function showDialog(d){d.showModal();d.scrollTop=0}
function edit(kind,id=''){const item=(kind==='log'?state.logs:state.wishes).find(x=>x.id===id);$('editForm').reset();$('editKind').value=kind;$('editId').value=id;$('dialogTitle').textContent=id?'記録を編集':kind==='log'?'思い出を記録':'行きたい場所を登録';$('fieldTitle').value=item?.title||'';$('fieldDate').value=item?.date||item?.planDate||today();$('fieldPlace').value=item?.place||'';$('fieldNote').value=item?.note||item?.reason||'';$('fieldLat').value=item?.lat??'';$('fieldLng').value=item?.lng??'';$('fieldGroup').value=item?.groupName||'';$('fieldTrip').value=item?.tripStyle||'未定';$('fieldStatus').value=item?.status||'wish';$('statusArea').classList.toggle('hidden',kind==='log');$('fieldGroup').closest('label').classList.toggle('hidden',kind==='wish');refreshCategoryUi();$('fieldMajor').value=item?.major||Object.keys(state.categories)[0]||'外食・グルメ';updateMinor();$('fieldMinor').value=item?.minor||'';$('editError').textContent='';$('photoPending').textContent='写真を追加すると保存時に自動圧縮します。';showDialog($('editDialog'))}
async function photoData(file,maxSide=1200,quality=.7){const img=await createImageBitmap(file);try{const scale=Math.min(1,maxSide/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));c.getContext('2d').drawImage(img,0,0,c.width,c.height);return c.toDataURL('image/jpeg',quality)}finally{img.close()}}
async function saveEdit(e){e.preventDefault();const kind=$('editKind').value,id=$('editId').value||uniqueId();const title=$('fieldTitle').value.trim();if(!title){$('editError').textContent='名前を入力してください';return}const old=(kind==='log'?state.logs:state.wishes).find(x=>x.id===id)||{};const lat=$('fieldLat').value,lng=$('fieldLng').value;if((lat||lng)&&!validCoord(lat,lng)){$('editError').textContent='緯度・経度が正しくありません';return}const base={...old,id,title,major:$('fieldMajor').value,minor:$('fieldMinor').value,tripStyle:$('fieldTrip').value,place:$('fieldPlace').value.trim(),note:$('fieldNote').value.trim(),lat:lat===''?null:Number(lat),lng:lng===''?null:Number(lng),groupName:$('fieldGroup').value.trim(),updatedAt:now(),createdAt:old.createdAt||now(),photos:[...(old.photos||[])]};if(kind==='log')base.date=$('fieldDate').value||today();else {base.planDate=$('fieldDate').value;base.status=$('fieldStatus').value;base.reason=base.note;if(base.status==='visited'&&!base.visitDate)base.visitDate=today()}
const button=$('saveButton');button.disabled=true;button.textContent='保存中…';$('editError').textContent='';try{const f=[...$('fieldPhotos').files];if(f.length>10)throw new Error('一度に追加できる写真は10枚までです');for(const file of f){let dataUrl=await photoData(file,1300,.72);if(dataUrl.length>680000)dataUrl=await photoData(file,1000,.55);if(dataUrl.length>780000)throw new Error('画像を小さくできませんでした');const photoId=uniqueId();await setDoc(doc(db,'photos',photoId),{id:photoId,ownerId:id,kind,dataUrl,createdAt:now()});base.photos.push({type:'firestore',id:photoId,ref:photoId});cardThumbnailCache.delete(id)}await setDoc(doc(db,kind==='log'?'logs':'wishes',id),base);$('editDialog').close();alertMsg('✓ 保存しました。Firebaseに反映済み！')}catch(ex){$('editError').textContent='保存できません: '+friendlyErr(ex);alertMsg('保存エラー',true)}finally{button.disabled=false;button.textContent='保存する'}}
$('editForm').addEventListener('submit',saveEdit);$('fieldPhotos').addEventListener('change',()=>{$('photoPending').textContent=[...$('fieldPhotos').files].map(f=>f.name).join('、')||'写真を追加できます'});
async function stampWish(id){if(!confirm('「行った！」スタンプを押しますか？'))return;const x=state.wishes.find(w=>w.id===id);if(!x)return;try{await setDoc(doc(db,'wishes',id),{...x,status:'visited',visitDate:today(),updatedAt:now()});alertMsg('🎟️ 訪問スタンプを押しました！')}catch(e){alertMsg('保存できません: '+friendlyErr(e),true)}}
async function deleteWish(id){if(!confirm('この「行きたい場所」を一覧から非表示にしますか？'))return;const x=state.wishes.find(w=>w.id===id);if(!x)return;try{await setDoc(doc(db,'wishes',id),{...x,deleted:true,updatedAt:now()});alertMsg('非表示にしました（データは保持）')}catch(e){alertMsg(friendlyErr(e),true)}}
async function getPhoto(ref){if(!ref)return null;if(ref.type==='firestore'){const id=String(ref.id||ref.ref||'');if(!id)return null;if(state.photoCache.has(id))return state.photoCache.get(id);const result=await getDoc(doc(db,'photos',id));const v=result.exists()?result.data().dataUrl:null;if(v)state.photoCache.set(id,v);return v}return null}
// v2.0.6: 旧データ側の photos 配列が空でも、Firestore 写真の ownerId から表示できる。
async function photoRefsForVisit(log){
  const original=Array.isArray(log.photos)?log.photos:[];
  const known=new Set(original.filter(p=>p?.type==='firestore').map(p=>String(p.id||p.ref||'')));
  const extra=[];
  const photos=await getDocs(query(collection(db,'photos'),where('ownerId','==',String(log.id))));
  for(const snapshot of photos.docs){
    const data=snapshot.data();
    if(data.dataUrl)state.photoCache.set(snapshot.id,data.dataUrl);
    if(data.dataUrl&&!known.has(snapshot.id)){
      extra.push({type:'firestore',id:snapshot.id,ref:snapshot.id});
      known.add(snapshot.id);
    }
  }
  return [...original.filter(p=>p?.type==='firestore'),...extra,...original.filter(p=>p?.type!=='firestore')];
}
async function showVisit(id){
  const x=state.logs.find(x=>x.id===id);if(!x)return;
  const seq=++state.visitSeq;
  $('visitTitle').textContent=x.title;
  const body=$('visitBody');
  body.innerHTML=`<p><strong>${esc(dateText(x.date))}</strong>　${esc(x.major||'')}/${esc(x.minor||'')}</p><p class="entry-note">${esc(x.note||'（感想なし）')}</p>${x.place?`<p><a href="${mapsUrl(x.place)}" target="_blank" rel="noopener noreferrer">📍 Googleマップで開く ↗</a></p>`:''}<h3>この日の写真</h3><div id="visitPhotos" class="photo-strip"><p class="muted">写真を確認しています…</p></div>`;
  showDialog($('visitDialog'));
  const area=$('visitPhotos');
  let refs=[];
  try{refs=await photoRefsForVisit(x)}catch(error){
    refs=Array.isArray(x.photos)?x.photos:[];
    if(!refs.length&&seq===state.visitSeq&&$('visitDialog').open){area.innerHTML='<p class="error">写真の照合に失敗しました。通信を確認してもう一度開いてください。</p>';return}
  }
  if(seq!==state.visitSeq||!$('visitDialog').open)return;
  area.replaceChildren();
  if(!refs.length){area.innerHTML='<p class="muted">この記録に紐づく写真はありません。</p>';return}
  for(const photo of refs){
    if(seq!==state.visitSeq||!$('visitDialog').open)return;
    const el=document.createElement('div');el.className='photo-missing';el.textContent='読み込み中';area.appendChild(el);
    try{
      const uri=await getPhoto(photo);
      if(seq!==state.visitSeq||!$('visitDialog').open)return;
      if(uri){
        const im=document.createElement('img');im.src=uri;im.alt='訪問時の写真';im.className='photo-thumb';im.style.cursor='zoom-in';im.addEventListener('click',()=>window.open(uri,'_blank','noopener'));el.replaceWith(im);
      }else{
        el.textContent='元写真（Drive）';const link=document.createElement('a');link.href='https://drive.google.com/drive/u/0/search?q='+encodeURIComponent(String(photo.ref||'').split('/').pop());link.target='_blank';link.rel='noopener noreferrer';link.textContent='Driveで探す ↗';el.appendChild(link);
      }
    }catch(error){el.textContent='写真取得失敗'}
  }
}

function renderCategories(){const box=$('categoryList');box.innerHTML=Object.entries(state.categories).map(([major,minors])=>`<div class="category-row"><strong>${esc(major)}</strong><button class="ghost" data-remove-cat="${esc(major)}" data-remove-minor="">大を削除</button></div>${minors.map(min=>`<div class="category-row"><span>　↳ ${esc(min)}</span><button class="ghost" data-remove-cat="${esc(major)}" data-remove-minor="${esc(min)}">小を削除</button></div>`).join('')}`).join('')}
async function saveCats(cat){await setDoc(doc(db,'settings','categories'),{majors:cat,updatedAt:now()})}
$('addCat').addEventListener('click',async()=>{const major=$('newMajor').value.trim(),minor=$('newMinor').value.trim();if(!major)return alertMsg('大カテゴリを入力してください',true);const clone=structuredClone(state.categories);if(!clone[major])clone[major]=[];if(minor&&!clone[major].includes(minor))clone[major].push(minor);try{await saveCats(clone);$('newMajor').value='';$('newMinor').value='';alertMsg('カテゴリを追加しました')}catch(e){alertMsg(friendlyErr(e),true)}});
async function removeCat(major,minor){const clone=structuredClone(state.categories);if(!confirm(`カテゴリ「${major}${minor?' / '+minor:''}」を削除しますか？過去の記録は残ります。`))return;if(minor)clone[major]=(clone[major]||[]).filter(x=>x!==minor);else delete clone[major];try{await saveCats(clone);alertMsg('カテゴリを削除しました')}catch(e){alertMsg(friendlyErr(e),true)}}
function saveFile(blob,name){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
$('exportJson').addEventListener('click',()=>{const data={logs:state.logs,wishes:state.wishes,custom:Object.entries(state.categories).flatMap(([major,minors])=>minors.map(minor=>({major,minor}))),exportedAt:now(),version:'2.0.0'};saveFile(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),`Yorimichi-Backup-${today()}.json`)});
$('jsonImport').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;let parsed;try{parsed=JSON.parse(await file.text())}catch(_){return $('importResult').textContent='JSONファイルを読み取れませんでした'}const logs=Array.isArray(parsed.logs)?parsed.logs:[],wishes=Array.isArray(parsed.wishes)?parsed.wishes:[];if(!logs.length&&!wishes.length)return $('importResult').textContent='記録が入っていません。';if(logs.length+wishes.length>5000)return $('importResult').textContent='件数が多すぎます。';if(!confirm(`旧データ ${logs.length}件、行きたい場所 ${wishes.length}件を取り込みますか？既存IDは上書きせずにスキップします。`))return;const existsLogs=new Set(state.logs.map(x=>x.id)),existsWishes=new Set(state.wishes.map(x=>x.id));let n=0,skip=0;try{const rows=[...logs.map(x=>({kind:'logs',x})),...wishes.map(x=>({kind:'wishes',x}))];let batch=writeBatch(db),part=0;for(const {kind,x} of rows){if(!x.id||!x.title){skip++;continue}const exists=kind==='logs'?existsLogs:existsWishes;if(exists.has(x.id)){skip++;continue}exists.add(x.id);const rec={...x,id:String(x.id),photos:Array.isArray(x.photos)?x.photos:[],createdAt:x.createdAt||now(),updatedAt:x.updatedAt||now()};batch.set(doc(db,kind,String(x.id)),rec);part++;n++;if(part===250){await batch.commit();batch=writeBatch(db);part=0}}if(part)await batch.commit();const cats=structuredClone(state.categories);for(const c of (parsed.custom||[])){if(!c?.major)continue;if(!cats[c.major])cats[c.major]=[];if(c.minor&&!cats[c.major].includes(c.minor))cats[c.major].push(c.minor)}if(Array.isArray(parsed.categoryRules)){const last=new Map();for(const c of parsed.categoryRules){if(c?.major)last.set(c.major+'\u0000'+(c.minor||''),c)}for(const c of last.values()){if(c.status==='削除'){if(!c.minor)delete cats[c.major];else if(cats[c.major])cats[c.major]=cats[c.major].filter(x=>x!==c.minor)}else{if(!cats[c.major])cats[c.major]=[];if(c.minor&&!cats[c.major].includes(c.minor))cats[c.major].push(c.minor)}}}await saveCats(cats);$('importResult').textContent=`取り込み完了：${n}件 / スキップ${skip}件。写真本体は別途取り込みが必要です。`;alertMsg('旧記録を取り込みました')}catch(err){$('importResult').textContent='途中でエラー: '+friendlyErr(err)+'。すでに取り込んだ記録は保持されています。'}});
// 写真本体には触れず、写真IDの参照だけを診断・修復（任意で実行）。
async function repairPhotoLinks(){
  const button=$('repairPhotoLinks'),output=$('photoRepairResult');
  button.disabled=true;output.textContent='Firebaseの写真と記録を照合しています…';
  try{
    const snap=await getDocs(collection(db,'photos'));
    const groups=new Map(), records=new Map();
    for(const log of state.logs)records.set(String(log.id),{kind:'logs',title:log.title});
    for(const wish of state.wishes)records.set(String(wish.id),{kind:'wishes',title:wish.title});
    let noOwner=0,missingRecord=0;
    for(const photo of snap.docs){
      const item=photo.data(),owner=String(item.ownerId||'');
      if(!item.dataUrl||!owner){noOwner++;continue}
      if(!records.has(owner)){missingRecord++;continue}
      if(!groups.has(owner))groups.set(owner,[]);
      groups.get(owner).push(photo.id);
    }
    let missingLinks=0, already=0;
    for(const [owner,ids] of groups){
      const entry=[...state.logs,...state.wishes].find(x=>String(x.id)===owner);
      const current=new Set((entry?.photos||[]).filter(p=>p?.type==='firestore').map(p=>String(p.id||p.ref||'')));
      for(const id of ids){if(current.has(id))already++;else missingLinks++}
    }
    output.textContent=`写真本体${snap.size}件／紐づけ済み${already}件／紐づけ不足${missingLinks}件／記録不明${missingRecord}件／写真データ不完全${noOwner}件。`;
    if(!missingLinks){output.textContent+=' 紐づけの不足はありません。写真がない記録もあります。';return}
    if(!confirm(`紐づけ不足 ${missingLinks} 件を修復しますか？ 写真本体・タイトル・住所・日付・思い出の内容は変更しません。`))return;
    let updated=0,linked=0;
    for(const [owner,ids] of groups){
      const record=records.get(owner);
      const docRef=doc(db,record.kind,owner);
      const count=await runTransaction(db,async transaction=>{
        const latest=await transaction.get(docRef);
        if(!latest.exists())return 0;
        const previous=Array.isArray(latest.data().photos)?latest.data().photos:[];
        const refs=[...previous];
        const known=new Set(previous.filter(p=>p?.type==='firestore').map(p=>String(p.id||p.ref||'')));
        let add=0;
        for(const id of ids){if(known.has(id))continue;refs.push({type:'firestore',id,ref:id});known.add(id);add++}
        if(add)transaction.update(docRef,{photos:refs});
        return add;
      });
      if(count){updated++;linked+=count}
    }
    state.headerPhotoIndex=null;
    output.textContent=`修復完了：写真${linked}件を${updated}件の記録に紐づけました。思い出を開き直して確認してください。`;
    alertMsg('写真の紐づけ確認・修復が完了しました');
  }catch(error){output.textContent='確認・修復に失敗しました: '+friendlyErr(error);alertMsg('写真の紐づけを確認できませんでした',true)}
  finally{button.disabled=false}
}
$('repairPhotoLinks').addEventListener('click',repairPhotoLinks);
$('bulkPhotos').addEventListener('change',async e=>{const files=[...e.target.files];if(!files.length)return;if(!confirm(`${files.length}枚の写真を圧縮して取り込みますか？`))return;let done=0,skip=0,failed=0;const all=[...state.logs,...state.wishes];for(const file of files){const parts=file.name.match(/^([0-9a-zA-Z_-]{6,36})__([0-9a-zA-Z_-]{6,36})\./);if(!parts){skip++;continue}const photoId=parts[1],owner=parts[2],item=all.find(x=>x.id===owner);if(!item){skip++;continue}try{let dataUrl=await photoData(file,1200,.68);if(dataUrl.length>680000)dataUrl=await photoData(file,900,.5);if(dataUrl.length>800000)throw Error('画像サイズ超過');await setDoc(doc(db,'photos',photoId),{id:photoId,ownerId:owner,kind:state.logs.some(x=>x.id===owner)?'log':'wish',dataUrl,createdAt:now()});const photos=[...(item.photos||[])];const found=photos.findIndex(p=>p.id===photoId||p.id===photoId.replace(/^legacy_/,'')||(p.type==='legacy'&&p.id===photoId));const ref={type:'firestore',id:photoId,ref:photoId};if(found>=0)photos[found]=ref;else photos.push(ref);await setDoc(doc(db,state.logs.some(x=>x.id===owner)?'logs':'wishes',owner),{...item,photos,updatedAt:now()});item.photos=photos;cardThumbnailCache.delete(owner);done++}catch(_){failed++}$('bulkResult').textContent=`処理中 ${done+skip+failed}/${files.length}：成功${done}件、対象外${skip}件、失敗${failed}件`}$('bulkResult').textContent=`完了：成功${done}件、対象外${skip}件、失敗${failed}件。`});
async function loadLeaflet(){if(window.L)return;state.leafletPromise??=new Promise((resolve,reject)=>{const style=document.createElement('link');style.rel='stylesheet';style.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';document.head.appendChild(style);const sc=document.createElement('script');sc.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';sc.onload=resolve;sc.onerror=()=>reject(new Error('地図サービスを読み込めません'));document.head.appendChild(sc)});await state.leafletPromise}
async function loadMap(){await loadLeaflet();if(!state.map){state.map=window.L.map('mapCanvas').setView([36.4,137.5],5);window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors',maxZoom:18}).addTo(state.map);state.map.on('click',e=>{state.pendingMapPoint=e.latlng;$('mapHint').textContent=`選択した位置：${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)} — 「＋記録」または「行きたい場所」から登録できます。`;})}setTimeout(()=>state.map.invalidateSize(),100);renderMapPins()}
function renderMapPins(){if(!state.map)return;state.pinLayer?.clearLayers();state.pinLayer=window.L.layerGroup().addTo(state.map);for(const x of [...state.logs,...state.wishes]){if(!validCoord(x.lat,x.lng))continue;const wish=state.wishes.some(w=>w.id===x.id);const color=wish&&x.status!=='visited'?'#dcaa3b':'#128b8d';const mark=window.L.circleMarker([Number(x.lat),Number(x.lng)],{radius:7,color:'#fff',weight:2,fillColor:color,fillOpacity:.98});const popup=document.createElement('div');const title=document.createElement('strong');title.textContent=x.title;popup.append(title,document.createElement('br'));const link=document.createElement('a');link.href=mapsUrl(x.place||x.title);link.target='_blank';link.rel='noopener noreferrer';link.textContent='Googleマップで開く ↗';popup.append(link);mark.bindPopup(popup);mark.addTo(state.pinLayer)}}
$('resetMap').addEventListener('click',()=>state.map?.setView([36.4,137.5],5));
function applyHeader(){$('heroPhoto').style.backgroundImage=state.media?`linear-gradient(118deg,#143c5d66,#1a6a7a44),url(${state.media})`:''}
function renderHeaderChoices(){
  const area=$('headerPhotoChoices');area.innerHTML='';
  const search=$('headerPhotoSearch').value.trim().toLocaleLowerCase('ja'),candidates=[];
  for(const log of dateSort(state.logs)){
    if(search&&![log.title,log.place,log.major,log.minor].some(v=>String(v||'').toLocaleLowerCase('ja').includes(search)))continue;
    const refs=new Map();
    for(const p of log.photos||[])if(p?.type==='firestore')refs.set(String(p.id||p.ref),p);
    for(const p of state.headerPhotoIndex?.get(String(log.id))||[])refs.set(String(p.id),p);
    for(const p of refs.values())candidates.push({p,log});
  }
  const found=candidates.slice(0,state.headerLimit||12);
  for(const {p,log} of found){
    const btn=document.createElement('button');btn.textContent='読み込み…';btn.title=log.title;
    btn.onclick=async()=>{try{const v=await getPhoto(p);if(v)await setHeaderSource(v)}catch(e){$('headerError').textContent=friendlyErr(e)}};
    area.append(btn);
    getPhoto(p).then(uri=>{if(uri){const im=document.createElement('img');im.src=uri;im.alt=log.title;btn.replaceChildren(im)}else btn.textContent='未取得'}).catch(()=>btn.textContent='取得失敗');
  }
  if(candidates.length>found.length){const more=document.createElement('button');more.textContent='もっと表示';more.onclick=()=>{state.headerLimit+=12;renderHeaderChoices()};area.append(more)}
  if(!candidates.length){const note=document.createElement('p');note.className='muted';note.textContent=state.headerPhotoIndex?'この条件に合う写真はありません。':'写真を照合しています…';area.append(note)}
}
async function initHeaderDialog(){
  state.headerLimit=12;$('headerPhotoSearch').value='';$('headerError').textContent='';renderHeaderChoices();showDialog($('headerDialog'));
  if(state.media)setHeaderSource(state.media);
  if(state.headerPhotoIndex)return;
  try{
    const snap=await getDocs(collection(db,'photos'));
    const index=new Map();
    for(const photo of snap.docs){
      const data=photo.data(),owner=String(data.ownerId||'');
      if(!data.dataUrl||!owner)continue;
      state.photoCache.set(photo.id,data.dataUrl);
      if(!index.has(owner))index.set(owner,[]);
      index.get(owner).push({type:'firestore',id:photo.id,ref:photo.id});
    }
    state.headerPhotoIndex=index;
    if($('headerDialog').open)renderHeaderChoices();
  }catch(e){$('headerError').textContent='過去写真の読み込みに失敗しました: '+friendlyErr(e)}
}
$('headerPhotoSearch').addEventListener('input',()=>{state.headerLimit=12;renderHeaderChoices()});
$('changeHeader').addEventListener('click',initHeaderDialog);$('headerFile').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;try{await setHeaderSource(URL.createObjectURL(f))}catch(err){$('headerError').textContent=friendlyErr(err)}});
async function setHeaderSource(src){const img=new Image();img.onload=()=>{state.headerImg=img;state.headerX=0;state.headerY=0;state.headerZoom=1;$('headerZoom').value=1;drawHeader()};img.onerror=()=>{$('headerError').textContent='画像の読み込みに失敗しました'};img.src=src}
function drawHeader(){const ctx=$('headerCanvas').getContext('2d'),c=$('headerCanvas'),im=state.headerImg;if(!im){ctx.fillStyle='#c9dce2';ctx.fillRect(0,0,c.width,c.height);return}const base=Math.max(c.width/im.naturalWidth,c.height/im.naturalHeight);state.headerBaseScale=base;const s=base*state.headerZoom,w=im.naturalWidth*s,h=im.naturalHeight*s,limX=(w-c.width)/2,limY=(h-c.height)/2;state.headerX=Math.max(-limX,Math.min(limX,state.headerX));state.headerY=Math.max(-limY,Math.min(limY,state.headerY));ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(im,(c.width-w)/2+state.headerX,(c.height-h)/2+state.headerY,w,h)}
$('headerZoom').addEventListener('input',e=>{state.headerZoom=Number(e.target.value);drawHeader()});let drag=null;$('headerCanvas').addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY};e.target.setPointerCapture(e.pointerId)});$('headerCanvas').addEventListener('pointermove',e=>{if(!drag)return;const factor=$('headerCanvas').width/$('headerCanvas').getBoundingClientRect().width;state.headerX+=(e.clientX-drag.x)*factor;state.headerY+=(e.clientY-drag.y)*factor;drag={x:e.clientX,y:e.clientY};drawHeader()});$('headerCanvas').addEventListener('pointerup',()=>drag=null);$('headerCanvas').addEventListener('pointercancel',()=>drag=null);
$('saveHeader').addEventListener('click',async()=>{if(!state.headerImg){$('headerError').textContent='写真を選んでください';return}const btn=$('saveHeader');btn.disabled=true;try{const dataUrl=$('headerCanvas').toDataURL('image/jpeg',.7);if(dataUrl.length>850000)throw Error('画像サイズが大きすぎます');await setDoc(doc(db,'media','header'),{dataUrl,updatedAt:now()});$('headerDialog').close();alertMsg('ヘッダー画像を保存しました')}catch(e){$('headerError').textContent=friendlyErr(e)}finally{btn.disabled=false}});
$('resetHeader').addEventListener('click',async()=>{if(!confirm('ヘッダーを標準に戻しますか？'))return;try{await setDoc(doc(db,'media','header'),{dataUrl:'',updatedAt:now()});alertMsg('標準ヘッダーに戻しました')}catch(e){alertMsg(friendlyErr(e),true)}});
document.addEventListener('click',e=>{const b=e.target.closest('button,[data-action]');if(!b)return;if(b.dataset.close){$(b.dataset.close)?.close();return}if(b.dataset.action==='new-log'){edit('log');if(state.pendingMapPoint){$('fieldLat').value=state.pendingMapPoint.lat;$('fieldLng').value=state.pendingMapPoint.lng}}if(b.dataset.action==='new-wish'){edit('wish');if(state.pendingMapPoint){$('fieldLat').value=state.pendingMapPoint.lat;$('fieldLng').value=state.pendingMapPoint.lng}}if(b.dataset.view)showVisit(b.dataset.view);if(b.dataset.editLog)edit('log',b.dataset.editLog);if(b.dataset.editWish)edit('wish',b.dataset.editWish);if(b.dataset.stamp)stampWish(b.dataset.stamp);if(b.dataset.deleteWish)deleteWish(b.dataset.deleteWish);if(b.dataset.removeCat!==undefined)removeCat(b.dataset.removeCat,b.dataset.removeMinor)});
refreshCategoryUi();drawHeader();

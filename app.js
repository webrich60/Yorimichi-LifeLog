import {initializeApp} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import {getAuth,GoogleAuthProvider,signInWithPopup,reauthenticateWithPopup,signOut,onAuthStateChanged,setPersistence,indexedDBLocalPersistence,browserSessionPersistence,inMemoryPersistence} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import {getFirestore,collection,doc,getDoc,getDocs,onSnapshot,query,where,orderBy,setDoc,updateDoc,writeBatch,runTransaction,serverTimestamp} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';

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
// v2.0.20: 思い出・行きたい場所に付ける外部リンク。無効なスキームは表示・保存しない。
const MAX_RECORD_LINKS=5;
function normalizeExternalUrl(raw){
  let value=String(raw??'').trim();
  if(!value)return '';
  if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^[a-z][a-z0-9+.-]*:/i.test(value))value='https://'+value;
  try{
    const u=new URL(value);
    if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.username||u.password)return '';
    return u.href;
  }catch(_){return ''}
}
function relatedLinks(record){
  const candidates=Array.isArray(record?.links)?record.links:[];
  const legacy=record?.externalUrl?[{url:record.externalUrl,label:record.externalLabel||'関連リンク'}]:[];
  return [...candidates,...legacy].map(v=>({url:normalizeExternalUrl(typeof v==='string'?v:v?.url),label:String(typeof v==='string'?'':v?.label||'').trim().slice(0,60)}))
    .filter(v=>v.url).slice(0,MAX_RECORD_LINKS);
}
function relatedLinksMarkup(record,compact=false){
  const links=relatedLinks(record);
  if(!links.length)return '';
  return `<div class="entry-link-list ${compact?'entry-link-list-compact':''}" aria-label="登録済みの関連リンク">${links.map(link=>`<a class="entry-link-chip" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(link.label||new URL(link.url).hostname)} ↗</a>`).join('')}</div>`;
}

const defaultCats={'観光・旅行':['観光スポット','自然・絶景','寺社・歴史','道の駅','旅館・ホテル','温泉'],'外食・グルメ':['カフェ・喫茶','和食','洋食','海鮮','ラーメン・麺類','スイーツ','中華'],'遊び・体験':['レジャー','イベント','文化体験','ドライブ'],'日常・暮らし':['買い物','家族','散歩','その他'],'宿泊':['ホテル','旅館','温泉宿']};
const state={user:null,logs:[],wishes:[],trashedLogs:[],trashedWishes:[],categories:structuredClone(defaultCats),media:null,tab:'home',unsubs:[],map:null,leafletPromise:null,pendingMapPoint:null,headerImg:null,headerX:0,headerY:0,headerZoom:1,headerBaseScale:1,photoCache:new Map(),headerPhotoIndex:null,visitSeq:0,toastTimer:null,loaded:{logs:false,wishes:false}};
const alertMsg=(message,bad=false)=>{let el=$('toast');el.textContent=message;el.style.background=bad?'#963d40':'#193d58';el.classList.remove('hidden');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.add('hidden'),4200)};
const syncInfo=s=>{$('syncState').textContent=s};
const friendlyErr=e=>{const c=e?.code||'',m=e?.message||String(e);if(c.includes('permission-denied'))return '保存権限がありません。FirestoreルールとGoogleアカウントを確認してください。';if(c.includes('offline')||c.includes('unavailable'))return '通信に接続できません。ネットワークを確認してください。';if(c.includes('popup'))return 'Googleログインが開けません。Chromeで開いて、ポップアップの許可を確認してください。';return m.slice(0,180)};
const dateSort=(arr,which='date',dir='new')=>[...arr].sort((a,b)=>dir==='new'?String(b[which]||b.createdAt||'').localeCompare(String(a[which]||a.createdAt||'')):String(a[which]||a.createdAt||'').localeCompare(String(b[which]||b.createdAt||'')));
const categoriesWithHistory=()=>{const cats=structuredClone(state.categories);if(!cats['人生の出来事'])cats['人生の出来事']=['家族','仕事','挑戦','転機・節目','その他'];for(const item of [...state.logs,...state.wishes]){const maj=item.major||'その他',min=item.minor||'';if(!cats[maj])cats[maj]=[];if(min&&!cats[maj].includes(min))cats[maj].push(min)}return cats};
function optionList(select,items,first=''){const current=select.value;select.replaceChildren();if(first){select.add(new Option(first,''))}items.forEach(x=>select.add(new Option(x,x)));if([...select.options].some(x=>x.value===current))select.value=current}
function resetLogin(){driveVideoToken=null;driveVideoTokenUntil=0;state.user=null;state.logs=[];state.wishes=[];state.trashedLogs=[];state.trashedWishes=[];state.photoCache.clear();cardThumbnailCache.clear();state.headerPhotoIndex=null;state.visitSeq++;state.loaded={logs:false,wishes:false};for(const un of state.unsubs)try{un()}catch(_){}state.unsubs=[];$('loginPage').classList.remove('hidden');$('appPage').classList.add('hidden');$('bottomNav').classList.add('hidden');$('account').classList.add('hidden')}
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
function connectData(){for(const unsub of state.unsubs)unsub();state.unsubs=[];state.loaded={logs:false,wishes:false};syncInfo('Firestore接続中…');state.unsubs.push(onSnapshot(collection(db,'logs'),snap=>{{const items=snap.docs.map(d=>({id:d.id,...d.data()}));state.logs=items.filter(x=>!x.deleted);state.trashedLogs=items.filter(x=>x.deleted);state.loaded.logs=true};dataUpdated()},err=>syncInfo('思い出取得エラー: '+friendlyErr(err))));state.unsubs.push(onSnapshot(collection(db,'wishes'),snap=>{{const items=snap.docs.map(d=>({id:d.id,...d.data()}));state.wishes=items.filter(x=>!x.deleted);state.trashedWishes=items.filter(x=>x.deleted);state.loaded.wishes=true};dataUpdated()},err=>syncInfo('行きたい場所取得エラー: '+friendlyErr(err))));state.unsubs.push(onSnapshot(doc(db,'settings','categories'),snap=>{if(snap.exists()&&snap.data().majors)state.categories=snap.data().majors;refreshCategoryUi();render()},err=>syncInfo('カテゴリ取得エラー: '+friendlyErr(err))));state.unsubs.push(onSnapshot(doc(db,'media','header'),snap=>{state.media=snap.exists()?snap.data().dataUrl||null:null;applyHeader();},err=>alertMsg('ヘッダー画像: '+friendlyErr(err),true)))}
function dataUpdated(){syncInfo(state.loaded.logs&&state.loaded.wishes?'● 本番接続済み・自動保存有効':'データを同期しています…');refreshCategoryUi();render()}
const navButtons=[...document.querySelectorAll('[data-tab]')];function showTab(tab){state.tab=tab;document.querySelectorAll('.view').forEach(el=>el.classList.toggle('hidden',el.id!==tab));document.querySelectorAll('.bottom-nav button').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===tab));render();if(tab==='map')loadMap().catch(e=>{$('mapHint').textContent='地図読み込みに失敗しました: '+friendlyErr(e)})}
navButtons.forEach(b=>b.addEventListener('click',()=>showTab(b.dataset.tab)));
function render(){if(!state.user)return;const logs=state.logs,wishes=state.wishes;$('statLogs').textContent=logs.length;$('statWishes').textContent=wishes.filter(x=>x.status!=='visited').length;$('statStamps').textContent=wishes.filter(x=>x.status==='visited').length;$('statPins').textContent=[...logs,...wishes].filter(x=>validCoord(x.lat,x.lng)).length;renderHome();if(state.tab==='logs')renderLogs();if(state.tab==='calendar'){renderMemoryCalendar();renderCalendarCategoryJumps();}if(state.tab==='wishes')renderWishes();if(state.tab==='settings'){renderCategories();renderTrash()}if(state.tab==='map'){if(state.map)renderMapPins();renderUnpinnedPlaces();}}
// 写真付き思い出カード：写真がない記録は中立的なアイコンを表示する。
// ※ 見た目の改善のみ。写真・記録・ピンの内容は更新しない。
function thumbButton(x,compact=false){
  const title=esc(x.title||'思い出');
  return `<button type="button" class="${compact?'visit-mini-thumb':'entry-cover'}" data-photo-log="${esc(x.id)}" data-photo-preview="${esc(x.id)}" aria-label="${title}の写真を拡大して見る"><span class="photo-empty-icon" aria-hidden="true">📷</span><span class="photo-empty-text">写真を確認中</span></button>`;
}
function cardLog(x){
  return `<article class="entry card entry-photo-card">
    ${thumbButton(x)}
    <div class="entry-main">
      <div class="entry-meta">${esc(dateText(x.date))}${x.date?' ・ ':''}${esc(x.major||'思い出')}${x.minor?' / '+esc(x.minor):''}</div>
      <div class="entry-title">${esc(x.title)}</div>
      ${x.place?`<a href="${mapsUrl(x.place)}" target="_blank" rel="noopener noreferrer" class="entry-meta entry-address">📍 ${esc(x.place)} ↗</a>`:''}
      ${relatedLinksMarkup(x,true)}
      <div class="entry-actions"><button class="primary slim record-open" data-view="${esc(x.id)}">記録を見る <span aria-hidden="true">›</span></button><button class="ghost slim" data-edit-log="${esc(x.id)}">編集する</button><button class="ghost slim danger-quiet" data-trash-log="${esc(x.id)}">削除</button></div>
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
      ${relatedLinksMarkup(x,true)}
      <div class="entry-actions"><button class="ghost slim" data-view="${esc(x.id)}">記録を見る ›</button><button class="ghost slim" data-edit-log="${esc(x.id)}">編集する</button><button class="ghost slim danger-quiet" data-trash-log="${esc(x.id)}">削除</button></div>
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
      const label=document.createElement('span');label.className='record-cover-label';label.textContent='拡大して見る';
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
// v2.0.12: 未訪問の「行きたい」を濃い文字で、訪問操作は淡色に区別。
// status値やFirebaseの保存形式は変更しない。
function cardWish(x){
  const visited=x.status==='visited';
  const planning=x.status==='planning';
  const stateLabel=visited?'✓ 訪問済み':planning?'計画中・未訪問':'行きたい';
  const when=visited&&x.visitDate?`<span class="wish-visit-date">訪問日 ${esc(dateText(x.visitDate))}</span>`:'';
  return `<article class="entry card wish-entry ${visited?'wish-entry-visited':'wish-entry-pending'}">
    <div>
      <div class="entry-meta">${esc(x.major||'行きたい')} ${x.minor?' / '+esc(x.minor):''}</div>
      <div class="entry-title">${esc(x.title)}</div>
      <div class="wish-status-row"><span class="wish-status ${visited?'wish-status-visited':'wish-status-pending'}">${stateLabel}</span>${visited?when:'<span class="wish-not-visited">未訪問</span>'}</div>
      ${x.place?`<a href="${mapsUrl(x.place)}" target="_blank" rel="noopener noreferrer" class="entry-meta">📍 ${esc(x.place)} ↗</a>`:''}
      ${relatedLinksMarkup(x,true)}
      <div class="entry-actions">
        ${visited?'':`<button type="button" class="ghost slim wish-mark-visit" data-stamp="${esc(x.id)}" aria-label="${esc(x.title)}に実際に行ったことを記録する">行った場合に記録する</button>`}
        ${Array.isArray(x.videos)&&x.videos.some(videoDriveId)?`<button type="button" class="ghost slim" data-wish-videos="${esc(x.id)}">🎬 動画を見る (${x.videos.length})</button>`:''}
        <button type="button" class="ghost slim" data-photo-preview="${esc(x.id)}" aria-label="${esc(x.title)}の写真を横スワイプで見る">📷 写真を見る${Array.isArray(x.photos)&&x.photos.length?' ('+x.photos.length+')':''}</button>
        <button type="button" class="ghost slim" data-edit-wish="${esc(x.id)}">編集</button>
        <button type="button" class="ghost slim danger-quiet" data-delete-wish="${esc(x.id)}">削除</button>
      </div>
    </div>
  </article>`;
}
const empty=t=>`<div class="card" style="padding:24px;text-align:center;color:#668292">${esc(t)}</div>`;
function homePlaceKey(log){
  // 同じ場所への複数回訪問はホームでは1枚にまとめる。アルバムは全記録を表示。
  return [String(log.groupName||log.title||'').trim(),String(log.place||'').trim()].join(' / ').normalize('NFKC').toLocaleLowerCase('ja');
}
function homePlaces(limit=5){
  const picked=[],used=new Set();
  for(const log of dateSort(state.logs)){
    const key=homePlaceKey(log);
    if(!key||used.has(key))continue;
    used.add(key);picked.push(log);
    if(picked.length>=limit)break;
  }
  return picked;
}
function homeMemoryCard(x,index){
  const date=canonicalVisitDate(x.date)||String(x.date||'');
  const category=[x.major,x.minor].filter(Boolean).join(' / ');
  const image=thumbButton(x);
  return `<article class="memory-tile ${index===0?'memory-tile-feature':'memory-tile-small'}">
    <div class="memory-tile-picture">${image}<span class="memory-tile-rank">${String(index+1).padStart(2,'0')}</span></div>
    <div class="memory-tile-info"><div class="memory-tile-meta">${esc(dateText(date))}${category?' · '+esc(category):''}</div>
      <h3>${esc(x.title||'思い出')}</h3>
      <button class="memory-tile-open" type="button" data-view="${esc(x.id)}" aria-label="${esc(x.title||'思い出')}の記録を見る">記録を見る <span aria-hidden="true">↗</span></button>
      <div class="memory-manage-actions" aria-label="この思い出の操作">
        <button type="button" data-edit-log="${esc(x.id)}" aria-label="${esc(x.title||'思い出')}を編集">✎ 編集</button>
        <button type="button" class="danger-quiet" data-trash-log="${esc(x.id)}" aria-label="${esc(x.title||'思い出')}をゴミ箱に移動">🗑 削除</button>
      </div>
    </div>
  </article>`;
}
function renderHome(){
  $('homeAlbumCount').textContent=state.logs.length+'件の思い出';
  const recent=homePlaces(10),area=$('homeRecent');
  area.innerHTML=recent.map(homeMemoryCard).join('')||empty('まだ思い出がありません。最初のよりみちを記録してみましょう。');
  scheduleCardThumbnails(area);
  $('homeWishes').innerHTML=dateSort(state.wishes.filter(x=>x.status!=='visited'),'createdAt').slice(0,2).map(cardWish).join('')||empty('行きたい場所をひとつ登録してみよう。');
}

function filtered(list,search,major){const text=search.trim().toLocaleLowerCase('ja');return list.filter(x=>(!major||x.major===major)&&(!text||[x.title,x.place,x.note,x.reason,x.groupName,x.major,x.minor].some(s=>String(s||'').toLocaleLowerCase('ja').includes(text))))}
// 検索は旧GAS移行時の大・小カテゴリを含む実際の保存値を使用。記録は変更しない。
const normCat=v=>String(v??'').trim().normalize('NFKC');
function logCategoryKey(x){return {major:normCat(x.major),minor:normCat(x.minor)}}
// v2.0.18：カレンダーから既存のアルバム分類へ。分類は読み取りのみ（Firestoreの記録を更新しない）。
function calendarCategoryIcon(label){
  if(/観光|旅行|お出かけ|散歩|景色/.test(label))return '🗺️';
  if(/外食|グルメ|麺|食事|スイーツ|カフェ/.test(label))return '🍽️';
  if(/宿泊|ホテル|旅館/.test(label))return '🏨';
  if(/病院|健康|医療/.test(label))return '🏥';
  if(/人生|家族|出来事/.test(label))return '✨';
  return '✦';
}
function renderCalendarCategoryJumps(){
  const majors=new Map();let uncategorized=0;
  for(const log of state.logs){
    const {major,minor}=logCategoryKey(log);
    if(!major&&!minor){uncategorized++;continue}
    if(!majors.has(major))majors.set(major,{count:0,minors:new Map()});
    const group=majors.get(major);group.count++;
    if(minor)group.minors.set(minor,(group.minors.get(minor)||0)+1);
  }
  const categoryArea=$('calendarCategoryButtons'),minorArea=$('calendarMinorButtons');
  categoryArea.replaceChildren();minorArea.replaceChildren();
  const addChip=(area,label,count,value,icon,isMinor=false)=>{
    const chip=document.createElement('button');chip.type='button';
    chip.className='calendar-cat-chip'+(isMinor?' calendar-cat-minor':'');
    chip.dataset.memoryCategory=value;
    chip.setAttribute('aria-label',label+' '+count+'件の思い出を見る');
    const symbol=document.createElement('span');symbol.className='calendar-cat-symbol';symbol.textContent=icon;
    const name=document.createElement('span');name.className='calendar-cat-name';name.textContent=label;
    const n=document.createElement('span');n.className='calendar-cat-count';n.textContent=count+'件';
    chip.append(symbol,name,n);area.append(chip);
  };
  const groups=[...majors].sort((a,b)=>b[1].count-a[1].count||a[0].localeCompare(b[0],'ja'));
  for(const [major,g] of groups){
    addChip(categoryArea,major||'(大カテゴリ未設定)',g.count,'major:'+major,calendarCategoryIcon(major));
    for(const [minor,count] of [...g.minors].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ja')))
      addChip(minorArea,minor,count,'minor:'+major+'\u0000'+minor,'↳',true);
  }
  if(uncategorized)addChip(categoryArea,'分類未設定',uncategorized,'uncategorized','📂');
  if(!groups.length&&!uncategorized){const p=document.createElement('p');p.className='muted';p.textContent='思い出を登録するとカテゴリが表示されます。';categoryArea.append(p)}
  $('calendarMinorButtons').parentElement.classList.toggle('hidden',!minorArea.querySelector('button'));
}
function jumpFromCalendarToCategory(category){
  // 以前の年・月・キーワード・日付の絞り込みを解除し、カテゴリだけで全期間から探す。
  $('logSearch').value='';$('logYear').value='';$('logMonth').value='';
  calendarState.day='';
  refreshLogFilterUi();
  $('logCategory').value=category;
  showTab('logs');
  window.scrollTo({top:0,behavior:'instant'});
}
$('calendarCategoryButtons').addEventListener('click',e=>{
  const b=e.target.closest('[data-memory-category]');
  if(b)jumpFromCalendarToCategory(b.dataset.memoryCategory);
});
$('calendarMinorButtons').addEventListener('click',e=>{
  const b=e.target.closest('[data-memory-category]');
  if(b)jumpFromCalendarToCategory(b.dataset.memoryCategory);
});
$('calendarAllCategories').addEventListener('click',()=>jumpFromCalendarToCategory(''));

function matchLogCategory(log,value){
  if(!value)return true;
  if(value==='uncategorized')return !logCategoryKey(log).major&&!logCategoryKey(log).minor;
  if(value.startsWith('major:'))return logCategoryKey(log).major===value.slice(6);
  if(value.startsWith('minor:')){
    const [major,minor]=value.slice(6).split('\u0000');
    const cat=logCategoryKey(log);return cat.major===major&&cat.minor===minor;
  }
  return false;
}
function visitDateParts(log){
  const raw=String(log.date||'').trim();
  const match=raw.match(/^(\d{4})[-/.年](\d{1,2})(?:[-/.月]|$)/);
  if(!match)return null;
  const year=Number(match[1]),month=Number(match[2]);
  return year>=1900&&year<=2100&&month>=1&&month<=12?{year,month}:null;
}
// v2.0.8: 2000年からの思い出年表。表示中の記録から組み立て、保存データは変更しない。
// 過去の「出来事」は既存の思い出記録（日付とカテゴリ）として登録できる。
const timelineMinYear=2000;
const timelineMaxYear=Math.max(2100,new Date().getFullYear()+20);
const calendarState=(()=>{const d=new Date();return {year:d.getFullYear(),month:d.getMonth()+1,day:'',decade:Math.floor(d.getFullYear()/10)*10}})();
function canonicalVisitDate(value){
  const match=String(value||'').trim().match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\D.*)?$/);
  if(!match)return '';
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const date=new Date(Date.UTC(year,month-1,day));
  if(year<1||year>timelineMaxYear||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return '';
  return `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function timelineEvents(){
  const entries=[];
  for(const log of state.logs){const date=canonicalVisitDate(log.date);if(date)entries.push({date,kind:normCat(log.major)==='人生の出来事'?'life':'memory',id:String(log.id),title:log.title||'思い出',category:[log.major,log.minor].filter(Boolean).join(' / ')})}
  for(const wish of state.wishes){
    const isVisited=wish.status==='visited';
    const date=canonicalVisitDate(isVisited?(wish.visitDate||wish.planDate):wish.planDate);
    if(date)entries.push({date,kind:'plan',id:String(wish.id),title:wish.title||'行きたい場所',category:isVisited?'訪問スタンプ':'行きたい予定'});
  }
  return entries;
}
function decadeOf(year){return Math.floor(Number(year)/10)*10}
function changeCalendarPeriod(year,month,filter='month'){
  let y=Number(year),m=Number(month);while(m<1){y--;m+=12}while(m>12){y++;m-=12}
  if(y<timelineMinYear||y>timelineMaxYear)return;
  calendarState.year=y;calendarState.month=m;calendarState.day='';calendarState.decade=decadeOf(y);
  if(filter){
    $('logYear').value=String(y);refreshLogFilterUi();
    $('logMonth').value=filter==='year'?'':String(m);
  }
  renderMemoryCalendar();if(state.tab==='logs')renderLogs();
}
function chooseCalendarDay(date){
  calendarState.day=calendarState.day===date?'':date;
  $('logYear').value=String(calendarState.year);
  refreshLogFilterUi();$('logMonth').value=String(calendarState.month);
  renderMemoryCalendar();if(state.tab==='logs')renderLogs();
}
function renderMemoryCalendar(){
  const year=calendarState.year,month=calendarState.month,decade=calendarState.decade;
  const events=timelineEvents();
  const yearly=new Map();
  for(const item of events){const y=Number(item.date.slice(0,4));yearly.set(y,(yearly.get(y)||0)+1)}
  const select=$('timelineYear');if(!select.options.length){
    for(let y=timelineMinYear;y<=timelineMaxYear;y++)select.add(new Option(y+'年',String(y)));
  }
  select.value=String(year);
  $('timelinePrevDecade').disabled=decade<=timelineMinYear;
  $('timelineNextDecade').disabled=decade+10>timelineMaxYear;
  $('timelineYears').innerHTML=Array.from({length:10},(_,i)=>{
    const y=decade+i;if(y>timelineMaxYear)return '';
    const count=yearly.get(y)||0;
    return `<button type="button" class="timeline-year ${year===y?'active':''}" data-timeline-year="${y}" aria-pressed="${year===y}"><strong>${y}</strong><small>${count?'📖 '+count+'件':'記録なし'}</small></button>`;
  }).join('');
  $('calendarMonthTitle').textContent=`${year}年 ${month}月`;
  $('calendarPrevMonth').disabled=year===timelineMinYear&&month===1;
  $('calendarNextMonth').disabled=year===timelineMaxYear&&month===12;
  const dates=new Map();for(const item of events){if(item.date.slice(0,7)!==`${year}-${String(month).padStart(2,'0')}`)continue;if(!dates.has(item.date))dates.set(item.date,[]);dates.get(item.date).push(item)}
  const first=new Date(Date.UTC(year,month-1,1)).getUTCDay();
  const days=new Date(Date.UTC(year,month,0)).getUTCDate();
  const cells=Array.from({length:first},()=>'<span class="calendar-empty" aria-hidden="true"></span>');
  for(let day=1;day<=days;day++){
    const date=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,items=dates.get(date)||[];
    const logs=items.filter(e=>e.kind==='memory').length,life=items.filter(e=>e.kind==='life').length,plans=items.filter(e=>e.kind==='plan').length;
    const weekday=(first+day-1)%7,nowToday=date===today(),selected=calendarState.day===date;
    cells.push(`<button type="button" class="calendar-day ${weekday===0?'sunday':weekday===6?'saturday':''} ${nowToday?'today':''} ${selected?'selected':''}" data-calendar-date="${date}" aria-pressed="${selected}" aria-label="${year}年${month}月${day}日、思い出${logs}件、出来事${life}件、予定${plans}件"><b>${day}</b><span class="calendar-day-dots">${logs?`<i class="memory-dot" title="思い出${logs}件"></i>`:''}${life?`<i class="life-dot" title="出来事${life}件"></i>`:''}${plans?`<i class="plan-dot" title="予定${plans}件"></i>`:''}</span>${items.length?`<small>${items.length}件</small>`:''}</button>`);
  }
  $('calendarDayGrid').innerHTML=cells.join('');
  const chosen=calendarState.day;
  const selectedDate=chosen||`${year}-${String(month).padStart(2,'0')}`;
  $('calendarSelectedTitle').textContent=chosen?`${year}年${month}月${Number(chosen.slice(-2))}日の記録`:`${year}年${month}月の思い出`;
  $('calendarClearDay').disabled=!chosen;
  const selectedEvents=chosen?(dates.get(chosen)||[]):[...dates.values()].flat().sort((a,b)=>b.date.localeCompare(a.date));
  let html=selectedEvents.slice(0,12).map(item=>{
    const isMemory=item.kind!=='plan';
    const action=isMemory?`data-view="${esc(item.id)}"`:`data-edit-wish="${esc(item.id)}"`;
    return `<button type="button" class="calendar-event ${item.kind==='life'?'life-event':isMemory?'memory-event':'plan-event'}" ${action}><span class="calendar-event-symbol">${item.kind==='life'?'📌':isMemory?'📖':'✦'}</span><span class="calendar-event-info"><strong>${esc(item.title)}</strong><small>${item.date.slice(5).replace('-','/')} · ${esc(item.category||'思い出')}</small></span><span aria-hidden="true">›</span></button>`;
  }).join('');
  if(selectedEvents.length>12)html+=`<p class="muted calendar-more">ほか${selectedEvents.length-12}件。下の思い出一覧から確認できます。</p>`;
  if(!selectedEvents.length)html='<p class="calendar-no-record">この期間にはまだ記録がありません。昔の思い出を追加してみよう。</p>';
  $('calendarDayEvents').innerHTML=html;
  $('calendarAddMemory').textContent=chosen?'＋ この日の思い出':'＋ この月の思い出';
  $('calendarAddLifeEvent').textContent=chosen?'＋ この日の出来事':'＋ この月の出来事';
}
$('timelineYear').addEventListener('change',e=>changeCalendarPeriod(Number(e.target.value),calendarState.month,'year'));
$('timelinePrevDecade').addEventListener('click',()=>{calendarState.decade=Math.max(timelineMinYear,calendarState.decade-10);calendarState.year=calendarState.decade;calendarState.month=1;changeCalendarPeriod(calendarState.year,1,'year')});
$('timelineNextDecade').addEventListener('click',()=>{calendarState.decade=Math.min(decadeOf(timelineMaxYear),calendarState.decade+10);calendarState.year=calendarState.decade;calendarState.month=1;changeCalendarPeriod(calendarState.year,1,'year')});
$('timelineYears').addEventListener('click',e=>{const b=e.target.closest('[data-timeline-year]');if(b)changeCalendarPeriod(Number(b.dataset.timelineYear),calendarState.month,'year')});
$('calendarPrevMonth').addEventListener('click',()=>changeCalendarPeriod(calendarState.year,calendarState.month-1));
$('calendarNextMonth').addEventListener('click',()=>changeCalendarPeriod(calendarState.year,calendarState.month+1));
$('calendarToday').addEventListener('click',()=>{const date=today(),y=Number(date.slice(0,4)),m=Number(date.slice(5,7));changeCalendarPeriod(y,m);chooseCalendarDay(date)});
$('calendarDayGrid').addEventListener('click',e=>{const b=e.target.closest('[data-calendar-date]');if(b)chooseCalendarDay(b.dataset.calendarDate)});
$('calendarClearDay').addEventListener('click',()=>{calendarState.day='';renderMemoryCalendar();if(state.tab==='logs')renderLogs()});
$('calendarAddMemory').addEventListener('click',()=>{edit('log');$('fieldDate').value=calendarState.day||`${calendarState.year}-${String(calendarState.month).padStart(2,'0')}-01`});
$('calendarAddLifeEvent').addEventListener('click',()=>{edit('log');$('fieldDate').value=calendarState.day||`${calendarState.year}-${String(calendarState.month).padStart(2,'0')}-01`;
 $('fieldMajor').value='人生の出来事';updateMinor();$('dialogTitle').textContent='人生の出来事を記録';});
function refreshLogFilterUi(){
  const selectedYear=$('logYear').value,selectedMonth=$('logMonth').value,selectedCat=$('logCategory').value;
  const dateValues=state.logs.map(visitDateParts).filter(Boolean);
  const years=[...new Set([...Array.from({length:timelineMaxYear-timelineMinYear+1},(_,i)=>timelineMinYear+i),...dateValues.map(d=>d.year)])].sort((a,b)=>b-a);
  const year=$('logYear');year.replaceChildren(new Option('すべての年',''));
  for(const y of years)year.add(new Option(y+'年',String(y)));
  if(state.logs.some(x=>!visitDateParts(x)))year.add(new Option('日付未設定','unknown'));
  if([...year.options].some(o=>o.value===selectedYear))year.value=selectedYear;
  const month=$('logMonth');month.replaceChildren(new Option('すべての月',''));month.disabled=year.value==='unknown';
  const availableMonths=Array.from({length:12},(_,i)=>i+1);
  for(const m of availableMonths)month.add(new Option(m+'月',String(m)));
  if([...month.options].some(o=>o.value===selectedMonth))month.value=selectedMonth;
  const groups=new Map();let unknown=0;
  for(const x of state.logs){
    const {major,minor}=logCategoryKey(x);
    if(!major&&!minor){unknown++;continue}
    const groupKey=major;
    if(!groups.has(groupKey))groups.set(groupKey,{total:0,minors:new Map()});
    const group=groups.get(groupKey);group.total++;
    if(minor)group.minors.set(minor,(group.minors.get(minor)||0)+1);
  }
  const cat=$('logCategory');cat.replaceChildren(new Option('すべてのカテゴリ（'+state.logs.length+'件）',''));
  for(const [major,g] of [...groups].sort((a,b)=>a[0].localeCompare(b[0],'ja'))){
    cat.add(new Option((major||'(大カテゴリ未設定)')+'（'+g.total+'件）','major:'+major));
    for(const [minor,count] of [...g.minors].sort((a,b)=>a[0].localeCompare(b[0],'ja')))
      cat.add(new Option('　↳ '+minor+'（'+count+'件）','minor:'+major+'\u0000'+minor));
  }
  if(unknown)cat.add(new Option('分類未設定（'+unknown+'件）','uncategorized'));
  if([...cat.options].some(o=>o.value===selectedCat))cat.value=selectedCat;
}
function filteredLogs(){
  const search=$('logSearch').value.trim().toLocaleLowerCase('ja');
  const year=$('logYear').value,month=$('logMonth').value,category=$('logCategory').value,selectedDay=calendarState.day;
  return state.logs.filter(x=>{
    if(!matchLogCategory(x,category))return false;
    const d=visitDateParts(x);
    if(year==='unknown'&&d)return false;
    if(year&&year!=='unknown'&&(!d||String(d.year)!==year))return false;
    if(month&&(!d||String(d.month)!==month))return false;
    if(selectedDay&&canonicalVisitDate(x.date)!==selectedDay)return false;
    if(search&&![x.title,x.place,x.note,x.reason,x.groupName,x.major,x.minor,x.date].some(s=>String(s||'').toLocaleLowerCase('ja').includes(search)))return false;
    return true;
  });
}
function groupKey(x){return String(x.groupName||((x.place||'').length>17?x.place:x.title)||x.id).trim().toLocaleLowerCase('ja')}
function renderLogs(){
  const a=dateSort(filteredLogs(),'date',$('logSort').value);
  $('logFilterCount').textContent=`該当 ${a.length} 件 ／ 全 ${state.logs.length} 件`; 
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
for(const id of ['logSearch','logSort','logView','logCategory','logYear','logMonth'])$(id).addEventListener(id==='logSearch'?'input':'change',()=>{if(id==='logYear'){$('logMonth').value='';refreshLogFilterUi();if($('logYear').value&&$('logYear').value!=='unknown'){calendarState.year=Number($('logYear').value);calendarState.decade=decadeOf(calendarState.year)}}
  if(id==='logMonth'&&$('logMonth').value)calendarState.month=Number($('logMonth').value);
  calendarState.day='';renderLogs()});
$('logFilterReset').addEventListener('click',()=>{for(const id of ['logSearch','logYear','logMonth','logCategory'])$(id).value='';refreshLogFilterUi();calendarState.day='';renderLogs()});
for(const id of ['wishSearch','wishSort','wishCategory','wishStatus'])$(id).addEventListener(id==='wishSearch'?'input':'change',renderWishes);
function refreshCategoryUi(){refreshLogFilterUi();const majors=Object.keys(categoriesWithHistory());optionList($('wishCategory'),majors,'すべてのカテゴリ');const prev=$('fieldMajor').value;optionList($('fieldMajor'),majors);if(prev)$('fieldMajor').value=prev;updateMinor()}
function updateMinor(){const arr=categoriesWithHistory()[$('fieldMajor').value]||[];optionList($('fieldMinor'),arr,'選択なし')}
$('fieldMajor').addEventListener('change',updateMinor);
function showDialog(d){d.showModal();d.scrollTop=0}
const MAX_RECORD_PHOTOS=5;
const photoDraft={files:[],refs:[],previewUrls:[],token:0,ready:true};
function resetPhotoDraft(){
  for(const url of photoDraft.previewUrls)URL.revokeObjectURL(url);
  photoDraft.previewUrls=[];photoDraft.files=[];photoDraft.refs=[];
  photoDraft.token++;
  photoDraft.ready=true;
  $('fieldPhotos').value='';
}
function paintPhotoDraft(){
  const area=$('photoDraftStrip');area.replaceChildren();
  const existing=photoDraft.refs.length;
  const total=existing+photoDraft.files.length;
  $('photoPending').textContent=photoDraft.ready?`${total} / ${MAX_RECORD_PHOTOS}枚（保存済み${existing}枚・今回追加${photoDraft.files.length}枚）`:'保存済みの写真を確認中…';
  $('fieldPhotos').disabled=!photoDraft.ready||total>=MAX_RECORD_PHOTOS;
  const add=$('fieldPhotos').closest('.photo-add-label');
  if(add)add.classList.toggle('photo-limit-reached',$('fieldPhotos').disabled);
  for(let i=0;i<photoDraft.files.length;i++){
    const file=photoDraft.files[i],box=document.createElement('div');box.className='photo-draft-item';
    const img=document.createElement('img');img.src=photoDraft.previewUrls[i];img.alt=`追加予定 ${i+1}枚目`;
    const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.className='photo-draft-remove';remove.setAttribute('aria-label',`${file.name}を追加候補から外す`);
    remove.onclick=()=>{URL.revokeObjectURL(photoDraft.previewUrls[i]);photoDraft.previewUrls.splice(i,1);photoDraft.files.splice(i,1);paintPhotoDraft()};
    box.append(img,remove);area.append(box);
  }
  if(!photoDraft.files.length){const p=document.createElement('p');p.className='muted';p.textContent=existing?'保存済みの写真はそのまま残ります。':'まだ写真は追加されていません。';area.append(p)}
}
async function loadExistingPhotoCount(record,token){
  try{
    const refs=await photoRefsForVisit(record);
    if(token!==photoDraft.token)return;
    photoDraft.refs=refs.filter(r=>r?.type==='firestore');
  }catch(e){
    if(token!==photoDraft.token)return;
    // 読み込みに失敗した場合、枚数制限が不確かなので編集時の追加を止める。
    photoDraft.refs=(record.photos||[]).filter(p=>p?.type==='firestore');
    photoDraft.ready=false;
    $('photoPending').textContent='保存済み写真の確認に失敗しました。通信を確認して編集画面を開き直してください。';
    $('fieldPhotos').disabled=true;
    return;
  }
  if(token!==photoDraft.token)return;
  photoDraft.ready=true;paintPhotoDraft();
}
$('fieldPhotos').addEventListener('change',e=>{
  if(!photoDraft.ready){e.target.value='';return}
  const picked=[...e.target.files].filter(f=>f.type.startsWith('image/'));
  const free=Math.max(0,MAX_RECORD_PHOTOS-photoDraft.refs.length-photoDraft.files.length);
  const added=picked.slice(0,free);
  for(const file of added){photoDraft.files.push(file);photoDraft.previewUrls.push(URL.createObjectURL(file))}
  e.target.value='';paintPhotoDraft();
  if(picked.length>added.length)alertMsg(`写真は1件につき最大${MAX_RECORD_PHOTOS}枚です。追加できなかった写真が${picked.length-added.length}枚あります。`,true);
});
// v2.0.19: 動画はFirestoreに本体を保存せず、Google DriveへOAuthでアップロードする。
// Firebaseには動画のDriveファイルID・名称などの参照情報だけを保持する。
const MAX_RECORD_VIDEOS=3;
const MAX_VIDEO_BYTES=250*1024*1024;
const DRIVE_FILE_SCOPE='https://www.googleapis.com/auth/drive.file';
let driveVideoToken=null,driveVideoTokenUntil=0;
const videoDraft={file:null,existing:[],uploaded:null};
const videoDriveId=entry=>{const id=String(entry?.id||entry?.driveId||'');return /^[\w-]{10,160}$/.test(id)?id:''};
const videoDriveUrl=id=>`https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
const videoDrivePreview=id=>`https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`;
const videoSizeText=size=>Number(size)>=1024*1024?`${(Number(size)/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(Number(size)/1024))} KB`;
function videoApiError(status,body=''){
  let code='',reason='';
  try{const d=JSON.parse(body).error;code=d?.status||'';reason=d?.message||''}catch(_){}
  if(status===401){driveVideoToken=null;driveVideoTokenUntil=0;return new Error('Driveの認証が切れています。接続確認から再認証してください。')}
  if(status===403)return new Error(`Driveへの書き込みが拒否されました。Drive APIが有効か、利用許可・空き容量をご確認ください。${reason?' 詳細: '+reason.slice(0,140):''}`);
  if(status===400)return new Error(`Driveが動画を受け付けませんでした。${reason||'ファイル形式・サイズを確認してください。'}`);
  return new Error(`Drive保存エラー（HTTP ${status}${code?' / '+code:''}）。${reason||String(body).slice(0,120)}`);
}
function driveIdFromLink(value){
  const str=String(value||'').trim();if(!str)return '';
  try{
    const url=new URL(str);
    if(url.hostname!=='drive.google.com'||url.protocol!=='https:')return '';
    const fromPath=url.pathname.match(/\/file\/d\/([\w-]{10,160})(?:\/|$)/);
    const id=fromPath?.[1]||(url.pathname==='/open'?url.searchParams.get('id'):'');
    return videoDriveId({id});
  }catch(_){return ''}
}
function videoMime(file){
  if(file.type.startsWith('video/'))return file.type;
  if(/\.mp4$/i.test(file.name))return 'video/mp4';
  if(/\.mov$/i.test(file.name))return 'video/quicktime';
  if(/\.m4v$/i.test(file.name))return 'video/x-m4v';
  if(/\.webm$/i.test(file.name))return 'video/webm';
  return '';
}
function paintVideoDraft(){
  const info=$('videoDraftInfo'),stored=$('videoStoredList');
  info.replaceChildren();stored.replaceChildren();
  if(videoDraft.file){
    const entry=document.createElement('div');entry.className='video-file-choice';
    const text=document.createElement('span');text.textContent=`🎬 ${videoDraft.file.name}（${videoSizeText(videoDraft.file.size)}）`;
    const remove=document.createElement('button');remove.type='button';remove.className='ghost slim';remove.textContent='選択を外す';remove.addEventListener('click',()=>{videoDraft.file=null;videoDraft.uploaded=null;$('fieldVideo').value='';paintVideoDraft()});
    entry.append(text,remove);info.append(entry);
  }else info.textContent='動画は未選択です。';
  for(const video of videoDraft.existing){
    const id=videoDriveId(video);if(!id)continue;
    const btn=document.createElement('button');btn.type='button';btn.className='video-saved-item';btn.textContent=`▶ ${video.name||'保存済み動画'}（${videoSizeText(video.size||0)}）`;
    btn.addEventListener('click',()=>openVideoViewer(video));stored.append(btn);
  }
  if(videoDraft.existing.length>=MAX_RECORD_VIDEOS){$('fieldVideo').disabled=true;$('fieldVideo').closest('.video-add-label')?.classList.add('hidden')}
  else{$('fieldVideo').disabled=false;$('fieldVideo').closest('.video-add-label')?.classList.remove('hidden')}
}
$('fieldVideo').addEventListener('change',event=>{
  const file=event.target.files?.[0];if(!file)return;
  if(!videoMime(file)){alertMsg('MP4・MOV・WebMなどの動画ファイルを選択してください。',true);event.target.value='';return}
  if(file.size>MAX_VIDEO_BYTES){alertMsg('動画は250MB以内にしてください。',true);event.target.value='';return}
  if(videoDraft.existing.length>=MAX_RECORD_VIDEOS){alertMsg('動画は1件につき最大3本です。',true);event.target.value='';return}
  videoDraft.file=file;videoDraft.uploaded=null;paintVideoDraft();
});
function authorizeDriveVideo(){
  if(driveVideoToken&&Date.now()<driveVideoTokenUntil)return Promise.resolve(driveVideoToken);
  if(!auth.currentUser)return Promise.reject(new Error('Googleログインをやり直してください。'));
  const driveProvider=new GoogleAuthProvider();driveProvider.addScope(DRIVE_FILE_SCOPE);
  driveProvider.setCustomParameters({prompt:'consent select_account'});
  // 必ずユーザーが「保存」を押したイベントから直ちに呼ぶ（ポップアップブロック対策）。
  return reauthenticateWithPopup(auth.currentUser,driveProvider).then(result=>{
    const token=GoogleAuthProvider.credentialFromResult(result)?.accessToken;
    if(!token)throw new Error('Google Driveのアクセス許可を取得できませんでした。');
    if(result.user.email?.toLowerCase()!==OWNER_EMAIL.toLowerCase())throw new Error('よりみち日和にログイン中のGoogleアカウントを選択してください。');
    driveVideoToken=token;driveVideoTokenUntil=Date.now()+45*60*1000;
    return token;
  });
}

// 動画を保存する前に、相棒がGoogle Driveの許可状態を画面から検査できる。
$('videoDriveTest').addEventListener('click',async()=>{
  const b=$('videoDriveTest'),out=$('videoDriveConnectionStatus');
  b.disabled=true;out.textContent='Google Driveへの接続を確認しています…';
  try{
    const token=await authorizeDriveVideo();
    const response=await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',{headers:{Authorization:`Bearer ${token}`}});
    if(!response.ok)throw videoApiError(response.status,await response.text());
    const info=await response.json();
    if(info?.user?.emailAddress?.toLowerCase()!==OWNER_EMAIL.toLowerCase())throw new Error('別のGoogleアカウントが選ばれています。いつものアカウントに切り替えてください。');
    out.textContent='✓ Google Driveに接続できました。動画ファイルを選択して保存できます。';
    alertMsg('✓ Google Driveへの接続に成功しました');
  }catch(e){out.textContent='接続できません: '+friendlyErr(e)+'　Driveへ先に動画を保存し、下のリンク欄に貼る方法なら、アプリに動画を登録できます。';}
  finally{b.disabled=false}
});
async function uploadVideoToDrive(file,token,title,onProgress){
  const mime=videoMime(file);if(!mime)throw new Error('サポートされていない動画形式です。');
  const label=`よりみち日和_${String(title||'思い出').replace(/[\\/:*?"<>|]/g,'_').slice(0,35)}_${file.name}`;
  // これまでは resumable の Location ヘッダーに依存していた。
  // クロスオリジンのブラウザでは Location が読み取れない場合があるため、
  // Google公式JS例に従い、一つのmultipart/relatedリクエストでメタデータと動画を送る。
  const boundary='yorimichi_'+uniqueId().replace(/[^a-zA-Z0-9]/g,'');
  const payload=new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify({name:label,mimeType:mime,description:'よりみち日和に添付した動画（非公開）'}),
    `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,file,`\r\n--${boundary}--\r\n`
  ]);
  onProgress?.(0);
  let response;
  try{
    response=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink',{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':`multipart/related; boundary=${boundary}`},body:payload
    });
  }catch(e){throw new Error('動画の送信に接続できませんでした。通信・Google Drive APIの設定を確認するか、Driveリンクで登録してください。'+friendlyErr(e))}
  if(!response.ok)throw videoApiError(response.status,await response.text());
  const data=await response.json();
  if(!videoDriveId(data))throw new Error('Google Driveへの送信後、動画IDを取得できませんでした。Drive内に重複保存されていないか確認してください。');
  onProgress?.(100);
  return {type:'google-drive',id:data.id,name:file.name,mimeType:mime,size:file.size,createdAt:now()};
}

function openVideoViewer(video){
  const id=videoDriveId(video);if(!id){alertMsg('動画のリンクが正しくありません。',true);return}
  $('videoViewerTitle').textContent=video.name||'動画を再生';
  $('videoViewerFrame').src=videoDrivePreview(id);
  $('videoViewerOpenDrive').href=videoDriveUrl(id);
  showDialog($('videoViewerDialog'));
}
$('videoViewerClose').addEventListener('click',()=>$('videoViewerDialog').close());
$('videoViewerDialog').addEventListener('close',()=>$('videoViewerFrame').removeAttribute('src'));
function videoButtonsMarkup(record){
  const videos=Array.isArray(record.videos)?record.videos.filter(videoDriveId):[];
  return videos.length?`<section class="record-videos"><h3>🎬 動画（${videos.length}本）</h3><div class="record-video-strip">${videos.map(v=>`<button type="button" class="record-video-button" data-video-id="${esc(videoDriveId(v))}" data-video-name="${esc(v.name||'動画')}" aria-label="${esc(v.name||'動画')}を再生"><span aria-hidden="true">▶</span><strong>${esc(v.name||'動画')}</strong><small>タップして再生 ↗</small></button>`).join('')}</div></section>`:'';
}
function findVideoById(id){
  for(const item of [...state.logs,...state.wishes])for(const video of item.videos||[])if(videoDriveId(video)===id)return video;
  return null;
}


function addRelatedLinkRow(value={}){
  const root=$('relatedLinkRows');
  if(root.children.length>=MAX_RECORD_LINKS){alertMsg('関連リンクは最大5件までです。',true);return}
  const row=document.createElement('div');row.className='related-link-row';
  const name=document.createElement('input');name.type='text';name.maxLength=60;name.placeholder='リンク名（例：公式サイト）';name.className='related-link-name';name.setAttribute('aria-label','関連リンクの名前');name.value=String(value.label||'');
  const url=document.createElement('input');url.type='url';url.inputMode='url';url.placeholder='https://example.com';url.className='related-link-url';url.setAttribute('aria-label','関連リンクのURL');url.value=String(value.url||'');
  // ブラウザ内蔵のURLバリデーションより正規化処理で判定し、日本語入力中は妨げない。
  url.type='text';
  const del=document.createElement('button');del.type='button';del.className='ghost slim related-link-remove';del.textContent='削除';del.setAttribute('aria-label','このリンク欄を削除');
  del.addEventListener('click',()=>{row.remove();updateRelatedLinkAddState()});
  row.append(name,url,del);root.append(row);updateRelatedLinkAddState();
}
function updateRelatedLinkAddState(){
  const count=$('relatedLinkRows').children.length;
  $('relatedLinkAdd').disabled=count>=MAX_RECORD_LINKS;
  $('relatedLinkCounter').textContent=`${count} / ${MAX_RECORD_LINKS}件`;
}
function loadRelatedLinkRows(item){
  $('relatedLinkRows').replaceChildren();
  const links=relatedLinks(item);
  (links.length?links:[{}]).forEach(addRelatedLinkRow);
}
function collectRelatedLinks(){
  const list=[];
  for(const row of $('relatedLinkRows').children){
    const label=row.querySelector('.related-link-name').value.trim();
    const raw=row.querySelector('.related-link-url').value.trim();
    if(!raw){if(label)throw new Error('リンク名がある行にはURLも入力してください。');continue}
    const url=normalizeExternalUrl(raw);
    if(!url)throw new Error('関連リンクのURLを確認してください。https:// から始まるサイトのURLを入力してください。');
    if(list.some(v=>v.url===url))continue;
    list.push({url,label:label||new URL(url).hostname});
  }
  if(list.length>MAX_RECORD_LINKS)throw new Error('関連リンクは最大5件です。');
  return list;
}
$('relatedLinkAdd').addEventListener('click',()=>addRelatedLinkRow());
function edit(kind,id=''){const item=(kind==='log'?state.logs:state.wishes).find(x=>x.id===id);if(id&&!item){alertMsg('編集対象が見つかりません。再読み込みしてください。',true);return}$('editForm').reset();loadRelatedLinkRows(item);resetPhotoDraft();videoDraft.file=null;videoDraft.uploaded=null;videoDraft.existing=Array.isArray(item?.videos)?item.videos.filter(videoDriveId):[];$('fieldVideo').value='';$('fieldVideoDriveUrl').value='';$('videoUploadProgress').textContent='';paintVideoDraft();clearLocationCandidates();$('editKind').value=kind;$('editId').value=id;$('dialogTitle').textContent=id?'記録を編集':kind==='log'?'思い出を記録':'行きたい場所を登録';$('fieldTitle').value=item?.title||'';$('fieldDate').value=item?.date||item?.planDate||today();$('fieldPlace').value=item?.place||'';$('fieldNote').value=item?.note||item?.reason||'';$('fieldLat').value=item?.lat??'';$('fieldLng').value=item?.lng??'';$('fieldGroup').value=item?.groupName||'';$('fieldTrip').value=item?.tripStyle||'未定';$('fieldStatus').value=item?.status||'wish';$('statusArea').classList.toggle('hidden',kind==='log');$('fieldGroup').closest('label').classList.toggle('hidden',kind==='wish');refreshCategoryUi();$('fieldMajor').value=item?.major||Object.keys(state.categories)[0]||'外食・グルメ';updateMinor();$('fieldMinor').value=item?.minor||'';$('editError').textContent='';paintPhotoDraft();if(item){photoDraft.ready=false;paintPhotoDraft();void loadExistingPhotoCount(item,photoDraft.token)}$('saveButton').textContent=item?'変更を保存':'保存する';$('editDelete').classList.toggle('hidden',!item);$('editDelete').dataset.trashKind=kind;$('editDelete').dataset.trashId=item?.id||'';showDialog($('editDialog'))}
async function photoData(file,maxSide=1200,quality=.7){const img=await createImageBitmap(file);try{const scale=Math.min(1,maxSide/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));c.getContext('2d').drawImage(img,0,0,c.width,c.height);return c.toDataURL('image/jpeg',quality)}finally{img.close()}}
// v2.0.16: 日本の住所に多い郵便番号・空白・ビル名などで検索が失敗しても
// 地図を直接選んで登録できる。検索サービスの候補は必ず本人が選ぶ。
let lastGeoRequestAt=0;
let locationSearching=false;
let locationPickerMap=null;
let locationPickerMarker=null;
let locationPickerPoint=null;
let locationPickerTarget=null;
let locationPickerBusy=false;
// ピン編集の操作が元のフォームを介さない場合でも、都道府県へ移動できるようにする。
// この座標は地図の初期表示専用。保存する位置としては使用しない。
const prefectureViewCenters={
 '北海道':[43.06,141.35], '青森県':[40.82,140.74], '岩手県':[39.70,141.15], '宮城県':[38.27,140.87],
 '秋田県':[39.72,140.10], '山形県':[38.25,140.34], '福島県':[37.75,140.47], '茨城県':[36.37,140.47],
 '栃木県':[36.56,139.88], '群馬県':[36.39,139.06], '埼玉県':[35.86,139.65], '千葉県':[35.61,140.12],
 '東京都':[35.68,139.76], '神奈川県':[35.45,139.64], '新潟県':[37.91,139.04], '富山県':[36.70,137.21],
 '石川県':[36.56,136.66], '福井県':[36.06,136.22], '山梨県':[35.66,138.57], '長野県':[36.65,138.18],
 '岐阜県':[35.42,136.76], '静岡県':[34.98,138.38], '愛知県':[35.18,136.91], '三重県':[34.73,136.51],
 '滋賀県':[35.00,135.87], '京都府':[35.01,135.76], '大阪府':[34.69,135.50], '兵庫県':[34.69,135.20],
 '奈良県':[34.69,135.83], '和歌山県':[34.23,135.17], '鳥取県':[35.50,134.24], '島根県':[35.47,133.05],
 '岡山県':[34.66,133.93], '広島県':[34.40,132.46], '山口県':[34.19,131.47], '徳島県':[34.07,134.56],
 '香川県':[34.34,134.04], '愛媛県':[33.84,132.77], '高知県':[33.56,133.53], '福岡県':[33.59,130.40],
 '佐賀県':[33.26,130.30], '長崎県':[32.75,129.88], '熊本県':[32.79,130.74], '大分県':[33.24,131.61],
 '宮崎県':[31.91,131.42], '鹿児島県':[31.60,130.56], '沖縄県':[26.21,127.68]
};
function pickerRecord(){
 if(!locationPickerTarget?.id)return null;
 const arr=locationPickerTarget.kind==='log'?state.logs:state.wishes;
 return arr.find(x=>String(x.id)===String(locationPickerTarget.id))||null;
}
function pickerAddress(){return pickerRecord()?.place||$('fieldPlace').value.trim()}
function pickerTitle(){return pickerRecord()?.title||$('fieldTitle').value.trim()}
function initialPickerView(address){
 const compact=normalizedAddress(address);
 for(const [pref,coordinates] of Object.entries(prefectureViewCenters)){
   if(compact.includes(pref))return {coordinates,zoom:10,label:pref};
 }
 return {coordinates:[36.2,137.4],zoom:5,label:'日本'};
}

function clearLocationCandidates(){
  $('locationCandidates').replaceChildren();
  $('locationLookupInfo').textContent='';
}
function normalizedAddress(value){
  return String(value||'').normalize('NFKC')
    .replace(/(?:〒\s*)?\d{3}\s*[-‐‑‒–—―ー－]?\s*\d{4}/g,'')
    .replace(/^(?:日本|Japan)[、,\s]*/i,'')
    .replace(/[\u3000\s]+/g,' ').trim();
}
function addressSearchVariants(raw,name){
  const base=normalizedAddress(raw),variants=[];
  const add=t=>{t=String(t||'').trim();if(t&&!variants.includes(t))variants.push(t)};
  if(base){
    add(base);
    const simple=base.replace(/(?:\s*[,，].*)$/,'').replace(/(?:\s*(?:ホテル|ビル|階|フロア).*\s*)$/,'').trim();
    // 住所がビル名等を含む場合は都道府県・市町村までを残して再検索する。
    if(simple!==base)add(simple);
    const jpCompact=base.replace(/[\s　]+/g,'');
    if(jpCompact!==base)add(jpCompact);
    // 建物名や番地に余分な空白が入る住所は、丁目・番地の前まで落とした候補も試す。
    const street=jpCompact.replace(/(?:\d+[-丁目番地号].*)$/,'');
    if(street&&street!==jpCompact)add(street);

  }
  if(name){
    const pref=base.match(/(?:東京都|北海道|(?:京都|大阪)府|.{2,3}県)[^市区町村郡]*[市区町村郡]?/);
    add((pref?.[0]?pref[0]+' ':'')+name);
  }
  return variants.slice(0,4);
}
// 日本の住所は地理院の住所検索を先に試す。結果は必ず候補を選んで確定する。
async function gsiAddressSearch(q){
  const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),10000);
  try{
    const res=await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q='+encodeURIComponent(q),{signal:ctrl.signal,headers:{Accept:'application/json'}});
    if(!res.ok)throw Error('住所検索サービスの応答 '+res.status);
    const json=await res.json();
    if(!Array.isArray(json))return [];
    return json.filter(x=>Array.isArray(x?.geometry?.coordinates)&&x.geometry.coordinates.length>=2)
      .map(x=>({lat:Number(x.geometry.coordinates[1]),lon:Number(x.geometry.coordinates[0]),display_name:String(x.properties?.title||q)+'（地理院検索：付近の位置の場合があります）'}))
      .filter(x=>validCoord(x.lat,x.lon)).slice(0,5);
  }finally{clearTimeout(timeout)}
}
async function searchLocationCandidates(raw,name){
  const queries=addressSearchVariants(raw,name);
  if(!queries.length&&name)queries.push(name);
  const errors=[];
  // 郵便番号・建物名を除去した住所を優先し、地理院の日本向け検索を利用。
  for(const q of queries.slice(0,3)){
    try{const list=await gsiAddressSearch(q);if(list.length)return list}catch(e){errors.push(e)}
  }
  // 地理院が使えない・見つからないときだけ従来のOSM検索。
  for(const q of queries.slice(0,2)){
    try{const list=await nominatimSearch(q);if(list.length)return list}catch(e){errors.push(e)}
  }
  if(errors.length&&errors.length>=queries.length*2)throw errors[errors.length-1];
  return [];
}
async function nominatimSearch(q){
  const pause=Math.max(0,1150-(Date.now()-lastGeoRequestAt));
  if(pause)await new Promise(resolve=>setTimeout(resolve,pause));
  const params=new URLSearchParams({q,format:'jsonv2',limit:'5',addressdetails:'1','accept-language':'ja'});
  lastGeoRequestAt=Date.now();
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),11000);
  try{
    const response=await fetch('https://nominatim.openstreetmap.org/search?'+params.toString(),{
      headers:{Accept:'application/json'},referrerPolicy:'strict-origin-when-cross-origin',signal:ctrl.signal
    });
    if(!response.ok)throw Error('検索サービスの応答 '+response.status);
    const result=await response.json();return Array.isArray(result)?result:[];
  }finally{clearTimeout(timer)}
}
function setCandidateCoordinates(lat,lng,message){
  if(!validCoord(lat,lng))return;
  $('fieldLat').value=String(Number(lat));$('fieldLng').value=String(Number(lng));
  $('locationLookupInfo').textContent=message||'✓ 位置を選択しました。最後に「変更を保存」を押してください。';
}
async function lookupAddressCoordinates(){
  if(locationSearching)return;
  const raw=$('fieldPlace').value.trim(),name=$('fieldTitle').value.trim();
  if(!raw&&!name){$('locationLookupInfo').textContent='住所か施設名を入力してください。';return}
  const btn=$('lookupLocation');clearLocationCandidates();
  btn.disabled=true;locationSearching=true;
  try{
    $('locationLookupInfo').textContent='日本の住所を検索中… 地理院→OpenStreetMapの順で探します。';
    const places=await searchLocationCandidates(raw,name);
    if(!places.length){
      $('locationLookupInfo').textContent='住所では見つかりませんでした。下の「地図から位置を選ぶ」で、目的地を直接指定できます。';
      return;
    }
    $('locationLookupInfo').textContent=`候補${places.length}件。正しい位置を選んでから保存してください。`; 
    for(const item of places){
      const lat=Number(item.lat),lng=Number(item.lon);
      if(!validCoord(lat,lng))continue;
      const candidate=document.createElement('button');candidate.type='button';candidate.className='location-candidate';
      const label=document.createElement('span');label.textContent=String(item.display_name||'候補地点').slice(0,250);
      const coordinates=document.createElement('small');coordinates.textContent=lat.toFixed(5)+', '+lng.toFixed(5);
      candidate.append(label,coordinates);
      candidate.addEventListener('click',()=>{
        setCandidateCoordinates(lat,lng,'✓ 地図の位置を選択しました。「変更を保存」でピン登録完了です。');
        $('locationCandidates').querySelectorAll('button').forEach(el=>el.classList.toggle('selected',el===candidate));
        $('locationLookupInfo').textContent='✓ 候補を選択しました。地図で位置を確認するか、下の「変更を保存」でピン登録してください。';
      });
      $('locationCandidates').append(candidate);
    }
  }catch(e){
    $('locationLookupInfo').textContent='住所検索が利用できません。下の「地図から位置を選ぶ」をお使いください。('+friendlyErr(e)+')';
  }finally{btn.disabled=false;locationSearching=false}
}
$('lookupLocation').addEventListener('click',lookupAddressCoordinates);
// 住所検索で見つからない場合の代替：OpenStreetMap の地図上で直接ピンを選択。
function markPickerPoint(lat,lng,from='地図で位置を選択'){
  if(!validCoord(lat,lng)||!locationPickerMap)return;
  locationPickerPoint={lat:Number(lat),lng:Number(lng)};
  const coord=[locationPickerPoint.lat,locationPickerPoint.lng];
  if(locationPickerMarker)locationPickerMarker.setLatLng(coord);
  else locationPickerMarker=window.L.marker(coord).addTo(locationPickerMap);
  $('locationPickerConfirm').disabled=false;
  $('locationPickerInfo').textContent=`✓ ${from}：${lat.toFixed(5)}, ${lng.toFixed(5)}。正しければ下の「ピンを保存」を押してください。`;
}
async function searchPickerAddress(){
  if(locationPickerBusy)return;
  const btn=$('locationPickerSearch'),results=$('locationPickerResults');
  const raw=pickerAddress(),name=pickerTitle();
  results.replaceChildren();
  locationPickerBusy=true;btn.disabled=true;
  $('locationPickerInfo').textContent='住所から位置候補を探しています…';
  try{
    const places=await searchLocationCandidates(raw,name);
    if(!places.length){
      $('locationPickerInfo').textContent='住所から候補が見つかりません。地図を動かして、目的地を直接タップしてください。';
      return;
    }
    $('locationPickerInfo').textContent=`候補が${places.length}件あります。選ぶと地図が移動します。目的地の位置を必ず確認してください。`;
    for(const p of places){
      if(!validCoord(p.lat,p.lon))continue;
      const btn2=document.createElement('button');btn2.type='button';btn2.className='location-candidate';
      const t=document.createElement('span');t.textContent=String(p.display_name||'場所の候補').slice(0,150);
      const c=document.createElement('small');c.textContent=`緯度 ${Number(p.lat).toFixed(5)}・経度 ${Number(p.lon).toFixed(5)}`;
      btn2.append(t,c);
      btn2.addEventListener('click',()=>{
        const lat=Number(p.lat),lng=Number(p.lon);
        locationPickerMap.setView([lat,lng],16);
        markPickerPoint(lat,lng,'候補の位置を選択');
        results.querySelectorAll('button').forEach(x=>x.classList.toggle('selected',x===btn2));
      });
      results.append(btn2);
    }
  }catch(e){
    $('locationPickerInfo').textContent='住所検索サービスを利用できません。地図を拡大して位置をタップしてください（'+friendlyErr(e)+'）。';
  }finally{locationPickerBusy=false;btn.disabled=false}
}
async function openLocationPicker(kind=null,id=null){
  locationPickerTarget=(typeof kind==='string'&&['log','wish'].includes(kind)&&id)
    ? {kind,id,fromList:true}
    : (($('editDialog').open&&$('editId').value)
      ? {kind:$('editKind').value,id:$('editId').value,fromList:false}
      : null);
  const target=pickerRecord(),label=target?.title||$('fieldTitle').value.trim()||'新しい場所';
  const address=target?.place||$('fieldPlace').value.trim();
  const dlg=$('locationPickerDialog');
  locationPickerPoint=null;
  $('locationPickerResults').replaceChildren();
  $('locationPickerTarget').textContent=`📍 ${label}${address?'　｜　'+address:''}`;
  $('locationPickerConfirm').textContent=target?'この位置でピンを保存':'この位置を入力欄に反映';
  $('locationPickerConfirm').disabled=true;
  $('locationPickerInfo').textContent='地図をタップしてピンの位置を決めてください。未保存です。';
  dlg.showModal();
  try{
    await loadLeaflet();
    if(!dlg.open)return;
    if(!locationPickerMap){
      locationPickerMap=window.L.map('locationPickerMap');
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
        attribution:'© OpenStreetMap contributors',maxZoom:19
      }).addTo(locationPickerMap);
      locationPickerMap.on('click',e=>markPickerPoint(e.latlng.lat,e.latlng.lng));
    }
    // 前回のピンを新しい登録先に持ち込まない。
    if(locationPickerMarker){locationPickerMap.removeLayer(locationPickerMarker);locationPickerMarker=null;}
    const lat=target?.lat??$('fieldLat').value,lng=target?.lng??$('fieldLng').value;
    if(lat!==''&&lng!==''&&validCoord(lat,lng)){
      locationPickerMap.setView([Number(lat),Number(lng)],15);
      markPickerPoint(Number(lat),Number(lng),'既存の位置を表示');
    }else{
      const view=initialPickerView(address);
      locationPickerMap.setView(view.coordinates,view.zoom);
      $('locationPickerInfo').textContent=`${view.label}付近を表示しています。拡大して目的地をタップし、最後に「ピンを保存」を押してください。`;
    }
    setTimeout(()=>locationPickerMap?.invalidateSize(),160);
  }catch(e){$('locationPickerInfo').textContent='地図を読み込めません: '+friendlyErr(e)}
}
$('locationPickerOpen').addEventListener('click',()=>openLocationPicker());
$('locationPickerSearch').addEventListener('click',searchPickerAddress);
$('locationPickerConfirm').addEventListener('click',async()=>{
  if(!locationPickerPoint)return;
  const {lat,lng}=locationPickerPoint;
  const target=locationPickerTarget;
  const btn=$('locationPickerConfirm');
  if(!target?.id){
    setCandidateCoordinates(lat,lng,'✓ 位置を選びました。元の画面の「変更を保存」を押してください。');
    $('locationPickerDialog').close();
    if($('editDialog').open)$('editDialog').scrollTop=$('editDialog').scrollHeight;
    return;
  }
  const rec=pickerRecord();
  if(!rec){$('locationPickerInfo').textContent='保存先の記録が見つかりません。再読み込みしてやり直してください。';return;}
  btn.disabled=true;btn.textContent='Firebaseへピンを保存中…';
  $('locationPickerInfo').textContent='Firebaseへ座標を保存しています。画面を閉じずにお待ちください。';
  try{
    const updatedAt=now();
    // 位置情報だけを部分更新。タイトル・住所・写真・訪問状況は変更しない。
    await updateDoc(doc(db,target.kind==='log'?'logs':'wishes',target.id),{lat,lng,updatedAt});
    rec.lat=lat;rec.lng=lng;rec.updatedAt=updatedAt;
    if($('editDialog').open){
      $('fieldLat').value=String(lat);$('fieldLng').value=String(lng);
      $('locationLookupInfo').textContent='✓ 地図ピンは保存済み。ほかの編集内容があれば「変更を保存」で保存してください。';
    }
    $('locationPickerDialog').close();
    if(target.fromList&&$('editDialog').open)$('editDialog').close();
    render();
    if(state.tab==='map'&&state.map){state.map.setView([lat,lng],15);state.map.invalidateSize();}
    const count=[...state.logs,...state.wishes].filter(x=>!validCoord(x.lat,x.lng)).length;
    $('mapRegistrationNotice').textContent=`✓ ${rec.title} をピン登録しました。未登録：残り${count}件。`;
    $('mapRegistrationNotice').classList.remove('hidden');
    alertMsg('✓ Firebaseへ位置を保存しました。地図にピンを表示します！');
  }catch(e){
    $('locationPickerInfo').textContent='ピンを保存できませんでした: '+friendlyErr(e)+'。位置は保持していますので、再試行してください。';
  }finally{btn.disabled=false;btn.textContent=target?.id?'この位置でピンを保存':'この位置を入力欄に反映';}
});
$('locationPickerCancel').addEventListener('click',()=>$('locationPickerDialog').close());
$('applyCoordinates').addEventListener('click',()=>{
  const raw=$('coordinatePaste').value.trim();
  const m=raw.match(/^\s*([+-]?\d+(?:\.\d+)?)\s*[,、\s]+\s*([+-]?\d+(?:\.\d+)?)\s*$/);
  if(!m){$('locationLookupInfo').textContent='「緯度, 経度」の順に入力してください（例：36.57890, 136.64850）。';return}
  const a=Number(m[1]),b=Number(m[2]);
  if(!validCoord(a,b)){$('locationLookupInfo').textContent='緯度・経度が範囲外です。';return}
  setCandidateCoordinates(a,b,'✓ 座標を反映しました。最後に「変更を保存」を押すとピンが立ちます。');
});
$('locationPickerGoogle').addEventListener('click',()=>{
  const q=$('fieldPlace').value.trim()||$('fieldTitle').value.trim();
  window.open(mapsUrl(q),'_blank','noopener,noreferrer');
});
// 住所の編集では既存のピンを消さない。新しい位置を選ぶまで元の座標を保持する。
$('fieldPlace').addEventListener('input',()=>{
  clearLocationCandidates();
  $('locationLookupInfo').textContent=($('fieldLat').value!==''&&$('fieldLng').value!=='')
    ?'住所が変わりました。既存の地図ピンは保持しています。場所が変わる場合は検索または地図から新しい位置を選んでください。'
    :'住所が変わりました。「住所から地図位置を探す」か「地図から位置を選ぶ」で登録してください。';
});

async function saveEdit(e){e.preventDefault();const kind=$('editKind').value,id=$('editId').value||uniqueId();const title=$('fieldTitle').value.trim();if(!title){$('editError').textContent='名前を入力してください';return}const old=(kind==='log'?state.logs:state.wishes).find(x=>x.id===id)||{};const lat=$('fieldLat').value,lng=$('fieldLng').value;if((lat||lng)&&!validCoord(lat,lng)){$('editError').textContent='緯度・経度が正しくありません';return}const base={...old,id,title,major:$('fieldMajor').value,minor:$('fieldMinor').value,tripStyle:$('fieldTrip').value,place:$('fieldPlace').value.trim(),note:$('fieldNote').value.trim(),lat:lat===''?null:Number(lat),lng:lng===''?null:Number(lng),groupName:$('fieldGroup').value.trim(),updatedAt:now(),createdAt:old.createdAt||now(),photos:[...(old.photos||[])]};if(kind==='log')base.date=$('fieldDate').value||today();else {base.planDate=$('fieldDate').value;base.status=$('fieldStatus').value;base.reason=base.note;if(base.status==='visited'&&!base.visitDate)base.visitDate=today()}
try{base.links=collectRelatedLinks()}catch(ex){$('editError').textContent=ex.message;return}
const hadPin=validCoord(old.lat,old.lng);
const willHavePin=validCoord(base.lat,base.lng);
const locationChanged=willHavePin&&(!hadPin||Number(old.lat)!==Number(base.lat)||Number(old.lng)!==Number(base.lng));
const manualVideoLink=$('fieldVideoDriveUrl').value.trim();
const manualVideoId=driveIdFromLink(manualVideoLink);
if(manualVideoLink&&!manualVideoId){$('editError').textContent='Google Driveの動画リンクを確認してください。';return}
if(manualVideoLink&&videoDraft.file){$('editError').textContent='動画ファイルとDriveのリンクは、どちらか一方だけ選んでください。';return}
if((videoDraft.file||manualVideoId) && videoDraft.existing.length>=MAX_RECORD_VIDEOS){$('editError').textContent='動画は最大3本です。';return}
if(videoDraft.file && videoDraft.file.size>MAX_VIDEO_BYTES){$('editError').textContent='動画は250MB以内にしてください。';return}
// Googleの認証ポップアップは「保存する」クリック直後に開く。
const driveAuthorization=videoDraft.file&&!videoDraft.uploaded?authorizeDriveVideo():null;
const button=$('saveButton');button.disabled=true;button.textContent='保存中…';$('editError').textContent='';try{if(!photoDraft.ready)throw Error('写真枚数の確認中です。少し待ってから保存してください。');
if(manualVideoId){
  base.videos=[...(Array.isArray(old.videos)?old.videos:[]),{type:'google-drive',id:manualVideoId,name:'Google Driveの動画',mimeType:'video/mp4',size:0,createdAt:now()}];
}
if(videoDraft.file){
  if(!videoDraft.uploaded){
    $('videoUploadProgress').textContent='Google Driveへの保存を準備しています…';
    const token=await driveAuthorization;
    videoDraft.uploaded=await uploadVideoToDrive(videoDraft.file,token,title,percent=>{$('videoUploadProgress').textContent=`動画をGoogle Driveへ保存中… ${percent}%`});
  }
  base.videos=[...(Array.isArray(old.videos)?old.videos:[]),videoDraft.uploaded];
  $('videoUploadProgress').textContent='動画の転送が完了しました。記録へ紐づけています…';
}

const f=[...photoDraft.files];
if(photoDraft.refs.length+f.length>MAX_RECORD_PHOTOS)throw Error('1件の写真は最大5枚です。');for(const file of f){let dataUrl=await photoData(file,1300,.72);if(dataUrl.length>680000)dataUrl=await photoData(file,1000,.55);if(dataUrl.length>780000)throw new Error('画像を小さくできませんでした');const photoId=uniqueId();await setDoc(doc(db,'photos',photoId),{id:photoId,ownerId:id,kind,dataUrl,createdAt:now()});base.photos.push({type:'firestore',id:photoId,ref:photoId});cardThumbnailCache.delete(id)}await setDoc(doc(db,kind==='log'?'logs':'wishes',id),base);
// Firestoreの書き込み成功後だけ画面の座標を更新。既存データは上書きしない。
const inMemory=(kind==='log'?state.logs:state.wishes).find(x=>x.id===id);
if(inMemory)Object.assign(inMemory,base);
$('editDialog').close();resetPhotoDraft();videoDraft.file=null;videoDraft.uploaded=null;videoDraft.existing=[];$('videoUploadProgress').textContent='';
render(); // ピンと「未登録一覧」の件数を即時更新する
if(willHavePin&&locationChanged){
  const count=[...state.logs,...state.wishes].filter(x=>!validCoord(x.lat,x.lng)).length;
  $('mapRegistrationNotice').textContent=`✓「${title}」の位置を登録しました。地図ピンに反映済み。未登録：残り${count}件。`;
  $('mapRegistrationNotice').classList.remove('hidden');
  // 位置保存後に該当ピンへ視点を移すと、マップ上でも登録が確認しやすい。
  if(state.tab==='map'&&state.map)state.map.setView([Number(base.lat),Number(base.lng)],13);
  alertMsg('✓ 位置を保存しました。マップでピンと未登録件数を確認してください。');
}else if(willHavePin) alertMsg('✓ 記録を保存しました。登録済みの地図ピンは維持されています。');
else alertMsg('✓ 記録を保存しました。地図ピンはまだ未登録です。');}catch(ex){$('editError').textContent='保存できません: '+friendlyErr(ex);$('videoUploadProgress').textContent=videoDraft.uploaded?'動画はDriveへ保存済みです。もう一度「保存する」を押すと、再アップロードせず記録への紐づけを試みます。':'Google Driveに保存できませんでした。下の「Driveに保存済みの動画リンク」を使う方法もあります。接続確認の結果を確認してください。';alertMsg('保存エラー',true)}finally{button.disabled=false;button.textContent='保存する'}}
$('editForm').addEventListener('submit',saveEdit);
async function stampWish(id){
  const x=state.wishes.find(w=>w.id===id);
  if(!x||x.status==='visited')return;
  if(!confirm(`「${x.title}」には実際に行きましたか？\n\n「OK」を押すと、目立つ「✓ 訪問済み」に変更します。\nまだ行っていなければ「キャンセル」を押してください。`))return;
  try{
    await setDoc(doc(db,'wishes',id),{...x,status:'visited',visitDate:today(),updatedAt:now()});
    alertMsg('✓ 訪問済みに変更しました');
  }catch(e){alertMsg('保存できません: '+friendlyErr(e),true)}
}
// v2.0.10: 非破壊のゴミ箱。Firestoreの記録・画像ドキュメントは物理削除しない。
// 必ず部分更新にして、既存の写真ID、訪問日、感想、地図の座標を保持する。
async function moveToTrash(kind,id){
  if(!['log','wish'].includes(kind)||!id)return;
  const items=kind==='log'?state.logs:state.wishes;
  const entry=items.find(x=>x.id===id);
  if(!entry)return alertMsg('対象の記録が見つかりません。再読み込みしてください。',true);
  if(!confirm(`「${entry.title}」をゴミ箱へ移動しますか？\n\n一覧・ホーム・カレンダー・地図からは非表示になります。写真は削除されません。「設定 → ゴミ箱」で復元できます。`))return;
  try{
    await updateDoc(doc(db,kind==='log'?'logs':'wishes',id),{deleted:true,deletedAt:now(),updatedAt:now()});
    cardThumbnailCache.delete(id);
    if($('visitDialog').open){$('visitDialog').close();state.visitSeq++}
    if($('editDialog').open)$('editDialog').close();
    if($('photoViewer')?.open)$('photoViewer').close();
    alertMsg('ゴミ箱へ移動しました。設定から元に戻せます。');
  }catch(e){alertMsg('削除に失敗しました: '+friendlyErr(e),true)}
}
async function restoreFromTrash(kind,id){
  if(!['log','wish'].includes(kind)||!id)return;
  const items=kind==='log'?state.trashedLogs:state.trashedWishes;
  const entry=items.find(x=>x.id===id);
  if(!entry)return alertMsg('ゴミ箱の記録が見つかりません。更新をお待ちください。',true);
  if(!confirm(`「${entry.title}」を元に戻しますか？`))return;
  try{
    await updateDoc(doc(db,kind==='log'?'logs':'wishes',id),{deleted:false,deletedAt:null,updatedAt:now()});
    cardThumbnailCache.delete(id);
    alertMsg('記録を復元しました。思い出一覧・地図に戻ります。');
  }catch(e){alertMsg('復元に失敗しました: '+friendlyErr(e),true)}
}
async function deleteWish(id){return moveToTrash('wish',id)}
function renderTrash(){
  const target=$('trashList');if(!target)return;
  const items=[...state.trashedLogs.map(x=>({...x,kind:'log'})),...state.trashedWishes.map(x=>({...x,kind:'wish'}))]
    .sort((a,b)=>String(b.deletedAt||'').localeCompare(String(a.deletedAt||'')));
  $('trashCount').textContent=`${items.length}件`;
  target.innerHTML=items.length?items.map(x=>`<div class="trash-row"><div class="trash-record"><strong>${esc(x.title)}</strong><small>${x.kind==='log'?'思い出':'行きたい場所'} · ${esc(dateText(x.date||x.planDate))}</small></div><button type="button" class="ghost slim" data-restore-kind="${x.kind}" data-restore-id="${esc(x.id)}">元に戻す</button></div>`).join(''):'<p class="muted">ゴミ箱は空です。</p>';
}
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
  body.innerHTML=`<p><strong>${esc(dateText(x.date))}</strong>　${esc(x.major||'')}/${esc(x.minor||'')}</p><p class="entry-note">${esc(x.note||'（感想なし）')}</p>${x.place?`<p><a href="${mapsUrl(x.place)}" target="_blank" rel="noopener noreferrer">📍 Googleマップで開く ↗</a></p>`:''}${relatedLinksMarkup(x)}${videoButtonsMarkup(x)}<h3>この日の写真</h3><p class="photo-swipe-help">写真は左右にスワイプして見られます。タップで拡大します。</p><div id="visitPhotos" class="photo-strip"><p class="muted">写真を確認しています…</p></div>`;
  $('visitEdit').dataset.editLog=x.id;
  $('visitDelete').dataset.trashLog=x.id;
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
        const btn=document.createElement('button');btn.type='button';btn.className='photo-thumb-button';btn.setAttribute('aria-label','写真を大きく見る');btn.classList.add('photo-swipe-slide');const im=document.createElement('img');im.src=uri;im.alt='訪問時の写真';im.className='photo-thumb';btn.append(im);btn.addEventListener('click',()=>openPhotoViewer(x.id,String(photo.id||photo.ref||'')));el.replaceWith(btn);
      }else{
        el.textContent='元写真（Drive）';const link=document.createElement('a');link.href='https://drive.google.com/drive/u/0/search?q='+encodeURIComponent(String(photo.ref||'').split('/').pop());link.target='_blank';link.rel='noopener noreferrer';link.textContent='Driveで探す ↗';el.appendChild(link);
      }
    }catch(error){el.textContent='写真取得失敗'}
  }
}

// v2.0.8: 写真は同じ画面の拡大ビューアで表示。Firebaseの写真データは読み取り専用。
const viewerState={photos:[],index:0,seq:0,title:''};
function paintPhotoViewer(){
  const current=viewerState.photos[viewerState.index];
  const img=$('photoViewerImage'),status=$('photoViewerStatus');
  if(!current){img.removeAttribute('src');img.classList.add('hidden');status.textContent='表示できる写真がありません';status.classList.remove('hidden');$('photoViewerCount').textContent='';return}
  img.src=current.uri;img.alt=viewerState.title+'の写真 '+(viewerState.index+1)+'枚目';img.classList.remove('hidden');
  status.classList.add('hidden');$('photoViewerCount').textContent=(viewerState.index+1)+' / '+viewerState.photos.length+' 枚';
  $('photoViewerPrev').disabled=viewerState.photos.length<=1;$('photoViewerNext').disabled=viewerState.photos.length<=1;
}
function stepPhotoViewer(delta){if(!viewerState.photos.length)return;viewerState.index=(viewerState.index+delta+viewerState.photos.length)%viewerState.photos.length;paintPhotoViewer()}
async function openPhotoViewer(logId,photoId=''){
  const x=[...state.logs,...state.wishes].find(log=>String(log.id)===String(logId));if(!x)return;
  const dialog=$('photoViewerDialog');const seq=++viewerState.seq;
  viewerState.title=x.title||'場所';viewerState.photos=[];viewerState.index=0;
  $('photoViewerTitle').textContent=viewerState.title;
  $('photoViewerImage').classList.add('hidden');$('photoViewerStatus').textContent='写真を読み込み中…';$('photoViewerStatus').classList.remove('hidden');$('photoViewerCount').textContent='';
  if(!dialog.open)dialog.showModal();
  let refs=[];
  try{refs=await photoRefsForVisit(x)}catch(_){refs=Array.isArray(x.photos)?x.photos:[]}
  const found=[];const used=new Set();
  for(const ref of refs){
    if(seq!==viewerState.seq||!dialog.open)return;
    if(ref?.type!=='firestore')continue;
    const id=String(ref.id||ref.ref||'');if(!id||used.has(id))continue;used.add(id);
    try{const uri=await getPhoto(ref);if(uri)found.push({id,uri})}catch(_){}
  }
  if(seq!==viewerState.seq||!dialog.open)return;
  if(!found.length){$('photoViewerStatus').textContent='この場所にはまだ写真がありません。編集から写真を追加できます。';$('photoViewerStatus').classList.remove('hidden');$('photoViewerPrev').disabled=true;$('photoViewerNext').disabled=true;return}
  viewerState.photos=found;
  const index=found.findIndex(p=>p.id===photoId);viewerState.index=index>=0?index:0;
  paintPhotoViewer();
}
$('photoViewerClose').addEventListener('click',()=>$('photoViewerDialog').close());
$('photoViewerPrev').addEventListener('click',()=>stepPhotoViewer(-1));
$('photoViewerNext').addEventListener('click',()=>stepPhotoViewer(1));
$('photoViewerDialog').addEventListener('close',()=>{viewerState.seq++;viewerState.photos=[];$('photoViewerImage').removeAttribute('src')});
$('photoViewerDialog').addEventListener('click',e=>{if(e.target===$('photoViewerDialog'))$('photoViewerDialog').close()});
document.addEventListener('keydown',e=>{if(!$('photoViewerDialog').open)return;if(e.key==='ArrowRight'){e.preventDefault();stepPhotoViewer(1)}if(e.key==='ArrowLeft'){e.preventDefault();stepPhotoViewer(-1)}});
let viewerTouchX=null;
$('photoViewerImage').addEventListener('touchstart',e=>{viewerTouchX=e.touches[0]?.clientX??null},{passive:true});
$('photoViewerImage').addEventListener('touchend',e=>{if(viewerTouchX===null)return;const x=e.changedTouches[0]?.clientX??viewerTouchX;const diff=x-viewerTouchX;viewerTouchX=null;if(Math.abs(diff)>65)stepPhotoViewer(diff<0?1:-1)},{passive:true});

function renderCategories(){const box=$('categoryList');box.innerHTML=Object.entries(state.categories).map(([major,minors])=>`<div class="category-row"><strong>${esc(major)}</strong><button class="ghost" data-remove-cat="${esc(major)}" data-remove-minor="">大を削除</button></div>${minors.map(min=>`<div class="category-row"><span>　↳ ${esc(min)}</span><button class="ghost" data-remove-cat="${esc(major)}" data-remove-minor="${esc(min)}">小を削除</button></div>`).join('')}`).join('')}
async function saveCats(cat){await setDoc(doc(db,'settings','categories'),{majors:cat,updatedAt:now()})}
$('addCat').addEventListener('click',async()=>{const major=$('newMajor').value.trim(),minor=$('newMinor').value.trim();if(!major)return alertMsg('大カテゴリを入力してください',true);const clone=structuredClone(state.categories);if(!clone[major])clone[major]=[];if(minor&&!clone[major].includes(minor))clone[major].push(minor);try{await saveCats(clone);$('newMajor').value='';$('newMinor').value='';alertMsg('カテゴリを追加しました')}catch(e){alertMsg(friendlyErr(e),true)}});
async function removeCat(major,minor){const clone=structuredClone(state.categories);if(!confirm(`カテゴリ「${major}${minor?' / '+minor:''}」を削除しますか？過去の記録は残ります。`))return;if(minor)clone[major]=(clone[major]||[]).filter(x=>x!==minor);else delete clone[major];try{await saveCats(clone);alertMsg('カテゴリを削除しました')}catch(e){alertMsg(friendlyErr(e),true)}}
function saveFile(blob,name){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
$('exportJson').addEventListener('click',()=>{const data={logs:state.logs,wishes:state.wishes,custom:Object.entries(state.categories).flatMap(([major,minors])=>minors.map(minor=>({major,minor}))),exportedAt:now(),version:'2.0.0'};saveFile(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),`Yorimichi-Backup-${today()}.json`)});
$('jsonImport').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;let parsed;try{parsed=JSON.parse(await file.text())}catch(_){return $('importResult').textContent='JSONファイルを読み取れませんでした'}const logs=Array.isArray(parsed.logs)?parsed.logs:[],wishes=Array.isArray(parsed.wishes)?parsed.wishes:[];if(!logs.length&&!wishes.length)return $('importResult').textContent='記録が入っていません。';if(logs.length+wishes.length>5000)return $('importResult').textContent='件数が多すぎます。';if(!confirm(`旧データ ${logs.length}件、行きたい場所 ${wishes.length}件を取り込みますか？既存IDは上書きせずにスキップします。`))return;const existsLogs=new Set([...state.logs,...state.trashedLogs].map(x=>x.id)),existsWishes=new Set([...state.wishes,...state.trashedWishes].map(x=>x.id));let n=0,skip=0;try{const rows=[...logs.map(x=>({kind:'logs',x})),...wishes.map(x=>({kind:'wishes',x}))];let batch=writeBatch(db),part=0;for(const {kind,x} of rows){if(!x.id||!x.title){skip++;continue}const exists=kind==='logs'?existsLogs:existsWishes;if(exists.has(x.id)){skip++;continue}exists.add(x.id);const rec={...x,id:String(x.id),photos:Array.isArray(x.photos)?x.photos:[],createdAt:x.createdAt||now(),updatedAt:x.updatedAt||now()};batch.set(doc(db,kind,String(x.id)),rec);part++;n++;if(part===250){await batch.commit();batch=writeBatch(db);part=0}}if(part)await batch.commit();const cats=structuredClone(state.categories);for(const c of (parsed.custom||[])){if(!c?.major)continue;if(!cats[c.major])cats[c.major]=[];if(c.minor&&!cats[c.major].includes(c.minor))cats[c.major].push(c.minor)}if(Array.isArray(parsed.categoryRules)){const last=new Map();for(const c of parsed.categoryRules){if(c?.major)last.set(c.major+'\u0000'+(c.minor||''),c)}for(const c of last.values()){if(c.status==='削除'){if(!c.minor)delete cats[c.major];else if(cats[c.major])cats[c.major]=cats[c.major].filter(x=>x!==c.minor)}else{if(!cats[c.major])cats[c.major]=[];if(c.minor&&!cats[c.major].includes(c.minor))cats[c.major].push(c.minor)}}}await saveCats(cats);$('importResult').textContent=`取り込み完了：${n}件 / スキップ${skip}件。写真本体は別途取り込みが必要です。`;alertMsg('旧記録を取り込みました')}catch(err){$('importResult').textContent='途中でエラー: '+friendlyErr(err)+'。すでに取り込んだ記録は保持されています。'}});
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
// 地図ピンが増えない原因を可視化。住所があっても座標が未設定なら一覧から直せる。
function renderUnpinnedPlaces(){
  const missing=[...state.logs.map(x=>({...x,_kind:'log'})),...state.wishes.map(x=>({...x,_kind:'wish'}))]
    .filter(x=>!validCoord(x.lat,x.lng));
  $('mapUnpinnedCount').textContent=missing.length+'件';
  const list=$('mapUnpinnedList');list.replaceChildren();
  if(!missing.length){const msg=document.createElement('p');msg.className='muted';msg.textContent='未登録の場所はありません。';list.append(msg);return;}
  const fragment=document.createDocumentFragment();
  for(const x of missing.slice(0,30)){
    const row=document.createElement('div');row.className='map-unpinned-row';
    const name=document.createElement('div');name.className='map-unpinned-text';
    const strong=document.createElement('strong');strong.textContent=x.title||'名称なし';
    const small=document.createElement('small');small.textContent=(x._kind==='wish'?'行きたい場所':'思い出')+' ｜ '+(x.place||'住所未登録');
    name.append(strong,small);
    const btn=document.createElement('button');btn.className='ghost slim';btn.type='button';btn.textContent='位置を登録';btn.setAttribute('aria-label',`${x.title||'記録'}の地図位置を登録する`);
    btn.addEventListener('click',()=>openLocationPicker(x._kind,x.id));
    row.append(name,btn);fragment.append(row);
  }
  list.append(fragment);
  if(missing.length>30){const small=document.createElement('p');small.className='muted';small.textContent='残り'+(missing.length-30)+'件。まずは上の30件から位置を登録してください。';list.append(small);}
}
async function loadMap(){await loadLeaflet();if(!state.map){state.map=window.L.map('mapCanvas').setView([36.4,137.5],5);window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors',maxZoom:18}).addTo(state.map);state.map.on('click',e=>{state.pendingMapPoint=e.latlng;$('mapHint').textContent=`選択した位置：${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)} — 「＋記録」または「行きたい場所」から登録できます。`;})}setTimeout(()=>state.map.invalidateSize(),100);renderMapPins()}
function renderMapPins(){if(!state.map)return;state.pinLayer?.clearLayers();state.pinLayer=window.L.layerGroup().addTo(state.map);for(const x of [...state.logs,...state.wishes]){if(!validCoord(x.lat,x.lng))continue;const wish=state.wishes.some(w=>w.id===x.id);const color=wish&&x.status!=='visited'?'#dcaa3b':'#128b8d';const mark=window.L.circleMarker([Number(x.lat),Number(x.lng)],{radius:7,color:'#fff',weight:2,fillColor:color,fillOpacity:.98});const popup=document.createElement('div');const title=document.createElement('strong');title.textContent=x.title;popup.append(title,document.createElement('br'));const link=document.createElement('a');link.href=mapsUrl(x.place||x.title);link.target='_blank';link.rel='noopener noreferrer';link.textContent='Googleマップで開く ↗';popup.append(link);mark.bindPopup(popup);mark.addTo(state.pinLayer)}}
$('resetMap').addEventListener('click',()=>state.map?.setView([36.4,137.5],5));
function applyHeader(){
  const hero=$('heroPhoto');
  const hasPhoto=typeof state.media==='string' && state.media.startsWith('data:image/');
  hero.classList.toggle('has-photo',hasPhoto);
  // 写真を設定した場合はフィルターを重ねず、画像本来の色で表示する。
  // 未設定時は既存CSSのグラデーションへ戻る。
  hero.style.backgroundImage=hasPhoto?`url("${state.media}")`:'';
}
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
document.addEventListener('click',e=>{const b=e.target.closest('button,[data-action]');if(!b)return;if(b.dataset.close){$(b.dataset.close)?.close();return}if(b.dataset.action==='new-log'){edit('log');if(state.pendingMapPoint){$('fieldLat').value=state.pendingMapPoint.lat;$('fieldLng').value=state.pendingMapPoint.lng}}if(b.dataset.action==='new-wish'){edit('wish');if(state.pendingMapPoint){$('fieldLat').value=state.pendingMapPoint.lat;$('fieldLng').value=state.pendingMapPoint.lng}}if(b.dataset.videoId){const video=findVideoById(b.dataset.videoId);if(video)openVideoViewer(video)}
if(b.dataset.wishVideos){const wish=state.wishes.find(x=>x.id===b.dataset.wishVideos);const video=wish?.videos?.find(videoDriveId);if(video)openVideoViewer(video)}
if(b.dataset.photoPreview)openPhotoViewer(b.dataset.photoPreview);if(b.dataset.view)showVisit(b.dataset.view);if(b.dataset.editLog){if($('visitDialog').open){$('visitDialog').close();state.visitSeq++}edit('log',b.dataset.editLog)}if(b.dataset.trashLog)void moveToTrash('log',b.dataset.trashLog);if(b.dataset.trashKind&&b.dataset.trashId)void moveToTrash(b.dataset.trashKind,b.dataset.trashId);if(b.dataset.restoreKind&&b.dataset.restoreId)void restoreFromTrash(b.dataset.restoreKind,b.dataset.restoreId);if(b.dataset.editWish)edit('wish',b.dataset.editWish);if(b.dataset.stamp)stampWish(b.dataset.stamp);if(b.dataset.deleteWish)deleteWish(b.dataset.deleteWish);if(b.dataset.removeCat!==undefined)removeCat(b.dataset.removeCat,b.dataset.removeMinor)});
refreshCategoryUi();drawHeader();

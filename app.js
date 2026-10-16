import {initializeApp} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import {getAuth,GoogleAuthProvider,signInWithPopup,signOut,onAuthStateChanged,setPersistence,indexedDBLocalPersistence,browserSessionPersistence,inMemoryPersistence} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
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
const defaultCats={'観光・旅行':['観光スポット','自然・絶景','寺社・歴史','道の駅','旅館・ホテル','温泉'],'外食・グルメ':['カフェ・喫茶','和食','洋食','海鮮','ラーメン・麺類','スイーツ','中華'],'遊び・体験':['レジャー','イベント','文化体験','ドライブ'],'日常・暮らし':['買い物','家族','散歩','その他'],'宿泊':['ホテル','旅館','温泉宿']};
const state={user:null,logs:[],wishes:[],trashedLogs:[],trashedWishes:[],categories:structuredClone(defaultCats),media:null,tab:'home',unsubs:[],map:null,leafletPromise:null,pendingMapPoint:null,headerImg:null,headerX:0,headerY:0,headerZoom:1,headerBaseScale:1,photoCache:new Map(),headerPhotoIndex:null,visitSeq:0,toastTimer:null,loaded:{logs:false,wishes:false}};
const alertMsg=(message,bad=false)=>{let el=$('toast');el.textContent=message;el.style.background=bad?'#963d40':'#193d58';el.classList.remove('hidden');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.add('hidden'),4200)};
const syncInfo=s=>{$('syncState').textContent=s};
const friendlyErr=e=>{const c=e?.code||'',m=e?.message||String(e);if(c.includes('permission-denied'))return '保存権限がありません。FirestoreルールとGoogleアカウントを確認してください。';if(c.includes('offline')||c.includes('unavailable'))return '通信に接続できません。ネットワークを確認してください。';if(c.includes('popup'))return 'Googleログインが開けません。Chromeで開いて、ポップアップの許可を確認してください。';return m.slice(0,180)};
const dateSort=(arr,which='date',dir='new')=>[...arr].sort((a,b)=>dir==='new'?String(b[which]||b.createdAt||'').localeCompare(String(a[which]||a.createdAt||'')):String(a[which]||a.createdAt||'').localeCompare(String(b[which]||b.createdAt||'')));
const categoriesWithHistory=()=>{const cats=structuredClone(state.categories);if(!cats['人生の出来事'])cats['人生の出来事']=['家族','仕事','挑戦','転機・節目','その他'];for(const item of [...state.logs,...state.wishes]){const maj=item.major||'その他',min=item.minor||'';if(!cats[maj])cats[maj]=[];if(min&&!cats[maj].includes(min))cats[maj].push(min)}return cats};
function optionList(select,items,first=''){const current=select.value;select.replaceChildren();if(first){select.add(new Option(first,''))}items.forEach(x=>select.add(new Option(x,x)));if([...select.options].some(x=>x.value===current))select.value=current}
function resetLogin(){state.user=null;state.logs=[];state.wishes=[];state.trashedLogs=[];state.trashedWishes=[];state.photoCache.clear();cardThumbnailCache.clear();state.headerPhotoIndex=null;state.visitSeq++;state.loaded={logs:false,wishes:false};for(const un of state.unsubs)try{un()}catch(_){}state.unsubs=[];$('loginPage').classList.remove('hidden');$('appPage').classList.add('hidden');$('bottomNav').classList.add('hidden');$('account').classList.add('hidden')}
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
function render(){if(!state.user)return;const logs=state.logs,wishes=state.wishes;$('statLogs').textContent=logs.length;$('statWishes').textContent=wishes.filter(x=>x.status!=='visited').length;$('statStamps').textContent=wishes.filter(x=>x.status==='visited').length;$('statPins').textContent=[...logs,...wishes].filter(x=>validCoord(x.lat,x.lng)).length;renderHome();if(state.tab==='logs')renderLogs();if(state.tab==='calendar')renderMemoryCalendar();if(state.tab==='wishes')renderWishes();if(state.tab==='settings'){renderCategories();renderTrash()}if(state.tab==='map'){if(state.map)renderMapPins();renderUnpinnedPlaces();}}
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
      <div class="entry-actions">
        ${visited?'':`<button type="button" class="ghost slim wish-mark-visit" data-stamp="${esc(x.id)}" aria-label="${esc(x.title)}に実際に行ったことを記録する">行った場合に記録する</button>`}
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
  const recent=homePlaces(5),area=$('homeRecent');
  area.innerHTML=recent.map(homeMemoryCard).join('')||empty('まだ思い出がありません。最初のよりみちを記録してみましょう。');
  scheduleCardThumbnails(area);
  $('homeWishes').innerHTML=dateSort(state.wishes.filter(x=>x.status!=='visited'),'createdAt').slice(0,2).map(cardWish).join('')||empty('行きたい場所をひとつ登録してみよう。');
}

function filtered(list,search,major){const text=search.trim().toLocaleLowerCase('ja');return list.filter(x=>(!major||x.major===major)&&(!text||[x.title,x.place,x.note,x.reason,x.groupName,x.major,x.minor].some(s=>String(s||'').toLocaleLowerCase('ja').includes(text))))}
// 検索は旧GAS移行時の大・小カテゴリを含む実際の保存値を使用。記録は変更しない。
const normCat=v=>String(v??'').trim().normalize('NFKC');
function logCategoryKey(x){return {major:normCat(x.major),minor:normCat(x.minor)}}
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
function edit(kind,id=''){const item=(kind==='log'?state.logs:state.wishes).find(x=>x.id===id);if(id&&!item){alertMsg('編集対象が見つかりません。再読み込みしてください。',true);return}$('editForm').reset();clearLocationCandidates();$('editKind').value=kind;$('editId').value=id;$('dialogTitle').textContent=id?'記録を編集':kind==='log'?'思い出を記録':'行きたい場所を登録';$('fieldTitle').value=item?.title||'';$('fieldDate').value=item?.date||item?.planDate||today();$('fieldPlace').value=item?.place||'';$('fieldNote').value=item?.note||item?.reason||'';$('fieldLat').value=item?.lat??'';$('fieldLng').value=item?.lng??'';$('fieldGroup').value=item?.groupName||'';$('fieldTrip').value=item?.tripStyle||'未定';$('fieldStatus').value=item?.status||'wish';$('statusArea').classList.toggle('hidden',kind==='log');$('fieldGroup').closest('label').classList.toggle('hidden',kind==='wish');refreshCategoryUi();$('fieldMajor').value=item?.major||Object.keys(state.categories)[0]||'外食・グルメ';updateMinor();$('fieldMinor').value=item?.minor||'';$('editError').textContent='';$('photoPending').textContent='写真を追加すると保存時に自動圧縮します。';$('saveButton').textContent=item?'変更を保存':'保存する';$('editDelete').classList.toggle('hidden',!item);$('editDelete').dataset.trashKind=kind;$('editDelete').dataset.trashId=item?.id||'';showDialog($('editDialog'))}
async function photoData(file,maxSide=1200,quality=.7){const img=await createImageBitmap(file);try{const scale=Math.min(1,maxSide/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));c.getContext('2d').drawImage(img,0,0,c.width,c.height);return c.toDataURL('image/jpeg',quality)}finally{img.close()}}
// v2.0.12: 住所を地図座標へ変換するのはユーザーが押した場合のみ。
// OpenStreetMap Nominatimを検索1回のタイミングだけ利用し、候補をユーザーが確認して選択する。
// 異なる候補・曖昧な住所を自動確定して誤ったピンを立てない。
let lastGeoRequestAt=0;
let locationSearching=false;
function clearLocationCandidates(){
  $('locationCandidates').replaceChildren();
  $('locationLookupInfo').textContent='';
}
async function lookupAddressCoordinates(){
  if(locationSearching)return;
  const raw=$('fieldPlace').value.trim();
  const name=$('fieldTitle').value.trim();
  if(!raw&&!name){$('locationLookupInfo').textContent='先に住所や場所の名前を入力してください。';return;}
  const queryText=raw||name;
  const btn=$('lookupLocation');
  clearLocationCandidates();
  btn.disabled=true;locationSearching=true;
  try{
    const pause=Math.max(0,1100-(Date.now()-lastGeoRequestAt));
    if(pause)await new Promise(resolve=>setTimeout(resolve,pause));
    const params=new URLSearchParams({q:queryText,format:'jsonv2',limit:'5',addressdetails:'1','accept-language':'ja'});
    lastGeoRequestAt=Date.now();
    const response=await fetch('https://nominatim.openstreetmap.org/search?'+params.toString(),{headers:{Accept:'application/json'},referrerPolicy:'strict-origin-when-cross-origin'});
    if(!response.ok)throw Error('検索サービスに接続できません（'+response.status+'）。時間をおいて再試行してください。');
    const places=await response.json();
    if(!Array.isArray(places)||!places.length){$('locationLookupInfo').textContent='位置が見つかりません。都道府県・市区町村を含めて住所を入力し直すか、地図をタップして位置を指定してください。';return;}
    $('locationLookupInfo').textContent=`候補${places.length}件。正しい場所を選んでください。選択しても「保存する」を押すまで記録は変更されません。`;
    for(const item of places){
      const lat=Number(item.lat),lng=Number(item.lon);
      if(!validCoord(lat,lng))continue;
      const candidate=document.createElement('button');candidate.type='button';candidate.className='location-candidate';
      const label=document.createElement('span');label.textContent=String(item.display_name||'候補地点').slice(0,250);
      const coordinates=document.createElement('small');coordinates.textContent=lat.toFixed(5)+', '+lng.toFixed(5);
      candidate.append(label,coordinates);
      candidate.addEventListener('click',()=>{
        $('fieldLat').value=String(lat);$('fieldLng').value=String(lng);
        $('locationCandidates').querySelectorAll('button').forEach(el=>el.classList.toggle('selected',el===candidate));
        $('locationLookupInfo').textContent='✓ 地図の位置を選択しました。「保存する」で確定してください。';
      });
      $('locationCandidates').append(candidate);
    }
  }catch(e){
    $('locationLookupInfo').textContent='検索に失敗しました: '+friendlyErr(e);
  }finally{btn.disabled=false;locationSearching=false;}
}
$('lookupLocation').addEventListener('click',lookupAddressCoordinates);
// 古い場所を編集するとき前の検索結果を残さない。
$('fieldPlace').addEventListener('input',()=>{
  clearLocationCandidates();
  // 住所を変更したら古い座標のまま保存しないよう除外する。
  $('fieldLat').value='';$('fieldLng').value='';
  $('locationLookupInfo').textContent='住所を変更したため前の地図座標を解除しました。新しい住所で位置検索してください。';
});

async function saveEdit(e){e.preventDefault();const kind=$('editKind').value,id=$('editId').value||uniqueId();const title=$('fieldTitle').value.trim();if(!title){$('editError').textContent='名前を入力してください';return}const old=(kind==='log'?state.logs:state.wishes).find(x=>x.id===id)||{};const lat=$('fieldLat').value,lng=$('fieldLng').value;if((lat||lng)&&!validCoord(lat,lng)){$('editError').textContent='緯度・経度が正しくありません';return}const base={...old,id,title,major:$('fieldMajor').value,minor:$('fieldMinor').value,tripStyle:$('fieldTrip').value,place:$('fieldPlace').value.trim(),note:$('fieldNote').value.trim(),lat:lat===''?null:Number(lat),lng:lng===''?null:Number(lng),groupName:$('fieldGroup').value.trim(),updatedAt:now(),createdAt:old.createdAt||now(),photos:[...(old.photos||[])]};if(kind==='log')base.date=$('fieldDate').value||today();else {base.planDate=$('fieldDate').value;base.status=$('fieldStatus').value;base.reason=base.note;if(base.status==='visited'&&!base.visitDate)base.visitDate=today()}
const button=$('saveButton');button.disabled=true;button.textContent='保存中…';$('editError').textContent='';try{const f=[...$('fieldPhotos').files];if(f.length>10)throw new Error('一度に追加できる写真は10枚までです');for(const file of f){let dataUrl=await photoData(file,1300,.72);if(dataUrl.length>680000)dataUrl=await photoData(file,1000,.55);if(dataUrl.length>780000)throw new Error('画像を小さくできませんでした');const photoId=uniqueId();await setDoc(doc(db,'photos',photoId),{id:photoId,ownerId:id,kind,dataUrl,createdAt:now()});base.photos.push({type:'firestore',id:photoId,ref:photoId});cardThumbnailCache.delete(id)}await setDoc(doc(db,kind==='log'?'logs':'wishes',id),base);$('editDialog').close();alertMsg(validCoord(base.lat,base.lng)?'✓ 保存しました。地図ピンにも反映されます。':'✓ 保存しました。地図ピンは住所から位置を検索すると表示されます。')}catch(ex){$('editError').textContent='保存できません: '+friendlyErr(ex);alertMsg('保存エラー',true)}finally{button.disabled=false;button.textContent='保存する'}}
$('editForm').addEventListener('submit',saveEdit);$('fieldPhotos').addEventListener('change',()=>{$('photoPending').textContent=[...$('fieldPhotos').files].map(f=>f.name).join('、')||'写真を追加できます'});
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
  body.innerHTML=`<p><strong>${esc(dateText(x.date))}</strong>　${esc(x.major||'')}/${esc(x.minor||'')}</p><p class="entry-note">${esc(x.note||'（感想なし）')}</p>${x.place?`<p><a href="${mapsUrl(x.place)}" target="_blank" rel="noopener noreferrer">📍 Googleマップで開く ↗</a></p>`:''}<h3>この日の写真</h3><div id="visitPhotos" class="photo-strip"><p class="muted">写真を確認しています…</p></div>`;
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
        const btn=document.createElement('button');btn.type='button';btn.className='photo-thumb-button';btn.setAttribute('aria-label','写真を大きく見る');const im=document.createElement('img');im.src=uri;im.alt='訪問時の写真';im.className='photo-thumb';btn.append(im);btn.addEventListener('click',()=>openPhotoViewer(x.id,String(photo.id||photo.ref||'')));el.replaceWith(btn);
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
  const x=state.logs.find(log=>String(log.id)===String(logId));if(!x)return;
  const dialog=$('photoViewerDialog');const seq=++viewerState.seq;
  viewerState.title=x.title||'思い出';viewerState.photos=[];viewerState.index=0;
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
  if(!found.length){dialog.close();if(!$('visitDialog').open)showVisit(logId);return}
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
    const btn=document.createElement('button');btn.className='ghost slim';btn.type='button';btn.textContent='位置を登録';
    btn.addEventListener('click',()=>edit(x._kind,x.id));
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
document.addEventListener('click',e=>{const b=e.target.closest('button,[data-action]');if(!b)return;if(b.dataset.close){$(b.dataset.close)?.close();return}if(b.dataset.action==='new-log'){edit('log');if(state.pendingMapPoint){$('fieldLat').value=state.pendingMapPoint.lat;$('fieldLng').value=state.pendingMapPoint.lng}}if(b.dataset.action==='new-wish'){edit('wish');if(state.pendingMapPoint){$('fieldLat').value=state.pendingMapPoint.lat;$('fieldLng').value=state.pendingMapPoint.lng}}if(b.dataset.photoPreview)openPhotoViewer(b.dataset.photoPreview);if(b.dataset.view)showVisit(b.dataset.view);if(b.dataset.editLog){if($('visitDialog').open){$('visitDialog').close();state.visitSeq++}edit('log',b.dataset.editLog)}if(b.dataset.trashLog)void moveToTrash('log',b.dataset.trashLog);if(b.dataset.trashKind&&b.dataset.trashId)void moveToTrash(b.dataset.trashKind,b.dataset.trashId);if(b.dataset.restoreKind&&b.dataset.restoreId)void restoreFromTrash(b.dataset.restoreKind,b.dataset.restoreId);if(b.dataset.editWish)edit('wish',b.dataset.editWish);if(b.dataset.stamp)stampWish(b.dataset.stamp);if(b.dataset.deleteWish)deleteWish(b.dataset.deleteWish);if(b.dataset.removeCat!==undefined)removeCat(b.dataset.removeCat,b.dataset.removeMinor)});
refreshCategoryUi();drawHeader();

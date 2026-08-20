const BUILD_VERSION = '5.3.0';
const app = document.querySelector('#app');
let mode = 'home';
let roomCode = localStorage.getItem('tp_room') || '';
let hostToken = localStorage.getItem('tp_host') || '';
let clientId = localStorage.getItem('tp_client') || '';
let state = null;
let lanUrl = '';
let timer = null;
let soundOn = true;
let musicOn = false;
let audioCtx = null;
let musicTimer = null;
let lastPhase = null;
let seenReactions = new Set();
let hostDraftProducer = '';
let hostDraftPresenterId = '';
let hostDraftPresenterName = '';
let hostSetupName = localStorage.getItem('tp_hostname') || '';
const ART_LIBRARY = window.TP_ART_LIBRARY || [];
let producerDraftArtId = '';
let producerDraftKey = '';
let artCategory = 'recommended';
let hostControlsTimer = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const api = async (url, options={}) => {
  const res = await fetch(url, { headers:{'Content-Type':'application/json'}, ...options });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};
const post = (url, body) => api(url, {method:'POST', body:JSON.stringify(body)});

function beep(freq=440,dur=.08,type='sine',vol=.04){
  if(!soundOn) return;
  audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();
  const now=audioCtx.currentTime;
  const o=audioCtx.createOscillator(), g=audioCtx.createGain();
  o.frequency.value=freq; o.type=type; g.gain.value=vol; o.connect(g); g.connect(audioCtx.destination);
  o.start(now); g.gain.exponentialRampToValueAtTime(.001,now+dur); o.stop(now+dur);
}
function chord(freqs,dur=.18,type='triangle',vol=.02,delay=0){ freqs.forEach((f,i)=>setTimeout(()=>beep(f,dur,type,vol), delay + i*8)); }
function revealSound(){ chord([262,330,392],.16,'square',.024); setTimeout(()=>chord([523,659],.18,'triangle',.026),110) }
function applause(){ [[330,392],[392,494],[523,659]].forEach((c,i)=>setTimeout(()=>chord(c,.22,'triangle',.025),i*130)); }
function performanceSting(){ chord([294,370,440],.14,'triangle',.02); setTimeout(()=>chord([440,554,659],.16,'sine',.02),120); }
function catSting(){ beep(180,.12,'sawtooth',.02); setTimeout(()=>beep(140,.15,'square',.02),100); setTimeout(()=>beep(520,.18,'triangle',.03),220); }
function startMusicLoop(kind='lobby'){
  clearTimeout(musicTimer);
  if(!musicOn || !soundOn) return;
  audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();
  const loops={
    lobby:{notes:[262,330,392,330,294,349,440,349], dur:.12, gap:310, type:'triangle', vol:.012},
    think:{notes:[392,440,392,330,392,440,494,523], dur:.09, gap:260, type:'sine', vol:.01},
    vote:{notes:[220,247,262,247,220,196,220,247], dur:.11, gap:350, type:'square', vol:.011},
    results:{notes:[523,659,784,659,523,659,880], dur:.12, gap:280, type:'triangle', vol:.012}
  };
  const cfg=loops[kind]||loops.lobby; let i=0;
  const tick=()=>{ if(!musicOn || !soundOn) return; beep(cfg.notes[i++%cfg.notes.length],cfg.dur,cfg.type,cfg.vol); musicTimer=setTimeout(tick,cfg.gap); };
  tick();
}
function updateMusicForState(){
  if(!musicOn || !soundOn){ clearTimeout(musicTimer); return; }
  const phase = state?.phase || mode;
  const kind = ['home','hostsetup','joinsetup','lobby'].includes(phase) ? 'lobby' : phase==='intro' ? 'think' : phase==='voting' ? 'vote' : phase==='results' ? 'results' : 'off';
  if(kind==='off'){ clearTimeout(musicTimer); return; }
  if(document.body.dataset.musicKind!==kind){ document.body.dataset.musicKind=kind; startMusicLoop(kind); }
}
function toggleMusic(){
  musicOn=!musicOn;
  if(!musicOn) { clearTimeout(musicTimer); document.body.dataset.musicKind=''; }
  else updateMusicForState();
  renderSoundbar();
  updateMusicForState();
}
function renderSoundbar(){
  document.querySelector('.soundbar')?.remove();
  const el=document.createElement('div'); el.className='soundbar';
  el.innerHTML=`<button class="iconbtn" id="soundBtn" title="Sound effects">${soundOn?'🔊':'🔇'}</button><button class="iconbtn" id="musicBtn" title="Music">${musicOn?'🎵':'🎶'}</button>`;
  document.body.appendChild(el);
  el.querySelector('#soundBtn').onclick=()=>{soundOn=!soundOn;if(!soundOn){musicOn=false;clearTimeout(musicTimer);document.body.dataset.musicKind='';}renderSoundbar();updateMusicForState();};
  el.querySelector('#musicBtn').onclick=toggleMusic;
}

function shell(content, wide=false){
  const subject=document.body.dataset.subject||'default';
  const label=subject==='games'?'GAME DEV':subject==='film'?'TV + FILM':subject==='esports'?'ESPORTS':subject==='sports'?'SPORTS':'TALKING POINTS';
  app.innerHTML=`<div class="themeChrome" aria-hidden="true"><div class="chromeTop"><span>${label}</span><b>LIVE</b></div><div class="chromeMark">${subjectIcon(subject)}</div><div class="chromeGrid"></div></div><main class="shell"><section class="card stageEnter ${wide?'wide':''}">${content}</section></main>`;
  renderSoundbar();
}
function wakeHostControls(sticky=false){
  const dock=document.querySelector('.hostControlDock');
  if(!dock) return;
  dock.classList.add('awake');
  clearTimeout(hostControlsTimer);
  if(!sticky) hostControlsTimer=setTimeout(()=>dock.classList.remove('awake'),4200);
}
function hostControlDock(s, nextLabel='', nextDisabled=false){
  if(!['intro','presenting','voting'].includes(s.phase)) return '';
  let main='';
  if(s.phase==='intro'){
    main=`<button class="dockBtn dockCat" id="catDock" disabled title="Cat is available after the first reveal">🐱 CAT</button><button class="dockBtn dockPrimary" id="next" ${s.introChoiceReady?'':'disabled'}>${s.introChoiceReady?'REVEAL FIRST SURPRISE':'WAITING FOR PRODUCER…'}</button>`;
  } else if(s.phase==='presenting'){
    main=`<button class="dockBtn dockCat" id="catOverride">🐱 CAT</button><button class="dockBtn dockPrimary" id="next" ${nextDisabled?'disabled':''}>${esc(nextLabel)}</button>`;
  } else if(s.phase==='voting'){
    main=`<button class="dockBtn dockPrimary" id="results">SHOW RESULTS</button>`;
  }
  return `<div class="hostControlDock"><button class="controlWake" id="controlWake" title="Show controls">🎛️ CONTROLS</button><div class="dockTray"><div class="dockStatus"><span>${s.phase==='presenting'?`SLIDE ${s.slideNumber}/${s.totalSlides||4}`:s.phase==='intro'?'READY CHECK':'VOTING'}</span>${s.phase==='presenting'&&s.slideNumber<(s.totalSlides||4)?`<b class="${s.nextChoiceReady?'ready':''}">${s.nextChoiceReady?'● NEXT READY':'○ PRODUCER WORKING'}</b>`:''}</div>${main}<button class="dockBtn dockGhost" id="fullscreenBtn">⛶ FULLSCREEN</button><button class="dockBtn dockExit" id="exitGame">↩ EXIT GAME</button><div class="dockHints"><span>SPACE Next</span><span>C Cat</span><span>F Fullscreen</span></div></div></div>`;
}
function hostExitChip(s){
  if(!s || s.phase==='lobby' || s.phase==='results') return '';
  return `<button class="hostExitChip" id="hostExitChip" title="Close this room and return to the start screen">↩ START / EXIT GAME</button>`;
}

function toggleFullscreen(){
  if(!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(()=>{});
  else document.exitFullscreen?.().catch(()=>{});
}

function showError(msg){
  const old=document.querySelector('.err'); if(old)old.remove();
  const el=document.createElement('div'); el.className='err'; el.textContent=msg;
  document.querySelector('.card')?.prepend(el);
  setTimeout(()=>el.remove(),5000);
}
function imageHtml(img, className='slideimg'){
  if(img?.kind==='text') return '';
  const fallback = `/assets/${esc(img?.fallback || 'teacher-cat.svg')}`;
  return `<img class="${className}" src="${esc(img?.url||fallback)}" alt="${esc(img?.title||'Mystery slide')}" loading="eager" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${fallback}';this.classList.add('fallback')">`;
}
function imageCredit(img){
  if(!img?.sourcePage) return '';
  return `<a class="credit" href="${esc(img.sourcePage)}" target="_blank" rel="noopener">ⓘ ${esc(img.title)} · ${esc(img.credit)} · ${esc(img.license)}</a>`;
}
function playerOptions(players, selected, includeCustom=false){
  const first = includeCustom ? `<option value="">Custom / not joined</option>` : `<option value="">Choose producer…</option>`;
  return first + (players||[]).map(p=>`<option value="${esc(p.id)}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('');
}

function home(){
  mode='home'; stopPoll();
  setTheme('default','home','home');
  shell(`<div class="heroMark">🎤</div><div class="gameshowKicker">CLASSROOM GAMESHOW</div><h1 class="logo">TALKING <span>POINTS</span></h1><p class="sub">One screen. One host. Present, improvise and survive the Producer.</p><div class="grid"><button class="btn big" id="host">🎬 Host / Projector</button><button class="btn alt big" id="join">📱 Join as player</button></div><div class="featureline"><span>🎮 Games Dev</span><span>🎥 TV & Film</span><span>🕹️ Esports</span><span>⚽ Sports</span><span>✍️ Write</span><span>🎨 Draw</span><span>🎭 Performance bonus</span></div>`);
  document.querySelector('#host').onclick=hostSetup;
  document.querySelector('#join').onclick=joinSetup;
}
function hostSetup(){
  mode='hostsetup';
  setTheme('default','setup','hostsetup');
  shell(`<div class="topbar"><div><div class="label">New game</div><h2 class="topic compact">Set up the room</h2></div><button class="btn ghost" id="back">Back</button></div><div class="stack"><div><div class="label">Host / teacher name <span class="tiny">(optional)</span></div><input class="field" id="hostName" maxlength="24" autocomplete="off" placeholder="e.g. Dits" value="${esc(hostSetupName)}" /></div><div class="apiSetup"><div class="label">Surprise mode</div><p class="tiny">This build is fully classroom-safe and self-contained: the Producer creates surprises with <b>Write</b>, <b>Draw</b> or <b>Act</b>. No web image search is used.</p></div><div class="label">Choose the subject</div><div class="grid"><button class="btn big" data-sub="games">🎮 Games Development</button><button class="btn alt big" data-sub="film">🎥 TV & Film</button><button class="btn big" data-sub="esports">🕹️ Esports</button><button class="btn alt big" data-sub="sports">⚽ Sports</button></div><p class="tiny">The host name is shown on the room screen and can be picked as Presenter, but the Producer must be on a joined phone. 🛡️ Strict classroom language filtering is always on.</p></div>`);
  document.querySelector('#back').onclick=home;
  document.querySelectorAll('[data-sub]').forEach(b=>b.onclick=async()=>{
    try{
      hostSetupName=document.querySelector('#hostName')?.value.trim()||'';
      if(hostSetupName) localStorage.setItem('tp_hostname',hostSetupName); else localStorage.removeItem('tp_hostname');
      const d=await post('/api/rooms',{subject:b.dataset.sub,hostName:hostSetupName});
      roomCode=d.code; hostToken=d.hostToken; clientId='';
      localStorage.setItem('tp_room',roomCode); localStorage.setItem('tp_host',hostToken); localStorage.removeItem('tp_client');
      state=d.state; mode='host'; hostDraftProducer=''; hostDraftPresenterId=''; hostDraftPresenterName='';
      await loadInfo(); renderHost(); startPoll(); beep(520,.1,'triangle');
    }catch(e){showError(e.message)}
  });
}
async function loadInfo(){ try{const d=await api('/api/info');const hosted=location.protocol==='https:';lanUrl=hosted?location.origin:(d.lanUrls?.[0]||location.origin)}catch{lanUrl=location.origin} }
function joinSetup(prefillCode=''){
  mode='joinsetup'; stopPoll();
  setTheme('default','join','joinsetup');
  shell(`<div class="topbar"><div><div class="label">Join room</div><h2 class="topic compact">Grab a phone</h2></div><button class="btn ghost" id="back">Back</button></div><div class="stack"><div><div class="label">Room code</div><input class="field codefield" id="code" maxlength="4" autocomplete="off" autocapitalize="characters" value="${esc(prefillCode)}" /></div><div><div class="label">Your name</div><input class="field" id="name" maxlength="24" autocomplete="off" placeholder="e.g. Jamie" /></div><button class="btn big" id="joinRoom">Join room</button><p class="tiny">The host chooses who presents and who secretly controls the slides each round.</p></div>`);
  document.querySelector('#back').onclick=home;
  document.querySelector('#joinRoom').onclick=joinRoom;
  document.querySelector('#code').addEventListener('keydown',e=>{if(e.key==='Enter')document.querySelector('#name').focus()});
  document.querySelector('#name').addEventListener('keydown',e=>{if(e.key==='Enter')joinRoom()});
}
async function joinRoom(){
  const code=document.querySelector('#code').value.trim().toUpperCase();
  const name=document.querySelector('#name').value.trim();
  if(code.length!==4) return showError('Enter the 4-character room code.');
  if(!name) return showError('Enter your name.');
  try{
    const d=await post('/api/join',{code,name});
    roomCode=code; clientId=d.clientId; hostToken='';
    localStorage.setItem('tp_room',roomCode); localStorage.setItem('tp_client',clientId); localStorage.removeItem('tp_host');
    state=d.state; mode='player'; history.replaceState({},'',location.pathname); renderPlayer(); startPoll(); beep(540,.09,'triangle');
  }catch(e){showError(e.message)}
}

function subjectLabel(subject){
  return ({games:'🎮 Games Dev', film:'🎥 TV & Film', esports:'🕹️ Esports', sports:'⚽ Sports'})[subject] || '🎮 Games Dev';
}

function subjectIcon(subject){
  return ({games:'🎮', film:'🎥', esports:'🕹️', sports:'⚽'})[subject] || '🎤';
}
function setTheme(subject='default', phase='home', screen='home'){
  document.body.dataset.subject=subject;
  document.body.dataset.phase=phase;
  document.body.dataset.screen=screen;
}

function normaliseLobbyDraft(s){
  const players=s.players||[];
  const ids=players.map(p=>p.id);
  if(hostDraftProducer && !ids.includes(hostDraftProducer)) hostDraftProducer='';
  if(hostDraftPresenterId && hostDraftPresenterId!=='__HOST__' && !ids.includes(hostDraftPresenterId)) hostDraftPresenterId='';

  // With one phone and a named host, use Host + phone for a painless demo.
  if(ids.length === 1 && !hostDraftPresenterId && !hostDraftPresenterName){
    if(s.hostName) hostDraftPresenterId='__HOST__';
    else hostDraftPresenterName='Test Presenter';
  }
  // With a class, follow the server's rotation suggestion.
  if(ids.length >= 2 && !hostDraftPresenterId && !hostDraftPresenterName){
    hostDraftPresenterId=s.nextPresenterId||ids[0];
  }
  if(!hostDraftProducer && ids.length){
    hostDraftProducer=s.nextProducerId||ids.find(id=>id!==hostDraftPresenterId)||ids[0];
  }
  if(ids.length >= 2 && hostDraftPresenterId===hostDraftProducer){
    hostDraftProducer=ids.find(id=>id!==hostDraftPresenterId)||hostDraftProducer;
  }
}
function presenterOptions(s, selected){
  const players=s.players||[];
  let html='<option value="">Choose presenter…</option>';
  if(s.hostName) html+=`<option value="__HOST__" ${selected==='__HOST__'?'selected':''}>🎬 ${esc(s.hostName)} (Host)</option>`;
  html+=players.map(p=>`<option value="${esc(p.id)}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('');
  return html;
}
function introSecondsLeft(s){
  const start=Number(s.introStartedAt||0); if(!start) return 60;
  return Math.max(0, 60 - Math.floor((Date.now()-start)/1000));
}
function introCountdownHtml(s){
  const left=introSecondsLeft(s);
  return `<div class="introTimer"><div class="label">Thinking time</div><div class="voteBig">${left}s</div><div class="tiny">Give the presenter a moment to think before the first image appears.</div></div>`;
}

function renderJoinQr(url){
  const el=document.querySelector('#joinQr');
  if(!el || typeof QRCode==='undefined') return;
  el.innerHTML='';
  try{
    new QRCode(el,{text:url,width:220,height:220,colorDark:'#000000',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
  }catch(e){
    el.innerHTML='<div class="tiny">QR unavailable — use the join address below.</div>';
  }
}

function renderHost(){
  if(!state)return;
  const s=state; setTheme(s.subject,s.phase,'host'); normaliseLobbyDraft(s);
  const joinBase=lanUrl||location.origin;
  const joinLink=`${joinBase}/?room=${encodeURIComponent(s.code)}`;
  const header=`<div class="topbar"><div class="row"><span class="pill majorpill">ROOM ${esc(s.code)}</span><span class="pill subjectpill">${subjectIcon(s.subject)} ${subjectLabel(s.subject)}</span>${s.hostName?`<span class="pill">🎬 ${esc(s.hostName)}</span>`:''}<span class="pill">👥 ${s.counts.total}</span><span class="pill ${s.locked?'lockedpill':''}">${s.locked?'🔒 Locked':'🔓 Open'}</span><span class="pill enginepill">✨ ${esc(s.imageEngine||'Write + draw + performance bonus')}</span><span class="pill">🛡️ Language filter ON</span><span class="pill buildpill">V${BUILD_VERSION}</span></div><button class="btn ghost" id="quit">Exit</button></div>`;
  let body='';
  if(s.phase==='lobby'){
    const players=(s.players||[]);
    const presenterControl = `<div><div class="label">Presenter</div><select class="field" id="presenterId">${presenterOptions(s,hostDraftPresenterId)}</select></div>`;
    body=`<div class="broadcastMast"><div><span class="broadcastEyebrow">${subjectIcon(s.subject)} ${subjectLabel(s.subject)}</span><h2>ROOM ${esc(s.code)}</h2></div><div class="broadcastLive"><i></i> WAITING FOR PLAYERS</div></div><div class="hostgrid"><div><div class="joinHero"><div><div class="label">Join code</div><div class="roomcode">${esc(s.code)}</div><div class="label">Scan to join</div><div id="joinQr" class="joinQr" aria-label="QR code to join room"></div></div><div class="joinHelp"><b>Scan → enter your name → join</b><div class="tiny">The room code is filled in automatically.</div></div></div><div class="label">Manual join address</div><div class="joinurl">${esc(joinBase)}</div><div class="row roomControls"><button class="btn ghost" id="toggleLock">${s.locked?'🔓 Unlock joining':'🔒 Lock joining'}</button><button class="btn ghost actionToggle ${s.allowActions?'on':''}" id="toggleActions">${s.allowActions?'🎭 Performance bonus ON':'🎭 Performance bonus OFF'}</button><button class="btn ghost" id="randomPair" ${players.length<2?'disabled':''}>🎲 Randomise pair</button></div><div class="label playerLabel">Connected</div><div class="playerchips">${players.length?players.map(p=>`<span>${esc(p.name)}</span>`).join(''):'<em>Waiting for students…</em>'}</div></div><div class="stack setupPanel">${presenterControl}<div><div class="label">Producer</div><select class="field" id="producerId">${playerOptions(players,hostDraftProducer,false)}</select></div><div class="tiny"><b>Next up:</b> ${esc(s.nextPresenterName||'')} presents, ${esc(s.nextProducerName||'')} creates the surprises. After each round, the Producer moves into the Presenter spot so everyone gets turns.</div><button class="btn big" id="start" ${players.length?'':'disabled'}>START PRESENTATION</button><p class="tiny">Starting a presentation automatically locks new joins. Unlock it here if somebody arrives late.</p></div></div>`;
  } else if(s.phase==='intro'){
    body=`<div class="introShow"><div class="roleReveal presenterReveal"><span>🎤 PRESENTER</span><strong>${esc(s.presenter)}</strong></div><div class="introCentre"><div class="showTitleLabel">TONIGHT'S PRESENTATION</div><div class="introPresentationTitle">${esc(s.topic)}</div><div class="introMeta">${introCountdownHtml(s)}<div class="producerStatus ${s.introChoiceReady?'ready':''}">${s.introChoiceReady?'🔥 SURPRISE LOCKED IN':'🎛️ PRODUCER IS COOKING…'}</div></div></div><div class="roleReveal producerReveal"><span>🎛️ PRODUCER</span><strong>${esc(s.producerName||'Secret')}</strong></div></div>${hostControlDock(s)}`;
  } else if(s.phase==='choosing'){
    body=`<div class="presenter">${esc(s.presenter)} presents · slide ${s.slideNumber} / ${s.totalSlides||4}</div><div class="presentationTopic"><span>Presentation:</span> ${esc(s.topic)}</div><div class="stageTitle stageBanner">${esc(s.stageLabel||'NEXT SLIDE')}</div><div class="waiting producerwait broadcastWait"><div class="spinner"></div><div class="waitHeadline">PRODUCER IS COOKING…</div><span class="tiny">${esc(s.producerName||'The producer')} is preparing the next surprise.</span><div class="reactionTotals">${reactionTotals(s)}</div></div>`;
  } else if(s.phase==='presenting' && s.revealed){
    const last=s.slideNumber===(s.totalSlides||4);
    const ready=!!s.nextChoiceReady;
    const nextLabel=last?'Open voting':ready?'NEXT SLIDE — READY':'PRODUCER PREPARING NEXT…';
    body=`<div class="presenter spotlight">${esc(s.presenter)} presents</div><div class="presentationTopic projectorTitle"><span>Presentation:</span> ${esc(s.topic)}</div><div class="stageTitle stageBanner">${esc(s.stageLabel||'')}</div><div class="questionFrame"><div class="questionNumber">${String(s.slideNumber).padStart(2,'0')}</div><div class="projectorQuestion">${esc(s.revealed.prompt)}</div></div><div class="visualReveal broadcastVisual">${revealedVisual(s)}</div>${performanceReveal(s)}<div class="reactionTotals">${reactionTotals(s)}</div>${last?'':`<div class="tiny ${ready?'done':''}">${ready?'✅ Next surprise is locked and ready':'🎛️ '+esc(s.producerName||'Producer')+' is preparing the next surprise now'}</div>`}${hostControlDock(s,nextLabel,(!last&&!ready))}`;
  } else if(s.phase==='voting'){
    body=`<div class="presenter">${esc(s.presenter)}</div><div class="gameshowKicker">THE VERDICT</div><div class="topic">Audience voting is open</div><div class="waiting"><div class="voteBig">${s.voteCount}</div><b>complete vote${s.voteCount===1?'':'s'}</b></div>${hostControlDock(s)}`;
  } else if(s.phase==='results'){
    body=`<div class="resultsShow"><div class="gameshowKicker">🏆 ROUND RESULTS</div><div class="presenter resultPresenter">${esc(s.presenter)}</div><div class="topic">The audience has spoken</div><div class="results"><div class="resultCard medal"><div class="medalIcon">😂</div><span>FUNNIEST</span><strong>${Number(s.result?.funny||0).toFixed(1)}</strong></div><div class="resultCard medal heroMedal"><div class="medalIcon">🧠</div><span>CONVINCING</span><strong>${Number(s.result?.convincing||0).toFixed(1)}</strong></div><div class="resultCard medal"><div class="medalIcon">🔥</div><span>RECOVERY</span><strong>${Number(s.result?.recovery||0).toFixed(1)}</strong></div></div><div class="overall overallScore"><span>ROUND SCORE</span><b>${Number(s.result?.overall||0).toFixed(1)} ★</b><small>${s.result?.votes||0} complete vote${s.result?.votes===1?'':'s'}</small></div><div class="overall overallScore bonusScore"><span>🎭 PERFORMANCE BONUS</span><b>+${Number(s.result?.performanceBonus||0).toFixed(1)} ★</b><small>Reward for fully committing to the challenge</small></div><div class="overall overallScore finalScore"><span>FINAL SCORE</span><b>${Number(s.result?.finalOverall||s.result?.overall||0).toFixed(1)} ★</b></div><div class="centre"><button class="btn big" id="again">NEXT ROUND</button></div></div>`;
  }
  if(s.phase!=='lobby' && s.phase!=='results') body = hostExitChip(s) + body;
  shell(header+body,true);
  if(s.phase==='lobby') renderJoinQr(joinLink);
  bindHostEvents();
}
function reactionTotals(s){
  const t=s.reactionTotals||{}; return ['😂','💀','👏','🔥'].map(e=>`<span>${e} ${t[e]||0}</span>`).join('');
}
function bindHostEvents(){
  document.querySelector('#controlWake')?.addEventListener('click',()=>wakeHostControls(true));
  document.querySelector('#fullscreenBtn')?.addEventListener('click',()=>{toggleFullscreen();wakeHostControls();});
  if(document.querySelector('.hostControlDock')) setTimeout(()=>wakeHostControls(),80);
  const exitGame=async()=>{
    if(!confirm('Exit this game and close the room for everyone?')) return;
    try{ if(roomCode&&hostToken) await post('/api/host/close',{code:roomCode,hostToken}); }catch{}
    localStorage.removeItem('tp_host'); localStorage.removeItem('tp_room');
    hostToken=''; roomCode=''; state=null; history.replaceState({},'',location.pathname); home();
  };
  document.querySelector('#quit')?.addEventListener('click',exitGame);
  document.querySelector('#exitGame')?.addEventListener('click',exitGame);
  document.querySelector('#hostExitChip')?.addEventListener('click',exitGame);
  const psel=document.querySelector('#producerId'); if(psel) psel.onchange=()=>hostDraftProducer=psel.value;
  const prsel=document.querySelector('#presenterId'); if(prsel) prsel.onchange=()=>{ hostDraftPresenterId=prsel.value; };
  document.querySelector('#toggleLock')?.addEventListener('click',async()=>{try{state=await post('/api/host/lock',{code:roomCode,hostToken,locked:!state.locked});renderHost()}catch(e){showError(e.message)}});
  document.querySelector('#toggleActions')?.addEventListener('click',async()=>{try{state=await post('/api/host/actions',{code:roomCode,hostToken,enabled:!state.allowActions});renderHost()}catch(e){showError(e.message)}});
  document.querySelector('#randomPair')?.addEventListener('click',()=>{
    const players=state?.players||[]; if(players.length<2)return;
    const shuffled=[...players].sort(()=>Math.random()-.5);
    hostDraftPresenterId=shuffled[0].id; hostDraftPresenterName=''; hostDraftProducer=shuffled[1].id;
    renderHost(); beep(620,.08,'triangle');
  });
  document.querySelector('#start')?.addEventListener('click',async()=>{
    const btn=document.querySelector('#start');
    try{
      if(btn){ btn.disabled=true; btn.textContent='STARTING…'; }
      hostDraftProducer=document.querySelector('#producerId')?.value||hostDraftProducer;
      hostDraftPresenterId=document.querySelector('#presenterId')?.value||'';
      hostDraftPresenterName='';
      state=await post('/api/host/start',{code:roomCode,hostToken,producerId:hostDraftProducer,presenterId:hostDraftPresenterId,presenterName:''});
      seenReactions.clear(); renderHost();
    }catch(e){
      if(btn){ btn.disabled=false; btn.textContent='START PRESENTATION'; }
      showError('Could not start: '+e.message);
    }
  });
  document.querySelector('#catOverride')?.addEventListener('click',async()=>{const b=document.querySelector('#catOverride');try{if(b){b.disabled=true;b.textContent='🐱 CAT!';}state=await post('/api/host/cat',{code:roomCode,hostToken});beep(720,.08,'triangle');setTimeout(()=>beep(900,.1,'triangle'),80);renderHost()}catch(e){showError(e.message);renderHost()}});
  document.querySelector('#next')?.addEventListener('click',async()=>{const b=document.querySelector('#next');try{if(b){b.disabled=true;b.textContent=(state?.phase==='intro'?'REVEALING…':state?.slideNumber===(state?.totalSlides||4)?'OPENING VOTING…':'REVEALING NEXT…');}state=await post('/api/host/next',{code:roomCode,hostToken});beep(390,.08,'square');renderHost()}catch(e){showError(e.message);renderHost()}});
  document.querySelector('#results')?.addEventListener('click',async()=>{try{state=await post('/api/host/results',{code:roomCode,hostToken});applause();renderHost()}catch(e){showError(e.message)}});
  document.querySelector('#again')?.addEventListener('click',async()=>{try{state=await post('/api/host/lobby',{code:roomCode,hostToken});hostDraftPresenterId='';hostDraftPresenterName='';hostDraftProducer='';renderHost()}catch(e){showError(e.message)}});
}

function reactionButtons(s, meRole='audience'){
  const bonus = s.performanceChallenge && meRole!=='presenter' ? `<button class="react nailedit ${s.ownPerformanceVote?'done':''}" id="nailedIt" ${s.ownPerformanceVote?'disabled':''}>🎭 NAILED IT</button>` : '';
  return `<div class="reactbox"><div class="tiny">LIVE REACTIONS</div><div class="reactrow">${['😂','💀','👏','🔥'].map(e=>`<button class="react" data-react="${e}">${e}</button>`).join('')}${bonus}</div></div>`;
}
function ratingRow(label,key,own){
  const selected=Number(own?.[key]||0);
  return `<div class="ratingBlock"><div class="ratingLabel">${label}</div><div class="ratingButtons">${[1,2,3,4,5].map(n=>`<button class="rate ${selected===n?'selected':''}" data-category="${key}" data-rating="${n}">${n}<span>★</span></button>`).join('')}</div></div>`;
}
function subjectArtCategory(subject){ return ({games:'games',film:'film',esports:'esports',sports:'sports'})[subject] || 'games'; }
function syncProducerDraft(s){
  const key=`${s.roundId||''}:${s.producerTargetSlide||s.slideNumber||1}`;
  if(key!==producerDraftKey){ producerDraftKey=key; producerDraftArtId=''; artCategory='recommended'; }
}
function artScore(asset,s){
  const hay=`${s.topic||''} ${s.currentPrompt||''}`.toLowerCase();
  const words=new Set(hay.replace(/[^a-z0-9]+/g,' ').split(/\s+/).filter(x=>x.length>2));
  let score=asset.category===subjectArtCategory(s.subject)?8:0;
  if(asset.category==='chaos') score+=1.5;
  for(const tag of asset.tags||[]) if(words.has(String(tag).toLowerCase())) score+=5;
  if((asset.tags||[]).some(tag=>hay.includes(String(tag).toLowerCase()))) score+=2;
  return score;
}
function artItemsFor(s,cat){
  if(cat==='recommended') return [...ART_LIBRARY].sort((a,b)=>artScore(b,s)-artScore(a,s) || a.title.localeCompare(b.title)).slice(0,12);
  if(cat==='subject') return ART_LIBRARY.filter(a=>a.category===subjectArtCategory(s.subject));
  return ART_LIBRARY.filter(a=>a.category===cat);
}
function renderArtCards(s,cat=artCategory){
  const items=artItemsFor(s,cat);
  return `<button type="button" class="artCard artNone ${!producerDraftArtId?'selected':''}" data-art-id=""><span>🚫</span><b>No image</b></button>` + items.map(a=>`<button type="button" class="artCard ${producerDraftArtId===a.id?'selected':''}" data-art-id="${esc(a.id)}"><img src="${esc(a.url)}" alt="${esc(a.title)}"><b>${esc(a.title)}</b></button>`).join('');
}
function artPicker(s){
  const tabs=[['recommended','✨ Recommended'],['subject',`${subjectIcon(s.subject)} ${subjectLabel(s.subject)}`],['faces','🙂 Faces'],['creatures','🐾 Creatures'],['objects','📦 Objects'],['chaos','💥 Chaos'],['games','🎮 Games'],['film','🎥 Film'],['esports','🕹️ Esports'],['sports','⚽ Sports']];
  return `<div class="artPanel"><div class="modeTitle artMode">🖼️ IMAGE CARD</div><div class="label">Optional local sticker art</div><div class="tiny">Pick something relevant, or deliberately ridiculous. These are bundled with the app — no web search.</div><div class="artTabs">${tabs.map(([id,label])=>`<button type="button" class="artTab ${artCategory===id?'selected':''}" data-art-cat="${id}">${label}</button>`).join('')}</div><div class="artGrid">${renderArtCards(s)}</div></div>`;
}
function producerCreatePanel(s, first=false){
  syncProducerDraft(s);
  const actionBits=s.allowActions?`<div class="actionPanel"><div class="modeTitle actMode">🎭 BONUS PERFORMANCE CHALLENGE</div><div class="label">Optional extra chaos</div><div class="tiny">Choose how the Presenter has to deliver their answer. This is optional and is locked together with the surprise.</div><div class="actionSuggestions">${(s.actionSuggestions||[]).map(x=>`<button class="actionChip" data-action="${esc(x)}">${esc(x)}</button>`).join('')}</div><input class="field" id="actionText" maxlength="180" autocomplete="off" placeholder="e.g. Answer like a furious football manager"/></div>`:'';
  return `<div class="producerQuestion"><div class="tiny">${first?'FIRST SURPRISE':esc(s.producerStageLabel||'NEXT SLIDE')}</div><div class="producerPrompt">${esc(s.currentPrompt||'')}</div></div>
  <div class="builderIntro"><b>BUILD THE SURPRISE</b><span>Pick an image, add text, draw — use one or combine them. Nothing is sent until Lock In.</span></div>
  <div class="producerModes">
    ${artPicker(s)}
    <div class="textFallback"><div class="modeTitle writeMode">✍️ TEXT</div><div class="label">Optional caption / surprise text</div><textarea class="field surpriseTextarea" id="surpriseText" maxlength="180" placeholder="e.g. the club’s cursed new signing"></textarea></div>
    <div class="drawPanel"><div class="modeTitle drawMode">🎨 DRAW</div><div class="label">Optional drawing</div><div class="tiny">Use your finger, stylus or mouse. Image + caption + doodle is absolutely allowed.</div><canvas id="surpriseCanvas" width="720" height="480" aria-label="Draw the surprise"></canvas><div class="drawActions"><button class="btn ghost" id="clearDrawing">Clear drawing</button></div></div>
    ${actionBits}
    <button class="btn big lockSurprise" id="lockSurprise">🔒 LOCK IN SURPRISE</button>
    <div class="tiny lockHint">Use at least an image, text or a drawing. The performance challenge is optional.</div>
  </div>`;
}

function revealedVisual(s){
  if(s.revealed?.kind==='text') return `<div class="textSurprise"><span class="quoteMark">“</span>${esc(s.revealed.text||s.revealed.title||'')}<span class="quoteMark end">”</span></div>`;
  if(s.revealed?.kind==='drawing') return `<div class="drawingBoard"><div class="tape tape1"></div><div class="tape tape2"></div><img class="slideimg drawingReveal" src="${esc(s.revealed.url||'')}" alt="Producer drawing"></div>`;
  if(s.revealed?.kind==='combo') return `<div class="comboReveal"><div class="comboCaption"><span>PRODUCER SAYS</span><strong>${esc(s.revealed.text||'')}</strong></div><div class="drawingBoard comboBoard"><div class="tape tape1"></div><div class="tape tape2"></div><img class="slideimg drawingReveal" src="${esc(s.revealed.url||'')}" alt="Producer drawing"></div></div>`;
  if(s.revealed?.kind==='artBuilder'){
    const caption=s.revealed.text?`<div class="comboCaption artCaption"><span>PRODUCER SAYS</span><strong>${esc(s.revealed.text)}</strong></div>`:'';
    const art=s.revealed.artUrl?`<div class="artRevealCard"><img src="${esc(s.revealed.artUrl)}" alt="${esc(s.revealed.artTitle||'Producer image card')}"><b>${esc(s.revealed.artTitle||'')}</b></div>`:'';
    const draw=s.revealed.drawingUrl?`<div class="drawingBoard artDrawing"><div class="tape tape1"></div><div class="tape tape2"></div><img class="slideimg drawingReveal" src="${esc(s.revealed.drawingUrl)}" alt="Producer drawing"></div>`:'';
    return `<div class="artBuilderReveal">${caption}<div class="artBuilderMedia">${art}${draw}</div></div>`;
  }
  return `${imageHtml(s.revealed)}${imageCredit(s.revealed)}`;
}
function performanceReveal(s){
  if(!s.performanceChallenge) return '';
  return `<div class="actionReveal bonusReveal"><div class="curtain curtainLeft"></div><div class="curtain curtainRight"></div><div class="actionKicker">🎭 BONUS PERFORMANCE CHALLENGE</div><div class="actionText">${esc(s.performanceChallenge.text||'')}</div><div class="bonusMeter"><span>NAILED IT votes: <b>${Number(s.performanceVoteCount||0)}</b> / ${Number(s.performanceTarget||0)}</span><span>Round bonus so far: <b>+${Number(s.performanceBonus||0).toFixed(1)} ★</b></span></div></div>`;
}

function renderPlayer(){
  if(!state)return; const s=state; const me=s.me||{}; setTheme(s.subject,s.phase,'player');
  const roleLabel=me.role==='producer'?'🎛️ Producer':me.role==='presenter'?'🎤 Presenter':'👀 Audience';
  const header=`<div class="topbar"><div class="row"><span class="pill majorpill">ROOM ${esc(s.code)}</span><span class="pill subjectpill">${subjectIcon(s.subject)} ${subjectLabel(s.subject)}</span><span class="pill">${roleLabel}</span></div><button class="btn ghost" id="leave">Leave</button></div>`;
  let body='';
  if(s.phase==='lobby'){
    body=`<div class="gameshowKicker">READY TO PLAY</div><div class="topic">You’re in.</div><div class="waiting">Waiting for the host to start.<br><br><b>${esc(me.name||'Player')}</b><p class="tiny">You could be picked as Presenter or Producer next.</p></div>`;
  } else if(s.phase==='intro'){
    if(me.role==='presenter') body=`<div class="presenter">You’re presenting</div><div class="topic">${esc(s.topic)}</div>${introCountdownHtml(s)}<div class="waiting presenterPhone">Take a minute to think. The Producer is secretly preparing the first surprise now.</div>`;
    else if(me.role==='producer') {
      if(s.introSelected) body=`<div class="presenter">You are the producer</div><div class="topic">${esc(s.topic)}</div>${introCountdownHtml(s)}<div class="waiting done">✅ Surprise ready. Keep it secret — the host will reveal it when ready. Optional bonus challenge saved if you added one.</div>`;
      else body=`<div class="presenter">You are the Producer · FIRST SURPRISE</div><div class="presentationTopic mobileTopic"><span>Presentation:</span> ${esc(s.topic)}</div>${producerCreatePanel(s,true)}`;
    }
    else body=`<div class="presenter">${esc(s.presenter)}</div><div class="topic">${esc(s.topic)}</div>${introCountdownHtml(s)}<div class="waiting">The presenter is thinking while the Producer secretly prepares the first surprise.</div>`;
  } else if(me.role==='producer' && s.phase==='choosing'){
    body=`<div class="presenter">You are the Producer · preparing slide ${s.producerTargetSlide||s.slideNumber}</div><div class="presentationTopic mobileTopic"><span>Presentation:</span> ${esc(s.topic)}</div>${producerCreatePanel(s,false)}`;
  } else if(me.role==='producer' && s.phase==='presenting' && s.slideNumber<(s.totalSlides||4)){
    if(s.nextSelected) body=`<div class="presenter">You are the Producer</div><div class="topic">Next surprise ready ✅</div><div class="waiting done">Slide ${s.producerTargetSlide||s.slideNumber+1} is locked. Keep it secret. As soon as the host advances, you can prepare the following slide.</div>`;
    else body=`<div class="presenter">You are the Producer · PREPARE SLIDE ${s.producerTargetSlide||s.slideNumber+1}</div><div class="presentationTopic mobileTopic"><span>While ${esc(s.presenter)} is talking:</span> choose the next surprise now.</div>${producerCreatePanel(s,false)}`;
  } else if(me.role==='presenter' && ['choosing','presenting'].includes(s.phase)){
    body=`<div class="presenter">You’re presenting</div><div class="topic">${esc(s.topic)}</div><div class="waiting presenterPhone">Don’t look for clues here. 👀<br><br>Eyes on the projector.</div>`;
  } else if(s.phase==='presenting'){
    body=`<div class="presenter">${esc(s.presenter)}</div><div class="topic">${esc(s.topic)}</div><div class="waiting">Watch the big screen 👀</div>${reactionButtons(s,me.role)}`;
  } else if(s.phase==='choosing'){
    body=`<div class="presenter">${esc(s.presenter)}</div><div class="topic">${esc(s.topic)}</div><div class="waiting">${esc(s.producerName||'The producer')} is choosing the next slide…</div>${reactionButtons(s,me.role)}`;
  } else if(s.phase==='voting'){
    if(me.role==='presenter') body=`<div class="topic">Your fate is sealed.</div><div class="waiting">The audience is rating your performance. 😈</div>`;
    else {
      const complete=['funny','convincing','recovery'].every(k=>Number(s.ownVote?.[k])>=1);
      body=`<div class="presenter">Rate ${esc(s.presenter)}</div><div class="topic">How did they survive?</div><div class="ratings">${ratingRow('😂 Funniest','funny',s.ownVote)}${ratingRow('🧠 Most convincing','convincing',s.ownVote)}${ratingRow('🔥 Best recovery','recovery',s.ownVote)}</div><div class="voteStatus ${complete?'done':''}">${complete?'✓ Vote complete — you can still change it.':'Rate all three to complete your vote.'}</div>`;
    }
  } else if(s.phase==='results'){
    body=`<div class="topic">${Number(s.result?.finalOverall||s.result?.overall||0).toFixed(1)} ★ final</div><div class="results mobile"><div class="resultCard"><span>😂</span><strong>${Number(s.result?.funny||0).toFixed(1)}</strong></div><div class="resultCard"><span>🧠</span><strong>${Number(s.result?.convincing||0).toFixed(1)}</strong></div><div class="resultCard"><span>🔥</span><strong>${Number(s.result?.recovery||0).toFixed(1)}</strong></div><div class="resultCard"><span>🎭</span><strong>+${Number(s.result?.performanceBonus||0).toFixed(1)}</strong></div></div><div class="waiting smallwait">Waiting for the next round.</div>`;
  }
  shell(header+body,true);
  bindPlayerEvents();
}
function bindPlayerEvents(){
  document.querySelector('#leave')?.addEventListener('click',async()=>{try{await post('/api/leave',{code:roomCode,clientId})}catch{}localStorage.removeItem('tp_client');localStorage.removeItem('tp_room');clientId='';roomCode='';home()});
  const canvas=document.querySelector('#surpriseCanvas');
  let drawingCtx=null, hasInk=false;
  if(canvas){
    const ctx=canvas.getContext('2d'); drawingCtx=ctx;
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#111111';ctx.lineWidth=10;ctx.lineCap='round';ctx.lineJoin='round';
    let drawing=false;
    const point=e=>{const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*(canvas.width/r.width),y:(e.clientY-r.top)*(canvas.height/r.height)}};
    const startDraw=e=>{e.preventDefault();drawing=true;hasInk=true;canvas.setPointerCapture?.(e.pointerId);const p=point(e);ctx.beginPath();ctx.moveTo(p.x,p.y)};
    const move=e=>{if(!drawing)return;e.preventDefault();const p=point(e);ctx.lineTo(p.x,p.y);ctx.stroke()};
    const endDraw=e=>{if(!drawing)return;e.preventDefault();drawing=false;ctx.closePath()};
    canvas.addEventListener('pointerdown',startDraw);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',endDraw);canvas.addEventListener('pointercancel',endDraw);
    document.querySelector('#clearDrawing')?.addEventListener('click',()=>{ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#111';hasInk=false});
  }
  const bindArtCards=()=>{
    document.querySelectorAll('[data-art-id]').forEach(b=>b.addEventListener('click',()=>{
      producerDraftArtId=b.dataset.artId||'';
      document.querySelectorAll('[data-art-id]').forEach(x=>x.classList.toggle('selected',(x.dataset.artId||'')===producerDraftArtId));
      beep(520,.04,'triangle',.012);
    }));
  };
  bindArtCards();
  document.querySelectorAll('[data-art-cat]').forEach(b=>b.addEventListener('click',()=>{
    artCategory=b.dataset.artCat||'recommended';
    document.querySelectorAll('[data-art-cat]').forEach(x=>x.classList.toggle('selected',x.dataset.artCat===artCategory));
    const grid=document.querySelector('.artGrid'); if(grid){grid.innerHTML=renderArtCards(state,artCategory); bindArtCards();}
  }));
  document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>{
    const input=document.querySelector('#actionText'); if(input){ input.value=b.dataset.action||''; document.querySelectorAll('[data-action]').forEach(x=>x.classList.remove('selected')); b.classList.add('selected'); }
  }));
  document.querySelector('#lockSurprise')?.addEventListener('click',async()=>{
    const text=document.querySelector('#surpriseText')?.value.trim()||'';
    const performance=document.querySelector('#actionText')?.value.trim()||'';
    if(!text && !hasInk && !producerDraftArtId) return showError('Pick an image, add some text, draw something — or combine them before locking the surprise.');
    const btn=document.querySelector('#lockSurprise');
    try{
      if(btn){btn.disabled=true;btn.textContent='🔒 LOCKING IN…'}
      const dataUrl=hasInk && canvas ? canvas.toDataURL('image/jpeg',0.72) : '';
      state=await post('/api/producer/lock',{code:roomCode,clientId,text,dataUrl,performance,assetId:producerDraftArtId});
      producerDraftArtId=''; revealSound(); renderPlayer();
    }catch(e){showError(e.message);if(btn){btn.disabled=false;btn.textContent='🔒 LOCK IN SURPRISE'}}
  });
  document.querySelectorAll('[data-react]').forEach(b=>b.onclick=async()=>{try{b.classList.add('popped');setTimeout(()=>b.classList.remove('popped'),180);await post('/api/react',{code:roomCode,clientId,emoji:b.dataset.react});beep(360,.035,'sine',.012)}catch(e){if(!/moment/i.test(e.message))showError(e.message)}});
  document.querySelector('#nailedIt')?.addEventListener('click',async()=>{try{state=await post('/api/performance',{code:roomCode,clientId});performanceSting();renderPlayer()}catch(e){showError(e.message)}});
  document.querySelectorAll('[data-category]').forEach(b=>b.onclick=async()=>{try{state=await post('/api/vote',{code:roomCode,clientId,category:b.dataset.category,rating:Number(b.dataset.rating)});beep(440+Number(b.dataset.rating)*60,.06,'triangle');renderPlayer()}catch(e){showError(e.message)}});
}

function spawnReaction(r){
  const fx=document.querySelector('#fx') || (()=>{const d=document.createElement('div');d.id='fx';document.body.appendChild(d);return d})();
  const el=document.createElement('div'); el.className='floatReaction'; el.textContent=r.emoji;
  el.style.left=`${8+Math.random()*84}%`; el.style.setProperty('--drift',`${Math.round(-80+Math.random()*160)}px`);
  fx.appendChild(el); setTimeout(()=>el.remove(),1800);
}
async function poll(){
  try{
    const q=new URLSearchParams({code:roomCode});
    if(mode==='host')q.set('hostToken',hostToken); if(mode==='player')q.set('clientId',clientId);
    const next=await api('/api/state?'+q.toString());
    const changed=JSON.stringify(next)!==JSON.stringify(state);
    if(changed){
      const newReactions = mode==='host' ? (next.reactions||[]).filter(r=>!seenReactions.has(r.id)) : [];
      if(lastPhase && next.phase!==lastPhase && next.phase==='presenting'){ revealSound(); if(next.performanceChallenge) setTimeout(performanceSting,170); }
      if(next.phase==='results' && lastPhase!=='results') applause();
      state=next; lastPhase=next.phase;
      if(mode==='host')renderHost(); else if(mode==='player')renderPlayer();
      for(const r of newReactions){seenReactions.add(r.id);spawnReaction(r)}
    }
  }catch(e){ if(e.message==='Room not found')home(); }
}
function startPoll(){stopPoll();lastPhase=state?.phase||null;seenReactions=new Set((state?.reactions||[]).map(r=>r.id));timer=setInterval(poll,750)}
function stopPoll(){if(timer)clearInterval(timer);timer=null}

document.addEventListener('pointermove',e=>{
  if(mode==='host' && state && ['intro','presenting','voting'].includes(state.phase) && e.clientY>window.innerHeight-190) wakeHostControls();
});
document.addEventListener('touchstart',e=>{
  if(mode==='host' && state && ['intro','presenting','voting'].includes(state.phase)){
    const y=e.touches?.[0]?.clientY||0; if(y>window.innerHeight-220) wakeHostControls();
  }
},{passive:true});
document.addEventListener('keydown',e=>{
  if(mode!=='host' || !state) return;
  const tag=(document.activeElement?.tagName||'').toLowerCase();
  if(['input','select','textarea'].includes(tag)) return;
  if(e.key==='f' || e.key==='F'){ e.preventDefault(); toggleFullscreen(); wakeHostControls(); return; }
  if((e.key==='c'||e.key==='C') && state.phase==='presenting'){ e.preventDefault(); document.querySelector('#catOverride')?.click(); wakeHostControls(); return; }
  if((e.code==='Space'||e.key===' ') && ['intro','presenting'].includes(state.phase)){
    const b=document.querySelector('#next'); if(b && !b.disabled){e.preventDefault();b.click();} wakeHostControls(); return;
  }
  if((e.key==='r'||e.key==='R') && state.phase==='voting'){ const b=document.querySelector('#results');if(b){e.preventDefault();b.click();} }
});

async function bootstrap(){
  const inviteCode=String(new URLSearchParams(location.search).get('room')||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);
  if(inviteCode){
    // A fresh QR invite must beat stale room/client data from an earlier lesson.
    stopPoll(); hostToken=''; clientId=''; roomCode=''; state=null;
    localStorage.removeItem('tp_host'); localStorage.removeItem('tp_client'); localStorage.removeItem('tp_room');
    joinSetup(inviteCode); return;
  }
  if(hostToken && roomCode){
    try{await loadInfo();state=await api('/api/state?'+new URLSearchParams({code:roomCode,hostToken}).toString());mode='host';renderHost();startPoll();return}catch{}
  }
  if(clientId && roomCode){
    try{state=await api('/api/state?'+new URLSearchParams({code:roomCode,clientId}).toString());if(state.me){mode='player';renderPlayer();startPoll();return}}catch{}
  }
  home();
}
bootstrap();


setInterval(()=>{
  if(state?.phase!=='intro') return;
  const el=document.querySelector('.introTimer .voteBig');
  if(el) el.textContent=`${introSecondsLeft(state)}s`;
},250);

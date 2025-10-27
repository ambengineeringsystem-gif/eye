// Viewer (caller) - creates offer and shows remote stream using Firebase Realtime Database for signaling
// IMPORTANT: Paste your Firebase config into `firebaseConfig` (see README)

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  push,
  onValue,
  onChildAdded,
  remove,
  get,
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-database.js";

// ======= FIREBASE CONFIG (embed, localStorage or paste at runtime) =======
// You can either: 1) paste your config directly into the `embeddedConfig` object below,
// 2) store it in localStorage under key 'firebaseConfig' (the UI will offer to save it),
// or 3) paste the config when prompted on page load.
const embeddedConfig = {
  apiKey: "AIzaSyB7KNURIlPW2S2J_aJdoX3c4L6BR5gma0g",
  authDomain: "secu-18771.firebaseapp.com",
  databaseURL: "https://secu-18771-default-rtdb.firebaseio.com",
  projectId: "secu-18771",
  storageBucket: "secu-18771.firebasestorage.app",
  messagingSenderId: "119665330735",
  appId: "1:119665330735:web:52bdea3a4a8aac362114da",
  measurementId: "G-GJMJJT9636"
};

function obtainFirebaseConfig() {
  // 1) use embedded if filled
  if (embeddedConfig && embeddedConfig.apiKey) return embeddedConfig;

  // 2) try localStorage
  try {
    const stored = localStorage.getItem('firebaseConfig');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && parsed.apiKey) return parsed;
    }
  } catch (e) {
    console.warn('Error reading firebaseConfig from localStorage', e);
  }

  // 3) prompt user to paste config JSON
  try {
    const raw = prompt('Firebase config not found. Paste Firebase config JSON (from Firebase console).\nExample: {"apiKey":"...","authDomain":"...","databaseURL":"https://...","projectId":"..."}');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.apiKey) {
        try { localStorage.setItem('firebaseConfig', JSON.stringify(parsed)); } catch (e) {}
        return parsed;
      }
      alert('Parsed JSON does not contain `apiKey`. Please paste a full Firebase config object.');
    }
  } catch (e) {
    alert('Invalid JSON pasted. Please try again.');
  }

  return {};
}

const firebaseConfig = obtainFirebaseConfig();

if (!firebaseConfig || !firebaseConfig.apiKey) {
  console.warn('Firebase config is empty. Provide it via the embeddedConfig, localStorage, or paste it when prompted.');
}

let app, db;
if (firebaseConfig && firebaseConfig.apiKey && (firebaseConfig.databaseURL || firebaseConfig.projectId)) {
  app = initializeApp(firebaseConfig);
  db = getDatabase(app);
} else {
  // Leave app/db undefined; createCall will show a helpful message if called.
  app = null;
  db = null;
}

const createBtn = document.getElementById('createBtn');
const hangupBtn = document.getElementById('hangupBtn');
const callIdField = document.getElementById('callId');
const remoteVideo = document.getElementById('remoteVideo');
const statusEl = document.getElementById('status');
const refreshCamsBtn = document.getElementById('refreshCams');
const cameraListDiv = document.getElementById('cameraList');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const smartDetectBtn = document.getElementById('smartDetectBtn');
const humanBoxes = document.getElementById('humanBoxes');
const linkedCamsDiv = document.getElementById('linkedCams');
const videoWrapper = document.getElementById('videoWrapper');
const sleepBanner = document.getElementById('sleepBanner');

// linked cameras stored in localStorage as array of names
let linkedCams = [];
function loadLinkedCams(){
  try{ const raw = localStorage.getItem('linkedCams'); if(raw) linkedCams = JSON.parse(raw) || []; }catch(e){ linkedCams = []; }
}
function saveLinkedCams(){ try{ localStorage.setItem('linkedCams', JSON.stringify(linkedCams)); }catch(e){} }
function renderLinkedCams(){
  if(!linkedCamsDiv) return;
  linkedCamsDiv.innerHTML = '';
  if(linkedCams.length === 0){ linkedCamsDiv.textContent = '(none)'; return; }
  linkedCams.forEach(name => {
    const d = document.createElement('div');
    d.style.marginBottom = '8px';
    const lbl = document.createElement('span'); lbl.textContent = name; lbl.style.marginRight = '8px'; d.appendChild(lbl);
    const vbtn = document.createElement('button'); vbtn.textContent = 'View'; vbtn.onclick = ()=> callCamera(name); d.appendChild(vbtn);
    const ubtn = document.createElement('button'); ubtn.textContent = 'Unlink'; ubtn.style.marginLeft='6px'; ubtn.onclick = ()=>{ linkedCams = linkedCams.filter(n=>n!==name); saveLinkedCams(); renderLinkedCams(); }; d.appendChild(ubtn);
    linkedCamsDiv.appendChild(d);
  });
}

loadLinkedCams(); renderLinkedCams();

// per-camera smart-detect preferences (persisted locally)
let smartPrefs = {};
function loadSmartPrefs(){ try{ const raw = localStorage.getItem('smartPrefs'); smartPrefs = raw ? JSON.parse(raw) : {}; }catch(e){ smartPrefs = {}; } }
function saveSmartPrefs(){ try{ localStorage.setItem('smartPrefs', JSON.stringify(smartPrefs)); }catch(e){} }
loadSmartPrefs();

// Motion overlay elements and current viewing camera name
let currentViewingName = null; // camera name we are currently viewing (for motion overlay)
const motionOverlay = document.getElementById('motionOverlay');
const motionBanner = document.getElementById('motionBanner');
const motionBox = document.getElementById('motionBox');

// Alarm related state
const alarmConfigs = {}; // cameraName -> config from DB
const alarmState = {}; // cameraName -> { lastMotionTs, lastHumanTs, lastAlarmTs }
const alarmButtons = {}; // cameraName -> DOM element for quick updates
const alarmLocks = {}; // cameraName -> { prevMotion, prevSmart, motionHandler, smartHandler }

// Modal elements
const alarmModal = document.getElementById('alarmModal');
const alarmModalTitle = document.getElementById('alarmModalTitle');
const alarmConf = document.getElementById('alarmConf');
const alarmConfVal = document.getElementById('alarmConfVal');
const alarmCooldown = document.getElementById('alarmCooldown');
const alarmArmDelay = document.getElementById('alarmArmDelay');
const alarmVoice = document.getElementById('alarmVoice');
const saveAlarmBtn = document.getElementById('saveAlarmBtn');
const cancelAlarmBtn = document.getElementById('cancelAlarmBtn');
const testAlarmBtn = document.getElementById('testAlarmBtn');
const alarmBanner = document.getElementById('alarmBanner');
let alarmModalCamera = null;

alarmConf && (alarmConf.oninput = ()=>{ if(alarmConfVal) alarmConfVal.textContent = alarmConf.value; });

function openAlarmModal(cameraName){
  alarmModalCamera = cameraName;
  if(alarmModalTitle) alarmModalTitle.textContent = 'Alarm Settings — ' + cameraName;
  const cfg = alarmConfigs[cameraName] || { mode: 'motion', minConfidence: 0.48, cooldown: 30 };
  // set radio
  Array.from(document.getElementsByName('alarmMode')).forEach(r=> r.checked = (r.value === cfg.mode));
  if(alarmConf) alarmConf.value = cfg.minConfidence || 0.48; if(alarmConfVal) alarmConfVal.textContent = alarmConf.value;
  if(alarmCooldown) alarmCooldown.value = cfg.cooldown || 30;
  if(alarmArmDelay) alarmArmDelay.value = cfg.armDelay || 0;
  if(alarmVoice) alarmVoice.checked = (cfg.voice === undefined) ? true : !!cfg.voice;
  if(alarmModal) alarmModal.style.display = 'block';
}

function closeAlarmModal(){ alarmModalCamera = null; if(alarmModal) alarmModal.style.display = 'none'; }

saveAlarmBtn && (saveAlarmBtn.onclick = async ()=>{
  if(!alarmModalCamera) return; const mode = Array.from(document.getElementsByName('alarmMode')).find(r=>r.checked).value;
  const cfg = { mode, minConfidence: parseFloat(alarmConf.value||0.48), cooldown: parseInt(alarmCooldown.value||30,10), armDelay: parseInt((alarmArmDelay && alarmArmDelay.value) || 0,10), voice: !!(alarmVoice && alarmVoice.checked) };
  try{ if(db) await set(ref(db, 'cameras/' + alarmModalCamera + '/alarmConfig'), cfg); alarmConfigs[alarmModalCamera] = cfg; status('Alarm saved for ' + alarmModalCamera); }catch(e){ console.warn('save alarm failed', e); }
  // optimistic UI: immediately update alarm button styling if present
  try{
    const btn = alarmButtons[alarmModalCamera];
    if(btn) btn.className = 'btn small warn';
  }catch(e){}
  closeAlarmModal();
});
cancelAlarmBtn && (cancelAlarmBtn.onclick = ()=> closeAlarmModal());
// Test alarm button: play the alarm locally and trigger UI banner so user can verify audio & visuals
testAlarmBtn && (testAlarmBtn.onclick = ()=>{
  if(!alarmModalCamera) {
    // still allow playing audio even if no camera selected
    triggerAlarm('test', { cfg: alarmConfigs[alarmModalCamera] || { mode: 'human' } });
    return;
  }
  triggerAlarm(alarmModalCamera, { cfg: alarmConfigs[alarmModalCamera] || { mode: 'human' } });
});

let pc;
let callId;
let callRef;
let callerCandidatesRef;
let calleeCandidatesRef;
let listeners = [];
const pendingArm = {}; // cameraName -> { timer, tick }
const cameraStatusListeners = {}; // cameraName -> offFn (for per-view listeners)
let viewerId = localStorage.getItem('viewerId') || null;
if(!viewerId){ viewerId = 'viewer-' + Math.random().toString(36).substr(2,9); localStorage.setItem('viewerId', viewerId); }

const servers = { iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ] };

createBtn && (createBtn.onclick = createCall);
hangupBtn && (hangupBtn.onclick = hangUp);
refreshCamsBtn && (refreshCamsBtn.onclick = listCameras);
fullscreenBtn && (fullscreenBtn.onclick = ()=>{
  const wrapper = document.getElementById('videoWrapper') || document.documentElement;
  if(wrapper.requestFullscreen){ wrapper.requestFullscreen(); }
  else if(wrapper.webkitRequestFullscreen){ wrapper.webkitRequestFullscreen(); }
});
// Smart human detection state
let smartModel = null;
let smartDetecting = false;
let smartInterval = null;
let lastHumanPredictions = null;
let lastHumanTs = 0;
const humanHoldMs = 6000; // keep last boxes visible for this long when detections drop
let detectionScoreThreshold = 0.48; // slightly lower to be more sensitive to static people

smartDetectBtn && (smartDetectBtn.onclick = async () => {
  if(!currentViewingName){ alert('Start viewing a camera first to enable Smart Detect'); return; }
  if(!smartDetecting){
    // start
    if(smartDetectBtn) smartDetectBtn.disabled = true;
    status('Loading human-detection model...');
    try{
      await loadCocoModel();
  startSmartDetect();
  smartDetectBtn && (smartDetectBtn.textContent = 'Smart Detect: ON');
    }catch(e){ console.warn('model load failed', e); alert('Failed to load detection model'); }
    if(smartDetectBtn) smartDetectBtn.disabled = false;
  } else {
    // stop
    stopSmartDetect();
    smartDetectBtn && (smartDetectBtn.textContent = 'Smart Detect: OFF');
  }
});

// start listing cameras immediately (if db initialized)
setTimeout(()=>{ try{ listCameras(); }catch(e){} }, 500);

function status(msg){ statusEl.textContent = msg; }

// Load TFJS and coco-ssd dynamically (UMD builds) if not already loaded
async function loadCocoModel(){
  if(window.cocoSsd && smartModel) return smartModel;
  // load tfjs first
  if(!window.tf){
    await new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js';
      s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
    });
  }
  // then coco-ssd
  if(!window.cocoSsd){
    await new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco-ssd.min.js';
      s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
    });
  }
  // load model
  smartModel = await window.cocoSsd.load();
  return smartModel;
}

function clearHumanBoxes(){ if(!humanBoxes) return; humanBoxes.innerHTML = ''; }

function renderHumanBoxes(predictions){
  if(!humanBoxes) return;
  humanBoxes.innerHTML = '';
  const vid = document.getElementById('remoteVideo');
  if(!vid || !vid.videoWidth) return;
  const wr = vid.getBoundingClientRect();
  const scaleX = wr.width / vid.videoWidth;
  const scaleY = wr.height / vid.videoHeight;

  // filter for person predictions above threshold
  const persons = (predictions || []).filter(p => p.class === 'person' && p.score >= detectionScoreThreshold);
  const now = Date.now();
  if(persons.length > 0){
    // got fresh detections — render and cache
    lastHumanPredictions = persons;
    lastHumanTs = now;
    // If we just rendered person boxes, also run alarm evaluation (ensures visual detections and alarm logic stay in sync)
    try{ if(currentViewingName){ maybeTriggerAlarm(currentViewingName, { humans: persons, ts: now }); } }catch(e){ console.warn('alarm check from renderHumanBoxes failed', e); }
  } else {
    // no fresh detections — if we have a recent cache, reuse it for a short hold period
    if(lastHumanPredictions && (now - lastHumanTs) <= humanHoldMs){
      // use cached predictions but render with reduced opacity
      persons.push(...lastHumanPredictions);
    } else {
      // nothing to show
      return;
    }
  }

  // Render person boxes (avoid duplicates if cached appended)
  const unique = [];
  persons.forEach(p => {
    // simple de-dup by bbox center
    const key = Math.round(p.bbox[0]) + ':' + Math.round(p.bbox[1]) + ':' + Math.round(p.bbox[2]) + ':' + Math.round(p.bbox[3]);
    if(unique.find(u=>u.key===key)) return; unique.push({key,p});
  });

  unique.forEach(u => {
    const p = u.p;
    const [x,y,wid,hei] = p.bbox; // pixels relative to video natural size
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.left = (x * scaleX) + 'px';
    el.style.top = (y * scaleY) + 'px';
    el.style.width = (wid * scaleX) + 'px';
    el.style.height = (hei * scaleY) + 'px';
    el.style.border = '3px solid rgba(0,200,255,0.95)';
    el.style.boxShadow = '0 0 12px rgba(0,200,255,0.5)';
    el.style.zIndex = 20;
    // if using cached (stale) predictions, reduce opacity
    if(now - lastHumanTs > 0 && (now - lastHumanTs) <= humanHoldMs && !(predictions && predictions.find(q=>q === p))){
      el.style.opacity = '0.55';
      el.style.border = '3px dashed rgba(0,200,255,0.75)';
    }
    humanBoxes.appendChild(el);
  });
}

function startSmartDetect(){
  if(!smartModel) return; if(smartDetecting) return; smartDetecting = true; status('Smart detect ON');
  clearHumanBoxes();
  const detectLoop = async ()=>{
    try{
      const vid = document.getElementById('remoteVideo');
      if(!vid || !vid.videoWidth) return;
      const preds = await smartModel.detect(vid);
      renderHumanBoxes(preds);
      // alarm check from human detection (only when viewing a camera)
      try{
        if(currentViewingName){
          const persons = (preds || []).filter(p => p.class === 'person' && p.score >= 0.01);
          if(persons.length > 0){
            maybeTriggerAlarm(currentViewingName, { humans: persons, ts: Date.now() });
          }
        }
      }catch(e){ console.warn('alarm check human failed', e); }
    }catch(e){ console.warn('detection tick failed', e); }
  };
  // run immediately then on interval
  detectLoop();
  smartInterval = setInterval(detectLoop, 700);
}

function stopSmartDetect(){
  smartDetecting = false; clearHumanBoxes(); if(smartInterval){ clearInterval(smartInterval); smartInterval = null; }
  status('Smart detect OFF');
}

async function createCall(){
  if(createBtn) createBtn.disabled = true;
  status('Creating peer connection...');

  if(!db){
    status('Firebase not initialized. Please provide a Firebase config (you will be prompted or store it in localStorage under key "firebaseConfig").');
    if(createBtn) createBtn.disabled = false;
    return;
  }

  pc = new RTCPeerConnection(servers);

  // show remote stream
  const remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  // Ensure viewer requests media from the remote side by adding recvonly transceivers
  try{
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }catch(e){ console.warn('Transceiver add failed (older browser?)', e); }

  pc.ontrack = event => {
    event.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    try{
      // show video unless the camera is currently marked as sleeping; the camera-status listener will hide the video when standby=true
      if(sleepBanner && sleepBanner.style.display === 'block'){
        // do not show video while sleeping
        try{ remoteVideo.style.display = 'none'; }catch(e){}
      } else {
        if(videoWrapper) videoWrapper.style.display = 'block';
        try{ remoteVideo.style.display = 'block'; }catch(e){}
      }
    }catch(e){}
  };

  // gather local ICE candidates and push to DB under callerCandidates
  pc.onicecandidate = event => {
    if(!event.candidate) return;
    push(callerCandidatesRef, event.candidate.toJSON());
  };

  // create a random callId
  callId = Math.random().toString(36).substr(2,9);
  if(callIdField) callIdField.value = callId;
  callRef = ref(db, 'calls/' + callId);
  callerCandidatesRef = ref(db, 'calls/' + callId + '/callerCandidates');
  calleeCandidatesRef = ref(db, 'calls/' + callId + '/calleeCandidates');

  // create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // write offer to DB
  await set(ref(db, 'calls/' + callId + '/offer'), pc.localDescription.toJSON());
  status('Offer written to database.');

  // listen for answer (apply only once and only when pc is in the expected state)
  const ansListener = onValue(ref(db, 'calls/' + callId + '/answer'), async snap => {
    const val = snap.val();
    if(!val) return;
    try{
      status('Answer received. Applying remote description...');
      // Only apply an answer if we are expecting one (we set a local offer earlier)
      if(pc && pc.signalingState === 'have-local-offer'){
        await pc.setRemoteDescription(val);
        status('Remote description set. Connection should complete soon.');

        // start listening for callee candidates
        const candsListener = onChildAdded(calleeCandidatesRef, snapshot => {
          const cand = snapshot.val();
          if(cand){
            pc.addIceCandidate(cand).catch(e => console.warn('Error adding callee candidate', e));
          }
        });
        listeners.push(candsListener);

  if(hangupBtn) hangupBtn.disabled = false;

        // remove this answer listener; it's no longer needed
        try{ ansListener(); }catch(e){}
      } else {
        console.warn('Answer arrived but PC not in have-local-offer (state=' + (pc?pc.signalingState:'no-pc') + '); skipping');
      }
    }catch(e){
      // If setRemoteDescription fails because of timing/state, ignore to avoid uncaught exceptions
      console.warn('Failed to set remote description for call answer:', e);
    }
  });
  listeners.push(ansListener);
}

// Call a named camera by creating a session at /sessions
async function callCamera(cameraName){
  if(!db){ status('Firebase not initialized.'); return; }
  if(createBtn) createBtn.disabled = true;
  status('Creating session to camera: ' + cameraName);

  // mark current viewing camera
  currentViewingName = cameraName;

  pc = new RTCPeerConnection(servers);

  const remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  pc.ontrack = event => {
    event.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    try{ if(videoWrapper) videoWrapper.style.display = 'block'; }catch(e){}
  };

  // Ensure viewer requests media from the remote side by adding recvonly transceivers
  try{
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }catch(e){ console.warn('Transceiver add failed (older browser?)', e); }

  // prepare candidate refs once session created
  const sessionRef = push(ref(db, 'sessions'));
  const sessionId = sessionRef.key;
  const callerCandsRefLocal = ref(db, 'sessions/' + sessionId + '/callerCandidates');
  const calleeCandsRefLocal = ref(db, 'sessions/' + sessionId + '/calleeCandidates');
  callerCandidatesRef = callerCandsRefLocal; calleeCandidatesRef = calleeCandsRefLocal;

  pc.onicecandidate = event => { if(!event.candidate) return; push(callerCandidatesRef, event.candidate.toJSON()); };

  // listen for camera status (standby/sleep) so we can show a "SLEEPING" message instead of the video
  try{
    const camStatusRef = ref(db, 'cameras/' + cameraName);
    const camStatusOff = onValue(camStatusRef, snap => {
      const v = snap.val();
      const standby = v && v.standby;
      try{
        if(standby){
          if(videoWrapper) videoWrapper.style.display = 'block';
          if(remoteVideo) remoteVideo.style.display = 'none';
          if(sleepBanner) sleepBanner.style.display = 'block';
        } else {
          if(sleepBanner) sleepBanner.style.display = 'none';
          if(remoteVideo) remoteVideo.style.display = 'block';
        }
      }catch(e){}
    });
    listeners.push(camStatusOff);
    cameraStatusListeners[cameraName] = camStatusOff;
  }catch(e){ console.warn('camera status listen failed', e); }

  // create offer and write session object with offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await set(sessionRef, { from: viewerId, target: cameraName, offer: pc.localDescription.toJSON(), created: Date.now() });
  if(callIdField) callIdField.value = sessionId;
  status('Session created — waiting for camera answer...');

  // wait for answer
  const ansListener = onValue(ref(db, 'sessions/' + sessionId + '/answer'), async snap => {
    const val = snap.val();
    if(!val) return;
    try{
  status('Answer received');
      if(pc && pc.signalingState === 'have-local-offer'){
        await pc.setRemoteDescription(val);

        // listen for callee ICE
        const candsListener = onChildAdded(ref(db, 'sessions/' + sessionId + '/calleeCandidates'), snapshot => {
          const cand = snapshot.val(); if(cand) pc.addIceCandidate(cand).catch(e => console.warn('addIce failed', e));
        });
        listeners.push(candsListener);

  if(hangupBtn) hangupBtn.disabled = false;

        // if smart pref for this camera is enabled, start smart detect now
        try{
          if(smartPrefs[cameraName]){
            await loadCocoModel(); startSmartDetect(); smartDetectBtn && (smartDetectBtn.textContent = 'Smart Detect: ON');
          }
        }catch(e){ console.warn('auto-start smart detect failed', e); }

        // remove this one-time answer listener
        try{ ansListener(); }catch(e){}
      } else {
        console.warn('Session answer arrived but PC not in have-local-offer (state=' + (pc?pc.signalingState:'no-pc') + '); skipping');
      }
    }catch(e){
      console.warn('Failed to set remote description for session answer:', e);
    }
  });
  listeners.push(ansListener);
}

async function hangUp(){
  if(hangupBtn) hangupBtn.disabled = true;
  status('Hanging up and cleaning database entry...');

  // clear current viewing camera
  currentViewingName = null;
  // stop smart detection if running
  try{ stopSmartDetect(); smartDetectBtn && (smartDetectBtn.textContent = 'Smart Detect: OFF'); }catch(e){}

  // remove listeners
  listeners.forEach(u => { try{ u(); }catch(e){} });
  listeners = [];

  try{ pc && pc.close(); }catch(e){}
  pc = null;

  try{ if(videoWrapper) { videoWrapper.style.display = 'none'; } }catch(e){}
  try{ if(sleepBanner) sleepBanner.style.display = 'none'; }catch(e){}
  try{ remoteVideo.srcObject = null; }catch(e){}

  // remove database call object
  if(callId){
    await remove(ref(db, 'calls/' + callId));
    status('Call removed from database. Done.');
  } else {
    // maybe this was a session-based call
    const possibleSession = callIdField && callIdField.value && callIdField.value.trim();
      if(possibleSession){ await remove(ref(db, 'sessions/' + possibleSession)); status('Session removed'); }
  }

  if(createBtn) createBtn.disabled = false;
  if(callIdField) callIdField.value = '';
}

// List registered cameras from /cameras and render clickable buttons
function listCameras(){
  if(!db){ if(cameraListDiv) cameraListDiv.textContent = 'No database connection'; return; }
  cameraListDiv.innerHTML = 'Loading...';
  const camsRef = ref(db, 'cameras');
  // use onValue to keep list live
  const off = onValue(camsRef, snap => {
    const data = snap.val() || {};
    cameraListDiv.innerHTML = '';
    const names = Object.keys(data).sort();
    if(names.length === 0){ cameraListDiv.textContent = '(no registered cameras)'; return; }
    names.forEach(n => {
      const info = data[n];
      const row = document.createElement('div');
      row.className = 'camera-row';
      row.style.marginBottom = '8px';

      // left: name + device info
      const leftDiv = document.createElement('div'); leftDiv.className = 'cam-left';
      const nameLabel = document.createElement('div'); nameLabel.className = 'name';
      nameLabel.textContent = n + (info && info.online ? ' • online' : ' • offline');
      leftDiv.appendChild(nameLabel);

      // show device info if available
      if(info && info.device){
        const di = document.createElement('div'); di.className = 'device-info';
        const label = info.device.cameraLabel || info.device.cameraDeviceId || '';
        const platform = info.device.platform || '';
        di.textContent = (label? label + ' — ':'') + platform;
        leftDiv.appendChild(di);
      }

      // groups container: Wake/Sleep, Motion/Smart, Alarm/Settings
      const groupsDiv = document.createElement('div'); groupsDiv.className = 'cam-groups';
      const groupWake = document.createElement('div'); groupWake.className = 'cam-group cam-group-wake';
      const groupMotion = document.createElement('div'); groupMotion.className = 'cam-group cam-group-motion';
      const groupAlarm = document.createElement('div'); groupAlarm.className = 'cam-group cam-group-alarm';
      groupsDiv.appendChild(groupWake); groupsDiv.appendChild(groupMotion); groupsDiv.appendChild(groupAlarm);

      // right side actions (link)
      const rightDiv = document.createElement('div'); rightDiv.className = 'cam-actions-right';

      // assemble row
      row.appendChild(leftDiv);
      row.appendChild(groupsDiv);
      row.appendChild(rightDiv);

  const wakeAndViewBtn = document.createElement('button');
  wakeAndViewBtn.className = 'btn small primary';
  wakeAndViewBtn.textContent = 'Wake & View';
  wakeAndViewBtn.onclick = async () => {
        if(!db){ alert('No DB'); return; }
        try{ await set(ref(db, 'cameras/' + n + '/wake'), Date.now()); status('Wake sent to ' + n + ' — waiting a moment...'); }catch(e){ console.warn('wake failed', e); }
        // give the camera a moment to prompt for permissions and start
        setTimeout(()=>{ callCamera(n); }, 900);
      };
  groupWake.appendChild(wakeAndViewBtn);

  const sleepBtn = document.createElement('button');
  sleepBtn.className = 'btn small warn';
  sleepBtn.textContent = 'Sleep';
  sleepBtn.onclick = async () => {
        if(!db){ alert('No DB'); return; }
        try{
          // mark camera as standby (sleep)
          await set(ref(db, 'cameras/' + n), { online: true, standby: true, lastSeen: Date.now() });
          status('Sleep command sent to ' + n);
        }catch(e){ console.warn('sleep failed', e); }
      };
  groupWake.appendChild(sleepBtn);

  const motionBtn = document.createElement('button');
  motionBtn.className = (info && info.motionEnabled) ? 'btn small toggle-on' : 'btn small';
  motionBtn.textContent = (info && info.motionEnabled) ? 'Motion: ON' : 'Motion: OFF';
  motionBtn.onclick = async () => {
        if(!db){ alert('No DB'); return; }
        try{
          const newVal = !(info && info.motionEnabled);
          await set(ref(db, 'cameras/' + n + '/motionEnabled'), newVal);
          motionBtn.textContent = newVal ? 'Motion: ON' : 'Motion: OFF';
          status('Motion ' + (newVal ? 'enabled' : 'disabled') + ' for ' + n);
        }catch(e){ console.warn('motion toggle failed', e); }
      };
  groupMotion.appendChild(motionBtn);

      // Quick Arm/Disarm toggle (shows and writes /cameras/<name>/alarmArmed)
      try{
        const armBtn = document.createElement('button');
        armBtn.className = 'btn small';
        armBtn.textContent = 'Arm';
        let armedTs = null;
        // listen for remote armed state
        const armedRef = ref(db, 'cameras/' + n + '/alarmArmed');
        const armedOff = onValue(armedRef, snapA => {
          const v = snapA.val();
          armedTs = v || null;
          if(v){
            armBtn.textContent = 'Armed'; armBtn.className = 'btn small toggle-on';
            // lock controls when external arm occurs
            try{ const cfgx = alarmConfigs[n] || {}; lockControls(n, cfgx, motionBtn, smartBtn); }catch(e){}
          } else {
            armBtn.textContent = 'Arm'; armBtn.className = 'btn small';
            // unlock controls when external disarm occurs
            try{ unlockControls(n, motionBtn, smartBtn); }catch(e){}
          }
        });
        listeners.push(armedOff);

        armBtn.onclick = async () => {
          if(!db){ alert('No DB'); return; }
          try{
            if(armedTs){ // currently armed -> disarm
              // cancel any pending arm timers
              if(pendingArm[n]){ try{ clearTimeout(pendingArm[n].timer); clearInterval(pendingArm[n].tick); }catch(e){} delete pendingArm[n]; }
              await set(ref(db, 'cameras/' + n + '/alarmArmed'), null);
              status('Alarm disarmed for ' + n);
              // reset cooldown so alarms can fire immediately
              if(alarmState[n]) alarmState[n].lastAlarmTs = 0;
              // unlock any controls that were forced by arming
              try{ unlockControls(n, motionBtn, smartBtn); }catch(e){}
            } else {
              // arm with optional delay
              const cfg = alarmConfigs[n] || {};
              const armDelay = Number(cfg.armDelay || 0);
              if(armDelay > 0){
                // start a countdown and schedule the arm
                let remaining = armDelay;
                armBtn.disabled = true;
                armBtn.textContent = 'Arming: ' + remaining + 's';
                const tick = setInterval(()=>{
                  remaining -= 1;
                  if(remaining <= 0){ clearInterval(tick); }
                  else { try{ armBtn.textContent = 'Arming: ' + remaining + 's'; }catch(e){} }
                }, 1000);
                const timer = setTimeout(async ()=>{
                  try{
                    await set(ref(db, 'cameras/' + n + '/alarmArmed'), Date.now());
                    status('Alarm armed for ' + n);
                    if(alarmState[n]) alarmState[n].lastAlarmTs = 0;
                    // lock controls according to saved alarmConfig
                    try{ lockControls(n, cfg, motionBtn, smartBtn); }catch(e){}
                  }catch(e){ console.warn('arm failed', e); }
                  try{ clearInterval(tick); }catch(e){}
                  delete pendingArm[n];
                  try{ armBtn.disabled = false; armBtn.textContent = 'Armed'; armBtn.className = 'btn small toggle-on'; }catch(e){}
                }, armDelay * 1000);
                pendingArm[n] = { timer, tick };
                // add a cleanup entry so timers get cleared when listeners removed
                listeners.push(()=>{ try{ if(pendingArm[n]){ clearTimeout(pendingArm[n].timer); clearInterval(pendingArm[n].tick); delete pendingArm[n]; armBtn.disabled=false; armBtn.textContent='Arm'; } }catch(e){} });
              } else {
                await set(ref(db, 'cameras/' + n + '/alarmArmed'), Date.now());
                status('Alarm armed for ' + n);
                if(alarmState[n]) alarmState[n].lastAlarmTs = 0;
                // immediate arm: lock controls per config
                try{ lockControls(n, cfg, motionBtn, smartBtn); }catch(e){}
              }
            }
          }catch(e){ console.warn('arm toggle failed', e); }
        };
  groupAlarm.appendChild(armBtn);
      }catch(e){ console.warn('quick arm button failed', e); }

  const smartBtn = document.createElement('button');
  const pref = !!smartPrefs[n];
  smartBtn.className = pref ? 'btn small toggle-on' : 'btn small';
  smartBtn.textContent = pref ? 'Smart: ON' : 'Smart: OFF';
  smartBtn.onclick = async () => {
        const newVal = !smartPrefs[n];
        smartPrefs[n] = newVal;
        saveSmartPrefs();
        smartBtn.textContent = newVal ? 'Smart: ON' : 'Smart: OFF';
        status('Smart detect ' + (newVal ? 'enabled' : 'disabled') + ' for ' + n);
        // if we are currently viewing this camera, start/stop detection immediately
        if(currentViewingName === n){
          if(newVal){
            try{ await loadCocoModel(); startSmartDetect(); smartDetectBtn && (smartDetectBtn.textContent = 'Smart Detect: ON'); }catch(e){ console.warn('start smart failed', e); }
          } else { stopSmartDetect(); smartDetectBtn && (smartDetectBtn.textContent = 'Smart Detect: OFF'); }
        }
      };
  groupMotion.appendChild(smartBtn);

      // Link/unlink button to pin this camera for quick access
  const linkBtn = document.createElement('button');
  linkBtn.className = 'btn small ghost';
  linkBtn.textContent = linkedCams.includes(n) ? 'Unlink' : 'Link';
  linkBtn.onclick = async () => {
        if(linkedCams.includes(n)){ linkedCams = linkedCams.filter(x=>x!==n); }
        else { linkedCams.push(n); }
        saveLinkedCams(); renderLinkedCams(); linkBtn.textContent = linkedCams.includes(n) ? 'Unlink' : 'Link';
      };
  rightDiv.appendChild(linkBtn);

      // Alarm settings button
      try{
  const alarmBtn = document.createElement('button');
  alarmBtn.className = (info && info.alarmConfig) ? 'btn small warn' : 'btn small';
  // label always shows the settings entry point (not all-caps)
  alarmBtn.textContent = 'Alarm Settings';
  alarmBtn.onclick = () => { openAlarmModal(n); };
  groupAlarm.appendChild(alarmBtn);
  // expose for optimistic updates when saving the modal
  try{ alarmButtons[n] = alarmBtn; }catch(e){}

        // keep local cache of alarmConfig for this camera; update only styling, not text
        const alarmRef = ref(db, 'cameras/' + n + '/alarmConfig');
        const alarmOff = onValue(alarmRef, snap => {
          const v = snap.val();
          if(v){ alarmConfigs[n] = v; alarmBtn.className = 'btn small warn'; }
          else { delete alarmConfigs[n]; alarmBtn.className = 'btn small'; }
        });
        listeners.push(alarmOff);
      }catch(e){ console.warn('alarm button failed', e); }

      // subscribe to motion events for this camera — show overlay if we are currently viewing it
      try{
        const motionRef = ref(db, 'cameras/' + n + '/motion');
        const mOff = onValue(motionRef, snapMotion => {
          const m = snapMotion.val();
          if(!m) return;
          if(currentViewingName === n){
            showMotionOverlay(m.bbox || null);
            // consider alarm trigger on motion
            try{ maybeTriggerAlarm(n, { motion: true, bbox: m.bbox || null, ts: m.ts || Date.now() }); }catch(e){ console.warn('alarm check motion failed', e); }
          }
        });
        listeners.push(mOff);
      }catch(e){ console.warn('motion subscribe failed', e); }

      cameraListDiv.appendChild(row);
    });
  });
  // store so we can remove later
  listeners.push(off);
}

export {};

// Display a transient overlay when motion is detected. bbox is optional normalized rect {x,y,w,h}
function showMotionOverlay(bbox){
  if(!motionOverlay) return;
  try{
    motionOverlay.style.display = 'flex';
    motionBanner.style.display = 'block';
    motionBox.style.display = 'none';
    if(bbox && bbox.x != null){
      const wrapper = document.getElementById('videoWrapper');
      const wr = wrapper.getBoundingClientRect();
      motionBox.style.left = (bbox.x * wr.width) + 'px';
      motionBox.style.top = (bbox.y * wr.height) + 'px';
      motionBox.style.width = (bbox.w * wr.width) + 'px';
      motionBox.style.height = (bbox.h * wr.height) + 'px';
      motionBox.style.display = 'block';
    }
    // auto-hide after 4s
    setTimeout(()=>{ try{ motionOverlay.style.display = 'none'; motionBox.style.display='none'; }catch(e){} }, 4000);
  }catch(e){ console.warn('showMotionOverlay failed', e); }
}

// Alarm evaluation and triggering
async function maybeTriggerAlarm(cameraName, evt){
  try{
    // ensure we have an alarm config; if not cached, try one-time read from DB
    let cfg = alarmConfigs[cameraName];
    if(!cfg && db){
      try{
        const snap = await get(ref(db, 'cameras/' + cameraName + '/alarmConfig'));
        const v = snap && snap.val ? snap.val() : null;
        if(v){ alarmConfigs[cameraName] = v; cfg = v; }
      }catch(e){ console.warn('failed to fetch alarmConfig on-demand', e); }
    }
    if(!cfg) return; // no alarm configured

    // coerce numeric fields to Numbers to avoid string comparison issues
    if(cfg.minConfidence != null) cfg.minConfidence = Number(cfg.minConfidence);
    if(cfg.cooldown != null) cfg.cooldown = Number(cfg.cooldown);

    const now = Date.now();
  alarmState[cameraName] = alarmState[cameraName] || {};
  const lastAlarm = alarmState[cameraName].lastAlarmTs || 0;
  // record recent motion/human timestamps so "both" mode can correlate events
  // prefer evt.ts when provided for motion/human origin accuracy
  if(evt && evt.motion){ alarmState[cameraName].lastMotionTs = evt.ts || now; }
  if(evt && evt.humans && evt.humans.length > 0){ alarmState[cameraName].lastHumanTs = evt.ts || now; }
    const cooldownMs = (cfg.cooldown || 30) * 1000;
    if(now - lastAlarm < cooldownMs) return; // cooling down

    // evaluate conditions
    let motionOk = false;
    let humanOk = false;

    // Direct evaluation from this event
    if(evt.motion) motionOk = true;
    if(evt.humans && evt.humans.length > 0){
      const minC = cfg.minConfidence || 0.48;
      humanOk = evt.humans.some(h => (h.score || 0) >= minC);
    }

    // For 'both' mode we also allow temporal correlation: if motion and human
    // detections happened within a short window (default 5s), treat as both.
    const bothWindowMs = (cfg.bothWindowSeconds ? Number(cfg.bothWindowSeconds) * 1000 : 5000);
    const lastMotion = alarmState[cameraName].lastMotionTs || 0;
    const lastHuman = alarmState[cameraName].lastHumanTs || 0;
    const motionRecent = (now - lastMotion) <= bothWindowMs;
    const humanRecent = (now - lastHuman) <= bothWindowMs;

      // DEBUG: log evaluation to help troubleshooting
      try{
        console.debug('[ALARM] evaluate', { cameraName, cfg, evtSummary: { humans: (evt.humans||[]).map(h=>({score:h.score||0})), motion: !!evt.motion }, motionOk, humanOk });
      }catch(e){}

    let shouldFire = false;
    if(cfg.mode === 'motion') shouldFire = motionOk;
    else if(cfg.mode === 'human') shouldFire = humanOk;
    else if(cfg.mode === 'both') {
      // If both flags are present in this single event, use them directly.
      if(motionOk && humanOk) shouldFire = true;
      else {
        // Otherwise check whether complementary event occurred recently (within window)
        shouldFire = (motionOk && humanRecent) || (humanOk && motionRecent) || (motionRecent && humanRecent);
      }
    }

    if(shouldFire){
      const matchedMotion = motionOk || motionRecent;
      const matchedHuman = humanOk || humanRecent;
      triggerAlarm(cameraName, { cfg, evt, matched: { motion: !!matchedMotion, human: !!matchedHuman } });
      alarmState[cameraName].lastAlarmTs = now;
      // record alarm event in DB for auditing
      try{ if(db) await push(ref(db, 'cameras/' + cameraName + '/alarms'), { ts: now, mode: cfg.mode, reason: { motion: !!evt.motion, humans: (evt.humans||[]).map(h=>({score:h.score,bbox:h.bbox})) }, camera: cameraName }); }catch(e){ console.warn('log alarm failed', e); }
    }
  }catch(e){ console.warn('maybeTriggerAlarm failed', e); }
}

function triggerAlarm(cameraName, info){
  try{
    if(alarmBanner) alarmBanner.style.display = 'block';
    // Play provided alarm.mp3 if available, otherwise fallback to short beep
    try{
      const audioEl = document.getElementById('alarmAudio');
      if(audioEl){
        try{ audioEl.pause(); audioEl.currentTime = 0; audioEl.volume = 0.95; audioEl.play().catch(e=>{ console.warn('alarm audio play failed', e); try{ playAlarmTone(880,0.6,800); }catch(e){} }); }
        catch(e){ console.warn('alarm audio play exception', e); try{ playAlarmTone(880,0.6,800); }catch(e){} }
      } else {
        try{ playAlarmTone(880, 0.6, 800); }catch(e){}
      }
    }catch(e){ console.warn('alarm play failed', e); }
    // speak an audible message announcing the alarm (use SpeechSynthesis if available)
    try{
      // only speak if voice is enabled in the alarm config (info.cfg takes precedence)
      let voiceEnabled = true;
      if(info && info.cfg && info.cfg.voice !== undefined) voiceEnabled = !!info.cfg.voice;
      else if(alarmConfigs[cameraName] && alarmConfigs[cameraName].voice !== undefined) voiceEnabled = !!alarmConfigs[cameraName].voice;
      if(voiceEnabled){ speakAlarm(cameraName, info); }
    }catch(e){ console.warn('speech alarm failed', e); }
    // auto-hide banner after 6s
    setTimeout(()=>{ try{ if(alarmBanner) alarmBanner.style.display = 'none'; }catch(e){} }, 6000);
    status('ALARM fired for ' + cameraName + ' (' + (info && info.cfg && info.cfg.mode) + ')');
  }catch(e){ console.warn('triggerAlarm failed', e); }
}

function playAlarmTone(freq=880, volume=0.5, durationMs=800){
  try{
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(); const g = ac.createGain();
    o.type = 'sine'; o.frequency.value = freq; g.gain.value = volume;
    o.connect(g); g.connect(ac.destination); o.start();
    setTimeout(()=>{ try{ o.stop(); ac.close(); }catch(e){} }, durationMs);
  }catch(e){ console.warn('playAlarmTone failed', e); }
}

// Speak a short TTS message when an alarm fires
function speakAlarm(cameraName, info){
  try{
    if(!window.speechSynthesis) return;
    // Decide phrase based on event info: prefer human/person detection over generic motion
    let phrase = `Alarm triggered for ${cameraName}`;
    try{
      const evt = info && info.evt ? info.evt : null;
      const cfg = (info && info.cfg) ? info.cfg : (alarmConfigs[cameraName] || {});
      const matched = info && info.matched ? info.matched : null;
      // Respect configured mode: motion-only => announce motion; human-only => announce human(s);
      // both => announce combined when both matched (including temporal correlation).
      if(cfg && cfg.mode === 'both'){
        if(matched && matched.motion && matched.human){
          phrase = `Motion and human presence detected in ${cameraName}`;
        } else if(evt && Array.isArray(evt.humans) && evt.humans.length > 0){
          const count = evt.humans.length;
          phrase = count === 1 ? `Person detected in ${cameraName}` : `${count} people detected in ${cameraName}`;
        } else if(evt && evt.motion){
          phrase = `Motion detected in ${cameraName}`;
        } else if(matched && matched.human){
          phrase = `Human presence detected in ${cameraName}`;
        } else if(matched && matched.motion){
          phrase = `Motion detected in ${cameraName}`;
        } else {
          // fallback
          phrase = `Motion and human presence detected in ${cameraName}`;
        }
      } else if(cfg && cfg.mode === 'human'){
        // prefer to report people count if available
        if(evt && Array.isArray(evt.humans) && evt.humans.length > 0){
          const count = evt.humans.length;
          phrase = count === 1 ? `Person detected in ${cameraName}` : `${count} people detected in ${cameraName}`;
        } else {
          phrase = `Human presence detected in ${cameraName}`;
        }
      } else {
        // motion (default)
        phrase = `Motion detected in ${cameraName}`;
      }
    }catch(e){ /* fallback phrase retained */ }
    const ut = new SpeechSynthesisUtterance(phrase);
    // pick a neutral voice if available
    try{
      const voices = window.speechSynthesis.getVoices();
      if(voices && voices.length){
        // prefer a voice with 'en' locale if present
        const en = voices.find(v=>/en/i.test(v.lang)) || voices[0];
        if(en) ut.voice = en;
      }
    }catch(e){}
    ut.rate = 1.0; ut.pitch = 1.0; ut.volume = 1.0;
    // attempt to speak; browsers may require user gesture to allow audio — guard errors
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(ut);
  }catch(e){ console.warn('speakAlarm error', e); }
}

// Lock motion/smart controls when alarm is armed and unlock on disarm
function lockControls(cameraName, cfg, motionBtn, smartBtn){
  try{
    alarmLocks[cameraName] = alarmLocks[cameraName] || {};
    const lock = alarmLocks[cameraName];
    // store previous visible states and handlers
    if(motionBtn){ lock.prevMotion = (motionBtn.textContent && motionBtn.textContent.indexOf('ON') !== -1); lock.motionHandler = motionBtn.onclick; }
    if(smartBtn){ lock.prevSmart = (smartBtn.textContent && smartBtn.textContent.indexOf('ON') !== -1); lock.smartHandler = smartBtn.onclick; }

    // enforce visuals and disable toggles according to cfg.mode
    const mode = cfg && cfg.mode ? cfg.mode : null;
    if((mode === 'motion' || mode === 'both') && motionBtn){
      try{ motionBtn.onclick = null; motionBtn.disabled = true; motionBtn.className = 'btn small toggle-on'; motionBtn.textContent = 'Motion: ON'; }catch(e){}
    }
    if((mode === 'human' || mode === 'both') && smartBtn){
      try{ smartBtn.onclick = null; smartBtn.disabled = true; smartBtn.className = 'btn small toggle-on'; smartBtn.textContent = 'Smart: ON'; }catch(e){}
    }
  }catch(e){ console.warn('lockControls failed', e); }
}

function unlockControls(cameraName, motionBtn, smartBtn){
  try{
    const lock = alarmLocks[cameraName];
    if(!lock) return;
    if(motionBtn){ try{ motionBtn.disabled = false; motionBtn.onclick = lock.motionHandler; motionBtn.className = (lock.prevMotion ? 'btn small toggle-on' : 'btn small'); motionBtn.textContent = (lock.prevMotion ? 'Motion: ON' : 'Motion: OFF'); }catch(e){} }
    if(smartBtn){ try{ smartBtn.disabled = false; smartBtn.onclick = lock.smartHandler; smartBtn.className = (lock.prevSmart ? 'btn small toggle-on' : 'btn small'); smartBtn.textContent = (lock.prevSmart ? 'Smart: ON' : 'Smart: OFF'); }catch(e){} }
    delete alarmLocks[cameraName];
  }catch(e){ console.warn('unlockControls failed', e); }
}

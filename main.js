// Cam (callee) - auto-answering WebRTC using Firebase Realtime Database for signaling
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
  onDisconnect,
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
  // Leave app/db undefined; startListening will show a helpful message if called.
  app = null;
  db = null;
}

const localVideo = document.getElementById('localVideo');
const callIdInput = document.getElementById('callIdInput');
const cameraNameInput = document.getElementById('cameraNameInput');
const registerBtn = document.getElementById('registerBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');

let pc;
let localStream;
let callRef; // database ref root for this call
let callerCandidatesRef;
let calleeCandidatesRef;
let listeners = [];
let registeredCameraName = null;
let cameraDbRef = null;
let motionMonitor = { intervalId: null, canvas: null, ctx: null, lastGray: null, lastMotionTs: 0 };
let motionDesired = false; // whether motion detection is enabled in DB

startBtn.onclick = startListening;
stopBtn.onclick = stopAll;
registerBtn && (registerBtn.onclick = registerCamera);

// Auto-register if camera name was saved previously
try{
  const savedName = localStorage.getItem('cameraName');
  if(savedName && cameraNameInput){ cameraNameInput.value = savedName; /* attempt auto-register after short delay */ setTimeout(()=>{ try{ if(registerBtn) registerCamera(); }catch(e){} }, 400); }
}catch(e){}

const servers = { iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ] };

async function startListening(){
  startBtn.disabled = true;
  status('Starting camera & listening...');

  if(!db){
    status('Firebase not initialized. Please provide a Firebase config (you will be prompted or store it in localStorage under key "firebaseConfig").');
    startBtn.disabled = false;
    return;
  }

  try{
    localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
  }catch(e){
    status('Error accessing camera/microphone: ' + e.message);
    startBtn.disabled = false;
    return;
  }

  localVideo.srcObject = localStream;

  // if we are registered, update camera DB entry with precise device info from the active track
  try{
    if(registeredCameraName && cameraDbRef){
      const tracks = localStream.getVideoTracks();
      if(tracks && tracks.length){
        const settings = tracks[0].getSettings();
        const deviceInfo = { platform: navigator.platform || '', userAgent: navigator.userAgent || '', cameraLabel: tracks[0].label || '', cameraDeviceId: settings.deviceId || '' };
        await set(cameraDbRef, { online: true, standby: false, lastSeen: Date.now(), device: deviceInfo });
      }
    }
  }catch(e){ console.warn('update camera db with device info failed', e); }

  const callId = callIdInput.value && callIdInput.value.trim();
  // If user pasted a callId, support legacy call flow. Otherwise use session-based flow (recommended).
  if (callId) {
    callRef = ref(db, 'calls/' + callId);
    callerCandidatesRef = ref(db, 'calls/' + callId + '/callerCandidates');
    calleeCandidatesRef = ref(db, 'calls/' + callId + '/calleeCandidates');
  } else {
    // Use session-based flow: wait for sessions targeted at this camera (register must have been called)
    status('No Call ID provided — will listen for incoming sessions for your registered camera name.');
    // nothing else here; session listener is started when camera registers
  }

  pc = new RTCPeerConnection(servers);

  // Add local tracks
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // Gather ICE candidates and push to calleeCandidates path
  pc.onicecandidate = event => {
    if(!event.candidate) return;
    push(calleeCandidatesRef, event.candidate.toJSON());
  };

  pc.onconnectionstatechange = () => {
    status('Peer connection state: ' + pc.connectionState);
  };

  // Listen for an offer in the database and auto-answer
  if (callRef) {
    const off = onValue(callRef, async snapshot => {
      const data = snapshot.val();
      if(!data || !data.offer) return;
      if(pc.signalingState !== 'stable') return; // already handled or mid-change

      status('Offer received — creating answer...');

      const offer = data.offer;
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // write answer to DB
      set(ref(db, 'calls/' + callId + '/answer'), pc.localDescription.toJSON());
      status('Answer written to database. Connection assembling...');

      // start listening for caller ICE candidates
      const candsListener = onChildAdded(callerCandidatesRef, snapshot => {
        const cand = snapshot.val();
        if(cand){
          pc.addIceCandidate(cand).catch(e => console.warn('Error adding caller candidate', e));
        }
      });
      listeners.push(candsListener);

      // Disable start, enable stop
      stopBtn.disabled = false;
    });
    listeners.push(off);

    status('Listening for offer on call ID: ' + callId);
  }
}

// Register the camera so viewers can find it and start sessions targeting the camera name
async function registerCamera(){
  if(!db){ status('Firebase not initialized.'); return; }
  const name = (cameraNameInput && cameraNameInput.value || '').trim();
  if(!name){ alert('Enter a camera name to register (example: front-door)'); return; }

  const camRef = ref(db, 'cameras/' + name);
  // gather device info (best-effort)
  let deviceInfo = { platform: navigator.platform || '', userAgent: navigator.userAgent || '' };
  try{
    // try to enumerate video input devices (labels may be empty without permission)
    if(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices){
      const devs = await navigator.mediaDevices.enumerateDevices();
      const videoDevs = devs.filter(d=>d.kind === 'videoinput');
      if(videoDevs && videoDevs.length){
        deviceInfo.cameraLabel = videoDevs[0].label || '';
        deviceInfo.cameraDeviceId = videoDevs[0].deviceId || '';
      }
    }
  }catch(e){ console.warn('enumerateDevices failed', e); }

  // write initial presence and device metadata
  await set(camRef, { online: true, standby: true, lastSeen: Date.now(), device: deviceInfo });
  try{ localStorage.setItem('cameraName', name); }catch(e){}
  // ensure removal on disconnect
  try{ onDisconnect(camRef).remove(); }catch(e){ console.warn('onDisconnect failed', e); }
  status('Camera registered as: ' + name + ' — listening for viewer sessions.');

  // remember registered camera name and DB ref so other functions can update metadata
  registeredCameraName = name;
  cameraDbRef = camRef;

  // start listening for session entries where target === name (session-based signaling)
  const sessionsRef = ref(db, 'sessions');
  const sessListener = onChildAdded(sessionsRef, async snap => {
    const session = snap.val();
    const sessionId = snap.key;
    if(!session) return;
    if(session.target !== name) return; // not for this camera
    if(!session.offer) return;
    // if already answered, ignore (prevents duplicate handling)
    if(session.answer) return;

    status('Session incoming from ' + (session.from || 'viewer') + ' — answering...');

    // ensure we have local media; if not, try to wake/getUserMedia
    if(!localStream){
      // mark session waking
      try{ await set(ref(db, 'sessions/' + sessionId + '/status'), 'waking'); }catch(e){}
      status('Waking camera (requesting local media)...');
      try{
        localStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
        localVideo.srcObject = localStream;
        // update presence to indicate streaming
        try{ await set(camRef, { online: true, standby: false, lastSeen: Date.now() }); }catch(e){}
      }catch(e){
        status('User did not grant camera permission or getUserMedia failed: ' + e.message);
        try{ await set(ref(db, 'sessions/' + sessionId + '/status'), 'failed'); }catch(e){}
        return;
      }
    }

  // create a dedicated peer connection for this session
    const sessionPc = new RTCPeerConnection(servers);
    // add local tracks
    if(localStream) localStream.getTracks().forEach(t => sessionPc.addTrack(t, localStream));

    // push our ICE to /sessions/<id>/calleeCandidates
    const calleeCandsRef = ref(db, 'sessions/' + sessionId + '/calleeCandidates');
    sessionPc.onicecandidate = e => { if(e.candidate) push(calleeCandsRef, e.candidate.toJSON()); };

    // handle remote tracks
    sessionPc.ontrack = ev => {
      // viewer will show the remote stream; camera doesn't need to render it
      console.log('session remote track', ev);
    };

    // set remote offer and create answer (guarded)
    try{
      await sessionPc.setRemoteDescription(session.offer);
      const answer = await sessionPc.createAnswer();
      await sessionPc.setLocalDescription(answer);
      // write answer
      await set(ref(db, 'sessions/' + sessionId + '/answer'), sessionPc.localDescription.toJSON());
      // optionally mark answered (helps avoid double-processing)
      try{ await set(ref(db, 'sessions/' + sessionId + '/answered'), true); }catch(e){}
    }catch(e){
      console.warn('Failed to answer session', sessionId, e);
      return;
    }

    // mark session answered (clear waking state)
    try{ await set(ref(db, 'sessions/' + sessionId + '/status'), 'answered'); }catch(e){}

    // listen for caller candidates
    const callerCandsRef = ref(db, 'sessions/' + sessionId + '/callerCandidates');
    const callerCandsListener = onChildAdded(callerCandsRef, snap2 => {
      const c = snap2.val(); if(c){ sessionPc.addIceCandidate(c).catch(e => console.warn('addIce failed', e)); }
    });

    // cleanup when pc closes
    sessionPc.onconnectionstatechange = () => {
      if(sessionPc.connectionState === 'closed' || sessionPc.connectionState === 'failed' || sessionPc.connectionState === 'disconnected'){
        try{ callerCandsListener(); }catch(e){}
      }
    };

    status('Answered session ' + sessionId);
  });
  listeners.push(sessListener);

  // listen to camera status changes (standby/active) so remote sleep can stop local media
  try{
    const statusListener = onValue(camRef, snap => {
      const data = snap.val();
      if(!data) return;
      const isStandby = !!data.standby;
      // track desired motion flag if present
      if(typeof data.motionEnabled !== 'undefined'){
        motionDesired = !!data.motionEnabled;
        // if enabled and we have localStream, ensure monitor runs
        if(motionDesired && localStream){ startMotionMonitor(name); }
        if(!motionDesired){ stopMotionMonitor(); }
      }
      if(isStandby){
        // enter sleep mode: stop local media if running
        if(localStream){
          try{ localStream.getTracks().forEach(t=>t.stop()); }catch(e){}
          localStream = null;
          localVideo.srcObject = null;
        }
        status('Camera is in standby (sleep)');
      } else {
        status('Camera is active');
        // do not force getUserMedia here; wake requests or manual Start will do that
      }
    });
    listeners.push(statusListener);
  }catch(e){ console.warn('failed to attach camera status listener', e); }

  // watch explicit motionEnabled flag (also handled above) to react when toggled
  try{
    const motionEnabledRef = ref(db, 'cameras/' + name + '/motionEnabled');
    const motionEnabledListener = onValue(motionEnabledRef, snap => {
      const v = snap.val();
      motionDesired = !!v;
      if(motionDesired){ if(localStream) startMotionMonitor(name); }
      else stopMotionMonitor();
    });
    listeners.push(motionEnabledListener);
  }catch(e){ console.warn('motionEnabled listener failed', e); }


  // listen for explicit wake requests written to /cameras/<name>/wake
  try{
    const wakeRef = ref(db, 'cameras/' + name + '/wake');
    const wakeListener = onValue(wakeRef, async wSnap => {
      const v = wSnap.val();
      if(!v) return;
      // a wake was requested (value is timestamp or true)
      status('Wake request received — turning camera on...');
      try{
        if(!localStream){
          localStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
          localVideo.srcObject = localStream;
        }
        // update presence
        try{ await set(camRef, { online: true, standby: false, lastSeen: Date.now() }); }catch(e){}
      }catch(e){
        console.warn('Wake getUserMedia failed', e);
      }
      // clear the wake flag to acknowledge
      try{ await set(wakeRef, null); }catch(e){}
    });
    listeners.push(wakeListener);
  }catch(e){ console.warn('wake listener setup failed', e); }

  // also start local preview if not already running
  try{ if(!localStream) { localStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true}); localVideo.srcObject = localStream; } }catch(e){ console.warn('preview start failed', e); }
}

function startMotionMonitor(name){
  if(motionMonitor.intervalId) return;
  if(!localStream) return; // we'll start once stream exists
  // small canvas for motion detection
  const w = 160; const h = 120;
  motionMonitor.canvas = document.createElement('canvas'); motionMonitor.canvas.width = w; motionMonitor.canvas.height = h;
  motionMonitor.ctx = motionMonitor.canvas.getContext('2d');
  motionMonitor.lastGray = null;
  motionMonitor.intervalId = setInterval(()=>{
    try{
      if(!localVideo || !motionMonitor.ctx) return;
      motionMonitor.ctx.drawImage(localVideo, 0, 0, w, h);
      const img = motionMonitor.ctx.getImageData(0,0,w,h);
      const gray = new Uint8ClampedArray(w*h);
      for(let i=0, j=0; i<img.data.length; i+=4, j++){
        // luma
        gray[j] = (img.data[i]*0.299 + img.data[i+1]*0.587 + img.data[i+2]*0.114)|0;
      }
      if(motionMonitor.lastGray){
        let diffCount = 0;
        let minX = w, minY = h, maxX = 0, maxY = 0;
        for(let y=0;y<h;y++){
          for(let x=0;x<w;x++){
            const idx = y*w + x;
            const d = Math.abs(gray[idx] - motionMonitor.lastGray[idx]);
            if(d > 30){ // pixel changed
              diffCount++;
              if(x<minX) minX=x; if(y<minY) minY=y; if(x>maxX) maxX=x; if(y>maxY) maxY=y;
            }
          }
        }
        // threshold diff count
        if(diffCount > 500){
          const now = Date.now();
          if(now - motionMonitor.lastMotionTs > 5000){
            motionMonitor.lastMotionTs = now;
            // normalized bbox
            const bx = minX / w; const by = minY / h; const bw = (maxX - minX)/w; const bh = (maxY - minY)/h;
            const payload = { ts: now, bbox: { x: bx, y: by, w: bw, h: bh } };
            try{ set(ref(db, 'cameras/' + name + '/motion'), payload); }catch(e){ console.warn('motion write failed', e); }
          }
        }
      }
      motionMonitor.lastGray = gray;
    }catch(e){ console.warn('motion monitor tick failed', e); }
  }, 250);
  console.log('motion monitor started for', name);
}

function stopMotionMonitor(){
  try{ if(motionMonitor.intervalId){ clearInterval(motionMonitor.intervalId); motionMonitor.intervalId = null; motionMonitor.lastGray = null; motionMonitor.canvas = null; motionMonitor.ctx = null; } }catch(e){}
  console.log('motion monitor stopped');
}

function status(msg){
  statusEl.textContent = msg;
}

async function stopAll(){
  stopBtn.disabled = true;
  status('Stopping...');

  // remove DB listeners
  listeners.forEach(unsub => { try{ unsub(); }catch(e){} });
  listeners = [];

  // close peer
  try{ pc && pc.close(); }catch(e){}
  pc = null;

  // stop local tracks
  if(localStream){
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  localVideo.srcObject = null;
  status('Stopped');
  startBtn.disabled = false;
}

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if(callRef){
    // Do not delete the call data automatically — viewer may want it — but could be cleaned up manually.
  }
});

export {};

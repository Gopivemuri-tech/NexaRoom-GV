(() => {
'use strict';

const c = window.NEXAROOM;
const $ = id => document.getElementById(id);
const esc = v => { const d=document.createElement('div'); d.textContent=String(v??''); return d.innerHTML; };

const peers = new Map(), names = new Map(), streams = new Map(), remoteMedia = new Map(), analysers = new Map();
const peerCohost = new Map(), pendingIce = new Map(), avatars = new Map(), peerUserIds = new Map();
// Per-peer negotiation state. Never share one peer's offer/ICE recovery with another.
const peerStates = new Map(), peerOperations = new Map(), peerAudio = new Map(), remoteTracks = new Map();
// Live-render evidence is independent of ICE state and cumulative RTP totals.
const remoteFrameAt = new Map(), trackedVideoElements = new WeakSet(), lastPlayerReset = new Map();
const diagnosticSamples = new Map();
let lastStageReset = 0;
let socket=null, localStream=null, cameraTrack=null, screenTrack=null, roomKey=null, roomKeyToken=null;
let startedAt=Date.now(), selectedPeer='local', manualPinUntil=0, audioCtx=null;
let endingMeeting=false, mediaProblem='', roomJoined=false, currentHostId=c.isHost?c.userId:null;
let currentPolicy={allow_chat:true,allow_screen_share:true,allow_unmute:true,allow_video:true};
let captionsOn=false, recognition=null, recorder=null, recordedChunks=[], recording=false;
let recordingSession=null;

function toast(t){
  const el=$('toast'); if(!el)return;
  el.textContent=t; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2300);
}
// Presentation-only incoming activity popups. Socket.IO payloads and delivery stay unchanged.
let chatUnread=0, fileUnread=0, meetingExitPromptShown=false;
const pendingOwnChats=[];
function updateActivityBadges(){
  const chat=$('chatUnreadBadge'), more=$('moreUnreadBadge'), files=$('filesUnreadBadge');
  if(chat){chat.textContent=chatUnread>9?'9+':String(chatUnread);chat.classList.toggle('hidden',!chatUnread);}
  if(files){files.textContent=fileUnread>9?'9+':String(fileUnread);files.classList.toggle('hidden',!fileUnread);}
  if(more){more.textContent=fileUnread>9?'9+':String(fileUnread);more.classList.toggle('hidden',!fileUnread);}
}
function isTabOpen(tab){return !$('sidePanel').classList.contains('closed')&&!$('tab-'+tab).classList.contains('hidden');}
function meetingNotice(type,title,detail){
  const stack=$('meetingNotifications');if(!stack)return;
  const card=document.createElement('button');card.type='button';card.className='meeting-activity meeting-activity-'+type;
  card.setAttribute('aria-label',title+'. Open '+(type==='file'?'Files':'Chat'));
  const icon=document.createElement('span');icon.className='activity-icon';icon.textContent=type==='file'?'↥':'✉';
  const copy=document.createElement('span');copy.className='activity-copy';
  const heading=document.createElement('strong');heading.textContent=title;
  const body=document.createElement('span');body.textContent=String(detail||'').slice(0,170);
  copy.append(heading,body);const close=document.createElement('span');close.className='activity-close';close.textContent='×';
  card.append(icon,copy,close);
  card.onclick=e=>{card.remove();if(e.target===close)return;openSide(type==='file'?'files':'chat');};
  stack.prepend(card);
  while(stack.children.length>3)stack.lastElementChild.remove();
  setTimeout(()=>{if(card.isConnected){card.classList.add('exiting');setTimeout(()=>card.remove(),220);}},7200);
}
function timeoutReached(){
  return Number.isFinite(c.durationLimit)&&c.durationLimit>0
    && (Date.now()-startedAt)>=c.durationLimit*60000-2500;
}
async function showMeetingEnded(info={}){
  if(meetingExitPromptShown)return;
  meetingExitPromptShown=true;
  stopLocalMedia();
  const timedOut=timeoutReached()||info.reason==='time_limit';
  const title=timedOut?'Meeting time limit reached':info.reason==='host_end'||/host ended/i.test(info.message||'')?'Host ended the meeting':'Meeting ended';
  const message=timedOut
    ? `The ${c.durationLimit}-minute meeting has reached its scheduled time limit.`
    : title==='Host ended the meeting'?'The host ended this meeting for everyone.':'This meeting has ended.';
  await appDialog({title,message,confirmText:'Back to workspace'});
  location.href='/';
}

function fatal(t){
  const el=$('fatalBanner'); if(el){el.textContent=t;el.classList.remove('hidden')}
  if($('connectionState')) $('connectionState').textContent='Connection issue';
}
function appDialog({title,message,confirmText='OK',cancelText='Cancel',danger=false,showCancel=false}={}){
  return new Promise(resolve=>{
    const modal=$('appDialog'), titleEl=$('appDialogTitle'), msgEl=$('appDialogMessage'), ok=$('appDialogConfirm'), cancel=$('appDialogCancel'), icon=$('appDialogIcon');
    titleEl.textContent=title||'NexaRoom'; msgEl.textContent=message||'';
    ok.textContent=confirmText; cancel.textContent=cancelText;
    ok.classList.toggle('danger-action',!!danger); icon.classList.toggle('danger-icon',!!danger);
    cancel.classList.toggle('hidden',!showCancel); modal.classList.remove('hidden');
    const done=v=>{modal.classList.add('hidden');ok.onclick=null;cancel.onclick=null;resolve(v)};
    ok.onclick=()=>done(true); cancel.onclick=()=>done(false);
  });
}
function quality(){
  return c.videoQuality==='1080p'
    ? {width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30,max:30}}
    : {width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}};
}
function initials(name){return String(name||'?').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase()||'?'}
function avatarHTML(name, url){
  // URLs come only from the server; only same-origin MEDIA urls are allowed.
  if(typeof url==='string' && /^\/media\/nexaroom_profiles\/[a-zA-Z0-9_./%-]+$/.test(url))
    return `<img class="nexa-avatar-img" src="${esc(url)}" alt="Profile photo" loading="lazy">`;
  return esc(initials(name));
}
function avatarFor(id){return id==='local'?(c.avatarUrl||''):(avatars.get(id)||'');}
function micStatusSvg(muted){
  return muted
    ? '<span class="mute-status mic-off" title="Muted"><svg viewBox="0 0 24 24"><path d="M9 8v4a3 3 0 0 0 4.7 2.5M15 11V7a3 3 0 0 0-5.4-1.8M6 11.5v.5a6 6 0 0 0 9.8 4.6M12 18v3M9 21h6M4 4l16 16"/></svg></span>'
    : '<span class="mute-status mic-on" title="Microphone on"><svg viewBox="0 0 24 24"><path d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zM6 11.5v.5a6 6 0 0 0 12 0v-.5M12 18v3M9 21h6"/></svg></span>';
}

async function initMedia(deviceIds={}){
  if($('connectionState')) $('connectionState').textContent='Checking camera and microphone…';
  // Allow signaling and joining a room even if a device is unavailable/blocked.
  const savedVideo=deviceIds.video||localStorage.getItem('nexaroom-camera-id')||'';
  const savedAudio=deviceIds.audio||localStorage.getItem('nexaroom-microphone-id')||'';
  const v={...quality(),...(savedVideo?{deviceId:{ideal:savedVideo}}:{})};
  const a={echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1,...(savedAudio?{deviceId:{ideal:savedAudio}}:{})};
  let next=null;const errors=[];
  if(!navigator.mediaDevices?.getUserMedia){
    mediaProblem='Browser camera/microphone API unavailable. HTTPS and a supported browser are required.';
  }else{
    try{ next=await navigator.mediaDevices.getUserMedia({video:v,audio:a}); }
    catch(e){
      errors.push(e.name||'MediaError');
      const tracks=[];
      try{const video=await navigator.mediaDevices.getUserMedia({video:v,audio:false});tracks.push(...video.getTracks())}catch(e2){errors.push('camera: '+(e2.name||e2.message))}
      try{const audio=await navigator.mediaDevices.getUserMedia({video:false,audio:a});tracks.push(...audio.getTracks())}catch(e2){errors.push('microphone: '+(e2.name||e2.message))}
      next=new MediaStream(tracks);
    }
  }
  if(!next) next=new MediaStream();
  const old=localStream; localStream=next;cameraTrack=next.getVideoTracks()[0]||null;
  if(old){
    for(const pc of peers.values()){
      for(const kind of ['audio','video']){
        const t=kind==='video'&&screenTrack?screenTrack:(next.getTracks().find(x=>x.kind===kind)||null);
        // A camera-off peer already has a sendrecv transceiver with a null sender track.
        // Reuse that sender when a device appears, instead of creating an unnegotiated m-line.
        const sender=pc.getTransceivers().find(x=>x.sender.track?.kind===kind || x.receiver.track?.kind===kind)?.sender
          ||pc.getSenders().find(x=>x.track?.kind===kind);
        if(sender)try{await sender.replaceTrack(t)}catch(e){console.warn('Device replacement failed',e)}
        else if(t)try{pc.addTrack(t,next)}catch(e){console.warn('Adding track failed',e)}
      }
    }
    old.getTracks().forEach(t=>t.stop());
  }
  const previewStream=screenTrack?new MediaStream([screenTrack,...next.getAudioTracks()]):localStream;
  $('localThumbVideo').srcObject=previewStream;
  streams.set('local',previewStream);setMain('local',false);
  $('thumb-local').classList.toggle('camera-off',!cameraTrack||!cameraTrack.enabled);
  if(selectedPeer==='local')refreshSpeakerMedia();
  $('camBtn').classList.toggle('off',!cameraTrack);$('camBtn').querySelector('small').textContent=cameraTrack?'Stop Video':'Start Video';
  syncLocalMicUI(!!next.getAudioTracks()[0]?.enabled);
  if(savedVideo&&cameraTrack)localStorage.setItem('nexaroom-camera-id',cameraTrack.getSettings().deviceId||savedVideo);
  if(savedAudio&&next.getAudioTracks()[0])localStorage.setItem('nexaroom-microphone-id',next.getAudioTracks()[0].getSettings().deviceId||savedAudio);
  mediaProblem=errors.join('; ');
  if($('connectionState')) $('connectionState').textContent=next.getTracks().length?'Media ready':'No camera/mic — joining with devices off';
  await loadDevices();
  if(mediaProblem)toast('Camera/mic: open Devices to choose your integrated camera or microphone.');
}

async function loadDevices(){
  try{
    const devices=await navigator.mediaDevices.enumerateDevices();
    const cams=devices.filter(d=>d.kind==='videoinput'), mics=devices.filter(d=>d.kind==='audioinput');
    const cs=$('cameraSelect'), ms=$('micSelect');
    if(cs){cs.innerHTML='';if(!cams.length)cs.add(new Option('No camera detected',''));cams.forEach((d,i)=>{const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||`Camera ${i+1}`;cs.appendChild(o)});if(cameraTrack)cs.value=cameraTrack.getSettings().deviceId||''}
    if(ms){ms.innerHTML='';if(!mics.length)ms.add(new Option('No microphone detected',''));mics.forEach((d,i)=>{const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||`Microphone ${i+1}`;ms.appendChild(o)});const at=localStream?.getAudioTracks()[0];if(at)ms.value=at.getSettings().deviceId||''}
  }catch{}
}

// A participant is in the meeting as soon as Socket.IO confirms the SID.
// Do not require WebRTC ontrack to arrive before rendering their tile.
// A peer can have several video receivers after a camera is enabled later.
// The first stream track may be an old permanently muted receiver. Never infer
// camera health solely from getVideoTracks()[0].
function preferredRemoteTrack(id, kind='video'){
  const stream=streams.get(id), tracks=(stream?.getTracks()||[]).filter(t=>t.kind===kind);
  const current=remoteTracks.get(id)?.[kind];
  if(current&&!tracks.includes(current))tracks.push(current);
  return tracks.find(t=>t.readyState==='live'&&!t.muted)
    ||tracks.find(t=>t.readyState==='live')||null;
}
function watchRemoteFrames(id,video){
  if(!video || typeof video.requestVideoFrameCallback!=='function'||trackedVideoElements.has(video))return;
  trackedVideoElements.add(video);
  function callback(){
    if($('thumb-'+id)?.querySelector('video')!==video)return;
    const old=remoteFrameAt.get(id)||0;
    remoteFrameAt.set(id,Date.now());
    // Status updates at most once per second, never on each 30 FPS frame.
    if(Date.now()-old>1000)refreshPeerTile(id);
    video.requestVideoFrameCallback(callback);
  }
  video.requestVideoFrameCallback(callback);
}
function peerVideoLive(id){
  const track=preferredRemoteTrack(id,'video');
  const video=$('thumb-'+id)?.querySelector('video');
  if(!track||track.readyState!=='live'||!video||video.paused)return false;
  const recentlyRendered=(Date.now()-(remoteFrameAt.get(id)||0))<4500;
  // A decoded frame from *minutes ago* is not proof of live video.
  // On browsers without frame callbacks, use the live unmuted track and player state.
  const hasFrame=video.readyState>=2&&video.videoWidth>0;
  if(typeof video.requestVideoFrameCallback==='function' && remoteFrameAt.has(id))return recentlyRendered;
  return !track.muted&&hasFrame;
}
function rebindRemoteVideo(id,stream,{force=false}={}){
  const video=$('thumb-'+id)?.querySelector('video');
  if(!video)return;
  watchRemoteFrames(id,video);
  const now=Date.now();
  const shouldReset=video.srcObject!==stream || (force&&now-(lastPlayerReset.get(id)||0)>9000);
  if(shouldReset){
    // Reset srcObject identity to make Chrome renegotiate its media element's
    // dynamically replaced tracks; in-place addTrack does not always wake playback.
    video.srcObject=null;
    video.srcObject=stream;
    lastPlayerReset.set(id,now);
  }
  if(video.paused||shouldReset)video.play().catch(()=>{});
  if(selectedPeer===id){
    const stage=$('mainVideo');
    if(stage && (stage.srcObject!==stream || shouldReset)){
      stage.srcObject=null;stage.srcObject=stream;stage.play().catch(()=>{});
    }else if(stage?.paused)stage.play().catch(()=>{});
  }
}
function syncPeerReceiverStream(id,incomingTrack=null,{repair=false}={}){
  const pc=peers.get(id);if(!pc)return;
  const tracks=remoteTracks.get(id)||{};
  if(incomingTrack)tracks[incomingTrack.kind]=incomingTrack;
  remoteTracks.set(id,tracks);
  // Audio and video may arrive in separate ontrack events. Merge the current
  // receivers and prefer unmuted tracks over stale muted receivers.
  const receivers=pc.getReceivers();
  const old=streams.get(id);
  const newTracks=[];
  let changed=!old;
  for(const kind of ['audio','video']){
    const possible=[...(tracks[kind]?[tracks[kind]]:[]), ...receivers.map(r=>r.track).filter(t=>t?.kind===kind)];
    const preferred=possible.find(t=>t.readyState==='live'&&!t.muted)
      ||possible.find(t=>t.readyState==='live')||null;
    if(preferred){newTracks.push(preferred);tracks[kind]=preferred;}
    const prior=old?.getTracks().find(t=>t.kind===kind)||null;
    if(preferred!==prior)changed=true;
  }
  // A NEW MediaStream identity forces media elements to bind the replacement.
  // Retaining and mutating the old MediaStream left the large stage on stale frames.
  const stream=changed?new MediaStream(newTracks):old;
  if(changed){
    streams.set(id,stream);
    thumb(id,names.get(id)||'Participant',stream);
    if(stream.getAudioTracks().length)attachRemoteAudio(id,stream);
  }
  rebindRemoteVideo(id,stream,{force:repair});
  refreshPeerTile(id);
}
function peerStatus(id){
  const media=remoteMedia.get(id)||{};
  if(media.camera===false && !media.sharing)return 'Camera off';
  const pc=peers.get(id);
  if(pc?.connectionState==='failed' || pc?.iceConnectionState==='failed')return 'Media connection failed · TURN relay may be required';
  if(media.sharing)return 'Waiting for shared screen…';
  return 'Connecting video…';
}
function refreshPeerTile(id){
  const el=$('thumb-'+id);if(!el)return;
  const media=remoteMedia.get(id)||{};
  const visible=peerVideoLive(id) && (media.camera!==false || media.sharing);
  el.classList.toggle('camera-off',!visible);
  const status=el.querySelector('.peer-video-status');
  if(status)status.textContent=visible?'':peerStatus(id);
  const mic=el.querySelector('.remote-mic');if(mic)mic.innerHTML=micStatusSvg(media.mic===false);
  if(selectedPeer===id)refreshSpeakerMedia();
}
function refreshSpeakerMedia(){
  const isLocal=selectedPeer==='local', media=remoteMedia.get(selectedPeer)||{};
  const track=isLocal?(screenTrack||cameraTrack):preferredRemoteTrack(selectedPeer,'video');
  const visible=isLocal
    ? !!track && track.readyState==='live' && !track.muted && (!!screenTrack||cameraTrack?.enabled)
    : peerVideoLive(selectedPeer) && (media.camera!==false||media.sharing);
  $('mainVideo').classList.toggle('camera-off',!visible);
  const status=$('speakerMediaStatus');
  if(status){status.textContent=visible?'':(isLocal?'Camera off':peerStatus(selectedPeer));status.classList.toggle('hidden',visible)}
}
function setMain(peerId,manual=true){
  if(peerId!=='local'&&!names.has(peerId))return;
  const stream=streams.get(peerId)||new MediaStream();
  selectedPeer=peerId;if(manual)manualPinUntil=Date.now()+8000;
  // Stage video stays muted; all remote audio plays through one dedicated element per peer.
  $('mainVideo').srcObject=stream;$('mainVideo').muted=true;$('mainVideo').play().catch(()=>{});
  const name=peerId==='local'?c.displayName:(names.get(peerId)||'Participant');
  $('speakerName').textContent=name;$('speakerAvatar').innerHTML=avatarHTML(name,avatarFor(peerId));
  syncStageHostBadge();refreshSpeakerMedia();
  document.querySelectorAll('.participant-thumb').forEach(x=>x.classList.toggle('active',x.dataset.peer===peerId));
}
function thumb(peerId,name,stream=null){
  let el=$('thumb-'+peerId);
  if(!el){
    el=document.createElement('article');el.id='thumb-'+peerId;el.className='participant-thumb camera-off';el.dataset.peer=peerId;
    el.innerHTML=`<div class="participant-avatar">${avatarHTML(name,avatarFor(peerId))}</div><video autoplay playsinline muted></video><span class="peer-video-status" aria-live="polite">Connecting video…</span><div class="participant-name"><span class="remote-mic">${micStatusSvg(false)}</span><span class="n"></span></div>`;
    el.onclick=()=>setMain(peerId,true);$('filmstrip').appendChild(el);
  }
  el.querySelector('.n').textContent=name;
  el.querySelector('.participant-avatar').innerHTML=avatarHTML(name,avatarFor(peerId));
  if(stream){streams.set(peerId,stream);const v=el.querySelector('video');watchRemoteFrames(peerId,v);if(v.srcObject!==stream)v.srcObject=stream;v.play().catch(()=>{})}
  refreshPeerTile(peerId);return el;
}
function ensurePeerTile(p){
  // Authoritative user ID is supplied by Socket.IO, not the visible display name.
  const uid=p.user_id??p.id;
  if(uid!=null && Number.isFinite(Number(uid)))peerUserIds.set(p.sid,Number(uid));
  names.set(p.sid,p.name||p.username||names.get(p.sid)||'Participant');
  if(p.avatar!==undefined)avatars.set(p.sid,p.avatar||'');
  if(p.media)remoteMedia.set(p.sid,p.media);
  if(p.cohost!==undefined)peerCohost.set(p.sid,!!p.cohost);
  thumb(p.sid,names.get(p.sid),streams.get(p.sid)||null);
}
function removePeer(id){
  const state=peerStates.get(id);
  if(state?.retryTimer)clearTimeout(state.retryTimer);
  if(state?.answerTimer)clearTimeout(state.answerTimer);
  peerStates.delete(id);peerOperations.delete(id);remoteTracks.delete(id);
  remoteFrameAt.delete(id);lastPlayerReset.delete(id);diagnosticSamples.delete(id);
  peers.get(id)?.close(); peers.delete(id); pendingIce.delete(id);
  const audioEl=peerAudio.get(id);if(audioEl){audioEl.pause();audioEl.srcObject=null;audioEl.remove();peerAudio.delete(id)} names.delete(id); peerUserIds.delete(id); avatars.delete(id); streams.delete(id); remoteMedia.delete(id); analysers.delete(id); peerCohost.delete(id);
  $('thumb-'+id)?.remove(); if(selectedPeer===id)setMain('local',false); renderPeople();
}
// Offer, answer and ICE recovery MUST be serialized for each peer independently.
// Otherwise overlapping SDP operations can strand a third participant at "Connecting video".
function peerOperation(id, job){
  const previous=peerOperations.get(id)||Promise.resolve();
  const current=previous.catch(()=>{}).then(job);
  peerOperations.set(id,current);
  current.then(()=>{if(peerOperations.get(id)===current)peerOperations.delete(id)},
    e=>{console.error('NexaRoom peer signaling failed',id,e);if(peerOperations.get(id)===current)peerOperations.delete(id)});
  return current;
}
function negotiatePeer(id,{restart=false}={}){
  const state=peerStates.get(id), pc=peers.get(id);
  if(!state||!pc||pc.signalingState==='closed')return;
  state.needsOffer=true;
  if(restart)state.needsRestart=true;
  if(state.offerQueued)return;
  state.offerQueued=true;
  // Coalesce onnegotiationneeded, device switches, and reconnection requests.
  queueMicrotask(()=>{
    state.offerQueued=false;
    peerOperation(id,async()=>{
      if(peers.get(id)!==pc||!state.needsOffer||!socket?.connected||!roomJoined)return;
      if(pc.signalingState!=='stable')return; // retry on signalingstatechange
      state.needsOffer=false;
      state.makingOffer=true;
      try{
        if(state.needsRestart){
          state.needsRestart=false;
          if(typeof pc.restartIce==='function')pc.restartIce();
        }
        const offer=await pc.createOffer();
        await pc.setLocalDescription(offer);
        if(peers.get(id)===pc&&socket?.connected){
          socket.emit('webrtc_offer',{target:id,sdp:pc.localDescription});
          // ICE cannot fail if SDP negotiation never finishes; retry unanswered
          // offers separately, without disturbing established peer connections.
          if(state.answerTimer)clearTimeout(state.answerTimer);
          state.answerTimer=setTimeout(()=>{
            state.answerTimer=null;
            if(peers.get(id)!==pc||!roomJoined||!socket?.connected||pc.signalingState!=='have-local-offer')return;
            if(state.answerRetries>=2){console.warn('WebRTC answer timed out for',id);refreshPeerTile(id);return}
            state.answerRetries++;
            peerOperation(id,async()=>{
              if(peers.get(id)!==pc||pc.signalingState!=='have-local-offer')return;
              try{await pc.setLocalDescription({type:'rollback'});negotiatePeer(id,{restart:true})}
              catch(e){console.warn('Unanswered WebRTC offer recovery failed',id,e)}
            });
          },10000);
        }
      }catch(e){state.needsOffer=true;console.warn('Peer offer failed',id,e)}
      finally{state.makingOffer=false}
    });
  });
}
function monitorPeerConnection(id){
  const pc=peers.get(id),state=peerStates.get(id);
  if(!pc||!state)return;
  const connected=pc.connectionState==='connected'||['connected','completed'].includes(pc.iceConnectionState);
  if(connected){
    if(state.retryTimer)clearTimeout(state.retryTimer);
    state.retryTimer=null;state.retries=0;
    refreshPeerTile(id);
    // Does not expose ICE addresses in application logs.
    return;
  }
  const failed=pc.connectionState==='failed'||pc.iceConnectionState==='failed';
  const disconnected=pc.connectionState==='disconnected'||pc.iceConnectionState==='disconnected';
  if((!failed&&!disconnected)||state.retryTimer||!roomJoined||!socket?.connected)return;
  if(state.retries>=3){
    console.warn('ICE recovery exhausted for',id);
    refreshPeerTile(id);
    return;
  }
  const delay=failed?1500*(state.retries+1):7000;
  state.retryTimer=setTimeout(()=>{
    state.retryTimer=null;
    if(peers.get(id)!==pc||!socket?.connected||!roomJoined)return;
    if(pc.connectionState==='connected'||['connected','completed'].includes(pc.iceConnectionState))return;
    state.retries++;
    console.warn('Retrying WebRTC ICE for peer',id,'attempt',state.retries);
    negotiatePeer(id,{restart:true});
    // If an offer has not completed yet, the next signalingstatechange will retry.
  },delay);
}
// Chrome mutes filmstrip thumbnails; unmuting just the pinned stage loses other speakers.
// Keep one audio output per remote peer, and retry autoplay on the next user gesture.
function attachRemoteAudio(id,stream){
  if(!stream?.getAudioTracks().length)return;
  let el=peerAudio.get(id);
  if(!el){el=document.createElement('audio');el.autoplay=true;el.playsInline=true;el.className='nexaroom-peer-audio';el.dataset.peer=id;el.style.display='none';document.body.appendChild(el);peerAudio.set(id,el)}
  if(el.srcObject!==stream)el.srcObject=stream;
  el.muted=false;el.volume=1;
  el.play().catch(()=>{});
}
function unlockRemoteAudio(){for(const el of peerAudio.values())el.play().catch(()=>{})}
document.addEventListener('pointerdown',unlockRemoteAudio,{passive:true});
// The STUN/TURN URL configured in .env may be UDP-only. Coturn on :3478 also
// listens over TCP, so advertise it as a fallback for networks that block UDP.
function effectiveIceServers(){
  return (c.iceServers||[{urls:'stun:stun.l.google.com:19302'}]).map(server=>{
    const urls=Array.isArray(server.urls)?[...server.urls]:[server.urls];
    for(const u of [...urls])if(typeof u==='string'&&/^turn:/i.test(u)&&/transport=udp/i.test(u)){
      const tcp=u.replace(/transport=udp/i,'transport=tcp');if(!urls.includes(tcp))urls.push(tcp);
    }
    return {...server,urls};
  });
}
// Detect stalled inbound media even when ICE reports connected. A connected
// PeerConnection is not proof that video packets are arriving.
async function checkInboundVideo(){
  if(!roomJoined||!socket?.connected)return;
  const now=Date.now();
  for(const [id,pc] of peers){
    const state=peerStates.get(id), media=remoteMedia.get(id)||{};
    if(!state||(!media.camera&&!media.sharing))continue;
    if(pc.connectionState==='closed')continue;
    if(pc.connectionState==='failed'||pc.iceConnectionState==='failed'){monitorPeerConnection(id);continue}
    let bytes=0,hadReport=false;
    try{const reports=await pc.getStats();reports.forEach(r=>{
      if(r.type==='inbound-rtp' && !r.isRemote && (r.kind==='video'||r.mediaType==='video')){
        hadReport=true;bytes+=Number(r.bytesReceived||0);
      }
    })}catch(e){continue}
    if(!hadReport)continue;
    if(bytes>state.lastVideoBytes){
      state.lastVideoBytes=bytes;state.lastVideoAt=now;state.stallRestarts=0;
      // Data is arriving over RTP. Repair the actual video element before
      // attempting yet another ICE restart (which cannot fix a stale DOM stream).
      const v=$('thumb-'+id)?.querySelector('video');
      const last=remoteFrameAt.get(id)||0;
      if(!peerVideoLive(id)||!v||v.srcObject!==streams.get(id)||v.paused
          ||(v.requestVideoFrameCallback&&now-last>7000))
        syncPeerReceiverStream(id,null,{repair:true});
      continue;
    }
    if(!state.lastVideoAt){state.lastVideoAt=now;state.lastVideoBytes=bytes;continue}
    if(now-state.lastVideoAt<16000||state.stallRestarts>=2)continue;
    if(pc.signalingState!=='stable'||state.makingOffer)continue;
    state.stallRestarts++;state.lastVideoAt=now;
    console.warn('NexaRoom: remote video inbound bytes stalled; trying ICE restart',id,'attempt',state.stallRestarts);
    negotiatePeer(id,{restart:true});refreshPeerTile(id);
  }
}
setInterval(()=>{checkInboundVideo().catch(e=>console.warn('Video health check failed',e))},5500);
function createPeer(id,name){
  if(peers.has(id))return peers.get(id);
  names.set(id,name||names.get(id)||'Participant');
  thumb(id,names.get(id),streams.get(id)||null);
  const pc=new RTCPeerConnection({iceServers:effectiveIceServers()});
  peerStates.set(id,{makingOffer:false,ignoreOffer:false,needsOffer:false,needsRestart:false,offerQueued:false,retryTimer:null,retries:0,answerTimer:null,answerRetries:0,initialExchangeComplete:false,lastVideoBytes:0,lastVideoAt:0,stallRestarts:0});
  // A late-joining peer must receive the ACTIVE shared screen, not the old camera.
  const outbound=screenTrack?new MediaStream([screenTrack,...(localStream?.getAudioTracks()||[])]):(localStream||new MediaStream());
  outbound.getTracks().forEach(t=>pc.addTrack(t,outbound));
  // Keep a sendrecv transceiver even without a camera: desktop guests can share later.
  for(const kind of ['audio','video'])if(!pc.getSenders().some(sender=>sender.track?.kind===kind))pc.addTransceiver(kind,{direction:'sendrecv'});
  pc.onicecandidate=e=>{if(e.candidate&&socket)socket.emit('ice_candidate',{target:id,candidate:e.candidate})};
  pc.ontrack=e=>{
    // Keep one stable MediaStream per peer, merging separate audio/video events.
    // A later unmuted receiver supersedes an earlier stale/muted receiver.
    if(peers.get(id)!==pc)return; // ignore a late event from a closed/replaced SID
    syncPeerReceiverStream(id,e.track);
    if(e.track.kind==='audio'){
      const st=streams.get(id);if(st){addAnalyser(id,st);attachRemoteAudio(id,st)}
    }
    e.track.addEventListener('unmute',()=>{
      if(peers.get(id)===pc)syncPeerReceiverStream(id,e.track);
    });
    e.track.addEventListener('mute',()=>{if(peers.get(id)===pc){syncPeerReceiverStream(id);refreshPeerTile(id)}});
    e.track.addEventListener('ended',()=>{if(peers.get(id)===pc){syncPeerReceiverStream(id);refreshPeerTile(id)}});
  };
  // Initial senders are already included in the first SDP offer/answer.
  // Avoid a second, colliding offer solely because the initial transceivers fired this event.
  pc.onnegotiationneeded=()=>{if(peerStates.get(id)?.initialExchangeComplete)negotiatePeer(id)};
  pc.onsignalingstatechange=()=>{
    if(pc.signalingState==='stable'&&peerStates.get(id)?.needsOffer)negotiatePeer(id);
  };
  pc.oniceconnectionstatechange=()=>monitorPeerConnection(id);
  pc.onconnectionstatechange=()=>{
    if(pc.connectionState==='failed')console.warn('Peer video connection failed; checking ICE/TURN',id);
    monitorPeerConnection(id);
    if(pc.connectionState!=='closed')refreshPeerTile(id);
  };
  peers.set(id,pc);renderPeople();return pc;
}
async function flushIce(id){
  const pc=peers.get(id);
  if(!pc?.remoteDescription)return;
  for(const cand of (pendingIce.get(id)||[]))try{await pc.addIceCandidate(new RTCIceCandidate(cand))}catch(e){console.warn('ICE candidate rejected',e)}
  pendingIce.delete(id);
}
async function callPeer(p){
  ensurePeerTile(p);
  createPeer(p.sid,p.name||p.username);
  // Only the joining peer sends the initial offer. The receiver includes its
  // existing tracks in the answer, then enables future device renegotiation.
  if(!peerStates.get(p.sid)?.initialExchangeComplete)negotiatePeer(p.sid);
}

function participantMenu(id,name){
  if(!c.isHost)return '';
  return `<div class="participant-actions">
    <button class="person-more" data-person="${esc(id)}">•••</button>
    <div class="person-menu hidden" id="person-menu-${esc(id)}">
      <button data-action="transfer" data-target="${esc(id)}">Transfer host to this person</button>
      <button data-action="cohost" data-target="${esc(id)}">Make co-host</button>
      <button class="remove-person" data-action="remove" data-target="${esc(id)}">Remove from meeting</button>
    </div>
  </div>`;
}
function bindParticipantMenus(){
  document.querySelectorAll('.person-more').forEach(btn=>btn.onclick=e=>{
    e.stopPropagation(); document.querySelectorAll('.person-menu').forEach(m=>m.classList.add('hidden'));
    $('person-menu-'+btn.dataset.person)?.classList.toggle('hidden');
  });
  document.querySelectorAll('.person-menu button').forEach(btn=>btn.onclick=async()=>{
    const id=btn.dataset.target;
    if(btn.dataset.action==='transfer'){
      if(!socket?.connected || !roomJoined){toast('Realtime connection must be online to transfer host.');return}
      const person=names.get(id)||'this participant';
      const accepted=await appDialog({title:'Transfer meeting host?',message:`Give ${person} full host control? You will become a participant. The meeting continues.`,confirmText:'Transfer host',cancelText:'Cancel',showCancel:true});
      if(accepted)socket.emit('host_transfer',{target:id});
    }else if(btn.dataset.action==='cohost'){
      socket?.emit('host_make_cohost',{target:id}); toast('Co-host permission sent');
    }else if(btn.dataset.action==='remove'){
      const yes=await appDialog({title:'Remove participant?',message:'This participant will be disconnected from the meeting.',confirmText:'Remove',cancelText:'Cancel',danger:true,showCancel:true});
      if(yes)socket?.emit('host_remove',{target:id});
    }
  });
}
function syncStageHostBadge(){
  // HOST badge belongs to the selected person's video, not the local browser.
  const uid=selectedPeer==='local'?Number(c.userId):peerUserIds.get(selectedPeer);
  $('currentHostBadge')?.classList.toggle('hidden',uid==null||uid!==currentHostId);
}
function updateHostRole(hostId, displayName=''){
  if(hostId==null)return;
  currentHostId=Number(hostId);
  const wasHost=c.isHost;
  c.isHost=Number(c.userId)===currentHostId;
  $('hostToolsBtn')?.classList.toggle('hidden',!c.isHost);
  $('endBtn')?.classList.toggle('hidden',!c.isHost);
  $('leaveBtn')?.classList.toggle('hidden',c.isHost);
  syncStageHostBadge();
  if(!c.isHost)$('hostToolsPanel')?.classList.add('hidden');
  if(wasHost!==c.isHost)toast(c.isHost?'You are now the meeting host.':'Hosting transferred. You remain in the meeting.');
  if(displayName){const target=$('meetingHostName');if(target)target.textContent=displayName;}
  renderPeople();
}
function renderPeople(){
  const list=$('peopleList');list.innerHTML='';
  const me=document.createElement('div');me.className='person-row';
  me.innerHTML=`<div class="person-avatar">${avatarHTML(c.displayName,c.avatarUrl||'')}</div><div class="person-copy"><b>${esc(c.displayName)} (You)</b><span>${c.isHost?'Host · ':'Participant · '}In meeting</span></div>`;
  list.appendChild(me);
  for(const [id,n] of names){
    const st=remoteMedia.get(id)||{}, co=peerCohost.get(id);
    const row=document.createElement('div');row.className='person-row';
    const isRoomHost=peerUserIds.get(id)===currentHostId;
    row.innerHTML=`<div class="person-avatar">${avatarHTML(n,avatarFor(id))}</div><div class="person-copy"><b>${esc(n)}${isRoomHost?' <em>HOST</em>':co?' <em>CO-HOST</em>':''}</b><span>${st.mic===false?'Muted':'Microphone on'} · ${st.sharing?'Sharing screen':st.camera===false?'Camera off':'Camera on'}</span></div>${participantMenu(id,n)}`;
    list.appendChild(row);
  }
  bindParticipantMenus();
  const n=1+names.size; $('peopleCount').textContent=n;$('toolbarPeopleCount').textContent=n;$('infoPeopleCount').textContent=n;
}
function emitMedia(){
  if(socket?.connected)socket.emit('media_state',{mic:!!localStream?.getAudioTracks()[0]?.enabled,camera:!!cameraTrack?.enabled,sharing:!!screenTrack});
}
function addAnalyser(id,stream){
  try{
    if(!audioCtx)audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    const tracks=stream.getAudioTracks();if(!tracks.length)return;
    const src=audioCtx.createMediaStreamSource(new MediaStream([tracks[0]])), an=audioCtx.createAnalyser();
    an.fftSize=256;src.connect(an);analysers.set(id,an);
  }catch{}
}
function monitorSpeaker(){
  if(Date.now()<manualPinUntil)return;
  let best=null,bestVol=.028;
  for(const [id,an] of analysers){
    const a=new Uint8Array(an.frequencyBinCount);an.getByteFrequencyData(a);
    const avg=a.reduce((s,v)=>s+v,0)/(a.length*255), card=id==='local'?$('thumb-local'):$('thumb-'+id);
    card?.classList.toggle('speaking',avg>.035);if(avg>bestVol){bestVol=avg;best=id}
  }
  if(best&&best!==selectedPeer)setMain(best,false);
}

async function waitForIO(){
  if(window.io)return window.io;
  return new Promise((resolve,reject)=>{
    const ok=()=>{cleanup();resolve(window.io)},bad=()=>{cleanup();reject(new Error('Socket.IO client could not load.'))};
    const cleanup=()=>{window.removeEventListener('nexaroom-socket-ready',ok);window.removeEventListener('nexaroom-socket-failed',bad)};
    window.addEventListener('nexaroom-socket-ready',ok,{once:true});window.addEventListener('nexaroom-socket-failed',bad,{once:true});
    setTimeout(()=>window.io?ok():bad(),22000);
  });
}
function applyPolicy(p={}){
  currentPolicy={...currentPolicy,...p};
  if($('allowChatToggle'))$('allowChatToggle').checked=currentPolicy.allow_chat!==false;
  if($('allowShareToggle'))$('allowShareToggle').checked=currentPolicy.allow_screen_share!==false;
  if($('allowUnmuteToggle'))$('allowUnmuteToggle').checked=currentPolicy.allow_unmute!==false;
  if($('allowVideoToggle'))$('allowVideoToggle').checked=currentPolicy.allow_video!==false;
  $('chatBtn')?.classList.toggle('restricted',currentPolicy.allow_chat===false&&!c.isHost);
  $('screenBtn')?.classList.toggle('restricted',currentPolicy.allow_screen_share===false&&!c.isHost);
}
async function connectRealtime(){
  const ioLib=await waitForIO();
  // Start over HTTP polling, then upgrade to WebSocket when nginx/mobile networks allow it.
  // WebSocket-first connections can fail outright on some mobile networks/proxies.
  socket=ioLib({path:'/socket.io',transports:['polling','websocket'],upgrade:true,rememberUpgrade:false,
    withCredentials:true,reconnection:true,reconnectionAttempts:Infinity,
    reconnectionDelay:900,reconnectionDelayMax:8000,timeout:20000});
  socket.on('connect',()=>{$('connectionState').textContent='Connecting to room…';socket.emit('join_room',{room:c.room,invite_token:c.inviteToken||''});emitMedia()});
  socket.on('connect_error',e=>{
    const message=String(e?.message||'Network/proxy error');
    $('connectionState').textContent='Reconnecting to meeting…';
    console.error('NexaRoom Socket.IO connection failed', message, e?.data||'');
    // An authenticated meeting MUST NOT silently redirect or create a new room.
    // Keep retrying this same room ID and report the real error to the user.
    if(message.toLowerCase().includes('authentication') || message.toLowerCase().includes('unauthorized')){
      fatal('Realtime authentication was rejected. Sign in again in this browser, then reopen the SAME invitation link.');
    }else{
      fatal('Realtime signaling unavailable ('+message+'). Your meeting was not moved or recreated. Reconnecting…');
    }
  });
  socket.on('disconnect',()=>{$('connectionState').textContent='Realtime disconnected — reconnecting…';roomJoined=false;renderPeople()});
  socket.on('room-ready',async d=>{
    roomJoined=true; if($('fatalBanner'))$('fatalBanner').classList.add('hidden');$('connectionState').textContent='Connected · Room ready';startedAt=d.meeting.started_at?new Date(d.meeting.started_at).getTime():Date.now();applyPolicy(d.policy||{});
    $('lockBadge')?.classList.toggle('hidden',!d.meeting.locked); if($('lockMeetingToggle'))$('lockMeetingToggle').checked=!!d.meeting.locked;
    // Reconnects replace stale SIDs; rebuild participant state from the authoritative room snapshot.
    for(const id of [...names.keys()])removePeer(id);
    updateHostRole(d.meeting.host_id);
    // Render ALL participants first; slow/failed media negotiations cannot hide a tile.
    for(const p of d.peers)ensurePeerTile(p);
    renderPeople();
    for(const p of d.peers)try{await callPeer(p)}catch(e){console.error('Peer offer failed',e);refreshPeerTile(p.sid)}
    // If someone was ALREADY sharing when we joined, focus their stage now;
    // no subsequent media-state event is guaranteed to fire.
    const presenter=d.peers.find(p=>p.media?.sharing===true);
    if(presenter&&names.has(presenter.sid)){setMain(presenter.sid,false);manualPinUntil=0}
    // The initial media_state sent on socket.connect can race with join_room;
    // resend after room-ready to keep camera-off and mic-off labels accurate.
    emitMedia();
  });
  socket.on('peer-joined',p=>{ensurePeerTile(p);renderPeople();toast((p.name||p.username)+' joined')});
  socket.on('webrtc-offer',d=>{
    if(!d?.from||!d.sdp||!roomJoined)return;
    const pc=createPeer(d.from,d.name), state=peerStates.get(d.from);
    peerOperation(d.from,async()=>{
      if(peers.get(d.from)!==pc)return;
      const collision=state.makingOffer||pc.signalingState!=='stable';
      // Deterministic perfect-negotiation role: only one side rolls back.
      const polite=String(socket.id)<String(d.from);
      state.ignoreOffer=!polite&&collision;
      if(state.ignoreOffer){console.warn('Ignoring colliding offer from',d.from);return}
      try{
        if(collision&&pc.signalingState==='have-local-offer'){
          if(state.answerTimer)clearTimeout(state.answerTimer);
          state.answerTimer=null;
          await pc.setLocalDescription({type:'rollback'});
        }
        await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
        state.ignoreOffer=false;
        await flushIce(d.from);
        const answer=await pc.createAnswer();
        await pc.setLocalDescription(answer);
        state.initialExchangeComplete=true;
        if(socket?.connected&&peers.get(d.from)===pc)socket.emit('webrtc_answer',{target:d.from,sdp:pc.localDescription});
      }catch(e){console.error('Failed to accept WebRTC offer',d.from,e);monitorPeerConnection(d.from)}
    });
  });
  socket.on('webrtc-answer',d=>{
    const pc=peers.get(d?.from);if(!pc||!d.sdp)return;
    peerOperation(d.from,async()=>{
      if(peers.get(d.from)!==pc||pc.signalingState!=='have-local-offer')return;
      try{
        await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
        const state=peerStates.get(d.from);
        if(state?.answerTimer)clearTimeout(state.answerTimer);
        if(state){state.answerTimer=null;state.answerRetries=0;state.ignoreOffer=false;state.initialExchangeComplete=true}
        await flushIce(d.from);
      }
      catch(e){console.error('Failed to accept WebRTC answer',d.from,e);monitorPeerConnection(d.from)}
    });
  });
  socket.on('ice-candidate',async d=>{
    if(!d?.candidate)return;
    const pc=peers.get(d.from);
    // Do not globally discard ICE on a glare: the valid answer's candidates can
    // arrive before its SDP and are indistinguishable from a discarded offer.
    if(!pc?.remoteDescription){const queue=pendingIce.get(d.from)||[];if(queue.length<200)queue.push(d.candidate);pendingIce.set(d.from,queue);return}
    try{await pc.addIceCandidate(new RTCIceCandidate(d.candidate))}catch(e){console.warn('ICE candidate failed',e)}
  });
  socket.on('peer-left',d=>removePeer(d.sid));
  socket.on('host-changed',d=>updateHostRole(d.host_id,d.host_name));
  socket.on('host-transfer-error',d=>toast(d.message||'Host transfer failed.'));
  socket.on('media-state',d=>{
    const wasSharing=remoteMedia.get(d.sid)?.sharing===true;
    remoteMedia.set(d.sid,d);if(names.has(d.sid))thumb(d.sid,names.get(d.sid));
    // Screen-share should become visible for ALL attendees, not only the presenter.
    if(d.sharing && !wasSharing && names.has(d.sid)){setMain(d.sid,false);manualPinUntil=0;}
    else if(!d.sharing && wasSharing && selectedPeer===d.sid)setMain('local',false);
    refreshPeerTile(d.sid);renderPeople();
  });
  socket.on('room-policy',d=>{applyPolicy(d.policy||{});toast('Host updated meeting permissions')});
  socket.on('meeting-lock',d=>{$('lockBadge')?.classList.toggle('hidden',!d.locked);if($('lockMeetingToggle'))$('lockMeetingToggle').checked=!!d.locked;toast(d.locked?'Meeting locked':'Meeting unlocked')});
  socket.on('host-mute',d=>{const t=localStream?.getAudioTracks()[0];if(t){t.enabled=false;syncLocalMicUI(false);emitMedia()}toast(d.message||'Host muted your microphone')});
  socket.on('policy-message',d=>toast(d.message||'This feature is disabled by the host.'));
  socket.on('cohost-status',d=>{peerCohost.set(d.sid,!!d.cohost);renderPeople();if(d.sid===socket.id)toast('You are now a co-host')});
  socket.on('removed-from-meeting',async d=>{await appDialog({title:'Removed from meeting',message:d.message||'The host removed you from this room.',confirmText:'Back to workspace'});location.href='/'});
  socket.on('room-error',async d=>{
    const message=String(d?.message||'This meeting is unavailable.');
    const title=/already ended|meeting has ended/i.test(message)?'Meeting has ended'
      :/full|capacity|participant limit|maximum/i.test(message)?'Meeting is full'
      :/locked|invite|passcode|access/i.test(message)?'Unable to join this meeting':'Unable to join meeting';
    await appDialog({title,message,confirmText:'Back to workspace'});location.href='/';
  });
  socket.on('meeting-ended',d=>showMeetingEnded(d));
  socket.on('reaction',showReaction);socket.on('chat-message',addChat);socket.on('encrypted-file',receiveFile);socket.on('whiteboard-draw',drawBoard);socket.on('whiteboard-clear',clearBoardLocal);socket.on('caption-line',showCaption);
}

function syncLocalMicUI(enabled){
  $('micBtn').classList.toggle('off',!enabled);$('micBtn').querySelector('small').textContent=enabled?'Mute':'Unmute';
  const holder=$('localMuteMark'); if(holder)holder.outerHTML= enabled
    ? '<span id="localMuteMark" class="mute-status mic-on"><svg viewBox="0 0 24 24"><path d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zM6 11.5v.5a6 6 0 0 0 12 0v-.5M12 18v3M9 21h6"/></svg></span>'
    : '<span id="localMuteMark" class="mute-status mic-off"><svg viewBox="0 0 24 24"><path d="M9 8v4a3 3 0 0 0 4.7 2.5M15 11V7a3 3 0 0 0-5.4-1.8M6 11.5v.5a6 6 0 0 0 9.8 4.6M12 18v3M9 21h6M4 4l16 16"/></svg></span>';
}

$('thumb-local').onclick=()=>setMain('local',true);
$('micBtn').onclick=()=>{
  const t=localStream?.getAudioTracks()[0];if(!t)return;
  if(!t.enabled && !c.isHost && currentPolicy.allow_unmute===false)return toast('Host disabled participant unmute.');
  t.enabled=!t.enabled;syncLocalMicUI(t.enabled);emitMedia();
};
$('camBtn').onclick=()=>{
  if(!cameraTrack){$('settingsModal').classList.remove('hidden');loadDevices();toast('Choose an available camera under Devices.');return}
  if(!cameraTrack.enabled&&!c.isHost&&currentPolicy.allow_video===false)return toast('Host disabled participant video.');
  cameraTrack.enabled=!cameraTrack.enabled;$('camBtn').classList.toggle('off',!cameraTrack.enabled);$('camBtn').querySelector('small').textContent=cameraTrack.enabled?'Stop Video':'Start Video';
  $('thumb-local').classList.toggle('camera-off',!cameraTrack.enabled);if(selectedPeer==='local')refreshSpeakerMedia();emitMedia();
};
$('screenBtn').onclick=async()=>{
  if(!c.allowScreenShare)return toast('Screen sharing is unavailable for this meeting plan.');
  if(!c.isHost&&currentPolicy.allow_screen_share===false)return toast('Screen sharing is disabled by the host.');
  if(screenTrack){await stopShare();return}
  if(typeof navigator.mediaDevices?.getDisplayMedia!=='function'){
    await appDialog({title:'Screen sharing unavailable on this browser',message:'The host allows everyone to share, but this mobile browser does not provide screen capture. Please use Chrome or Edge on a desktop/laptop. Android phone-screen sharing would require a native app.',confirmText:'OK'});
    return;
  }
  let captureTrack=null;
  const changedSenders=[];
  try{
    const capture=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:30}},audio:false});
    captureTrack=capture.getVideoTracks()[0];if(!captureTrack)throw new Error('No screen track returned');
    // A sendrecv video transceiver exists even when the user joined camera-off.
    for(const pc of peers.values()){
      const sender=pc.getSenders().find(x=>x.track?.kind==='video')
        ||pc.getTransceivers().find(x=>x.receiver?.track?.kind==='video')?.sender;
      if(sender){const previous=sender.track;await sender.replaceTrack(captureTrack);changedSenders.push([sender,previous])}
    }
    screenTrack=captureTrack;
    streams.set('local',new MediaStream([screenTrack,...(localStream?.getAudioTracks()||[])]));
    $('localThumbVideo').srcObject=streams.get('local');setMain('local',false);
    $('screenBtn').classList.add('active');$('screenBtn').querySelector('small').textContent='Stop Share';screenTrack.onended=stopShare;emitMedia();
    // Browser capture starting is NOT proof that remote WebRTC peers receive it.
    const failed=[...peers.values()].filter(pc=>pc.connectionState==='failed'||pc.iceConnectionState==='failed');
    if(failed.length)toast('Sharing locally, but some peer connections failed. A TURN relay may be needed.');
  }catch(e){
    if(captureTrack&&!screenTrack){
      for(const [sender,previous] of changedSenders)try{await sender.replaceTrack(previous)}catch(err){console.warn('Share rollback failed',err)}
      captureTrack.stop();
    }
    if(e.name==='NotAllowedError'){toast('Screen sharing was cancelled or blocked by the browser.');return}
    console.error('Screen capture failed',e);toast('Screen sharing failed: '+(e?.message||e?.name||'check browser permissions'));
  }
};
let stoppingShare=false;
async function stopShare(){
  const active=screenTrack;
  if(!active||stoppingShare)return;
  stoppingShare=true;
  try{
    for(const [id,pc] of peers){
      const sender=pc.getSenders().find(x=>x.track?.kind==='video')
        ||pc.getTransceivers().find(x=>x.receiver?.track?.kind==='video')?.sender;
      if(!sender)continue;
      try{await sender.replaceTrack(cameraTrack?.readyState==='live'?cameraTrack:null)}
      catch(err){
        console.warn('Share stop: video sender replacement failed for',id,err);
        negotiatePeer(id); // best-effort recovery without blocking other peers
      }
    }
  }finally{
    // Always signal share STOP and restore local camera, even on one peer error.
    active.onended=null;
    try{active.stop()}catch{}
    if(screenTrack===active){
      screenTrack=null;
      streams.set('local',localStream);
      $('localThumbVideo').srcObject=localStream;
      if(selectedPeer==='local')setMain('local',false);
      $('screenBtn').classList.remove('active');
      $('screenBtn').querySelector('small').textContent='Share';
      emitMedia();
    }
    stoppingShare=false;
  }
}

$('copyInvite').onclick=copyInvite;$('copyInfoInvite').onclick=copyInvite;
function inviteUrl(){
  const base=(c.publicBaseUrl||location.origin).replace(/\/$/,'');
  const u=new URL(c.joinPath||'/meeting/join/',base+'/');
  u.searchParams.set('invite',String(c.meetingCode||'').replace(/\s/g,''));
  if(c.passcode)u.searchParams.set('passcode',c.passcode);
  if(c.inviteToken)u.searchParams.set('token',c.inviteToken);
  if(roomKeyToken)u.searchParams.set('k',roomKeyToken);
  return u.toString();
}
async function copyText(text){
  try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return true}}catch{}
  const ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
  let ok=false;try{ok=document.execCommand('copy')}catch{}ta.remove();return ok;
}
async function copyInvite(){const url=inviteUrl();const ok=await copyText(url);if($('inviteLinkValue'))$('inviteLinkValue').value=url;toast(ok?'Invite link copied':'Select and copy the invite link')}
function openMeetingInfo(){$('inviteLinkValue').value=inviteUrl();$('meetingInfoModal').classList.remove('hidden')}
$('meetingInfoBtn').onclick=openMeetingInfo;$('moreMeetingInfo').onclick=()=>{$('moreMenu').classList.add('hidden');openMeetingInfo()};
$('closeMeetingInfo').onclick=()=>$('meetingInfoModal').classList.add('hidden');

function stopLocalMedia(){
  try{localStream?.getTracks().forEach(t=>t.stop());screenTrack?.stop();socket?.disconnect()}catch{}
}
$('leaveBtn')?.addEventListener('click',async()=>{
  const yes=await appDialog({title:'Leave meeting?',message:'Are you sure you want to leave? The meeting will continue for everyone else.',confirmText:'Leave meeting',cancelText:'Stay',danger:true,showCancel:true});
  if(!yes)return;
  stopLocalMedia();location.href='/';
});
$('endBtn')?.addEventListener('click',async()=>{
  if(endingMeeting)return;
  const yes=await appDialog({title:'End meeting for everyone?',message:'All participants will leave this NexaRoom. You cannot restart an ended meeting.',confirmText:'End meeting',cancelText:'Keep meeting',danger:true,showCancel:true});
  if(!yes)return;
  endingMeeting=true;
  try{
    // Authenticated HTTP fallback: ending works even if Socket.IO failed.
    const resp=await fetch(c.endMeetingUrl,{method:'POST',credentials:'same-origin',headers:{'X-CSRFToken':c.csrfToken,'X-Requested-With':'XMLHttpRequest'}});
    if(!resp.ok)throw new Error('Server returned '+resp.status);
    if(socket?.connected)socket.emit('end_meeting');
    stopLocalMedia();location.href='/';
  }catch(e){endingMeeting=false;toast('Could not end meeting. Please retry.');console.error('End meeting HTTP fallback failed',e)}
});
// Periodic status check so peers are informed even during Socket.IO outage.
setInterval(async()=>{
  if(endingMeeting)return;
  try{const r=await fetch(c.meetingStateUrl,{credentials:'same-origin',cache:'no-store'});if(r.ok){const x=await r.json();if(x.status==='ended')await showMeetingEnded(x)}}catch{}
},12000);

function openSide(tab){
  if(tab==='chat')chatUnread=0;
  if(tab==='files')fileUnread=0;
  updateActivityBadges();
  $('sidePanel').classList.remove('closed');document.querySelectorAll('.side-pane').forEach(x=>x.classList.add('hidden'));$('tab-'+tab).classList.remove('hidden');
  document.querySelectorAll('.side-tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
}
$('chatBtn').onclick=()=>openSide('chat');$('peopleBtn').onclick=()=>openSide('people');
$('moreBtn').onclick=e=>{e.stopPropagation();$('moreMenu').classList.toggle('hidden')};
document.addEventListener('click',e=>{if(!$('moreMenu').classList.contains('hidden')&&!e.target.closest('.more-wrap'))$('moreMenu').classList.add('hidden');document.querySelectorAll('.person-menu').forEach(m=>{if(!e.target.closest('.participant-actions'))m.classList.add('hidden')})});
$('fileBtn').onclick=()=>{$('moreMenu').classList.add('hidden');openSide('files');$('fileInput').click()};
$('closeSide').onclick=()=>$('sidePanel').classList.add('closed');
document.querySelectorAll('.side-tab').forEach(b=>b.onclick=()=>openSide(b.dataset.tab));

$('chatForm').onsubmit=e=>{
  e.preventDefault();const t=$('chatInput').value.trim();if(!t)return;
  if(!c.isHost&&currentPolicy.allow_chat===false)return toast('Chat is disabled by the host.');
  if(socket?.connected){pendingOwnChats.push({text:t,at:Date.now()});socket.emit('chat_message',{text:t});$('chatInput').value=''}
};
function addChat(m){
  document.querySelector('.empty-chat')?.remove();const r=document.createElement('div');r.className='chat-msg';
  r.innerHTML=`<div><b>${esc(m.sender)}</b><span>${new Date(m.at||Date.now()).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div><p>${esc(m.text)}</p>`;
  $('chatMessages').appendChild(r);$('chatMessages').scrollTop=$('chatMessages').scrollHeight;
  // Server echoes local outgoing messages; do not alert the sender about their own text.
  const now=Date.now();while(pendingOwnChats.length&&now-pendingOwnChats[0].at>15000)pendingOwnChats.shift();
  const idx=m.sender===c.displayName?pendingOwnChats.findIndex(x=>x.text===m.text):-1;
  if(idx>=0){pendingOwnChats.splice(idx,1);return;}
  if(!isTabOpen('chat'))chatUnread++;
  updateActivityBadges();
  meetingNotice('chat',`${m.sender||'Participant'} sent a message`,m.text);
}

$('reactBtn').onclick=()=>$('reactionMenu').classList.toggle('hidden');
$('reactionMenu').querySelectorAll('button').forEach(b=>b.onclick=()=>{socket?.emit('reaction',{emoji:b.textContent});$('reactionMenu').classList.add('hidden')});
function showReaction(r){const x=document.createElement('div');x.className='floating-reaction';x.innerHTML=`<b>${esc(r.name)}</b> ${esc(r.emoji)}`;$('reactionLayer').appendChild(x);setTimeout(()=>x.remove(),2600)}

function b64(b){let x='';b.forEach(v=>x+=String.fromCharCode(v));return btoa(x).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function un64(v){v=v.replace(/-/g,'+').replace(/_/g,'/');while(v.length%4)v+='=';const x=atob(v);return Uint8Array.from(x,a=>a.charCodeAt(0))}
async function initKey(){
  const h=new URLSearchParams(location.hash.slice(1));let k=h.get('k');
  if(!k&&c.isHost){k=b64(crypto.getRandomValues(new Uint8Array(32)));history.replaceState(null,'',location.pathname+location.search+'#k='+k)}
  roomKeyToken=k||null;
  if(k)roomKey=await crypto.subtle.importKey('raw',un64(k),{name:'AES-GCM'},false,['encrypt','decrypt']);else toast('Invite encryption key missing.');
}
$('fileInput').onchange=async()=>{
  const f=$('fileInput').files?.[0];if(!f)return;if(!c.allowFiles)return toast('File sharing disabled.');
  if(f.size>c.maxFileMb*1024*1024)return toast(`Maximum file size is ${c.maxFileMb} MB`);if(!roomKey)return toast('Secure room key unavailable.');
  const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},roomKey,await f.arrayBuffer());
  socket?.emit('encrypted_file',{name:f.name,type:f.type,size:f.size,iv:Array.from(iv),cipher});addFile('You',f.name,null,true);$('fileInput').value='';
};
function addFile(sender,name,url,sent){
  const r=document.createElement('div');r.className='file-row';r.innerHTML=`<div><b>${esc(name)}</b><span>${esc(sender)}</span></div>`;
  if(url){const a=document.createElement('a');a.href=url;a.download=name;a.textContent='Download';r.appendChild(a)}else{const s=document.createElement('span');s.textContent=sent?'Sent':'';r.appendChild(s)}
  $('fileList').prepend(r);
}
async function receiveFile(p){
  try{const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(p.iv)},roomKey,p.cipher),url=URL.createObjectURL(new Blob([plain],{type:p.type}));addFile(p.sender,p.name,url,false);if(!isTabOpen('files'))fileUnread++;updateActivityBadges();meetingNotice('file',`${p.sender||'Participant'} shared a file`,p.name)}
  catch{toast('Could not decrypt the shared file.')}
}

const boardModal=$('boardModal'),cv=$('whiteboard'),ctx=cv.getContext('2d');let drawing=false,last=null;
function resizeBoard(){const r=cv.getBoundingClientRect(),d=devicePixelRatio||1;cv.width=r.width*d;cv.height=r.height*d;ctx.setTransform(d,0,0,d,0,0);ctx.lineCap='round'}
function point(e){const r=cv.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}}
function drawBoard(a){const r=cv.getBoundingClientRect();ctx.strokeStyle=a.c;ctx.lineWidth=a.w;ctx.beginPath();ctx.moveTo(a.x0*r.width,a.y0*r.height);ctx.lineTo(a.x1*r.width,a.y1*r.height);ctx.stroke()}
function clearBoardLocal(){ctx.clearRect(0,0,cv.width,cv.height)}
$('boardBtn').onclick=()=>{$('moreMenu').classList.add('hidden');if(!c.allowWhiteboard)return toast('Whiteboard disabled.');boardModal.classList.remove('hidden');setTimeout(resizeBoard,30)};
$('closeBoard').onclick=()=>boardModal.classList.add('hidden');cv.onpointerdown=e=>{drawing=true;last=point(e)};cv.onpointermove=e=>{if(!drawing)return;const p=point(e),a={x0:last.x,y0:last.y,x1:p.x,y1:p.y,c:$('boardColor').value,w:+$('boardSize').value};drawBoard(a);socket?.emit('whiteboard_draw',a);last=p};window.addEventListener('pointerup',()=>{drawing=false;last=null});$('clearBoard').onclick=()=>{clearBoardLocal();socket?.emit('whiteboard_clear')};

/* Host tools */
$('hostToolsBtn')?.addEventListener('click',()=>{$('hostToolsPanel').classList.remove('hidden')});
$('closeHostTools')?.addEventListener('click',()=>$('hostToolsPanel').classList.add('hidden'));
$('muteAllBtn')?.addEventListener('click',async()=>{const yes=await appDialog({title:'Mute everyone?',message:'All other participants will be muted.',confirmText:'Mute all',cancelText:'Cancel',showCancel:true});if(yes)socket?.emit('host_mute_all')});
[['allowChatToggle','allow_chat'],['allowShareToggle','allow_screen_share'],['allowUnmuteToggle','allow_unmute'],['allowVideoToggle','allow_video']].forEach(([id,name])=>{
  $(id)?.addEventListener('change',e=>socket?.emit('host_policy',{name,value:e.target.checked}));
});
$('lockMeetingToggle')?.addEventListener('change',e=>socket?.emit('host_policy',{name:'locked',value:e.target.checked}));

/* Safe one-click connection diagnostics. Never expose ICE addresses, TURN passwords
   or SDP tokens in a shared report; only candidate types and RTP byte counts. */
async function meetingConnectionReport(){
  const report={version:'V9.8',roomJoined,signaling:socket?.connected?'connected':'disconnected',
    peers:[],turnOffered:effectiveIceServers().some(s=>(Array.isArray(s.urls)?s.urls:[s.urls]).some(u=>typeof u==='string'&&u.startsWith('turn:')))};
  for(const [sid,pc] of peers){
    const m=remoteMedia.get(sid)||{};
    const p={name:names.get(sid)||'Participant',signaling:pc.signalingState,
      expectedCamera:m.camera??null,expectedSharing:m.sharing??null,
      frameRenderedAgeMs:remoteFrameAt.has(sid)?Date.now()-remoteFrameAt.get(sid):null,
      tileVisible:peerVideoLive(sid),isSelectedStage:selectedPeer===sid,
      ice:pc.iceConnectionState,connection:pc.connectionState,
      remoteVideoBytes:0,remoteAudioBytes:0,remoteVideoFrames:0,selectedRoute:'unknown',
      videoTrackState:preferredRemoteTrack(sid,'video')?.readyState||'missing',
      videoTrackMuted:preferredRemoteTrack(sid,'video')?.muted??null,
      videoPlayerReadyState:$('thumb-'+sid)?.querySelector('video')?.readyState??null,
      videoPlayerWidth:$('thumb-'+sid)?.querySelector('video')?.videoWidth??null,
      videoPlayerPaused:$('thumb-'+sid)?.querySelector('video')?.paused??null};
    try{
      const stats=await pc.getStats();let pair=null;
      stats.forEach(x=>{
        if(x.type==='transport' && x.selectedCandidatePairId)pair=stats.get(x.selectedCandidatePairId);
        if(x.type==='candidate-pair' && x.selected && x.state==='succeeded')pair=x;
        if(x.type==='inbound-rtp' && !x.isRemote){
          if(x.kind==='video'||x.mediaType==='video'){p.remoteVideoBytes+=x.bytesReceived||0;p.remoteVideoFrames+=x.framesDecoded||0}
          if(x.kind==='audio'||x.mediaType==='audio')p.remoteAudioBytes+=x.bytesReceived||0;
        }
      });
      const prior=diagnosticSamples.get(sid);
      p.sampleGapSeconds=prior?Math.round((Date.now()-prior.time)/100)/10:null;
      p.videoBytesSincePrevious=prior?Math.max(0,p.remoteVideoBytes-prior.bytes):null;
      p.videoFramesSincePrevious=prior?Math.max(0,p.remoteVideoFrames-prior.frames):null;
      diagnosticSamples.set(sid,{time:Date.now(),bytes:p.remoteVideoBytes,frames:p.remoteVideoFrames});
      if(pair){const local=stats.get(pair.localCandidateId),remote=stats.get(pair.remoteCandidateId);
        p.selectedRoute=(local?.candidateType||'?')+' / '+(remote?.candidateType||'?');}
    }catch(e){p.statsError=e.name||'Unavailable'}
    report.peers.push(p);
  }
  return report;
}
window.NexaRoomConnectionReport=meetingConnectionReport;
$('networkDebugBtn')?.addEventListener('click',async()=>{
  $('moreMenu').classList.add('hidden');
  try{const report=JSON.stringify(await meetingConnectionReport(),null,2);
    console.info('NexaRoom connection diagnostics (no IP addresses):',report);
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(report);toast('Connection diagnostics copied. Share without credentials.');}
    else await appDialog({title:'Connection diagnostics',message:report,confirmText:'OK'});
  }catch(e){console.warn('Connection diagnostics failed',e);toast('Could not copy diagnostics; check Chrome console.')}
});

/* Recording: draw all connected participants to a single stable 720p canvas.
   Capture selected/pinned speaker separately would lose people when stage switches.
   Mix audio tracks from ALL peers; never record only the currently selected peer. */
function recordingSources(){
  const entries=[['local',c.displayName,localStream]];
  for(const [id,name] of names)entries.push([id,name,streams.get(id)]);
  return entries;
}
function drawRecordingFrame(session){
  if(!session.running)return;
  const {ctx,canvas}=session, members=recordingSources();
  ctx.fillStyle='#091322';ctx.fillRect(0,0,canvas.width,canvas.height);
  const n=members.length,cols=n===1?1:2,rows=Math.ceil(n/cols);
  const gap=12,w=(canvas.width-gap*(cols+1))/cols,h=(canvas.height-gap*(rows+1))/rows;
  for(let i=0;i<n;i++){
    const [id,name,stream]=members[i],x=gap+(i%cols)*(w+gap),y=gap+Math.floor(i/cols)*(h+gap);
    ctx.fillStyle='#12313a';ctx.fillRect(x,y,w,h);
    const v=id==='local'?$('localThumbVideo'):$('thumb-'+id)?.querySelector('video');
    const track=stream?.getVideoTracks()[0];
    if(v&&track?.readyState==='live'&&!track.muted&&v.readyState>=2&&v.videoWidth){
      const ratio=Math.max(w/v.videoWidth,h/v.videoHeight),sw=w/ratio,sh=h/ratio;
      const sx=(v.videoWidth-sw)/2,sy=(v.videoHeight-sh)/2;
      try{ctx.drawImage(v,sx,sy,sw,sh,x,y,w,h)}catch(e){}
    }else{
      ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#d3eeee';ctx.font='bold 36px Arial';ctx.fillText(initials(name),x+w/2,y+h/2);
    }
    ctx.fillStyle='rgba(4,18,30,.82)';ctx.fillRect(x,y+h-35,w,35);
    ctx.textAlign='left';ctx.textBaseline='middle';ctx.font='17px Arial';ctx.fillStyle='white';
    ctx.fillText(String(name).slice(0,35),x+12,y+h-17);
  }
  session.animation=requestAnimationFrame(()=>drawRecordingFrame(session));
}
function refreshRecordingAudio(session){
  const existing=new Set();
  for(const [id,,stream] of recordingSources()){
    const audioTrack=stream?.getAudioTracks()[0];if(!audioTrack||audioTrack.readyState==='ended')continue;
    const key=id+':'+audioTrack.id;existing.add(key);
    if(session.audioNodes.has(key))continue;
    try{
      const source=session.audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
      source.connect(session.destination);session.audioNodes.set(key,source);
    }catch(e){console.warn('Recording audio track unavailable',id,e)}
  }
  for(const [key,node] of session.audioNodes)if(!existing.has(key)){
    try{node.disconnect()}catch{}session.audioNodes.delete(key);
  }
}
function recordingType(){
  for(const type of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/webm;codecs=vp8,opus','video/webm']){
    if(MediaRecorder.isTypeSupported(type))return type;
  }
  return '';
}
async function finishRecording(){
  const session=recordingSession;recordingSession=null;
  if(session){
    session.running=false;cancelAnimationFrame(session.animation);clearInterval(session.audioTimer);
    session.audioNodes.forEach(node=>{try{node.disconnect()}catch{}});
    session.recordStream.getTracks().forEach(track=>track.stop());
    try{session.silentOscillator?.stop()}catch{}
    try{await session.audioContext?.close()}catch{}
  }
  recording=false;$('recordBtn').classList.remove('recording');$('recordBtn').querySelector('b').textContent='Record meeting';
}
$('recordBtn').onclick=async()=>{
  $('moreMenu').classList.add('hidden');
  if(recording){if(recorder&&recorder.state!=='inactive')recorder.stop();return}
  if(!window.MediaRecorder||!HTMLCanvasElement.prototype.captureStream)return toast('Recording is unavailable in this browser.');
  let session=null;
  try{
    const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
    const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw Error('Cannot initialize recording canvas');
    const picture=canvas.captureStream(24);
    const Audio=window.AudioContext||window.webkitAudioContext;
    const audioContext=Audio?new Audio():null;
    if(audioContext)await audioContext.resume();
    const destination=audioContext?.createMediaStreamDestination();
    // Keep audio encoder clock running even when everyone is muted or has no mic.
    // Chromium may otherwise produce an empty WebM from a video+silent audio track.
    let silentOscillator=null;
    if(audioContext&&destination){silentOscillator=audioContext.createOscillator();const gain=audioContext.createGain();gain.gain.value=0;silentOscillator.connect(gain).connect(destination);silentOscillator.start()}
    const recordStream=new MediaStream([...picture.getVideoTracks(),...(destination?.stream.getAudioTracks()||[])]);
    session={canvas,ctx,audioContext,destination,recordStream,animation:0,audioTimer:0,audioNodes:new Map(),silentOscillator,running:true};
    recordingSession=session;drawRecordingFrame(session);
    if(audioContext){refreshRecordingAudio(session);session.audioTimer=setInterval(()=>refreshRecordingAudio(session),1500)}
    const type=recordingType();
    recordedChunks=[];
    recorder=new MediaRecorder(recordStream,type?{mimeType:type,videoBitsPerSecond:2200000}:{});
    recorder.ondataavailable=e=>{if(e.data?.size)recordedChunks.push(e.data)};
    recorder.onerror=e=>console.error('Recording failed',e);
    recorder.onstop=async()=>{
      const mime=recorder.mimeType||type||'video/webm';
      const ext=mime.startsWith('video/mp4')?'mp4':'webm';
      const blob=new Blob(recordedChunks,{type:mime});
      if(blob.size){const url=URL.createObjectURL(blob),a=document.createElement('a');
        a.href=url;a.download=`NexaRoom-${c.meetingCode.replace(/\s/g,'-')}.${ext}`;
        document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
        toast(`Recording saved (${ext.toUpperCase()})`);
      }else toast('Recording was empty; browser capture may have failed.');
      await finishRecording();
    };
    recorder.start(1500);recording=true;$('recordBtn').classList.add('recording');$('recordBtn').querySelector('b').textContent='Stop recording';
    toast('Recording all visible participants. Inform everyone before recording.');
  }catch(e){console.error('Recording start failed',e);await finishRecording();toast('Recording failed: '+(e.message||'browser unsupported'))}
};

/* Captions */
function showCaption(d){
  if(!captionsOn)return;const el=$('captionOverlay');el.innerHTML=`<b>${esc(d.name)}:</b> ${esc(d.text)}`;el.classList.remove('hidden');clearTimeout(showCaption.t);showCaption.t=setTimeout(()=>el.classList.add('hidden'),5000);
}
$('captionsBtn').onclick=()=>{
  $('moreMenu').classList.add('hidden');
  if(captionsOn){captionsOn=false;try{recognition?.stop()}catch{};$('captionOverlay').classList.add('hidden');$('captionsBtn').classList.remove('active');return toast('Captions off')}
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR)return appDialog({title:'Captions unavailable',message:'Live speech recognition is not supported by this browser. Try the latest Chrome or Edge.',confirmText:'OK'});
  recognition=new SR();recognition.continuous=true;recognition.interimResults=false;recognition.lang='en-IN';
  recognition.onresult=e=>{const text=e.results[e.results.length-1][0].transcript.trim();if(text){showCaption({name:c.displayName,text});socket?.emit('caption_line',{text})}};
  recognition.onend=()=>{if(captionsOn)try{recognition.start()}catch{}};
  try{recognition.start();captionsOn=true;$('captionsBtn').classList.add('active');toast('Live captions on')}catch{toast('Could not start captions')}
};

/* Notes */
$('notesBtn').onclick=()=>{$('moreMenu').classList.add('hidden');$('meetingNotes').value=localStorage.getItem('nexaroom-notes-'+c.room)||'';$('notesModal').classList.remove('hidden')};
$('closeNotes').onclick=()=>{$('notesModal').classList.add('hidden');localStorage.setItem('nexaroom-notes-'+c.room,$('meetingNotes').value)};
$('meetingNotes').addEventListener('input',()=>localStorage.setItem('nexaroom-notes-'+c.room,$('meetingNotes').value));
$('clearNotes').onclick=async()=>{const yes=await appDialog({title:'Clear meeting notes?',message:'Your local notes for this room will be deleted.',confirmText:'Clear',cancelText:'Cancel',danger:true,showCancel:true});if(yes){$('meetingNotes').value='';localStorage.removeItem('nexaroom-notes-'+c.room)}};
$('downloadNotes').onclick=()=>{const text=$('meetingNotes').value||'No notes.';const blob=new Blob([`${c.meetingCode} — NexaRoom notes\n\n${text}`],{type:'text/plain'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`NexaRoom-${c.meetingCode.replace(/\s/g,'-')}-notes.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};


/* Built-in Apps */
$('appsBtn').onclick=()=>{$('moreMenu').classList.add('hidden');$('appsModal').classList.remove('hidden')};
$('closeApps').onclick=()=>$('appsModal').classList.add('hidden');
document.querySelectorAll('[data-open-tool]').forEach(btn=>btn.onclick=()=>{
  $('appsModal').classList.add('hidden');
  const tool=btn.dataset.openTool;
  if(tool==='notes')$('notesBtn').click();
  if(tool==='board')$('boardBtn').click();
  if(tool==='files')$('fileBtn').click();
});

/* Device settings */
$('settingsBtn').onclick=async()=>{$('moreMenu').classList.add('hidden');await loadDevices();$('settingsModal').classList.remove('hidden')};
$('quickDevicesBtn')?.addEventListener('click',()=>$('settingsBtn').click());
let microphoneTestFrame=0,microphoneTestContext=null,microphoneTestStream=null;
function stopMicrophoneTest(){
  cancelAnimationFrame(microphoneTestFrame);microphoneTestFrame=0;
  microphoneTestStream?.getTracks().forEach(t=>t.stop());microphoneTestStream=null;
  microphoneTestContext?.close().catch(()=>{});microphoneTestContext=null;
  $('micTestBar').style.width='0%';$('testMicBtn').textContent='Test microphone';
}
$('testMicBtn').onclick=async()=>{
  if(microphoneTestContext){stopMicrophoneTest();$('micTestStatus').textContent='Test stopped.';return}
  try{
    const dev=$('micSelect').value;
    microphoneTestStream=await navigator.mediaDevices.getUserMedia({audio:dev?{deviceId:{ideal:dev}}:true,video:false});
    microphoneTestContext=new (window.AudioContext||window.webkitAudioContext)();
    await microphoneTestContext.resume();
    const source=microphoneTestContext.createMediaStreamSource(microphoneTestStream),analyser=microphoneTestContext.createAnalyser();
    analyser.fftSize=1024;source.connect(analyser);
    const samples=new Uint8Array(analyser.fftSize);
    $('testMicBtn').textContent='Stop test';
    const update=()=>{
      analyser.getByteTimeDomainData(samples);
      let sum=0;for(const sample of samples){const x=(sample-128)/128;sum+=x*x}
      const rms=Math.sqrt(sum/samples.length),level=Math.min(100,Math.round(rms*450));
      $('micTestBar').style.width=level+'%';
      $('micTestStatus').textContent=level>3?'Microphone detected — input level '+level+'%':'Listening... speak near your mic';
      microphoneTestFrame=requestAnimationFrame(update);
    };update();
  }catch(e){stopMicrophoneTest();$('micTestStatus').textContent='Microphone access failed: '+(e.name||e.message)}
};
$('closeSettings').onclick=()=>{stopMicrophoneTest();$('settingsModal').classList.add('hidden')};
$('applyDevices').onclick=async()=>{try{const video=$('cameraSelect').value,audio=$('micSelect').value;stopMicrophoneTest();await initMedia({video,audio});if(video)localStorage.setItem('nexaroom-camera-id',video);if(audio)localStorage.setItem('nexaroom-microphone-id',audio);$('settingsModal').classList.add('hidden');emitMedia();toast('Devices updated')}catch(e){console.error(e);toast('Could not switch devices')}};

setInterval(()=>{
  const sec=Math.max(0,Math.floor((Date.now()-startedAt)/1000));$('timer').textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
  if(c.durationLimit&&sec>=c.durationLimit*60&&c.isHost&&socket?.connected)socket.emit('end_meeting');
},1000);
setInterval(monitorSpeaker,450);

(async()=>{
  try{await initKey()}catch(e){console.warn('Invite encryption key invalid',e);toast('File encryption key unavailable.')}
  try{await initMedia()}catch(e){console.error('Media capture failed',e);localStream=new MediaStream();streams.set('local',localStream);toast('Devices unavailable; join with camera/mic off.')}
  renderPeople();
  try{await connectRealtime()}catch(e){console.error('Socket.IO client loading failed',e);fatal('Realtime connection could not start: '+(e?.message||'Check Socket.IO script and refresh.'))}
})();
})();

// Screen sharing for The Conference Room.
// Everyone with a room open joins a small peer-to-peer mesh. Each connection has one
// two-way video slot, so any number of people can share at the same time and everyone
// sees every shared screen. Signaling goes through the members-only conference_room_rtc
// function; the video goes browser to browser and never touches the server.
(() => {
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
  const MAX_PEERS = 6;
  const peerId = crypto.randomUUID();
  const conns = new Map(); // peer -> {pc, sender, pending, stream, name, sharing, tile}
  let roomId = null, after = 0, screen = null, busy = false, myTile = null;
  const canShare = !!navigator.mediaDevices?.getDisplayMedia;
  const btn = document.querySelector('#sharebtn'), grid = document.querySelector('#screens');

  const rtc = async (action, data = {}) => {
    const { data: out, error } = await sb.rpc('conference_room_rtc', { p_key: key, p_action: action, p_data: { room_id: roomId, peer: peerId, ...data } });
    if (error) throw error;
    return out;
  };
  const signal = (to, body) => rtc('signal', { to, body }).catch(e => console.warn('signal', e.message));

  if (!canShare) { btn.disabled = true; btn.title = 'Screen sharing needs a desktop browser (Chrome, Edge, Firefox or Safari on a computer).'; }

  function makeTile(label, mine) {
    const el = document.createElement('div');
    el.className = 'screen' + (mine ? ' mine' : '');
    el.innerHTML = '<video autoplay muted playsinline></video><span></span>';
    el.querySelector('span').textContent = label;
    el.querySelector('video').onclick = e => e.currentTarget.requestFullscreen?.();
    el.title = 'Click to view full screen';
    grid.append(el);
    return el;
  }
  function layout() { grid.classList.toggle('hidden', !grid.children.length); }

  function showRemote(c) {
    const show = c.sharing && c.stream;
    if (show && !c.tile) { c.tile = makeTile(c.name + ' is sharing', false); c.tile.querySelector('video').srcObject = c.stream; }
    if (!show && c.tile) { c.tile.remove(); c.tile = null; }
    if (c.tile) c.tile.querySelector('span').textContent = c.name + ' is sharing';
    layout();
  }

  function close(peer) {
    const c = conns.get(peer);
    if (!c) return;
    c.pc.close();
    c.tile?.remove();
    conns.delete(peer);
    layout();
  }

  function connect(peer, name) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const c = { pc, sender: null, pending: [], stream: null, name, sharing: false, tile: null, created: Date.now() };
    conns.set(peer, c);
    pc.onicecandidate = e => { if (e.candidate) signal(peer, { type: 'candidate', candidate: e.candidate.toJSON() }); };
    pc.ontrack = e => { c.stream = e.streams[0] || new MediaStream([e.track]); showRemote(c); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') close(peer); };
    return c;
  }

  async function offer(peer, name) {
    const c = connect(peer, name);
    const tr = c.pc.addTransceiver('video', { direction: 'sendrecv', streams: [new MediaStream()] });
    c.sender = tr.sender;
    if (screen) await c.sender.replaceTrack(screen.getVideoTracks()[0]);
    await c.pc.setLocalDescription(await c.pc.createOffer());
    await signal(peer, { type: 'offer', sdp: c.pc.localDescription.sdp });
  }

  async function handle(from, body) {
    let c = conns.get(from);
    if (body.type === 'offer') {
      if (c) close(from);
      c = connect(from, 'Someone');
      await c.pc.setRemoteDescription({ type: 'offer', sdp: body.sdp });
      const tr = c.pc.getTransceivers()[0];
      if (tr) { tr.direction = 'sendrecv'; c.sender = tr.sender; if (screen) await c.sender.replaceTrack(screen.getVideoTracks()[0]); }
      await c.pc.setLocalDescription(await c.pc.createAnswer());
      await signal(from, { type: 'answer', sdp: c.pc.localDescription.sdp });
    } else if (!c) {
      return;
    } else if (body.type === 'answer') {
      if (c.pc.signalingState === 'have-local-offer') await c.pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
    } else if (body.type === 'candidate') {
      if (!c.pc.remoteDescription) { c.pending.push(body.candidate); return; }
      await c.pc.addIceCandidate(body.candidate).catch(() => {});
      return;
    }
    for (const cand of c.pending.splice(0)) await c.pc.addIceCandidate(cand).catch(() => {});
  }

  function teardown() {
    if (roomId && key) rtc('leave').catch(() => {});
    for (const peer of [...conns.keys()]) close(peer);
    stopShare();
    roomId = null; after = 0;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const want = (key && active && active.id) || null;
      if (want !== roomId) { teardown(); roomId = want; }
      btn.classList.toggle('hidden', !roomId);
      if (!roomId) return;
      const peers = (await rtc('presence', { sharing: !!screen })) || [];
      const seen = new Set();
      for (const p of peers.slice(0, MAX_PEERS)) {
        seen.add(p.peer);
        let c = conns.get(p.peer);
        if (!c && peerId < p.peer) { await offer(p.peer, p.name); c = conns.get(p.peer); }
        if (c) { c.name = p.name; c.sharing = !!p.sharing; showRemote(c); }
        // retry a connection that never came up (lost offer, network change)
        if (c && peerId < p.peer && c.pc.connectionState !== 'connected' && Date.now() - c.created > 20000) close(p.peer);
      }
      for (const peer of [...conns.keys()]) if (!seen.has(peer)) close(peer);
      const signals = (await rtc('poll', { after })) || [];
      for (const s of signals) {
        after = Math.max(after, s.id);
        try { await handle(s.from, s.body); } catch (e) { console.warn('rtc', e); }
        const c = conns.get(s.from), p = peers.find(x => x.peer === s.from);
        if (c && p) { c.name = p.name; c.sharing = !!p.sharing; showRemote(c); }
      }
    } catch (e) {
      console.warn('screen share', e.message || e);
    } finally {
      busy = false;
    }
  }

  async function startShare() {
    if (!confirm('Everyone in this room will see the screen, window or tab you choose. Close anything private first. Continue?')) return;
    let display;
    try { display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
    catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') alert('Screen sharing could not start: ' + (e.message || e.name)); return; }
    screen = display;
    const track = display.getVideoTracks()[0];
    track.onended = stopShare;
    for (const c of conns.values()) c.sender?.replaceTrack(track).catch(() => {});
    myTile = makeTile('You are sharing', true);
    myTile.querySelector('video').srcObject = display;
    btn.textContent = 'Stop sharing';
    btn.classList.add('on');
    layout();
    tick();
  }

  function stopShare() {
    if (!screen) return;
    screen.getTracks().forEach(t => t.stop());
    screen = null;
    for (const c of conns.values()) c.sender?.replaceTrack(null).catch(() => {});
    myTile?.remove(); myTile = null;
    btn.textContent = 'Share screen';
    btn.classList.remove('on');
    layout();
  }

  btn.onclick = () => (screen ? stopShare() : startShare());
  window.addEventListener('pagehide', () => { if (roomId && key) rtc('leave').catch(() => {}); });
  setInterval(tick, 1500);
})();

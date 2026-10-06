import { useEffect, useRef, useState } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { DailyCall, DailyParticipant } from '@daily-co/daily-js';
import type { AnamClient } from '@anam-ai/js-sdk';
import { ArrowUpRight, AudioLines, CameraOff, Clock3, Globe2, LogOut, MessageCircle, Mic, MicOff, PhoneOff, ShieldCheck, X } from 'lucide-react';
import { startOpenMic, type OpenMic } from './openMic';

type Config = { supabaseUrl: string; supabaseKey: string; ready: boolean; poster: string; anamPoster?: string; maxCallSeconds: number; echoAvailable?: boolean; anamAvailable?: boolean; anamMaxCallSeconds?: number };
type Status = { remainingSeconds: number; anamRemainingSeconds?: number; busy: boolean; ownCall: string | null; calls: { date: number; seconds: number; active: boolean }[] };
type Mode = 'anam' | 'full' | 'echo';
type Connection = { id: string; providerId: string; url?: string; token: string; expires: number; durationSeconds?: number; mode?: 'anam' | 'echo'; provider?: 'anam' | 'tavus' };
const formatTime = (n: number) => `${Math.floor(Math.max(0, n) / 60)}:${String(Math.floor(Math.max(0, n) % 60)).padStart(2, '0')}`;

export default function App() {
  const [config, setConfig] = useState<Config>();
  const [client, setClient] = useState<SupabaseClient>();
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status>();
  const [language, setLanguage] = useState('en');
  const [mode, setMode] = useState<Mode>('anam');
  const [typedMessage, setTypedMessage] = useState('');
  const [listening, setListening] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [tab, setTab] = useState('conversation');
  const [error, setError] = useState('');
  const [login, setLogin] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'connected' | 'ending'>('idle');
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [caption, setCaption] = useState('');
  const [showPortrait, setShowPortrait] = useState(false);
  const call = useRef<DailyCall | null>(null);
  const anam = useRef<AnamClient | null>(null);
  const anamCaption = useRef({ id: '', text: '' });
  const connection = useRef<Connection | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const lock = useRef(false);
  const ending = useRef(false);
  const openMic = useRef<OpenMic | null>(null);
  const startingMic = useRef(false);
  const awaitingPal = useRef(false);
  const palStarted = useRef(false);
  const replyLock = useRef(false);
  const speechTimeout = useRef<number | null>(null);
  const currentSession = useRef<Session | null>(null);
  currentSession.current = session;

  useEffect(() => {
    let active = true;
    fetch('/api/config').then(async r => { if (!r.ok) throw new Error(); return r.json() as Promise<Config>; }).then(c => {
      if (!active) return;
      setConfig(c);
      setMode(c.anamAvailable ? 'anam' : 'echo');
      if (c.supabaseUrl && c.supabaseKey) setClient(createClient(c.supabaseUrl, c.supabaseKey));
    }).catch(() => { if (active) setError('Setup is not connected yet. The interface is available to preview.'); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!client) return;
    const { data } = client.auth.onAuthStateChange((_event, next) => setSession(next));
    client.auth.getSession().then(({ data }) => setSession(data.session));
    return () => data.subscription.unsubscribe();
  }, [client]);
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const { data } = client ? await client.auth.getSession() : { data: { session: null } };
    const token = data.session?.access_token;
    if (!token) throw new Error('Please sign in to start a conversation.');
    const response = await fetch(`/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error((result as { error?: string }).error || 'Something went wrong. Please try again.');
    return result as T;
  }
  async function refresh() {
    if (!currentSession.current) return;
    try { setStatus(await api<Status>('status')); } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (session) void refresh(); else setStatus(undefined); }, [session?.user.id]);
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => void refresh(), 20000);
    return () => clearInterval(timer);
  }, [session?.user.id, client]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!connection.current) return;
      const left = Math.max(0, Math.ceil((connection.current.expires - Date.now()) / 1000));
      setTime(left);
      if (!left && !ending.current) void endCall();
    }, 1000);
    const leave = () => {
      const c = connection.current;
      if (!c || !currentSession.current) return;
      void fetch('/api/end', { method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentSession.current.access_token}` }, body: JSON.stringify({ id: c.id }) });
    };
    window.addEventListener('pagehide', leave);
    return () => { clearInterval(timer); window.removeEventListener('pagehide', leave); };
  }, [client]);

  function syncTracks() {
    if (!call.current) return;
    const participant = Object.values(call.current.participants()).find((p: DailyParticipant) => !p.local);
    const vt = participant?.tracks.video.persistentTrack;
    const at = participant?.tracks.audio.persistentTrack;
    if (video.current) {
      const old = video.current.srcObject as MediaStream | null;
      if (vt && old?.getVideoTracks()[0]?.id !== vt.id) video.current.srcObject = new MediaStream([vt]);
      if (!vt) video.current.srcObject = null;
      if (vt) void video.current.play().catch(() => {});
    }
    setHasVideo(Boolean(vt));
    if (participant && connection.current) {
      setPhase('connected');
      if (connection.current.mode === 'echo' && !openMic.current && !startingMic.current) void startEchoMic();
    }
    if (audio.current) {
      const old = audio.current.srcObject as MediaStream | null;
      if (at && old?.getAudioTracks()[0]?.id !== at.id) {
        audio.current.srcObject = new MediaStream([at]);
        void audio.current.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
      }
      if (!at) audio.current.srcObject = null;
    }
  }
  async function sendMessage(message: string) {
    const c = connection.current;
    if (!c || !['echo', 'anam'].includes(c.mode || '') || (c.mode === 'echo' && !call.current) || (c.mode === 'anam' && !anam.current) || replyLock.current || ending.current) return;
    const spoken = message.trim();
    if (!spoken) return;
    if (c.mode === 'anam') {
      try { anam.current?.sendUserMessage(spoken); setCaption(`You: ${spoken}`); setTypedMessage(''); setError(''); }
      catch (e) { setError((e as Error).message); }
      return;
    }
    replyLock.current = true; openMic.current?.pause();
    setReplying(true); setError(''); setCaption(`You: ${spoken}`); setTypedMessage('');
    try {
      const answer = await api<{ reply: string; emotion: string }>('respond', { id: c.id, message: spoken });
      if (connection.current?.id !== c.id || !call.current) return;
      awaitingPal.current = true;
      palStarted.current = false;
      call.current.sendAppMessage({ message_type: 'conversation', event_type: 'conversation.echo', conversation_id: c.providerId,
        properties: { modality: 'text', text: `<emotion value="${answer.emotion}"/> ${answer.reply}`, done: true } }, '*');
      setCaption(answer.reply);
      if (speechTimeout.current) window.clearTimeout(speechTimeout.current);
      speechTimeout.current = window.setTimeout(() => { awaitingPal.current = false; palStarted.current = false; openMic.current?.resume(); }, 15000);
    } catch (e) { setError((e as Error).message); awaitingPal.current = false; openMic.current?.resume(); }
    finally { replyLock.current = false; setReplying(false); }
  }
  async function handleAudio(blob: Blob) {
    const c = connection.current;
    if (!c || ending.current) return;
    setTranscribing(true);
    try {
      const { data } = client ? await client.auth.getSession() : { data: { session: null } };
      if (!data.session?.access_token) throw new Error('Please sign in again.');
      const response = await fetch(`/api/transcribe?id=${encodeURIComponent(c.id)}`, { method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': blob.type }, body: blob });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok || !result.message) throw new Error(result.error || 'Could not transcribe your voice.');
      if (connection.current?.id === c.id) await sendMessage(result.message);
    } catch (e) { setError((e as Error).message); openMic.current?.resume(); }
    finally { setTranscribing(false); }
  }
  async function startEchoMic() {
    if (startingMic.current || openMic.current || ending.current) return;
    startingMic.current = true;
    try {
      const activeMic = await startOpenMic(handleAudio, setHearing);
      if (ending.current || !connection.current) { activeMic.stop(); return; }
      openMic.current = activeMic; setListening(true); setMuted(false);
    }
    catch { setError('Jinha could not open your microphone. Check browser microphone permission, then reconnect.'); }
    finally { startingMic.current = false; }
  }
  async function startCall() {
    if (!session) { setLogin(true); return; }
    if (lock.current) return;
    lock.current = true; ending.current = false; setError(''); setCaption(''); setPhase('connecting');
    try {
      if (!config?.ready) throw new Error('Jinha’s live connection is being set up. Please check back shortly.');
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Use a supported browser over HTTPS to enable your microphone.');
      // Validate microphone permission before starting a billed conversation. Never request video.
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      mic.getTracks().forEach(t => t.stop());
      const c = await api<Connection>('start', { language, mode });
      // Use a local deadline so a device clock that differs from the server cannot inflate the timer.
      if (c.durationSeconds) c.expires = Date.now() + c.durationSeconds * 1000;
      connection.current = c; setTime(Math.max(0, Math.ceil((c.expires - Date.now()) / 1000)));
      if (c.provider === 'anam') {
        const { createClient: createAnamClient, AnamEvent } = await import('@anam-ai/js-sdk');
        const live = createAnamClient(c.token, { disableInputAudio: false });
        anam.current = live;
        if (video.current) video.current.muted = false;
        live.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => { setHasVideo(true); setPhase('connected'); });
        live.addListener(AnamEvent.CONNECTION_CLOSED, () => { if (!ending.current && connection.current?.id === c.id) void endCall(); });
        live.addListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, event => {
          if (event.role !== 'persona' || !event.content) return;
          if (anamCaption.current.id !== event.id) anamCaption.current = { id: event.id, text: '' };
          anamCaption.current.text += event.content;
          setCaption(anamCaption.current.text.trim());
        });
        live.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, messages => {
          const last = messages.at(-1);
          if (last?.role === 'persona' && last.content) setCaption(last.content.trim());
          const recent = messages.slice(-2).filter(m => m.content?.trim()).map(m => ({ id: m.id, role: m.role === 'persona' ? 'assistant' : 'user', content: m.content }));
          if (recent.length && connection.current?.id === c.id) void api('anam/remember', { id: c.id, messages: recent }).catch(() => {});
        });
        await live.streamToVideoElement('jinha-avatar');
        setMuted(false); setPhase('connected'); setHasVideo(true);
        return;
      }
      const { default: Daily } = await import('@daily-co/daily-js');
      const daily = Daily.createCallObject({ videoSource: false, startVideoOff: true, startAudioOff: mode === 'echo' });
      call.current = daily;
      daily.on('participant-joined', syncTracks).on('participant-updated', syncTracks).on('participant-left', syncTracks).on('track-started', syncTracks).on('track-stopped', syncTracks);
      daily.on('left-meeting', () => { if (!ending.current && connection.current) void endCall(); });
      daily.on('error', () => { setError('The connection was interrupted. End the call and reconnect.'); if (!ending.current) void endCall(); });
      daily.on('app-message', event => {
        const data = event?.data;
        if (data?.event_type === 'conversation.utterance' && data?.properties?.role === 'assistant' && typeof data?.properties?.speech === 'string') setCaption(data.properties.speech);
        if (connection.current?.mode === 'echo' && awaitingPal.current && data?.event_type === 'conversation.started_speaking' && ['pal', 'replica', 'assistant'].includes(data?.properties?.role)) palStarted.current = true;
        if (connection.current?.mode === 'echo' && awaitingPal.current && palStarted.current && data?.event_type === 'conversation.stopped_speaking' && ['pal', 'replica', 'assistant'].includes(data?.properties?.role)) {
          awaitingPal.current = false;
          palStarted.current = false;
          if (speechTimeout.current) window.clearTimeout(speechTimeout.current);
          speechTimeout.current = null; openMic.current?.resume();
        }
      });
      await daily.join({ url: c.url!, token: c.token, videoSource: false, startVideoOff: true, userName: 'You' });
      setMuted(false); syncTracks();
    } catch (e) {
      const message = e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone access was denied. Allow your microphone in browser settings and try again.' : (e as Error).message;
      setError(message);
      await endCall();
    } finally { lock.current = false; }
  }
  async function endCall(id = connection.current?.id) {
    if (ending.current) return;
    ending.current = true; setPhase('ending');
    openMic.current?.stop(); openMic.current = null; setListening(false); setHearing(false); setReplying(false); setTranscribing(false);
    awaitingPal.current = false; palStarted.current = false; replyLock.current = false;
    if (speechTimeout.current) window.clearTimeout(speechTimeout.current);
    speechTimeout.current = null;
    const daily = call.current; call.current = null;
    const avatar = anam.current; anam.current = null;
    anamCaption.current = { id: '', text: '' };
    try {
      if (daily) { try { await daily.leave(); } finally { await daily.destroy(); } }
      if (avatar) await avatar.stopStreaming();
    } catch { /* Server cleanup below is authoritative. */ }
    try { if (id) await api('end', { id }); } catch (e) { setError((e as Error).message); }
    connection.current = null; setPhase('idle'); setHasVideo(false); setAudioBlocked(false); setCaption('');
    if (video.current) video.current.srcObject = null;
    if (audio.current) audio.current.srcObject = null;
    ending.current = false; await refresh();
  }
  async function signIn(event: React.FormEvent) {
    event.preventDefault(); if (!client) return;
    setSigningIn(true); setError('');
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    setSigningIn(false);
    if (error) setError(error.message);
    else { setPassword(''); setLogin(false); }
  }
  const inCall = phase !== 'idle';
  return <div className="app">
    <header className="header"><a className="brand" href="/" aria-label="Jinha home"><span className="brand-mark">J</span><span>Jinha</span></a><div className="header-right"><span className="header-label">PRIVATE DEMO</span><button className="account" onClick={() => { if (session) { void client?.auth.signOut(); } else setLogin(true); }} disabled={inCall}>{session ? <><LogOut size={15}/> Sign out</> : <>Sign in <ArrowUpRight size={15}/></>}</button></div></header>
    <main>
      <div className="intro"><div><div className="eyebrow">YOUR SPACE WITH JINHA</div><h1>Talk with Jinha</h1><p>A more personal conversation, whenever you need one.</p></div><span className="intro-status"><span className="dot"/>{phase === 'connected' ? 'In conversation' : phase === 'connecting' ? 'Connecting' : 'Ready when you are'}</span></div>
      <div className="workspace">
        <section className="companion" aria-label="Jinha video conversation">
          <div className={`stage ${mode === 'anam' ? 'stage-portrait' : ''}`}>
            {(mode === 'anam' ? '/jinha-full.png' : config?.poster) && !hasVideo && !previewFailed && ((mode === 'anam' ? '/jinha-full.png' : config?.poster)?.endsWith('.mp4')
              ? <video className="poster" src={mode === 'anam' ? config?.anamPoster : config?.poster} autoPlay muted loop playsInline preload="metadata" aria-label="Selected Jinha avatar preview" onError={() => setPreviewFailed(true)}/>
              : <img className="poster" src={mode === 'anam' ? '/jinha-full.png' : config?.poster} alt="Selected Jinha avatar preview" onError={() => setPreviewFailed(true)}/>)}
            <video id="jinha-avatar" className={`avatar-video ${hasVideo ? 'visible' : ''}`} ref={video} autoPlay playsInline muted={mode !== 'anam'} aria-label="Jinha live video"/>
            <audio ref={audio} autoPlay/>
            {!hasVideo && (!(mode === 'anam' ? config?.anamPoster : config?.poster) || previewFailed) && <div className="placeholder"><div className="halo halo-one"/><div className="halo halo-two"/><div className="monogram">J<span>진하</span></div><p>{phase === 'connecting' ? 'Making a little room for you…' : previewFailed ? 'Preview unavailable. Meet Jinha in a call.' : 'Your next conversation starts here.'}</p></div>}
            <div className="stage-top"><span className="glass-label"><span className={`dot ${phase === 'connected' ? '' : 'soft'}`}/>{phase === 'connected' ? 'Live' : phase === 'connecting' ? 'Connecting' : 'Jinha'}</span><button className="glass-label portrait-link" onClick={() => setShowPortrait(true)}>Full-length portrait <ArrowUpRight size={13}/></button></div>
            <div className="stage-bottom"><div><span className="small-label">YOUR COMPANION</span><h2>Jinha <span>진하</span></h2><p>Warm, curious, and a little playful</p></div></div>
            {caption && <p className="caption">{caption}</p>}
          </div>
          <div className="call-bar"><span className="privacy"><CameraOff size={17}/> Camera off · Microphone only</span><div className="call-buttons">{inCall ? <><span className="timer">{formatTime(time)}</span>{connection.current?.mode === 'echo' ? <button className="round" disabled={phase !== 'connected' || !listening} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => { openMic.current?.mute(!muted); setMuted(!muted); }}>{muted ? <MicOff size={20}/> : <Mic size={20}/>}</button> : connection.current?.mode === 'anam' ? <button className="round" disabled={phase !== 'connected'} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => { if (muted) anam.current?.unmuteInputAudio(); else anam.current?.muteInputAudio(); setMuted(!muted); }}>{muted ? <MicOff size={20}/> : <Mic size={20}/>}</button> : <button className="round" disabled={phase !== 'connected'} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => { call.current?.setLocalAudio(muted); setMuted(!muted); }}>{muted ? <MicOff size={20}/> : <Mic size={20}/>}</button>}<button className="end" disabled={phase === 'ending' || phase === 'connecting'} onClick={() => void endCall()}><PhoneOff size={18}/>{phase === 'ending' ? 'Ending…' : 'End call'}</button></> : <button className="primary" onClick={() => void startCall()} disabled={Boolean(session && (!config?.ready || status?.busy || (status && (mode === 'anam' ? status.anamRemainingSeconds ?? 0 : status.remainingSeconds) < 60)))}><AudioLines size={20}/>{session ? 'Start conversation' : 'Sign in to talk'}</button>}</div></div>
          {phase === 'connected' && connection.current?.mode === 'anam' && <form className="echo-input" onSubmit={e => { e.preventDefault(); void sendMessage(typedMessage); }}><span>{muted ? 'Microphone muted.' : 'Microphone on · just speak naturally.'}</span><div><input aria-label="Message to Jinha" value={typedMessage} onChange={e => setTypedMessage(e.target.value)} placeholder="Or type a message…" maxLength={500}/><button type="submit" disabled={!typedMessage.trim()}>Send</button></div></form>}
          {phase === 'connected' && connection.current?.mode === 'echo' && <form className="echo-input" onSubmit={e => { e.preventDefault(); void sendMessage(typedMessage); }}><span>{muted ? 'Microphone muted.' : hearing ? 'I hear you…' : transcribing ? 'Turning your speech into text…' : replying || awaitingPal.current ? 'Jinha is replying…' : listening ? 'Microphone on · just speak naturally.' : 'Opening microphone…'}</span><div><input aria-label="Message to Jinha" value={typedMessage} onChange={e => setTypedMessage(e.target.value)} placeholder="Or type a message…" maxLength={500}/><button type="submit" disabled={!typedMessage.trim() || replying || transcribing}>Send</button></div></form>}
          {audioBlocked && <button className="audio-unlock" onClick={() => { void audio.current?.play().then(() => setAudioBlocked(false)); }}>Tap to hear Jinha</button>}
        </section>
        <aside className="sidebar">
          <div className="tabs" role="tablist" aria-label="Companion information"><button role="tab" aria-selected={tab === 'conversation'} onClick={() => setTab('conversation')}>Conversation</button><button role="tab" aria-selected={tab === 'memories'} onClick={() => setTab('memories')}>History</button></div>
          {tab === 'conversation' ? <div className="panel"><div className="eyebrow lavender">MEET JINHA</div><h3>A conversation that feels closer.</h3><p className="description">Jinha listens and responds in English, Korean, or Spanish. Talk naturally; she remembers recent moments when you return.</p><div className="divider"/><label className="field-label" htmlFor="language"><Globe2 size={16}/> Starting language</label><select id="language" value={language} onChange={e => setLanguage(e.target.value)} disabled={inCall}><option value="en">English</option><option value="ko">한국어 · Korean</option><option value="es">Español · Spanish</option></select><p className="hint">You can switch languages during a call.</p><label className="field-label" htmlFor="mode">Conversation style</label><select id="mode" value={mode} onChange={e => { setMode(e.target.value as Mode); setPreviewFailed(false); }} disabled={inCall}><option value="anam" disabled={!config?.anamAvailable}>Expressive Jinha · open mic</option><option value="full">Classic · open mic</option><option value="echo" disabled={!config?.echoAvailable}>Expression focus · open mic</option></select><p className="hint">Expressive Jinha uses a portrait video. The full-length image is a still portrait.</p><div className="divider"/><div className="field-label"><MessageCircle size={16}/> Start with a thought</div><div className="prompts"><p>“Tell me something about your day.”</p><p>“Teach me a phrase in Korean.”</p></div></div> : <div className="panel"><div className="eyebrow lavender">PICK UP WHERE WE LEFT OFF</div><h3>Your conversations</h3><p className="description">Use the same account across devices. Jinha can recall recent details from expressive conversations.</p><div className="history">{!session ? <p>Sign in to see your conversation history.</p> : !status?.calls.length ? <div className="empty-history"><MessageCircle/><p>Your story starts with a hello.</p><span>Your completed calls will appear here.</span></div> : [...status.calls].reverse().map((c, i) => <div className="history-item" key={`${c.date}-${i}`}><MessageCircle size={17}/><div><strong>{new Date(c.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</strong><span>{c.active ? 'In progress' : 'Conversation with Jinha'}</span></div><span>{formatTime(c.seconds)}</span></div>)}</div><p className="hint">History shows call time, not a transcript. Ask your host to review or delete stored memories.</p></div>}
          <div className="session-note"><ShieldCheck size={19}/><div><strong>Your voice. Your space.</strong><p>{mode === 'echo' ? 'Your camera stays off. Your microphone listens during the call; Cloudflare transcribes each finished phrase to guide Jinha’s reply and expression. Useful details may be remembered for next time.' : mode === 'anam' ? 'Your camera stays off. Anam processes your microphone and Jinha’s replies. Recent turns may be remembered for the next call.' : 'Microphone only. Jinha may use your tone to guide her replies. Conversations are processed by our AI providers; useful details may be remembered for next time.'}</p></div></div>
        </aside>
      </div>
      {error && <div className="notice error" role="alert"><span>{error}</span><button aria-label="Dismiss message" onClick={() => setError('')}><X size={17}/></button></div>}
      {config && !config.ready && <div className="notice"><Clock3 size={17}/><span>Preview mode · Live conversations will open once the connection is ready.</span></div>}
      {session && status && <div className="usage"><Clock3 size={14}/><span>{inCall ? `Time left in this call: ${formatTime(time)}` : `Available demo time: ${formatTime(mode === 'anam' ? status.anamRemainingSeconds ?? 0 : status.remainingSeconds)}`} · Up to {formatTime(mode === 'anam' ? config?.anamMaxCallSeconds || 150 : config?.maxCallSeconds || 300)} per call</span>{status.ownCall && !inCall && <button onClick={() => void endCall(status.ownCall!)}>Close previous call</button>}{status.busy && !status.ownCall && <span>Another tester is talking. Please return shortly.</span>}</div>}
      <footer><span>Jinha · Private demo</span><span>Jinha is an AI character, not a real person.</span></footer>
    </main>
    {showPortrait && <div className="portrait-backdrop" onClick={() => setShowPortrait(false)}><section className="portrait-modal" role="dialog" aria-modal="true" aria-label="Full-length still portrait of Jinha" onClick={e => e.stopPropagation()}><button className="modal-close" aria-label="Close portrait" onClick={() => setShowPortrait(false)}><X/></button><img src="/jinha-full.png" alt="Full-length still portrait of Jinha"/><div><strong>Jinha · full-length portrait</strong><span>Still image · Live video focuses on her face and upper body.</span></div></section></div>}
    {login && <div className="modal-backdrop" onClick={() => setLogin(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="login-title" onClick={e => e.stopPropagation()}><button className="modal-close" aria-label="Close sign in" onClick={() => setLogin(false)}><X/></button><span className="brand-mark">j.</span><h2 id="login-title">A space of your own.</h2><p>Sign in with your demo account. Your memories follow you, even on a different device.</p>{client ? <form onSubmit={signIn}><label htmlFor="email">Email</label><input autoFocus id="email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)}/><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)}/><button className="primary" disabled={signingIn}>{signingIn ? 'Signing in…' : 'Continue'}<ArrowUpRight size={17}/></button></form> : <div className="notice">Account access is being configured. Please check back shortly.</div>}{error && <p role="alert" className="form-error">{error}</p>}<p className="hint">Private demo · Only invited email addresses can start calls.</p></section></div>}
  </div>;
}

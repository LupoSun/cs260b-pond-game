/**
 * Background music for the classroom display.
 *
 * The music is recorded loops served from /music (see public/music/CREDITS.txt for the sources,
 * all Creative Commons 0). Each mood maps to one looped track; the leaderboard adds a one-shot
 * fanfare before its loop. Tracks are fetched only once music is switched on.
 *
 * It plays on the classroom display only. Thirty phones each running their own copy would never be
 * in time with one another, and phone audio is optional anyway (spec Section 8).
 *
 * Audio is optional by design: every failure here (no Web Audio, blocked autoplay, a missing or
 * undecodable file) leaves the display silent and fully usable.
 *
 * Browsers refuse to start audio until the page has been clicked or a key pressed, and no page can
 * waive that. So the display calls `prime()` on every click or key press, from the moment it opens:
 * the audio device is then ready before the facilitator switches music on, and music starts without
 * a further click. If nobody has touched the page, `needsUnlock()` is true and `onBlockedChange`
 * tells the display to say so.
 */

import { MUSIC_VOLUME_DEFAULT } from '../shared/constants.js';

/** What the room is doing, which decides the track. `silent` plays nothing. */
export type MusicMood = 'lobby' | 'practice' | 'game' | 'results' | 'silent';

type TrackId = 'lobby' | 'practice' | 'game' | 'fanfare';

const TRACK_URLS: Record<TrackId, string> = {
  lobby: '/music/lobby.mp3',
  practice: '/music/practice.mp3',
  game: '/music/game.mp3',
  fanfare: '/music/fanfare.mp3',
};

const TRACK_IDS = Object.keys(TRACK_URLS) as TrackId[];

/** The loop each mood plays. `results` plays the fanfare first, then the lobby loop. */
const MOOD_LOOP: Record<Exclude<MusicMood, 'silent'>, TrackId> = {
  lobby: 'lobby',
  practice: 'practice',
  game: 'game',
  results: 'lobby',
};

/** Facilitator volume (0..100) to output gain. Squared so the slider feels even to the ear. */
function volumeToGain(volume: number): number {
  const v = Math.max(0, Math.min(100, volume)) / 100;
  return v * v;
}
/** Every track is brought to this average level so a swapped-in file is not louder than the rest */
const TARGET_RMS_DB = -19;
const MAX_TRACK_GAIN = 2.5;
const MIN_TRACK_GAIN = 0.2;
const CROSSFADE_SEC = 0.5;
/** Anything quieter than this at a file's edges is treated as encoder padding, not music */
const EDGE_SILENCE_LEVEL = 0.004;
/** MP3 padding is a few tens of milliseconds; never trim more, so a genuinely quiet bar survives */
const MAX_EDGE_TRIM_SEC = 0.08;

interface LoadedTrack {
  buffer: AudioBuffer;
  /** Gain that brings this track to the shared target level without clipping */
  gain: number;
  /** Loop points with any encoder padding removed, so the loop does not hiccup at the seam */
  loopStartSec: number;
  loopEndSec: number;
}

type TrackState = { status: 'loading' } | { status: 'failed' } | ({ status: 'ready' } & LoadedTrack);

interface PlayingVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

function analyseTrack(buffer: AudioBuffer): LoadedTrack {
  const length = buffer.length;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  let sumSquares = 0;
  let peak = 0;
  for (const data of channels) {
    for (let i = 0; i < length; i++) {
      const v = data[i];
      sumSquares += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, length * channels.length));
  const rmsDb = 20 * Math.log10(rms + 1e-9);
  let gain = Math.pow(10, (TARGET_RMS_DB - rmsDb) / 20);
  gain = Math.min(MAX_TRACK_GAIN, Math.max(MIN_TRACK_GAIN, gain));
  if (peak > 0) gain = Math.min(gain, 0.98 / peak);

  const isSilentAt = (i: number): boolean => channels.every((data) => Math.abs(data[i]) < EDGE_SILENCE_LEVEL);
  const maxTrim = Math.floor(MAX_EDGE_TRIM_SEC * buffer.sampleRate);
  let lead = 0;
  while (lead < maxTrim && lead < length - 1 && isSilentAt(lead)) lead++;
  let tail = 0;
  while (tail < maxTrim && tail < length - 1 - lead && isSilentAt(length - 1 - tail)) tail++;

  return {
    buffer,
    gain,
    loopStartSec: lead / buffer.sampleRate,
    loopEndSec: (length - tail) / buffer.sampleRate,
  };
}

export class PartyMusic {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private tracks = new Map<TrackId, TrackState>();
  private mood: MusicMood = 'silent';
  /** The mood whose program is sounding now (null: nothing is playing) */
  private playingMood: MusicMood | null = null;
  private voices: PlayingVoice[] = [];
  private muted = false;
  private volume: number = MUSIC_VOLUME_DEFAULT;

  /** Loudness chosen by the facilitator in Mission Control, 0..100. */
  setVolume(volume: number): void {
    if (!Number.isFinite(volume) || volume === this.volume) return;
    this.volume = volume;
    this.applyMasterLevel(0.12);
  }

  /** True while a mood with music is selected, whether or not the browser has let it start yet. */
  isActive(): boolean {
    return this.mood !== 'silent';
  }

  /** True when the browser is holding audio back until the page gets a click or key press. */
  needsUnlock(): boolean {
    return this.isActive() && this.ctx !== null && this.ctx.state !== 'running';
  }

  /** Called whenever the browser starts or stops holding the music back. */
  onBlockedChange: ((blocked: boolean) => void) | null = null;

  /**
   * Call from every click or key handler, whether or not music is on yet. Opens the audio device
   * inside the user gesture, which is the only moment a browser allows it.
   */
  prime(): void {
    if (!this.ensureContext()) return;
    if (this.ctx!.state !== 'running') void this.ctx!.resume();
  }

  /** Local mute for this display (its Sound button); the facilitator's switch chooses the mood. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMasterLevel(0.15);
  }

  setMood(mood: MusicMood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    if (mood === 'silent') {
      this.syncPlayback();
      return;
    }
    if (!this.ensureContext()) return;
    if (this.ctx!.state === 'suspended') void this.ctx!.resume();
    this.applyMasterLevel(0.2);
    this.loadTracks();
    this.syncPlayback();
    this.onBlockedChange?.(this.needsUnlock());
  }

  stop(): void {
    this.setMood('silent');
  }

  /** Releases the audio device; the instance can be started again afterwards. */
  dispose(): void {
    this.stop();
    for (const voice of this.voices) {
      try {
        voice.source.stop();
      } catch {
        // already stopped
      }
    }
    this.voices = [];
    this.playingMood = null;
    if (this.ctx) this.ctx.onstatechange = null;
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.analyser = null;
    // Decoded buffers belong to the closed context; fetch again if music returns
    this.tracks.clear();
  }

  /** Peak output level right now, 0..1. Used to confirm that sound is actually being produced. */
  measureLevel(): number {
    if (!this.analyser) return 0;
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    return peak;
  }

  /** Which tracks have loaded, failed, or are still loading, and what is playing. For automated checks. */
  describeTracks(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of TRACK_IDS) {
      const state = this.tracks.get(id);
      out[id] =
        state?.status === 'ready'
          ? `ready ${state.buffer.duration.toFixed(3)}s loop ${state.loopStartSec.toFixed(3)}-${state.loopEndSec.toFixed(3)} gain ${state.gain.toFixed(2)}`
          : (state?.status ?? 'not requested');
    }
    out.playing = this.playingMood ?? 'nothing';
    out.voices = String(this.voices.length);
    return out;
  }

  private ensureContext(): boolean {
    if (this.ctx) return true;
    if (typeof window === 'undefined') return false;
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return false;
    try {
      const ctx = new Ctx();
      const master = ctx.createGain();
      master.gain.value = 0;
      // A gentle limiter so peaks never clip on small classroom speakers
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 4;
      limiter.attack.value = 0.004;
      limiter.release.value = 0.18;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      master.connect(limiter);
      limiter.connect(analyser);
      analyser.connect(ctx.destination);

      this.ctx = ctx;
      this.master = master;
      this.analyser = analyser;
      this.applyMasterLevel(0.3);
      // When the browser lets the audio run (or stops it), set the level again and tell the display
      ctx.onstatechange = () => {
        if (this.ctx !== ctx) return;
        this.applyMasterLevel(0.15);
        this.onBlockedChange?.(this.needsUnlock());
      };
      return true;
    } catch {
      return false;
    }
  }

  private applyMasterLevel(rampSec: number): void {
    if (!this.ctx || !this.master) return;
    const target = this.muted ? 0 : volumeToGain(this.volume);
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    if (this.ctx.state !== 'running') {
      // A held-back context's clock is not moving, so a ramp scheduled now could be lost; set it outright
      this.master.gain.value = target;
      return;
    }
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(target, now + rampSec);
  }

  /** Fetches and decodes every track once. A track that fails stays silent; the rest still play. */
  private loadTracks(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const id of TRACK_IDS) {
      if (this.tracks.has(id)) continue;
      this.tracks.set(id, { status: 'loading' });
      fetch(TRACK_URLS[id])
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then((bytes) => ctx.decodeAudioData(bytes))
        .then((buffer) => {
          // The context may have been closed and replaced while this was loading
          if (this.ctx !== ctx) return;
          this.tracks.set(id, { status: 'ready', ...analyseTrack(buffer) });
          this.syncPlayback();
        })
        .catch((err: unknown) => {
          if (this.ctx !== ctx) return;
          this.tracks.set(id, { status: 'failed' });
          console.warn(`Background music: could not load ${TRACK_URLS[id]}; that track stays silent.`, err);
          this.syncPlayback();
        });
    }
  }

  /** Makes what is sounding match the selected mood, once the tracks it needs have loaded. */
  private syncPlayback(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (this.playingMood === this.mood) return;

    if (this.mood === 'silent') {
      this.fadeOutVoices(CROSSFADE_SEC);
      this.playingMood = null;
      return;
    }

    const loop = this.tracks.get(MOOD_LOOP[this.mood]);
    const fanfare = this.mood === 'results' ? this.tracks.get('fanfare') : undefined;
    // Wait for everything this mood needs; a failed track is simply skipped
    if (!loop || loop.status === 'loading') return;
    if (this.mood === 'results' && (!fanfare || fanfare.status === 'loading')) return;

    this.fadeOutVoices(CROSSFADE_SEC);
    this.playingMood = this.mood;

    let startAt = ctx.currentTime + 0.06;
    if (fanfare && fanfare.status === 'ready') {
      // Let the outgoing track clear before the fanfare, and the loop come in under its last note
      startAt += CROSSFADE_SEC * 0.6;
      this.startVoice(fanfare, startAt, false, 0.01);
      startAt += Math.max(0.5, fanfare.buffer.duration - 0.35);
    }
    if (loop.status === 'ready') {
      this.startVoice(loop, startAt, true, CROSSFADE_SEC);
    }
  }

  private startVoice(track: LoadedTrack, when: number, looping: boolean, fadeInSec: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const source = ctx.createBufferSource();
    source.buffer = track.buffer;
    if (looping) {
      source.loop = true;
      source.loopStart = track.loopStartSec;
      source.loopEnd = track.loopEndSec;
    }
    const gain = ctx.createGain();
    // Silent until its start time, so a voice cancelled before it begins never sounds
    gain.gain.value = 0;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(track.gain, when + fadeInSec);
    source.connect(gain);
    gain.connect(this.master);
    source.start(when, track.loopStartSec);

    const voice: PlayingVoice = { source, gain };
    this.voices.push(voice);
    source.onended = () => {
      this.voices = this.voices.filter((v) => v !== voice);
      gain.disconnect();
    };
  }

  /** Fades out and stops everything sounding or scheduled. New voices can start straight away. */
  private fadeOutVoices(fadeSec: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of this.voices) {
      try {
        // Read the level first: cancelling a ramp that has not begun would otherwise snap it
        const level = voice.gain.gain.value;
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(level, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
        voice.source.stop(now + fadeSec + 0.02);
      } catch {
        // already stopped
      }
    }
  }
}

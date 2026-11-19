/**
 * Optional sound & haptic feedback utilities (Section 8).
 *
 * Platform rules enforced:
 * - Visual feedback is always primary; audio & haptics are optional enhancements.
 * - Android Chrome `navigator.vibrate` is used ONLY after recognition has latched (never during active sensor capture,
 *   preventing vibration transients from contaminating accelerometer samples).
 * - Never relies on hidden iOS switch hacks or Taptic Engine workarounds.
 */
export class FeedbackController {
  private audioCtx: AudioContext | null = null;
  private muted = false;
  private hapticsEnabled = true;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setHapticsEnabled(enabled: boolean): void {
    this.hapticsEnabled = enabled;
  }

  isHapticsEnabled(): boolean {
    return this.hapticsEnabled;
  }

  static supportsVibration(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  static prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * Call ONLY after local stroke recognition has latched (`recognized_locked`) so sensor evaluation is already finished.
   */
  pulseLatchedRecognition(): void {
    if (!this.hapticsEnabled || !FeedbackController.supportsVibration()) return;
    try {
      navigator.vibrate(22);
    } catch {
      // Ignore blocked vibration calls silently
    }
  }

  playTone(
    kind:
      | 'accepted'
      | 'rejected'
      | 'collected'
      | 'collected_big'
      | 'collected_jackpot'
      | 'countdown_tick'
      | 'go',
  ): void {
    if (this.muted || typeof window === 'undefined') return;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!this.audioCtx) {
        this.audioCtx = new Ctx();
      }
      if (this.audioCtx.state === 'suspended') {
        void this.audioCtx.resume();
      }

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      if (kind === 'accepted') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.09);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc.start(now);
        osc.stop(now + 0.15);
      } else if (kind === 'rejected') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(260, now);
        osc.frequency.linearRampToValueAtTime(215, now + 0.1);
        gain.gain.setValueAtTime(0.045, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.13);
      } else if (kind === 'collected') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(659.25, now);
        osc.frequency.exponentialRampToValueAtTime(1046.5, now + 0.12);
        gain.gain.setValueAtTime(0.09, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.start(now);
        osc.stop(now + 0.19);
      } else if (kind === 'collected_big') {
        // Golden bug: a brighter two-note hop
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(783.99, now);
        osc.frequency.setValueAtTime(1174.66, now + 0.09);
        gain.gain.setValueAtTime(0.11, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.31);
      } else if (kind === 'collected_jackpot') {
        // Pond star: a rising four-note fanfare
        osc.type = 'square';
        [523.25, 659.25, 783.99, 1046.5].forEach((hz, i) => {
          osc.frequency.setValueAtTime(hz, now + i * 0.085);
        });
        gain.gain.setValueAtTime(0.085, now);
        gain.gain.setValueAtTime(0.085, now + 0.36);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
        osc.start(now);
        osc.stop(now + 0.71);
      } else if (kind === 'countdown_tick') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc.start(now);
        osc.stop(now + 0.1);
      } else if (kind === 'go') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.setValueAtTime(880, now + 0.07);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
        osc.start(now);
        osc.stop(now + 0.25);
      }
    } catch {
      // Audio playback is optional; never throw
    }
  }
}

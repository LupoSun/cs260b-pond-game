import type { SensorStatus } from '../shared/types.js';
import { isValidVec3 } from './gravity.js';
import type { MotionSample } from './types.js';

export interface SensorCapabilityReport {
  status: SensorStatus;
  isSecureContext: boolean;
  hasDeviceMotionApi: boolean;
  hasDeviceOrientationApi: boolean;
  permissionState: 'not_required' | 'granted' | 'denied';
  receivedMotionEvents: number;
  receivedOrientationEvents: number;
  hasLinearAcceleration: boolean;
  hasAccelIncludingGravity: boolean;
  measuredRateHz: number;
  summaryMessage: string;
}

type SampleListener = (sample: MotionSample) => void;

interface PermissionCapableEvent {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
}

/**
 * Browser DeviceMotion / DeviceOrientation manager (Section 7.1).
 *
 * - Feature-detects iOS Safari `requestPermission()` separately on DeviceMotionEvent and DeviceOrientationEvent.
 * - Verifies actual numeric sample delivery over a live check window (not merely `window.DeviceMotionEvent !== undefined`).
 * - Normalizes timestamps using monotonic `performance.now()` so Safari/Chrome event timestamp epoch differences never confuse seconds and milliseconds.
 */
export class BrowserSensorManager {
  private listeners = new Set<SampleListener>();
  private listening = false;
  private latestOrientation: { alpha: number | null; beta: number | null; gamma: number | null } | null =
    null;

  private motionCount = 0;
  private orientationCount = 0;
  private sawValidLinear = false;
  private sawValidIncG = false;
  private recentTimestampsMs: number[] = [];

  private readonly onDeviceOrientation = (ev: DeviceOrientationEvent): void => {
    this.orientationCount += 1;
    this.latestOrientation = {
      alpha: ev.alpha != null && Number.isFinite(ev.alpha) ? ev.alpha : null,
      beta: ev.beta != null && Number.isFinite(ev.beta) ? ev.beta : null,
      gamma: ev.gamma != null && Number.isFinite(ev.gamma) ? ev.gamma : null,
    };
  };

  private readonly onDeviceMotion = (ev: DeviceMotionEvent): void => {
    const nowMs = performance.now();
    this.motionCount += 1;
    this.recentTimestampsMs.push(nowMs);
    if (this.recentTimestampsMs.length > 60) {
      this.recentTimestampsMs.shift();
    }

    const lin = ev.acceleration;
    const linearAccel =
      lin && lin.x != null && lin.y != null && lin.z != null
        ? { x: lin.x, y: lin.y, z: lin.z }
        : null;
    if (isValidVec3(linearAccel)) {
      if (Math.abs(linearAccel.x) > 1e-6 || Math.abs(linearAccel.y) > 1e-6 || Math.abs(linearAccel.z) > 1e-6) {
        this.sawValidLinear = true;
      }
    }

    const inc = ev.accelerationIncludingGravity;
    const accelIncludingGravity =
      inc && inc.x != null && inc.y != null && inc.z != null
        ? { x: inc.x, y: inc.y, z: inc.z }
        : null;
    if (isValidVec3(accelIncludingGravity)) {
      this.sawValidIncG = true;
    }

    const rot = ev.rotationRate;
    const rotationRateDegPerSec =
      rot && rot.alpha != null && rot.beta != null && rot.gamma != null
        ? { alpha: rot.alpha, beta: rot.beta, gamma: rot.gamma }
        : null;

    const sample: MotionSample = {
      timestampMs: nowMs,
      linearAccel: isValidVec3(linearAccel) ? linearAccel : null,
      accelIncludingGravity: isValidVec3(accelIncludingGravity) ? accelIncludingGravity : null,
      rotationRateDegPerSec,
      orientationDeg: this.latestOrientation ? { ...this.latestOrientation } : null,
    };

    for (const cb of this.listeners) {
      cb(sample);
    }
  };

  subscribe(listener: SampleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getLatestOrientation(): { beta: number; gamma: number } | null {
    if (
      this.latestOrientation &&
      this.latestOrientation.beta != null &&
      this.latestOrientation.gamma != null
    ) {
      return { beta: this.latestOrientation.beta, gamma: this.latestOrientation.gamma };
    }
    return null;
  }

  getMeasuredRateHz(): number {
    if (this.recentTimestampsMs.length < 4) return 0;
    const first = this.recentTimestampsMs[0];
    const last = this.recentTimestampsMs[this.recentTimestampsMs.length - 1];
    const spanSec = (last - first) / 1000;
    if (spanSec <= 0.01) return 0;
    return Number(((this.recentTimestampsMs.length - 1) / spanSec).toFixed(1));
  }

  /**
   * Must be invoked directly from a user tap/click handler so iOS Safari grants permission.
   */
  async enableAndCheckCapabilities(checkWindowMs = 650): Promise<SensorCapabilityReport> {
    const isSecure = typeof window !== 'undefined' ? Boolean(window.isSecureContext) : false;
    const hasMotionApi = typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
    const hasOrientationApi = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;

    if (!isSecure && typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      return {
        status: 'unsupported',
        isSecureContext: false,
        hasDeviceMotionApi: hasMotionApi,
        hasDeviceOrientationApi: hasOrientationApi,
        permissionState: 'denied',
        receivedMotionEvents: 0,
        receivedOrientationEvents: 0,
        hasLinearAcceleration: false,
        hasAccelIncludingGravity: false,
        measuredRateHz: 0,
        summaryMessage: 'HTTPS is required for phone motion sensors. Open the HTTPS session link.',
      };
    }

    if (!hasMotionApi) {
      return {
        status: 'unsupported',
        isSecureContext: isSecure,
        hasDeviceMotionApi: false,
        hasDeviceOrientationApi: hasOrientationApi,
        permissionState: 'not_required',
        receivedMotionEvents: 0,
        receivedOrientationEvents: 0,
        hasLinearAcceleration: false,
        hasAccelIncludingGravity: false,
        measuredRateHz: 0,
        summaryMessage: 'This browser does not expose DeviceMotion sensors. Use a phone or touch fallback.',
      };
    }

    let permissionState: 'not_required' | 'granted' | 'denied' = 'not_required';

    try {
      const motionCtor = window.DeviceMotionEvent as unknown as PermissionCapableEvent;
      const oriCtor = hasOrientationApi
        ? (window.DeviceOrientationEvent as unknown as PermissionCapableEvent)
        : null;

      // Trigger both permission requests synchronously in the same user-gesture turn before awaiting,
      // preventing iOS Safari from expiring transient user activation on the second request.
      const motionPermPromise =
        typeof motionCtor.requestPermission === 'function'
          ? motionCtor.requestPermission()
          : Promise.resolve<'not_required'>('not_required');
      const oriPermPromise =
        oriCtor && typeof oriCtor.requestPermission === 'function'
          ? oriCtor.requestPermission().catch(() => 'denied' as const)
          : Promise.resolve<'not_required'>('not_required');

      const [motionRes] = await Promise.all([motionPermPromise, oriPermPromise]);
      if (motionRes !== 'not_required') {
        if (motionRes !== 'granted') {
          return {
            status: 'denied',
            isSecureContext: isSecure,
            hasDeviceMotionApi: hasMotionApi,
            hasDeviceOrientationApi: hasOrientationApi,
            permissionState: 'denied',
            receivedMotionEvents: 0,
            receivedOrientationEvents: 0,
            hasLinearAcceleration: false,
            hasAccelIncludingGravity: false,
            measuredRateHz: 0,
            summaryMessage:
              'Motion permission was declined. Reload the page and allow Motion & Orientation access, or choose Touch Fallback.',
          };
        }
        permissionState = 'granted';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Permission prompt failed';
      return {
        status: 'denied',
        isSecureContext: isSecure,
        hasDeviceMotionApi: hasMotionApi,
        hasDeviceOrientationApi: hasOrientationApi,
        permissionState: 'denied',
        receivedMotionEvents: 0,
        receivedOrientationEvents: 0,
        hasLinearAcceleration: false,
        hasAccelIncludingGravity: false,
        measuredRateHz: 0,
        summaryMessage: `Could not obtain motion sensor access (${msg}). Tap Enable Motion directly or choose Touch Fallback.`,
      };
    }

    this.startListening();

    const startMotionCount = this.motionCount;
    const startOriCount = this.orientationCount;

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, checkWindowMs);
    });

    const receivedMotion = this.motionCount - startMotionCount;
    const receivedOri = this.orientationCount - startOriCount;
    const rateHz = this.getMeasuredRateHz();
    const usableNumbers = this.sawValidLinear || this.sawValidIncG;

    if (receivedMotion < 3 || !usableNumbers) {
      return {
        status: 'unsupported',
        isSecureContext: isSecure,
        hasDeviceMotionApi: hasMotionApi,
        hasDeviceOrientationApi: hasOrientationApi,
        permissionState,
        receivedMotionEvents: receivedMotion,
        receivedOrientationEvents: receivedOri,
        hasLinearAcceleration: this.sawValidLinear,
        hasAccelIncludingGravity: this.sawValidIncG,
        measuredRateHz: rateHz,
        summaryMessage:
          'No numeric motion samples arrived from this device/browser (common on desktops or restricted browser settings). You can use Touch Fallback.',
      };
    }

    return {
      status: 'ready',
      isSecureContext: isSecure,
      hasDeviceMotionApi: hasMotionApi,
      hasDeviceOrientationApi: hasOrientationApi,
      permissionState,
      receivedMotionEvents: receivedMotion,
      receivedOrientationEvents: receivedOri,
      hasLinearAcceleration: this.sawValidLinear,
      hasAccelIncludingGravity: this.sawValidIncG,
      measuredRateHz: rateHz,
      summaryMessage: `Motion sensors active (${rateHz} Hz, ${
        this.sawValidLinear ? 'linear acceleration' : 'gravity-compensated accelerometer'
      }).`,
    };
  }

  startListening(): void {
    if (this.listening || typeof window === 'undefined') return;
    window.addEventListener('deviceorientation', this.onDeviceOrientation, { passive: true });
    window.addEventListener('devicemotion', this.onDeviceMotion, { passive: true });
    this.listening = true;
  }

  stopListening(): void {
    if (!this.listening || typeof window === 'undefined') return;
    window.removeEventListener('deviceorientation', this.onDeviceOrientation);
    window.removeEventListener('devicemotion', this.onDeviceMotion);
    this.listening = false;
  }

  /**
   * Injects synthetic samples ONLY for automated unit tests or explicitly labeled DEV SIMULATION mode.
   */
  injectDevSyntheticSample(sample: MotionSample): void {
    for (const cb of this.listeners) {
      cb(sample);
    }
  }
}

import { describe, expect, it } from 'vitest';
import { Euler, Matrix4 } from 'three';
import { pitchAngleDeg, steerFromTiltDeg, throttleFromPitchDeg, tiltAngleDeg } from '@/input/gyro';
import { InputManager } from '@/input/InputManager';
import { resetTouchInput, touchInput } from '@/input/touchInput';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * W3C DeviceOrientation angles of a phone held facing the player, tilted back by `lean` degrees
 * from vertical, in a screen orientation of `screenAngle` degrees (0 portrait, 90 landscape with
 * the top of the phone on the left…), with the player having turned it clockwise by `wheel` degrees
 * about the screen normal. Built from real rotation matrices, independent of the formula under test.
 */
function reading(lean: number, screenAngle: number, wheel: number): { beta: number; gamma: number } {
  const base = new Matrix4().makeRotationX((90 - lean) * D2R); // device flat = identity, upright = Rx(90°)
  const about = new Matrix4().makeRotationZ((screenAngle - wheel) * D2R); // +z points at the player: CCW is positive
  const e = new Euler().setFromRotationMatrix(base.multiply(about), 'ZXY'); // W3C: R = Rz(alpha) Rx(beta) Ry(gamma)
  return { beta: e.x * R2D, gamma: e.y * R2D };
}

describe('tiltAngleDeg', () => {
  it('reads the wheel angle in every screen orientation, clockwise = positive', () => {
    for (const lean of [0, 15, 30]) {
      for (const screenAngle of [0, 90, 180, 270]) {
        for (const wheel of [-50, -20, -5, 0, 8, 25, 60]) {
          const { beta, gamma } = reading(lean, screenAngle, wheel);
          const angle = tiltAngleDeg(beta, gamma, screenAngle);
          expect(angle, `lean ${lean} screen ${screenAngle} wheel ${wheel}`).not.toBeNull();
          expect(angle as number).toBeCloseTo(wheel, 4);
        }
      }
    }
  });

  it('has no opinion about a phone lying flat', () => {
    expect(tiltAngleDeg(0, 0, 90)).toBeNull();
    expect(tiltAngleDeg(5, -3, 0)).toBeNull();
  });
});

describe('steerFromTiltDeg', () => {
  it('has a dead band, full lock at 32° and is odd-symmetric and monotonic', () => {
    expect(steerFromTiltDeg(0)).toBe(0);
    expect(steerFromTiltDeg(2.4)).toBe(0);
    expect(steerFromTiltDeg(-2.4)).toBe(0);
    expect(steerFromTiltDeg(32)).toBeCloseTo(1, 6);
    expect(steerFromTiltDeg(80)).toBe(1);
    expect(steerFromTiltDeg(-80)).toBe(-1);
    let prev = 0;
    for (let d = 3; d <= 32; d += 1) {
      const s = steerFromTiltDeg(d);
      expect(s).toBeGreaterThan(prev);
      expect(steerFromTiltDeg(-d)).toBeCloseTo(-s, 9);
      prev = s;
    }
  });
});

describe('touch input merge', () => {
  it('adds the tilt to the stick steer, and carries JUMP', () => {
    const im = new InputManager();
    touchInput.active = true;
    touchInput.tilt = 0.4;
    touchInput.steer = 0.2;
    touchInput.jump = true;
    touchInput.throttle = 1;
    const s = im.sample();
    expect(s.steer).toBeCloseTo(0.6, 9);
    expect(s.jump).toBe(true);
    expect(s.throttle).toBe(1);
    expect(s.boost).toBe(false);
    resetTouchInput();
    touchInput.active = false;
    const idle = im.sample();
    expect(idle.steer).toBe(0);
    expect(idle.jump).toBe(false);
  });

  it('clamps steer to 1 and ignores touch input while disabled (menus)', () => {
    const im = new InputManager();
    touchInput.active = true;
    touchInput.tilt = 1;
    touchInput.steer = 1;
    expect(im.sample().steer).toBe(1);
    im.setEnabled(false);
    expect(im.sample().steer).toBe(0);
    resetTouchInput();
    touchInput.active = false;
  });
});

describe('tilt gas / brake merge', () => {
  it('adds the tilt throttle to the stick / key throttle and clamps it', () => {
    const im = new InputManager();
    touchInput.active = true;
    touchInput.tiltThrottle = -0.6;
    expect(im.sample().throttle).toBeCloseTo(-0.6, 9);
    touchInput.tiltThrottle = 0.8;
    touchInput.throttle = 0.5;
    expect(im.sample().throttle).toBe(1);
    resetTouchInput();
    expect(touchInput.tiltThrottle).toBe(0);
    touchInput.active = false;
  });
});

describe('pitchAngleDeg / throttleFromPitchDeg', () => {
  it('reads how far the screen faces up, whatever the screen orientation', () => {
    for (const lean of [-25, -10, 0, 12, 30, 55]) {
      for (const screenAngle of [0, 90, 180, 270]) {
        for (const wheel of [-40, 0, 25]) {
          const { beta, gamma } = reading(lean, screenAngle, wheel);
          // the top of the phone tipped away from the player = screen facing up = positive
          expect(pitchAngleDeg(beta, gamma), `lean ${lean} screen ${screenAngle} wheel ${wheel}`).toBeCloseTo(lean, 4);
        }
      }
    }
  });

  it('maps tilt to gas (+) and brake (−) with a dead band and full travel', () => {
    expect(throttleFromPitchDeg(0)).toBe(0);
    expect(throttleFromPitchDeg(4.9)).toBe(0);
    expect(throttleFromPitchDeg(-4.9)).toBe(0);
    expect(throttleFromPitchDeg(12)).toBeGreaterThan(0.2);
    expect(throttleFromPitchDeg(12)).toBeLessThan(0.7);
    expect(throttleFromPitchDeg(-12)).toBe(-throttleFromPitchDeg(12));
    expect(throttleFromPitchDeg(25)).toBe(1);
    expect(throttleFromPitchDeg(-80)).toBe(-1);
  });
});

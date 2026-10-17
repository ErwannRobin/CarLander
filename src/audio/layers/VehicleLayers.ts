/**
 * Continuous vehicle layers. All nodes are built once and run for the lifetime of the engine (node
 * reuse); `update()` only retargets AudioParams (allocation-free, epsilon-gated automation).
 *
 *   motor   electric whine: soft fundamental + detuned 2nd harmonic + load-dependent filtered noise,
 *           pitch ∝ wheel spin (fixed reduction gear), brightness/level ∝ throttle load
 *   wind    body roar (brown, lowpass opening with speed) + high whistle, amplitude ∝ speed²
 *   road    tyre/road rumble while wheels are grounded — drops out on takeoff (instant sense of flight)
 *   squeal  resonant noise bands + jittered tone, from wheel slip
 *   rocket  driven pink-noise roar + sub rumble + sparse crackle, from boostLevel
 *   rcs     cold-gas hiss from the RCS axes, panned by yaw/roll (+ discrete puffs via the host)
 *   vacuum  turbine whine that spools up/down with inertia + suction air rush
 *   air     airborne whoosh, modulated by the body rotation (flips "chop" the air)
 *   scrape  sustained metal scrape fed by impact events
 *
 * Slow motion: every pitch-like parameter is scaled by sqrt(timeScale) (tape-style slowdown).
 */
import type { RenderFrame, SurfaceKind } from '@/game/types';
import { clamp, fin, smoothK, smoothstep, Wander } from '../dsp/math';
import { kRate, ParamDriver } from '../dsp/params';
import { driveCurve, harmonicWave } from '../dsp/buffers';
import type { NoiseBank } from '../sfx/synth';

export type LayerName = 'motor' | 'wind' | 'road' | 'squeal' | 'rocket' | 'crackle' | 'rcs' | 'vacuum' | 'air' | 'scrape';

export const LAYER_NAMES: readonly LayerName[] = ['motor', 'wind', 'road', 'squeal', 'rocket', 'crackle', 'rcs', 'vacuum', 'air', 'scrape'];

export interface LayerHost {
  ctx: BaseAudioContext;
  /** Vehicle bus input. */
  out: AudioNode;
  noise: NoiseBank;
  rng: () => number;
  /** Discrete RCS puff (one-shot) when an axis starts firing. */
  onRcsPuff(t: number, pan: number, strength: number): void;
}

const TWO_PI = Math.PI * 2;

export class VehicleLayers {
  private readonly ctx: BaseAudioContext;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  /** Audible layers (null = all). Test hook. */
  private mask: ReadonlySet<LayerName> | null = null;

  // motor
  private readonly motorFund: ParamDriver;
  private readonly motorHarm: ParamDriver;
  private readonly motorNoiseFreq: ParamDriver;
  private readonly motorNoiseGain: ParamDriver;
  private readonly motorCut: ParamDriver;
  private readonly motorGain: ParamDriver;
  // wind
  private readonly windLowCut: ParamDriver;
  private readonly windLowGain: ParamDriver;
  private readonly windHighFreq: ParamDriver;
  private readonly windHighGain: ParamDriver;
  // road
  private readonly roadCut: ParamDriver;
  private readonly roadGain: ParamDriver;
  // squeal
  private readonly squealF1: ParamDriver;
  private readonly squealF2: ParamDriver;
  private readonly squealTone: ParamDriver;
  private readonly squealGain: ParamDriver;
  // rocket
  private readonly roarCut: ParamDriver;
  private readonly roarGain: ParamDriver;
  private readonly rumbleGain: ParamDriver;
  private readonly rumbleOscFreq: ParamDriver;
  private readonly rumbleOscGain: ParamDriver;
  private readonly crackleRate: ParamDriver;
  private readonly crackleGain: ParamDriver;
  // rcs
  private readonly rcsFreq: ParamDriver;
  private readonly rcsPan: ParamDriver;
  private readonly rcsGain: ParamDriver;
  // vacuum
  private readonly vacWhineFreq: ParamDriver;
  private readonly vacWhineGain: ParamDriver;
  private readonly vacBladeFreq: ParamDriver;
  private readonly vacBladeGain: ParamDriver;
  private readonly vacAirFreq: ParamDriver;
  private readonly vacAirGain: ParamDriver;
  private readonly vacSuckGain: ParamDriver;
  // air
  private readonly airFreq: ParamDriver;
  private readonly airGain: ParamDriver;
  // scrape
  private readonly scrapeFreq: ParamDriver;
  private readonly scrapeGain: ParamDriver;

  // smoothed state
  private load = 0;
  private squeal = 0;
  private grounded = 0;
  private air = 0;
  private rpm = 0;
  private rotPhase = 0;
  private scrape = 0;
  /** Level the scrape follows while contact reports keep arriving, and how long (sim s) it holds. */
  private scrapeTarget = 0;
  private scrapeHold = 0;
  private rcsLevel = 0;
  private readonly rcsPrev = [0, 0, 0];
  private readonly rcsLastPuff = [-1, -1, -1];
  private readonly gust: Wander;
  private readonly flutter: Wander;
  private readonly jitter: Wander;
  private readonly scrapeWander: Wander;

  constructor(private readonly host: LayerHost) {
    const ctx = (this.ctx = host.ctx);
    const out = host.out;
    const { white, pink, brown, crackle } = host.noise;
    const rng = host.rng;
    this.gust = new Wander(rng, 1.2, 1.2);
    this.flutter = new Wander(rng, 9, 3);
    this.jitter = new Wander(rng, 6, 2);
    this.scrapeWander = new Wander(rng, 14, 3);

    // Shared looping noise sources (one per colour) feed every noise-based layer.
    const whiteSrc = this.noiseSrc(white, rng);
    const pinkSrc = this.noiseSrc(pink, rng);
    const brownSrc = this.noiseSrc(brown, rng);
    const crackleSrc = this.noiseSrc(crackle, rng);

    // --- motor ---------------------------------------------------------
    const motorOut = this.gain(0);
    const motorLp = this.filter('lowpass', 1500, 0.8);
    const motorHp = this.filter('highpass', 90, 0.7);
    const fund = this.osc(harmonicWave(ctx, [1, 0.3, 0.12, 0.05]), 60);
    const harm = this.osc('sine', 120);
    const fundG = this.gain(0.8);
    const harmG = this.gain(0.32);
    const mNoiseBp = this.filter('bandpass', 2000, 0.9);
    const mNoiseG = this.gain(0);
    fund.connect(fundG).connect(motorLp);
    harm.connect(harmG).connect(motorLp);
    whiteSrc.connect(mNoiseBp).connect(mNoiseG).connect(motorLp);
    motorLp.connect(motorHp).connect(motorOut).connect(out);
    this.motorFund = new ParamDriver(kRate(fund.frequency), 60, 0.035, 0.002, true);
    this.motorHarm = new ParamDriver(kRate(harm.frequency), 120, 0.035, 0.002, true);
    this.motorNoiseFreq = new ParamDriver(kRate(mNoiseBp.frequency), 2000, 0.05, 0.01, true);
    this.motorNoiseGain = new ParamDriver(mNoiseG.gain, 0, 0.06, 0.003);
    this.motorCut = new ParamDriver(kRate(motorLp.frequency), 1500, 0.06, 0.01, true);
    this.motorGain = new ParamDriver(motorOut.gain, 0, 0.05, 0.0004);

    // --- wind ----------------------------------------------------------
    const windLowLp = this.filter('lowpass', 300, 0.5);
    const windLowHp = this.filter('highpass', 110, 0.6);
    const windLowG = this.gain(0);
    brownSrc.connect(windLowLp).connect(windLowHp).connect(windLowG).connect(out);
    const windHighBp = this.filter('bandpass', 1200, 0.7);
    const windHighG = this.gain(0);
    whiteSrc.connect(windHighBp).connect(windHighG).connect(out);
    this.windLowCut = new ParamDriver(kRate(windLowLp.frequency), 300, 0.08, 0.01, true);
    this.windLowGain = new ParamDriver(windLowG.gain, 0, 0.08, 0.0004);
    this.windHighFreq = new ParamDriver(kRate(windHighBp.frequency), 1200, 0.08, 0.01, true);
    this.windHighGain = new ParamDriver(windHighG.gain, 0, 0.08, 0.0003);

    // --- road ----------------------------------------------------------
    const roadLp = this.filter('lowpass', 300, 0.7);
    const roadBody = this.filter('peaking', 110, 1.2, 4);
    const roadG = this.gain(0);
    brownSrc.connect(roadLp).connect(roadBody).connect(roadG).connect(out);
    this.roadCut = new ParamDriver(kRate(roadLp.frequency), 300, 0.06, 0.01, true);
    this.roadGain = new ParamDriver(roadG.gain, 0, 0.035, 0.0004);

    // --- squeal --------------------------------------------------------
    const sqBp1 = this.filter('bandpass', 820, 14);
    const sqBp2 = this.filter('bandpass', 1460, 10);
    const sqBoost1 = this.gain(6);
    const sqBoost2 = this.gain(3.5);
    const sqOsc = this.osc('sine', 820);
    const sqOscG = this.gain(0.35);
    const sqHp = this.filter('highpass', 420, 0.7);
    const squealG = this.gain(0);
    whiteSrc.connect(sqBp1).connect(sqBoost1).connect(sqHp);
    whiteSrc.connect(sqBp2).connect(sqBoost2).connect(sqHp);
    sqOsc.connect(sqOscG).connect(sqHp);
    sqHp.connect(squealG).connect(out);
    this.squealF1 = new ParamDriver(kRate(sqBp1.frequency), 820, 0.03, 0.004, true);
    this.squealF2 = new ParamDriver(kRate(sqBp2.frequency), 1460, 0.03, 0.004, true);
    this.squealTone = new ParamDriver(kRate(sqOsc.frequency), 820, 0.03, 0.002, true);
    this.squealGain = new ParamDriver(squealG.gain, 0, 0.03, 0.0004);

    // --- rocket --------------------------------------------------------
    const roarPre = this.gain(1.4);
    const roarSh = this.ctx.createWaveShaper();
    roarSh.curve = driveCurve(1.6);
    this.nodes.push(roarSh);
    const roarLp = this.filter('lowpass', 500, 0.6);
    const roarG = this.gain(0);
    pinkSrc.connect(roarPre).connect(roarSh).connect(roarLp).connect(roarG).connect(out);
    const rumbleLp = this.filter('lowpass', 150, 0.7);
    const rumbleG = this.gain(0);
    brownSrc.connect(rumbleLp).connect(rumbleG).connect(out);
    const rumbleOsc = this.osc('sine', 44);
    const rumbleOscG = this.gain(0);
    rumbleOsc.connect(rumbleOscG).connect(out);
    const crackHp = this.filter('highpass', 1200, 0.7);
    const crackPeak = this.filter('peaking', 3000, 0.9, 3);
    const crackG = this.gain(0);
    crackleSrc.connect(crackHp).connect(crackPeak).connect(crackG).connect(out);
    this.roarCut = new ParamDriver(kRate(roarLp.frequency), 500, 0.05, 0.01, true);
    this.roarGain = new ParamDriver(roarG.gain, 0, 0.04, 0.0004);
    this.rumbleGain = new ParamDriver(rumbleG.gain, 0, 0.05, 0.0004);
    this.rumbleOscFreq = new ParamDriver(kRate(rumbleOsc.frequency), 44, 0.08, 0.005, true);
    this.rumbleOscGain = new ParamDriver(rumbleOscG.gain, 0, 0.05, 0.0003);
    this.crackleRate = new ParamDriver(crackleSrc.playbackRate, 1, 0.1, 0.01, true);
    this.crackleGain = new ParamDriver(crackG.gain, 0, 0.05, 0.0004);

    // --- rcs -----------------------------------------------------------
    // Cold-gas "pssht": pink noise (a hiss without white noise's fizzy top end).
    const rcsHp = this.filter('highpass', 1200, 0.7);
    const rcsBp = this.filter('bandpass', 3000, 0.7);
    const rcsP = this.ctx.createStereoPanner();
    this.nodes.push(rcsP);
    const rcsG = this.gain(0);
    pinkSrc.connect(rcsHp).connect(rcsBp).connect(rcsP).connect(rcsG).connect(out);
    this.rcsFreq = new ParamDriver(kRate(rcsBp.frequency), 3000, 0.05, 0.01, true);
    this.rcsPan = new ParamDriver(kRate(rcsP.pan), 0, 0.05, 0.02);
    this.rcsGain = new ParamDriver(rcsG.gain, 0, 0.03, 0.0004);

    // --- vacuum turbine -----------------------------------------------
    const vacHp = this.filter('highpass', 120, 0.7);
    vacHp.connect(out);
    const whine = this.osc('sine', 200);
    const whineG = this.gain(0);
    whine.connect(whineG).connect(vacHp);
    const blade = this.osc('triangle', 552);
    const bladeG = this.gain(0);
    blade.connect(bladeG).connect(vacHp);
    const vacAirBp = this.filter('bandpass', 400, 1.5);
    const vacAirG = this.gain(0);
    whiteSrc.connect(vacAirBp).connect(vacAirG).connect(vacHp);
    const suckLp = this.filter('lowpass', 280, 0.8);
    const suckG = this.gain(0);
    brownSrc.connect(suckLp).connect(suckG).connect(out);
    this.vacWhineFreq = new ParamDriver(kRate(whine.frequency), 200, 0.04, 0.002, true);
    this.vacWhineGain = new ParamDriver(whineG.gain, 0, 0.05, 0.0003);
    this.vacBladeFreq = new ParamDriver(kRate(blade.frequency), 552, 0.04, 0.002, true);
    this.vacBladeGain = new ParamDriver(bladeG.gain, 0, 0.05, 0.0002);
    this.vacAirFreq = new ParamDriver(kRate(vacAirBp.frequency), 400, 0.05, 0.01, true);
    this.vacAirGain = new ParamDriver(vacAirG.gain, 0, 0.05, 0.0003);
    this.vacSuckGain = new ParamDriver(suckG.gain, 0, 0.06, 0.0004);

    // --- airborne whoosh ----------------------------------------------
    // Pink (not white) noise: an airy "whoosh" rather than a hiss.
    const airBp = this.filter('bandpass', 700, 1.1);
    const airG = this.gain(0);
    pinkSrc.connect(airBp).connect(airG).connect(out);
    this.airFreq = new ParamDriver(kRate(airBp.frequency), 700, 0.04, 0.01, true);
    this.airGain = new ParamDriver(airG.gain, 0, 0.05, 0.0004);

    // --- scrape ---------------------------------------------------------
    const scrBp = this.filter('bandpass', 1900, 1.5);
    const scrPre = this.gain(2.2);
    const scrSh = this.ctx.createWaveShaper();
    scrSh.curve = driveCurve(2.5);
    this.nodes.push(scrSh);
    const scrHp = this.filter('highpass', 600, 0.7);
    const scrG = this.gain(0);
    whiteSrc.connect(scrBp).connect(scrPre).connect(scrSh).connect(scrHp).connect(scrG).connect(out);
    this.scrapeFreq = new ParamDriver(kRate(scrBp.frequency), 1900, 0.02, 0.01, true);
    this.scrapeGain = new ParamDriver(scrG.gain, 0, 0.02, 0.0004);
  }

  /** Test hook: hear one layer only (null = all). */
  setSolo(name: LayerName | null): void {
    this.mask = name === null ? null : new Set([name]);
  }

  /** Test hook: hear only these layers (null = all). */
  setMask(names: readonly LayerName[] | null): void {
    this.mask = names === null ? null : new Set(names);
  }

  /**
   * Feed a chassis contact into the scrape layer. `sustained`: one of the periodic reports the sim sends
   * (~every 0.1 s of sim time) while the body slides along a surface: the level then holds between
   * reports and follows the slide speed, instead of pulsing at the report rate. An isolated hit only
   * leaves a short gritty tail.
   */
  addImpact(strength: number, sustained = false): void {
    const s = clamp(fin(strength), 0, 1);
    this.scrapeTarget = sustained ? Math.max(s, this.scrapeTarget * 0.5) : s;
    this.scrapeHold = sustained ? 0.15 : 0.04;
    if (s > this.scrape) this.scrape = s; // hits jump in at once (the gain driver smooths the edge)
  }

  /** Clear transient state (restart). */
  reset(t: number): void {
    this.squeal = 0;
    this.scrape = 0;
    this.scrapeTarget = 0;
    this.scrapeHold = 0;
    this.air = 0;
    this.rpm = 0;
    this.load = 0;
    this.rcsLevel = 0;
    this.rcsPrev.fill(0);
    this.squealGain.set(0, t, 0.02);
    this.scrapeGain.set(0, t, 0.02);
    this.airGain.set(0, t, 0.05);
    this.vacWhineGain.set(0, t, 0.08);
    this.vacBladeGain.set(0, t, 0.08);
    this.vacAirGain.set(0, t, 0.08);
    this.vacSuckGain.set(0, t, 0.08);
    this.roarGain.set(0, t, 0.05);
    this.rumbleGain.set(0, t, 0.05);
    this.rumbleOscGain.set(0, t, 0.05);
    this.crackleGain.set(0, t, 0.05);
    this.rcsGain.set(0, t, 0.03);
  }

  private m(name: LayerName): number {
    return this.mask === null || this.mask.has(name) ? 1 : 0;
  }

  /** Per rendered frame (only while the vehicle bus is live). */
  update(frame: RenderFrame, t: number, dt: number): void {
    const snap = frame.snapshot;
    const v = snap.vehicle;
    const simDt = clamp(fin(frame.simDt), 0, 0.1);
    const ts = clamp(fin(snap.timeScale, 1) || 1, 0.15, 1);
    const pitch = Math.sqrt(ts);
    const speed = Math.max(0, fin(v.speed));

    // --- wheels ---------------------------------------------------------
    let spin = 0;
    let slipMax = 0;
    let slipSum = 0;
    let nGround = 0;
    let surface: SurfaceKind | null = null;
    const wheels = v.wheels;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      spin += Math.abs(fin(w.spinRate));
      if (w.grounded) {
        const sl = clamp(fin(w.slip), 0, 1);
        nGround++;
        slipSum += sl;
        if (sl > slipMax) slipMax = sl;
        if (w.surface) surface = w.surface;
      }
    }
    spin /= Math.max(1, wheels.length);
    const groundTarget = nGround / 4;
    this.grounded += (groundTarget - this.grounded) * smoothK(dt, groundTarget > this.grounded ? 0.03 : 0.05);

    // --- motor ------------------------------------------------------------
    const loadTarget = v.airborne ? 0 : clamp(Math.abs(fin(v.throttle)), 0, 1);
    this.load += (loadTarget - this.load) * smoothK(dt, loadTarget > this.load ? 0.08 : 0.25);
    const fMotor = clamp((48 + spin * 4.4) * pitch, 20, 4000);
    this.motorFund.set(fMotor, t);
    this.motorHarm.set(fMotor * 2.008, t);
    this.motorNoiseFreq.set(clamp(900 + fMotor * 2.4, 200, 9000), t);
    this.motorCut.set((1300 + 3400 * this.load) * pitch, t);
    const presence = smoothstep(0.4, 4, Math.max(speed, spin * 0.36));
    const sn = clamp(speed / 57, 0, 1.4);
    this.motorGain.set(presence * (0.02 + 0.05 * Math.sqrt(sn)) * (0.45 + 0.55 * this.load) * this.m('motor'), t);
    this.motorNoiseGain.set(0.5 * this.load * presence, t);

    // --- wind -------------------------------------------------------------
    const s = clamp(speed / 80, 0, 1.25);
    const gust = this.gust.step(dt);
    const airT = v.airborne ? 1 : 0;
    this.air += (airT - this.air) * smoothK(dt, airT > this.air ? 0.25 : 0.1);
    const exposed = 1 + 0.3 * this.air;
    this.windLowGain.set(0.24 * s * s * (1 + 0.18 * gust) * exposed * this.m('wind'), t);
    this.windLowCut.set((260 + 1500 * s) * pitch * (1 + 0.25 * this.air) * (1 + 0.1 * gust), t);
    this.windHighGain.set(0.13 * Math.pow(s, 2.5) * (1 + 0.6 * this.air) * this.m('wind'), t);
    this.windHighFreq.set((900 + 2400 * s) * pitch, t);

    // --- road ---------------------------------------------------------------
    let bright = 1;
    let level = 1;
    switch (surface) {
      case 'metal':
        bright = 1.5;
        level = 0.9;
        break;
      case 'adhesive':
        bright = 0.8;
        level = 0.85;
        break;
      case 'concrete':
      case 'landing':
        bright = 1.15;
        break;
      case 'terrain':
        bright = 0.9;
        level = 1.2;
        break;
      default:
        break;
    }
    const roadAmt = clamp(speed / 50, 0, 1.3);
    this.roadGain.set(0.19 * Math.pow(roadAmt, 1.2) * this.grounded * level * this.m('road'), t);
    this.roadCut.set((180 + 8 * speed) * bright * pitch, t);

    // --- tyre squeal ----------------------------------------------------------
    const slip = slipMax * 0.7 + (nGround > 0 ? slipSum / nGround : 0) * 0.3;
    const sqTarget = smoothstep(0.22, 0.85, slip) * smoothstep(1.5, 7, speed) * (nGround > 0 ? 1 : 0);
    this.squeal += (sqTarget - this.squeal) * smoothK(dt, sqTarget > this.squeal ? 0.04 : 0.12);
    const fl = this.flutter.step(dt);
    const f1 = (780 + 170 * slip + 2 * Math.min(speed, 40)) * pitch * (1 + 0.035 * fl);
    this.squealF1.set(f1, t);
    this.squealF2.set(f1 * 1.78, t);
    this.squealTone.set(f1 * (1 + 0.004 * fl), t);
    this.squealGain.set(0.09 * this.squeal * (0.8 + 0.2 * fl) * this.m('squeal'), t);

    // --- rocket ---------------------------------------------------------------
    // the vertical booster reuses the rocket roar, a little softer
    const b = clamp(Math.max(fin(v.boostLevel), 0.8 * fin(v.jumpLevel)), 0, 1);
    const jit = this.jitter.step(dt);
    this.roarGain.set(0.18 * Math.pow(b, 1.1) * this.m('rocket'), t);
    this.roarCut.set((420 + 2600 * b) * pitch * (1 + 0.05 * jit), t);
    this.rumbleGain.set(0.27 * b * this.m('rocket'), t);
    this.rumbleOscFreq.set(44 * pitch * (1 + 0.04 * jit), t);
    this.rumbleOscGain.set(0.06 * b * this.m('rocket'), t);
    this.crackleGain.set(0.16 * smoothstep(0.25, 0.9, b) * this.m('crackle'), t);
    this.crackleRate.set((0.75 + 0.5 * b) * pitch, t);

    // --- RCS ------------------------------------------------------------------
    const rcs = v.rcs;
    const rp = clamp(fin(rcs.pitch), -1, 1);
    const ry = clamp(fin(rcs.yaw), -1, 1);
    const rr = clamp(fin(rcs.roll), -1, 1);
    const ap = Math.abs(rp);
    const ay = Math.abs(ry);
    const ar = Math.abs(rr);
    const act = Math.max(ap, ay, ar);
    const rcsTarget = 0.11 * Math.pow(act, 0.7) * this.m('rcs');
    this.rcsGain.set(rcsTarget, t, rcsTarget > this.rcsLevel ? 0.015 : 0.06);
    this.rcsLevel = rcsTarget;
    this.rcsPan.set(clamp(rr * 0.45 + ry * 0.35, -0.6, 0.6), t);
    this.rcsFreq.set(3000 * pitch * (1 + 0.12 * fl), t);
    if (this.m('rcs')) {
      this.puff(0, ap, 0, t);
      this.puff(1, ay, Math.sign(ry) * 0.4, t);
      this.puff(2, ar, Math.sign(rr) * 0.5, t);
    }

    // --- vacuum turbine -------------------------------------------------------
    const vac = v.vacuum;
    const vs = clamp(fin(vac.strength), 0, 1);
    const rpmTarget = !vac.available || vac.mode === 'off' ? 0 : vac.mode === 'armed' ? 0.42 : 0.55 + 0.45 * vs;
    this.rpm += (rpmTarget - this.rpm) * smoothK(simDt, rpmTarget > this.rpm ? 0.45 : 1.1);
    const r = this.rpm;
    const fw = (200 + 1150 * r) * pitch;
    const mv = this.m('vacuum');
    this.vacWhineFreq.set(fw, t);
    this.vacBladeFreq.set(fw * 2.76, t);
    this.vacWhineGain.set(0.04 * Math.pow(r, 1.5) * mv, t);
    this.vacBladeGain.set(0.012 * r * r * mv, t);
    this.vacAirFreq.set((400 + 2600 * r) * pitch, t);
    this.vacAirGain.set(0.06 * r * r * mv, t);
    this.vacSuckGain.set(0.09 * vs * (vac.mode === 'engaged' ? 1 : 0.4) * mv, t);

    // --- airborne whoosh ------------------------------------------------------
    const w = fin(v.angularVelocity.length());
    const spinF = clamp(w / 6, 0, 1);
    this.rotPhase = (this.rotPhase + w * simDt) % TWO_PI;
    const mod = Math.abs(Math.sin(this.rotPhase));
    this.airGain.set(0.075 * this.air * clamp(speed / 30, 0.2, 1.3) * (0.35 + 0.65 * spinF * (0.4 + 0.6 * mod)) * this.m('air'), t);
    this.airFreq.set((350 + 900 * spinF * mod + 350 * clamp(speed / 60, 0, 1)) * pitch, t);

    // --- scrape (sim time: contact reports are spaced in sim time, slow motion stretches them) ----------
    if (this.scrapeHold > 0) {
      this.scrapeHold -= simDt;
      this.scrape += (this.scrapeTarget - this.scrape) * smoothK(simDt, 0.06);
    } else {
      this.scrapeTarget = 0;
      this.scrape *= Math.exp(-simDt / 0.09);
    }
    if (this.scrape < 0.002) this.scrape = 0;
    const sw = this.scrapeWander.step(dt);
    this.scrapeGain.set(0.15 * this.scrape * this.m('scrape'), t);
    this.scrapeFreq.set((1900 + 700 * sw) * pitch, t);
  }

  private puff(axis: number, value: number, pan: number, t: number): void {
    if (value >= 0.2 && this.rcsPrev[axis] < 0.2 && t - this.rcsLastPuff[axis] > 0.07) {
      this.rcsLastPuff[axis] = t;
      this.host.onRcsPuff(t, pan, value);
    }
    this.rcsPrev[axis] = value;
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.sources.length = 0;
    this.nodes.length = 0;
  }

  /* --- node helpers ------------------------------------------------------ */

  private gain(v: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    this.nodes.push(g);
    return g;
  }

  private filter(type: BiquadFilterType, f: number, q: number, gainDb = 0): BiquadFilterNode {
    const n = this.ctx.createBiquadFilter();
    n.type = type;
    n.frequency.value = f;
    n.Q.value = q;
    n.gain.value = gainDb;
    this.nodes.push(n);
    return n;
  }

  private osc(type: OscillatorType | PeriodicWave, f: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type as OscillatorType; // PeriodicWave is structurally empty, so narrowing yields `string`
    else o.setPeriodicWave(type);
    o.frequency.value = f;
    o.start();
    this.nodes.push(o);
    this.sources.push(o);
    return o;
  }

  private noiseSrc(buf: AudioBuffer, rng: () => number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start(0, rng() * buf.duration * 0.9);
    this.nodes.push(s);
    this.sources.push(s);
    return s;
  }
}

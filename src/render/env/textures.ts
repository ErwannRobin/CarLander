/**
 * Procedural textures for the sky and clouds, generated once on the CPU and cached for the app
 * lifetime. They are `DataTexture`s shared by every <World>: `retainEnvTextures()` /
 * `releaseEnvTextures()` reference-count the mounted worlds, and when the last one unmounts the GPU
 * copies are disposed. three re-uploads from the cached CPU data on the next use, which keeps
 * remounts (and React StrictMode double effects) safe and cheap.
 */
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  ClampToEdgeWrapping,
  RGBAFormat,
  UnsignedByteType,
} from 'three';
import { clamp01, fbm, mulberry32, Perlin2, smoothstep, worley2 } from './noise';

/** Rank-normalizes values to a uniform [0, 1] distribution (so "coverage" thresholds are exact). */
function equalize(src: Float32Array): Float32Array {
  const n = src.length;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => src[a] - src[b]);
  const out = new Float32Array(n);
  for (let r = 0; r < n; r++) out[idx[r]] = r / (n - 1);
  return out;
}

let cloudNoise: DataTexture | null = null;
let puffAtlas: DataTexture | null = null;
let users = 0;

/** Marks the shared env textures as in use (one call per mounted <World>). */
export function retainEnvTextures(): void {
  users++;
}

/**
 * Releases one use; frees the GPU copies once no <World> is mounted (CPU data stays cached). The
 * check is deferred to a microtask: when one <World> replaces another in the same commit (title →
 * level) the count only touches zero momentarily and nothing is freed / re-uploaded.
 */
export function releaseEnvTextures(): void {
  users = Math.max(0, users - 1);
  if (users > 0) return;
  queueMicrotask(() => {
    if (users > 0) return;
    cloudNoise?.dispose();
    puffAtlas?.dispose();
  });
}

/**
 * Tileable cloud noise, RGBA:
 *  R  large-scale fbm (cloud masses), equalized
 *  G  billows: inverted multi-octave Worley (puffy cauliflower tops), equalized
 *  B  fine fbm detail (edge erosion), equalized
 *  A  fibrous anisotropic fbm (cirrus streaks), equalized
 */
export function getCloudNoiseTexture(): DataTexture {
  if (cloudNoise) return cloudNoise;
  const S = 256;
  const n = S * S;
  const pA = new Perlin2(1337);
  const pB = new Perlin2(4242);
  const pC = new Perlin2(9001);
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const a = new Float32Array(n);
  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x;
      // domain-warped fbm for natural, non-blobby cloud masses
      const wx = fbm(pB, u * 4 + 3.1, v * 4 + 7.7, 3, 4) * 0.35;
      const wy = fbm(pB, u * 4 + 11.3, v * 4 + 1.9, 3, 4) * 0.35;
      r[i] = fbm(pA, (u + wx * 0.25) * 4, (v + wy * 0.25) * 4, 6, 4);
      const w =
        (1 - worley2(u, v, 5, 11)) * 0.55 + (1 - worley2(u, v, 11, 23)) * 0.3 + (1 - worley2(u, v, 23, 37)) * 0.15;
      g[i] = w;
      b[i] = fbm(pC, u * 16, v * 16, 4, 16);
      // cirrus: stretched along x, plus a little warp so streaks curve
      a[i] = fbm(pC, u * 3 + wy * 0.6, v * 18, 5, 3) * 0.7 + fbm(pA, u * 6, v * 30, 3, 6) * 0.3;
    }
  }
  const R = equalize(r);
  const G = equalize(g);
  const B = equalize(b);
  const A = equalize(a);
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = Math.round(R[i] * 255);
    data[i * 4 + 1] = Math.round(G[i] * 255);
    data[i * 4 + 2] = Math.round(B[i] * 255);
    data[i * 4 + 3] = Math.round(A[i] * 255);
  }
  const tex = new DataTexture(data, S, S, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = NoColorSpace;
  tex.anisotropy = 4;
  tex.name = 'env.cloudNoise';
  tex.needsUpdate = true;
  cloudNoise = tex;
  return tex;
}

/** Number of puff variants per atlas row (atlas is PUFF_GRID x PUFF_GRID). */
export const PUFF_GRID = 2;

/**
 * Soft cumulus "puff" sprites (2x2 atlas, 256 px tiles), RGBA:
 *  R  density / alpha
 *  G  normal.x * 0.5 + 0.5   (sprite space, +x right)
 *  B  normal.y * 0.5 + 0.5   (+y up)
 *  A  thickness (0..1), used for soft self-shadowing / translucency
 * Each tile is a union of spherical blobs (cauliflower shape) with noisy, eroded edges.
 */
export function getPuffAtlasTexture(): DataTexture {
  if (puffAtlas) return puffAtlas;
  const T = 256;
  const S = T * PUFF_GRID;
  const data = new Uint8Array(S * S * 4);
  const noise = new Perlin2(77);
  const H = new Float32Array(T * T);
  const D = new Float32Array(T * T);

  for (let tile = 0; tile < PUFF_GRID * PUFF_GRID; tile++) {
    const rnd = mulberry32(1000 + tile * 97);
    // blob layout (tile space -1..1, y up): many small puffs piled into a mound (cauliflower)
    const blobs: { x: number; y: number; r: number }[] = [];
    const nBlobs = [14, 18, 22, 12][tile];
    const width = [0.55, 0.68, 0.62, 0.7][tile];
    blobs.push({ x: 0, y: -0.12, r: 0.42 });
    for (let k = 1; k < nBlobs; k++) {
      const u = rnd() * 2 - 1;
      const x = u * width;
      // mound profile: taller in the middle, low at the sides
      const top = 0.38 * (1 - u * u) + 0.02;
      const y = -0.3 + rnd() * (top + 0.25);
      const rr = (0.12 + rnd() * 0.16) * (1.1 - Math.abs(u) * 0.4);
      blobs.push({ x, y, r: rr });
    }
    const wispy = tile === 3;
    const ox = (tile % PUFF_GRID) * T;
    const oy = Math.floor(tile / PUFF_GRID) * T;

    // height field (blob union) + eroded density
    for (let y = 0; y < T; y++) {
      const py = ((y + 0.5) / T) * 2 - 1;
      for (let x = 0; x < T; x++) {
        const px = ((x + 0.5) / T) * 2 - 1;
        // warp the lookup so blob outlines are irregular
        const wx = px + fbm(noise, px * 4 + tile * 7.1, py * 4 - 3.3, 3) * 0.05;
        const wy = py + fbm(noise, px * 4 - 9.7, py * 4 + tile * 2.9, 3) * 0.05;
        let h = 0;
        for (const bl of blobs) {
          const dx = (wx - bl.x) / bl.r;
          const dy = (wy - bl.y) / bl.r;
          const q = 1 - (dx * dx + dy * dy);
          if (q > 0) h = Math.max(h, Math.sqrt(q) * bl.r);
        }
        // flat-ish underside (cumulus bases)
        h *= smoothstep(-0.62, -0.3, py);
        const n1 = fbm(noise, px * 5 + tile * 13.7, py * 5 - tile * 5.1, 5);
        const n2 = fbm(noise, px * 14 - tile * 3.3, py * 14 + tile * 8.9, 3);
        const hh = Math.max(0, h + n1 * 0.035 + n2 * 0.02);
        const rad = Math.sqrt(px * px + py * py);
        const border = 1 - smoothstep(0.8, 0.96, rad);
        H[y * T + x] = hh * border;
        const edge = wispy ? 0.12 : 0.05;
        let dens = smoothstep(0.0, edge, hh - 0.01 + n2 * 0.015) * border;
        dens *= wispy ? 0.5 + 0.5 * clamp01(n1 * 1.4 + 0.5) : 0.8 + 0.2 * clamp01(n1 + 0.5);
        D[y * T + x] = dens;
      }
    }
    // normals from the height field (soft), write texels
    const k = 1.7;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const i = y * T + x;
        const hl = H[y * T + Math.max(0, x - 2)];
        const hr = H[y * T + Math.min(T - 1, x + 2)];
        const hd = H[Math.max(0, y - 2) * T + x];
        const hu = H[Math.min(T - 1, y + 2) * T + x];
        let nx = (hl - hr) * k * (T / 64);
        let ny = (hd - hu) * k * (T / 64);
        let nz = 1;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv;
        ny *= inv;
        nz *= inv;
        const o = ((oy + y) * S + (ox + x)) * 4;
        data[o] = Math.round(clamp01(D[i]) * 255);
        data[o + 1] = Math.round((nx * 0.5 + 0.5) * 255);
        data[o + 2] = Math.round((ny * 0.5 + 0.5) * 255);
        data[o + 3] = Math.round(clamp01(H[i] * 2.4) * 255);
      }
    }
  }
  const tex = new DataTexture(data, S, S, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = NoColorSpace;
  tex.name = 'env.puffAtlas';
  tex.needsUpdate = true;
  puffAtlas = tex;
  return tex;
}

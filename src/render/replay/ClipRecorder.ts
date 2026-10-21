/**
 * Records the WebGL canvas to a video file with MediaRecorder (what the player sees: camera, post
 * effects, slow motion; no HUD, no sound). MP4 (H.264) where the browser can record it, WebM otherwise.
 */
const CANDIDATES: Array<{ mime: string; ext: string }> = [
  // MP4 first: it plays everywhere (iPhone, messaging apps); WebM only where MP4 recording is missing
  { mime: 'video/mp4;codecs=avc1.640028', ext: 'mp4' },
  { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
];

export function pickRecordingFormat(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined' || !('captureStream' in HTMLCanvasElement.prototype)) {
    return null;
  }
  return CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.mime)) ?? null;
}

export class ClipRecorder {
  readonly ext: string;
  private readonly rec: MediaRecorder;
  private readonly stream: MediaStream;
  private readonly chunks: Blob[] = [];
  private readonly done: Promise<Blob>;

  constructor(canvas: HTMLCanvasElement, format: { mime: string; ext: string }) {
    this.ext = format.ext;
    this.stream = canvas.captureStream(60);
    const bits = Math.min(24_000_000, Math.max(5_000_000, Math.round(canvas.width * canvas.height * 5)));
    this.rec = new MediaRecorder(this.stream, { mimeType: format.mime, videoBitsPerSecond: bits });
    this.done = new Promise((resolve, reject) => {
      this.rec.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: format.mime.split(';')[0] }));
      this.rec.onerror = () => reject(new Error('The browser could not record the video.'));
    });
    this.rec.start(250);
  }

  /** Stops recording and resolves with the finished file. */
  stop(): Promise<Blob> {
    if (this.rec.state !== 'inactive') this.rec.stop();
    this.stream.getTracks().forEach((t) => t.stop());
    return this.done;
  }

  cancel() {
    this.rec.onstop = null;
    if (this.rec.state !== 'inactive') this.rec.stop();
    this.stream.getTracks().forEach((t) => t.stop());
  }
}

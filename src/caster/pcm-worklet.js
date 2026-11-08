'use strict';
// Plays float32 stereo PCM pushed from the main process (the helper's system
// sound capture) into the WebRTC audio track. Resamples linearly from the
// device rate to the AudioContext rate and keeps latency low: on underrun it
// outputs silence, and if the queue grows past ~150 ms it skips ahead.

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = sampleRate;
    this.queue = []; // Float32Array chunks, interleaved stereo
    this.queued = 0; // frames queued
    this.chunk = null;
    this.pos = 0; // fractional frame position inside this.chunk
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.rate) this.inRate = m.rate;
      if (m.pcm) {
        this.queue.push(m.pcm);
        this.queued += m.pcm.length / 2;
        const max = Math.round(this.inRate * 0.15);
        while (this.queued > max && this.queue.length > 1) this.queued -= this.queue.shift().length / 2;
      }
    };
  }

  frame(i) {
    // Frame i of the current chunk, reaching into the next chunk when needed.
    let c = this.chunk;
    let n = c.length / 2;
    if (i < n) return [c[i * 2], c[i * 2 + 1]];
    const next = this.queue[0];
    if (next && i - n < next.length / 2) return [next[(i - n) * 2], next[(i - n) * 2 + 1]];
    return [c[(n - 1) * 2], c[(n - 1) * 2 + 1]];
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    const step = this.inRate / sampleRate;
    for (let k = 0; k < left.length; k++) {
      if (!this.chunk || this.pos >= this.chunk.length / 2) {
        if (this.chunk) this.pos -= this.chunk.length / 2;
        this.chunk = this.queue.shift() || null;
        if (this.chunk) this.queued -= this.chunk.length / 2;
        else this.pos = 0;
      }
      if (!this.chunk) {
        left[k] = 0;
        if (right) right[k] = 0;
        continue;
      }
      const i = Math.floor(this.pos);
      const t = this.pos - i;
      const a = this.frame(i);
      const b = this.frame(i + 1);
      left[k] = a[0] + (b[0] - a[0]) * t;
      if (right) right[k] = a[1] + (b[1] - a[1]) * t;
      this.pos += step;
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);

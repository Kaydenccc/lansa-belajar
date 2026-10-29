'use strict';

// AudioWorklet: meneruskan audio mikrofon (mono, sampleRate AudioContext) ke jendela aplikasi.
class LensaTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}

registerProcessor('lensa-tap', LensaTap);

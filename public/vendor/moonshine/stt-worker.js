// On-device listening for Amelia's Talker. Runs the Moonshine speech model inside the tablet, off the main thread.
// Audio comes in as 16 kHz samples; text goes back. Nothing leaves the device.
import { MoonshineModel, Settings } from './moonshine.min.js';

const here = new URL('./', import.meta.url).href;
Settings.BASE_ASSET_PATH.MOONSHINE = here;
Settings.BASE_ASSET_PATH.ONNX_RUNTIME = here + 'ort/';

let model = null, loading = null;
function load() {
  if (!loading) {
    model = new MoonshineModel('model/tiny');
    const t0 = performance.now();
    loading = model.loadModel().then(() => {
      postMessage({ type: 'ready', ms: Math.round(performance.now() - t0), isolated: !!self.crossOriginIsolated });
    });
  }
  return loading;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') { await load(); return; }
    if (m.type === 'hear') {
      await load();
      const t0 = performance.now();
      const text = await model.generate(m.audio);
      postMessage({
        type: 'text', id: m.id, partial: !!m.partial, text: String(text || '').trim(),
        ms: Math.round(performance.now() - t0), secs: m.audio.length / 16000
      });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err).slice(0, 300) });
  }
};

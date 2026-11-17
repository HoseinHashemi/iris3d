export function runSegmentation(vol, smooth, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./segWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') onProgress?.(e.data.value);
      else if (e.data.type === 'done') { worker.terminate(); resolve({ surfaces: e.data.surfaces }); }
    };
    worker.onerror = (err) => { worker.terminate(); reject(err); };
    worker.postMessage({
      data: vol.data, w: vol.w, h: vol.h, d: vol.d,
      umPerPx: (vol.depthMM * 1000) / vol.h,
      latUm: (vol.widthMM * 1000) / Math.max(1, vol.w - 1),
      latUmZ: vol.d > 1 ? (vol.lengthMM * 1000) / (vol.d - 1) : 1e6,
      smooth,
    });
  });
}
